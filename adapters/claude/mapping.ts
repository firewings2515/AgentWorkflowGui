// Pure conversions from Claude SDK message shapes to contracts types. No state, no I/O; the adapter
// decides which session / turn / native task a message belongs to and passes that in. SDK messages
// are untrusted data, so every field is checked before use.
import {
  ItemId,
  type LimitWindow,
  type ModelOption,
  type NativeTaskId,
  type SessionId,
  type SessionItem,
  type Timestamp,
  type TokenCounts,
  TurnId,
} from '../../contracts';
import type { WireModelInfo } from './wire';

type CommandItem = Extract<SessionItem, { kind: 'command' }>;
type FileChangeItem = Extract<SessionItem, { kind: 'fileChange' }>;
type ToolCallItem = Extract<SessionItem, { kind: 'toolCall' }>;

export type Json = Record<string, unknown>;

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Adds `key` only when the value is present (exactOptionalPropertyTypes forbids explicit undefined). */
export const opt = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
  (value === undefined || value === null ? {} : { [key]: value }) as { [P in K]?: V };

export const isoFromMs = (ms: number): Timestamp => new Date(ms).toISOString();

/** Where a message or item belongs. Items of a native sub-agent carry its task and no session turn (R-13). */
export interface Placement {
  sessionId: SessionId;
  turnId?: string | undefined;
  nativeTaskId?: NativeTaskId | undefined;
}

export const placed = (p: Placement) => ({
  sessionId: p.sessionId,
  ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
  ...opt('nativeTaskId', p.nativeTaskId),
});

// ---- tools ----------------------------------------------------------------------------------------

/** Shell tools; Claude on Windows mixes both (SP-04). */
export const COMMAND_TOOLS: readonly string[] = ['Bash', 'PowerShell'];
/** File-writing tools the R-07 lock and read-only nodes care about. */
export const FILE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** The tool that spawns a native sub-agent (`Task` in older CLIs). */
export const AGENT_TOOLS: readonly string[] = ['Agent', 'Task'];

export type ToolKind = 'command' | 'fileChange' | 'toolCall';

export const toolKindOf = (name: string): ToolKind => (COMMAND_TOOLS.includes(name) ? 'command' : FILE_TOOLS.includes(name) ? 'fileChange' : 'toolCall');

/** Paths a tool call names: written files for edit tools, read / searched paths for the rest. */
export const toolPaths = (input: unknown): string[] => {
  if (!isObject(input)) return [];
  return [input.file_path, input.notebook_path, input.path].filter(isNonEmptyString);
};

/** `mcp__<server>__<tool>` → server and tool; other names are built-in tools. */
export const splitMcpName = (name: string): { tool: string; server?: string } => {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1]!, tool: m[2]! } : { tool: name };
};

const clip = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One-line description of a tool call for the item list and permission requests. */
export const toolSummary = (name: string, input: unknown): string => {
  const i = isObject(input) ? input : {};
  const command = str(i.command);
  if (COMMAND_TOOLS.includes(name) && command) return clip(`${name}: ${command}`);
  const target = toolPaths(i)[0] ?? str(i.pattern) ?? str(i.url) ?? str(i.query) ?? str(i.description);
  return clip(target ? `${name} ${target}` : name);
};

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** The item for a tool call the model just made. Edits stay `proposed` until their result arrives (R-07). */
export const startItem = (p: Placement, use: ToolUse, cwd: string, startedAt: Timestamp): SessionItem | undefined => {
  const base = { id: ItemId.parse(use.id), ...placed(p), startedAt };
  const input = isObject(use.input) ? use.input : {};
  switch (toolKindOf(use.name)) {
    case 'command': {
      const command = str(input.command);
      if (!command) return undefined;
      // `run_in_background`: it outlives its tool call, and file locks wait for it (R-07, SP-06 W3).
      const background = input.run_in_background === true;
      return { ...base, kind: 'command', command, cwd, state: 'running', ...(background && { background }), output: '', outputTruncated: false } satisfies CommandItem;
    }
    case 'fileChange': {
      const paths = toolPaths(input);
      if (paths.length === 0) return undefined;
      // Write may create the file; which one is known only from its result.
      return { ...base, kind: 'fileChange', changes: paths.map((path) => ({ path, change: 'update' as const })), state: 'proposed' } satisfies FileChangeItem;
    }
    case 'toolCall': {
      const { tool, server } = splitMcpName(use.name);
      return { ...base, kind: 'toolCall', tool, ...opt('server', server), summary: toolSummary(use.name, input), state: 'running' } satisfies ToolCallItem;
    }
  }
};

/** A `tool_result` block plus the structured `tool_use_result` the SDK puts beside it on live messages. */
export interface ToolResult {
  isError: boolean;
  content: unknown;
  structured?: unknown;
}

/** Plain text of a `tool_result` content (string, or text blocks). */
export const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Json => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
};

/** Keeps the tail when output is longer than `max` (the end of a command's output matters most). */
export const tailOf = (output: string, max: number): { output: string; outputTruncated: boolean } =>
  output.length > max ? { output: output.slice(output.length - max), outputTruncated: true } : { output, outputTruncated: false };

/**
 * The finished item. `declined`: the GUI's PreToolUse answer denied the call, so the error result is the
 * denial, not a failure. `interrupted`: the turn was interrupted while the call ran.
 */
export const finishItem = (
  item: SessionItem,
  result: ToolResult,
  o: { endedAt: Timestamp; declined: boolean; interrupted: boolean; maxOutputChars: number },
): SessionItem => {
  const s = isObject(result.structured) ? result.structured : undefined;
  switch (item.kind) {
    case 'command': {
      const stdout = s ? [str(s.stdout), str(s.stderr)].filter(isNonEmptyString).join('\n') : '';
      const output = tailOf(stdout || toolResultText(result.content), o.maxOutputChars);
      const state: CommandItem['state'] = o.declined
        ? 'declined'
        : s?.interrupted === true || (o.interrupted && result.isError)
          ? 'interrupted'
          : result.isError
            ? 'failed'
            : 'completed';
      return { ...item, ...output, state, endedAt: o.endedAt };
    }
    case 'fileChange': {
      const state: FileChangeItem['state'] = o.declined ? 'declined' : result.isError ? 'failed' : 'applied';
      const created = s?.type === 'create';
      const gitDiff = s && isObject(s.gitDiff) ? str(s.gitDiff.patch) : undefined;
      return {
        ...item,
        changes: created ? item.changes.map((c) => ({ ...c, change: 'add' as const })) : item.changes,
        state,
        ...opt('diff', gitDiff),
        endedAt: o.endedAt,
      };
    }
    case 'toolCall': {
      const state: ToolCallItem['state'] = o.declined ? 'declined' : result.isError ? 'failed' : 'completed';
      return { ...item, state, endedAt: o.endedAt };
    }
  }
};

/** Closes an item whose result never came (turn over, session gone). Returns undefined when already ended. */
export const closeOpenItem = (item: SessionItem, how: 'interrupted' | 'failed', endedAt: Timestamp): SessionItem | undefined => {
  if (item.endedAt !== undefined) return undefined;
  switch (item.kind) {
    case 'command':
      return { ...item, state: how, endedAt };
    case 'fileChange':
      return { ...item, state: 'failed', endedAt };
    case 'toolCall':
      return { ...item, state: 'failed', endedAt };
  }
};

// ---- content --------------------------------------------------------------------------------------

/** Text blocks of an assistant or user message content (thinking and tool blocks are not message text). */
export const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Json => isObject(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
};

export const toolUsesOf = (content: unknown): ToolUse[] =>
  Array.isArray(content)
    ? content
        .filter((b): b is Json => isObject(b) && b.type === 'tool_use' && isNonEmptyString(b.id) && isNonEmptyString(b.name))
        .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input }))
    : [];

export const toolResultsOf = (content: unknown): (ToolResult & { toolUseId: string })[] =>
  Array.isArray(content)
    ? content
        .filter((b): b is Json => isObject(b) && b.type === 'tool_result' && isNonEmptyString(b.tool_use_id))
        .map((b) => ({ toolUseId: b.tool_use_id as string, isError: b.is_error === true, content: b.content }))
    : [];

/** A user message that is a prompt (typed, dispatched or injected), not a tool result carrier. */
export const isPrompt = (content: unknown): boolean => typeof content === 'string' || (Array.isArray(content) && toolResultsOf(content).length === 0);

/** The exact dispatched text: a string, or a single text block with that text (CR2 §4 content match). */
export const sameText = (content: unknown, text: string): boolean =>
  content === text || (Array.isArray(content) && content.length === 1 && isObject(content[0]) && content[0].type === 'text' && content[0].text === text);

// ---- tokens and limits ----------------------------------------------------------------------------

const count = (v: unknown): number => Math.max(0, Math.trunc(num(v) ?? 0));

/**
 * Messages API `usage` → TokenCounts. `input` includes cache reads and writes (what the model read);
 * `cachedInput` is the cache-read part.
 */
export const toTokenCounts = (usage: unknown): TokenCounts | undefined => {
  if (!isObject(usage)) return undefined;
  const fresh = count(usage.input_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const thinking = isObject(usage.output_tokens_details) ? num(usage.output_tokens_details.thinking_tokens) : undefined;
  const input = fresh + cacheRead + cacheWrite;
  return { input, cachedInput: cacheRead, output, ...opt('reasoningOutput', thinking === undefined ? undefined : count(thinking)), total: input + output };
};

/**
 * `result.modelUsage` → the session total. It is cumulative across the turns of one query() and per
 * model (main loop and sub-agents), so the models are summed, never the results (R-12).
 */
export const sumModelUsage = (modelUsage: unknown): { counts: TokenCounts; contextWindow?: number } | undefined => {
  if (!isObject(modelUsage)) return undefined;
  const models = Object.values(modelUsage).filter(isObject);
  if (models.length === 0) return undefined;
  let input = 0;
  let cachedInput = 0;
  let output = 0;
  let reasoning = 0;
  let contextWindow: number | undefined;
  for (const m of models) {
    input += count(m.inputTokens) + count(m.cacheReadInputTokens) + count(m.cacheCreationInputTokens);
    cachedInput += count(m.cacheReadInputTokens);
    output += count(m.outputTokens);
    reasoning += count(m.thinkingTokens);
    const window = num(m.contextWindow);
    if (window !== undefined && window > 0) contextWindow = Math.max(contextWindow ?? 0, Math.trunc(window));
  }
  return { counts: { input, cachedInput, output, reasoningOutput: reasoning, total: input + output }, ...opt('contextWindow', contextWindow) };
};

const toWindow = (utilization: unknown, resetsAt: unknown): LimitWindow | undefined => {
  const u = num(utilization);
  if (u === undefined) return undefined;
  const r = num(resetsAt);
  return { percentUsed: Math.min(100, Math.max(0, u * 100)), ...opt('resetsAt', r === undefined ? undefined : isoFromMs(r * 1000)) };
};

/**
 * `rate_limit_event` → plan windows. Recorded events carry `unifiedWindows` (five_hour, seven_day) beside
 * the typed `rateLimitType` + `utilization`; both are read (SP-01).
 */
export const toLimitWindows = (info: unknown): { claude5h?: LimitWindow; claudeWeekly?: LimitWindow } => {
  if (!isObject(info)) return {};
  const out: { claude5h?: LimitWindow; claudeWeekly?: LimitWindow } = {};
  const unified = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
  const five = isObject(unified.five_hour) ? toWindow(unified.five_hour.utilization, unified.five_hour.resetsAt) : undefined;
  const week = isObject(unified.seven_day) ? toWindow(unified.seven_day.utilization, unified.seven_day.resetsAt) : undefined;
  if (five) out.claude5h = five;
  if (week) out.claudeWeekly = week;
  const typed = toWindow(info.utilization, info.resetsAt);
  if (typed && info.rateLimitType === 'five_hour' && !out.claude5h) out.claude5h = typed;
  if (typed && info.rateLimitType === 'seven_day' && !out.claudeWeekly) out.claudeWeekly = typed;
  return out;
};

// ---- models ---------------------------------------------------------------------------------------

/** `supportedModels()` entry → picker option (R-12, HC-02). `default` is the CLI's own default. */
export const toModelOption = (m: WireModelInfo): ModelOption => ({
  runtime: 'claude',
  model: m.value,
  displayName: m.displayName || m.value,
  efforts: (m.supportedEffortLevels ?? []).filter(isNonEmptyString),
  isDefault: m.value === 'default',
  hidden: false,
});

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const toEffort = (effort: string | undefined): (typeof EFFORTS)[number] | undefined => EFFORTS.find((e) => e === effort);

// ---- stored task notifications --------------------------------------------------------------------

const tag = (text: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1]!.trim() : undefined;
};

/**
 * The `<task-notification>` prompt Claude stores when a background sub-agent ends (it is what wakes the
 * session, R-05). Only its tags are read; the surrounding text is not interpreted.
 */
export const parseTaskNotification = (text: string): { taskId: string; toolUseId?: string; status?: string; summary?: string } | undefined => {
  if (!text.includes('<task-notification>')) return undefined;
  const taskId = tag(text, 'task-id');
  if (!taskId) return undefined;
  return { taskId, ...opt('toolUseId', tag(text, 'tool-use-id')), ...opt('status', tag(text, 'status')), ...opt('summary', tag(text, 'summary')) };
};

// Pure conversions from Codex wire shapes to contracts types. No state, no I/O; the adapter decides
// which session / turn / native task a wire object belongs to and passes that in.
import {
  type Attachment,
  ItemId,
  type Message,
  MessageId,
  type MessageOrigin,
  type ModelOption,
  type ModelSelection,
  type NativeTaskId,
  type SessionId,
  type SessionItem,
  type Timestamp,
  type TokenCounts,
  type TokenUsage,
  type Turn,
  TurnId,
} from '../../contracts';
import type { WireItem, WireItemStatus, WireModel, WireTokenUsage, WireTokenUsageBreakdown, WireTurn, WireUserInput } from './protocol';
type CommandItem = Extract<SessionItem, { kind: 'command' }>;
type FileChangeItem = Extract<SessionItem, { kind: 'fileChange' }>;
type ToolCallItem = Extract<SessionItem, { kind: 'toolCall' }>;

/** Adds `key` only when the value is present (exactOptionalPropertyTypes forbids explicit undefined). */
export const opt = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
  (value === undefined || value === null ? {} : { [key]: value }) as { [P in K]?: V };

export const isoFromMs = (ms: number): Timestamp => new Date(ms).toISOString();
export const isoFromSeconds = (s: number): Timestamp => isoFromMs(s * 1000);

/** Where a wire object belongs. Items of a native sub-agent carry its task and no session turn. */
export interface Placement {
  sessionId: SessionId;
  turnId?: string | undefined;
  nativeTaskId?: NativeTaskId | undefined;
}

const placed = (p: Placement) => ({
  sessionId: p.sessionId,
  ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
  ...opt('nativeTaskId', p.nativeTaskId),
});

// ---- tokens ---------------------------------------------------------------------------------------

export const toTokenCounts = (b: WireTokenUsageBreakdown): TokenCounts => ({
  input: b.inputTokens,
  cachedInput: b.cachedInputTokens,
  output: b.outputTokens,
  reasoningOutput: b.reasoningOutputTokens,
  total: b.totalTokens,
});

/** Codex reports `last` (this model call) and `total` (thread so far); the total must never be summed again. */
export const toTokenUsage = (p: Placement, usage: WireTokenUsage, at: Timestamp): TokenUsage => ({
  sessionId: p.sessionId,
  ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
  ...opt('nativeTaskId', p.nativeTaskId),
  latest: toTokenCounts(usage.last),
  cumulative: toTokenCounts(usage.total),
  ...opt('contextWindow', usage.modelContextWindow !== null && usage.modelContextWindow > 0 ? usage.modelContextWindow : undefined),
  at,
});

// ---- turns ----------------------------------------------------------------------------------------

const turnStates = { inProgress: 'running', completed: 'completed', interrupted: 'interrupted', failed: 'failed' } as const;

export const toTurn = (
  sessionId: SessionId,
  turn: WireTurn,
  opts: { now: Timestamp; requestedModel?: ModelSelection | undefined; nativeTaskId?: NativeTaskId | undefined },
): Turn => {
  const state = turnStates[turn.status] ?? 'failed';
  const startedAt = typeof turn.startedAt === 'number' ? isoFromSeconds(turn.startedAt) : opts.now;
  return {
    id: TurnId.parse(turn.id),
    sessionId,
    ...opt('nativeTaskId', opts.nativeTaskId),
    state,
    ...opt('requestedModel', opts.requestedModel),
    ...(state === 'failed' && { failure: { message: turn.error?.message ?? `turn ended with status ${turn.status}` } }),
    startedAt,
    ...(state !== 'running' && { endedAt: typeof turn.completedAt === 'number' ? isoFromSeconds(turn.completedAt) : opts.now }),
  };
};

// ---- messages -------------------------------------------------------------------------------------

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Text parts joined with newlines; images and mentions become attachments. */
export const userContent = (content: WireUserInput[]): { text: string; attachments: Attachment[] } => {
  const texts: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part.type === 'localImage' && typeof part.path === 'string' && part.path !== '') {
      attachments.push({ kind: 'image', path: part.path, name: baseName(part.path) });
    } else if (part.type === 'mention' && typeof part.path === 'string' && part.path !== '') {
      attachments.push({ kind: 'file', path: part.path, name: typeof part.name === 'string' && part.name !== '' ? part.name : baseName(part.path) });
    }
  }
  return { text: texts.join('\n'), attachments };
};

export const toUserMessage = (p: Placement, item: Extract<WireItem, { type: 'userMessage' }>, origin: MessageOrigin, createdAt: Timestamp): Message => {
  const { text, attachments } = userContent(item.content);
  return { id: MessageId.parse(item.id), ...placed(p), role: 'user', origin, text, attachments, createdAt };
};

/** Codex has no per-message model (R-12), so `observedModel` stays empty. */
export const toAgentMessage = (p: Placement, item: Extract<WireItem, { type: 'agentMessage' }>, createdAt: Timestamp): Message => ({
  id: MessageId.parse(item.id),
  ...placed(p),
  role: 'assistant',
  origin: { kind: 'agent' },
  text: item.text,
  attachments: [],
  createdAt,
});

// ---- items ----------------------------------------------------------------------------------------

export interface ItemTimes {
  startedAt: Timestamp;
  /** Set when the item is over; ignored for states that are still open. */
  endedAt?: Timestamp | undefined;
}

export interface CommandOutput {
  output: string;
  truncated: boolean;
}

const commandStates = { inProgress: 'running', completed: 'completed', failed: 'failed', declined: 'declined' } as const;
const fileStates = { inProgress: 'proposed', completed: 'applied', failed: 'failed', declined: 'declined' } as const;
const toolStates = { inProgress: 'running', completed: 'completed', failed: 'failed', declined: 'declined' } as const;

const ended = <S extends string>(state: S, open: S, times: ItemTimes) => ({
  startedAt: times.startedAt,
  ...(state !== open && { endedAt: times.endedAt ?? times.startedAt }),
});

const text = (value: string | null | undefined, fallback: string) => (value === undefined || value === null || value.trim() === '' ? fallback : value);

export const toCommandItem = (
  p: Placement,
  item: Extract<WireItem, { type: 'commandExecution' }>,
  times: ItemTimes,
  output: CommandOutput,
  override?: CommandItem['state'],
): CommandItem => {
  const state = override ?? commandStates[item.status] ?? 'failed';
  return {
    id: ItemId.parse(item.id),
    ...placed(p),
    kind: 'command',
    command: text(item.command, '(unknown command)'),
    cwd: text(item.cwd, '(unknown)'),
    state,
    ...opt('exitCode', typeof item.exitCode === 'number' && Number.isInteger(item.exitCode) ? item.exitCode : undefined),
    ...opt('nativeProcessRef', typeof item.processId === 'string' && item.processId !== '' ? item.processId : undefined),
    output: output.output,
    outputTruncated: output.truncated,
    ...ended<CommandItem['state']>(state, 'running', times),
  };
};

const changeKind = (k: { type: string }): FileChangeItem['changes'][number]['change'] => (k.type === 'add' ? 'add' : k.type === 'delete' ? 'delete' : 'update');

/** Returns undefined for a patch without file entries (the contract needs at least one). */
export const toFileChangeItem = (
  p: Placement,
  item: Extract<WireItem, { type: 'fileChange' }>,
  times: ItemTimes,
  override?: FileChangeItem['state'],
): FileChangeItem | undefined => {
  const changes = (item.changes ?? [])
    .filter((c) => typeof c.path === 'string' && c.path !== '')
    .map((c) => ({
      path: c.path,
      change: changeKind(c.kind),
      ...opt('movePath', c.kind.type === 'update' && 'move_path' in c.kind && c.kind.move_path !== '' ? c.kind.move_path : undefined),
    }));
  if (changes.length === 0) return undefined;
  const state = override ?? fileStates[item.status] ?? 'failed';
  const diff = item.changes.map((c) => c.diff).filter((d) => typeof d === 'string' && d !== '').join('\n');
  return { id: ItemId.parse(item.id), ...placed(p), kind: 'fileChange', changes, state, ...opt('diff', diff === '' ? undefined : diff), ...ended(state, 'proposed', times) };
};

const MAX_SUMMARY = 300;
const clip = (s: string) => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s);

/** MCP / dynamic tool calls and web searches. Other item types are not session items. */
export const toToolCallItem = (p: Placement, item: WireItem, times: ItemTimes, override?: ToolCallItem['state']): ToolCallItem | undefined => {
  let tool: string;
  let server: string | null | undefined;
  let summary: string;
  let status: WireItemStatus;
  switch (item.type) {
    case 'mcpToolCall':
    case 'dynamicToolCall':
      tool = text(item.tool, 'tool');
      server = item.type === 'mcpToolCall' ? item.server : item.namespace;
      summary = clip(JSON.stringify(item.arguments ?? null));
      status = item.status;
      break;
    case 'webSearch':
      tool = 'webSearch';
      summary = clip(typeof item.query === 'string' ? item.query : '');
      // Web search items carry no status; item/completed is what ends them.
      status = times.endedAt === undefined ? 'inProgress' : 'completed';
      break;
    default:
      return undefined;
  }
  const state = override ?? toolStates[status] ?? 'failed';
  return {
    id: ItemId.parse(item.id),
    ...placed(p),
    kind: 'toolCall',
    tool,
    ...opt('server', server === '' ? undefined : server),
    summary,
    state,
    ...ended(state, 'running', times),
  };
};

/** The open state an item ends in when its turn ends without closing it (SP-08: interrupt leaves commands open). */
export const closeOpenItem = (item: SessionItem, turnState: Turn['state']): SessionItem['state'] | undefined => {
  switch (item.kind) {
    case 'command':
      return item.state === 'running' ? (turnState === 'interrupted' ? 'interrupted' : 'failed') : undefined;
    case 'toolCall':
      return item.state === 'running' ? 'failed' : undefined;
    case 'fileChange':
      return item.state === 'proposed' ? 'failed' : undefined;
  }
};

// ---- models ---------------------------------------------------------------------------------------

export const toModelOption = (m: WireModel): ModelOption => ({
  runtime: 'codex',
  model: m.model || m.id,
  displayName: m.displayName || m.model || m.id,
  efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e): e is string => typeof e === 'string' && e !== ''),
  ...opt('defaultEffort', m.defaultReasoningEffort === '' ? undefined : m.defaultReasoningEffort),
  isDefault: m.isDefault === true,
  hidden: m.hidden === true,
});

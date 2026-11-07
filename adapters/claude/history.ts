// Stored transcript → contracts history (R-13, CR-6). Read-only and pure: the adapter fetches the
// messages with getSessionMessages / getSubagentMessages and passes them in.
//
// The transcript has no turn records, so turns are rebuilt: every prompt (typed, dispatched or a
// background-agent notification) starts one, identified by that prompt's uuid. A turn is `completed`
// unless the transcript shows it was interrupted; failures are not stored, so they cannot be told apart.
import {
  type Message,
  MessageId,
  type MessageOrigin,
  type NativeTask,
  NativeTaskId,
  type SessionId,
  type SessionItem,
  type Timestamp,
  type Turn,
  TurnId,
} from '../../contracts';
import type { HistoryEntry } from '../../core/ports';
import {
  AGENT_TOOLS,
  closeOpenItem,
  finishItem,
  isNonEmptyString,
  isObject,
  isPrompt,
  type Json,
  opt,
  parseTaskNotification,
  type Placement,
  placed,
  startItem,
  str,
  textOf,
  toolResultsOf,
  toolResultText,
  toolUsesOf,
} from './mapping';
import type { WireSessionMessage, WireTranscriptEntry } from './wire';

/** Text the CLI stores when the user interrupts a turn or a tool call. */
export const INTERRUPT_MARKER = '[Request interrupted by user';

/**
 * The role of a prompt the GUI sent, by its origin (contracts `message.origin-role`): the GUI's own notice (C-31) is a
 * `system` message, everything else a `user` one (T065: a notice as a user message could not be stored).
 */
export const promptRole = (origin: MessageOrigin): 'user' | 'system' => (origin.kind === 'system' ? 'system' : 'user');
/** The CLI's error result for a call the PreToolUse hook denied or did not answer in time. */
const HOOK_REFUSAL = /^PreToolUse(:\S+)? hook (error|did not respond)/;
/** Output of CLI-local commands (e.g. the model switch of setModel) is stored as user text but is no prompt. */
const LOCAL_COMMAND = /^<(local-command-stdout|local-command-stderr|local-command-caveat|command-name)>/;

export interface TranscriptContext {
  sessionId: SessionId;
  cwd: string;
  /** Set when reading a native sub-agent's own transcript: entries carry it and no session turns. */
  nativeTaskId?: NativeTaskId;
  /** Origin of a stored user prompt (peer / handoff are known only to the layer above, by uuid). */
  userOrigin: (uuid: string) => MessageOrigin;
  maxOutputChars: number;
  /** Used only when a stored entry has no timestamp. */
  fallbackTime: Timestamp;
}

export interface MappedTranscript {
  entries: HistoryEntry[];
  /** Agent calls and their results, for rebuilding native tasks. */
  agentCalls: Map<string, AgentCall>;
  /** `<task-notification>` prompts by task_id. */
  notifications: Map<string, { status?: string; summary?: string; toolUseId?: string; at: Timestamp }>;
  /** Something could not be represented (compacted history, unreadable entries). */
  complete: boolean;
}

interface AgentCall {
  toolUseId: string;
  label: string;
  agentType?: string;
  background: boolean;
  startedAt: Timestamp;
  result?: { isError: boolean; text: string; at: Timestamp };
}

const messageOf = (m: WireSessionMessage): Json | undefined => (isObject(m.message) ? m.message : undefined);

// ---- turn rules -----------------------------------------------------------------------------------
// Shared by readHistory (the SDK's chain view) and reconcile (raw lines), so both put a prompt in the
// same turn. A turn is finished only on evidence: a final assistant message (stop_reason other than
// tool_use) or the stored interrupt prompt. Without it the turn may still be running or was cut off.

/** How a stored turn is known to have ended. */
type TurnEnd = { state: 'completed' } | { state: 'interrupted' } | { state: 'failed'; failure: string };

/**
 * The end an assistant message shows: a TurnEnd, `undefined` when the turn goes on (tool_use), or
 * `'none'` when the message says nothing. `<synthetic>` is the CLI's own message for an API error (R-12).
 */
const endOf = (message: Json): TurnEnd | undefined | 'none' => {
  const stop = str(message.stop_reason);
  if (!isNonEmptyString(stop)) return 'none';
  if (stop === 'tool_use') return undefined;
  return str(message.model) === '<synthetic>' ? { state: 'failed', failure: textOf(message.content) || 'API error' } : { state: 'completed' };
};

/** A prompt taken in while a turn ran joins that turn (as live, where it is folded in); any other starts one. */
const joinsOpenTurn = (queued: boolean, open: { end?: TurnEnd | undefined } | undefined): boolean => queued && open !== undefined && open.end === undefined;

/** User text that is not a prompt of its own: the stored interrupt notice, or CLI-local command output. */
const notAPrompt = (text: string): 'interrupt' | 'local' | undefined => (text.startsWith(INTERRUPT_MARKER) ? 'interrupt' : LOCAL_COMMAND.test(text) ? 'local' : undefined);

export const mapTranscript = (messages: readonly WireSessionMessage[], ctx: TranscriptContext): MappedTranscript => {
  const entries: HistoryEntry[] = [];
  const agentCalls = new Map<string, AgentCall>();
  const notifications: MappedTranscript['notifications'] = new Map();
  // Open tool calls with the turn they belong to: a turn closes only its own calls (review r2 P2).
  const items = new Map<string, { item: SessionItem; index: number; turnId: string | undefined }>();
  let complete = true;
  let lastTime = ctx.fallbackTime;

  // Session turns (main transcript only). A turn without an end stays running and the history is
  // marked incomplete; its open calls stay open too.
  let turn: { id: string; index: number; startedAt: Timestamp; lastAt: Timestamp; end?: TurnEnd | undefined } | undefined;
  const closeTurn = () => {
    if (!turn) return;
    const { end } = turn;
    if (!end) {
      complete = false;
      turn = undefined;
      return;
    }
    const entry: Turn = {
      id: TurnId.parse(turn.id),
      sessionId: ctx.sessionId,
      state: end.state,
      ...(end.state === 'failed' && { failure: { message: end.failure } }),
      startedAt: turn.startedAt,
      endedAt: turn.lastAt,
    };
    entries[turn.index] = { kind: 'turn', turn: entry };
    for (const [id, open] of items) {
      if (open.turnId !== turn.id) continue;
      const closed = closeOpenItem(open.item, end.state === 'interrupted' ? 'interrupted' : 'failed', turn.lastAt);
      if (closed) entries[open.index] = { kind: 'item', item: closed };
      items.delete(id);
    }
    turn = undefined;
  };
  const placement = (): Placement =>
    ctx.nativeTaskId !== undefined ? { sessionId: ctx.sessionId, nativeTaskId: ctx.nativeTaskId } : { sessionId: ctx.sessionId, turnId: turn?.id };

  // Assistant frames of one API message arrive as several entries; their text is merged.
  let open: { id: string; index: number; message: Message } | undefined;

  for (const m of messages) {
    // Compaction replaced the earlier conversation with this summary: the history is no longer whole.
    // (The boundary line itself reaches here without its `subtype`; the adapter also scans raw lines.)
    if (m.isCompactSummary === true) {
      complete = false;
      continue;
    }
    const inner = messageOf(m);
    if (!inner || !isNonEmptyString(m.uuid)) {
      if (m.type !== 'system') complete = false;
      continue;
    }
    const at: Timestamp = isNonEmptyString(m.timestamp) && !Number.isNaN(Date.parse(m.timestamp)) ? new Date(m.timestamp).toISOString() : lastTime;
    lastTime = at;
    if (turn) turn.lastAt = at;

    if (m.type === 'user') {
      const content = inner.content;
      const text = textOf(content);
      if (isPrompt(content)) {
        open = undefined;
        const skip = notAPrompt(text);
        if (skip === 'interrupt' && turn) turn.end = { state: 'interrupted' };
        if (skip) continue;
        const notice = parseTaskNotification(text);
        if (ctx.nativeTaskId === undefined && !joinsOpenTurn(m.isQueuedCommand === true, turn)) {
          closeTurn();
          turn = { id: m.uuid, index: entries.length, startedAt: at, lastAt: at };
          entries.push({ kind: 'turn', turn: { id: TurnId.parse(m.uuid), sessionId: ctx.sessionId, state: 'running', startedAt: at } });
        }
        if (notice) {
          notifications.set(notice.taskId, { ...opt('status', notice.status), ...opt('summary', notice.summary), ...opt('toolUseId', notice.toolUseId), at });
          const message: Message = {
            id: MessageId.parse(m.uuid),
            ...placed(placement()),
            role: 'system',
            origin: { kind: 'system' },
            text: notice.summary ?? `background agent ${notice.taskId} ${notice.status ?? 'reported'}`,
            attachments: [],
            createdAt: at,
          };
          entries.push({ kind: 'message', message });
          continue;
        }
        // A sub-agent's prompt is written by its parent agent; contracts have no agent origin for the user
        // role, so it is kept as the task's user-role message.
        const origin: MessageOrigin = ctx.nativeTaskId !== undefined ? { kind: 'user' } : ctx.userOrigin(m.uuid);
        const message: Message = {
          id: MessageId.parse(m.uuid),
          ...placed(placement()),
          role: promptRole(origin),
          origin,
          text,
          attachments: [],
          createdAt: at,
        };
        entries.push({ kind: 'message', message });
        continue;
      }
      for (const result of toolResultsOf(content)) {
        // An interrupted tool call (e.g. one stopped sub-agent) does not end the turn; only the stored
        // interrupt prompt above does.
        const text = toolResultText(result.content);
        const call = agentCalls.get(result.toolUseId);
        if (call && !call.result) call.result = { isError: result.isError, text, at };
        const tracked = items.get(result.toolUseId);
        if (!tracked) continue;
        const finished = finishItem(tracked.item, result, {
          endedAt: at,
          declined: result.isError && HOOK_REFUSAL.test(text),
          interrupted: text.startsWith(INTERRUPT_MARKER),
          maxOutputChars: ctx.maxOutputChars,
        });
        entries[tracked.index] = { kind: 'item', item: finished };
        items.delete(result.toolUseId);
      }
      continue;
    }

    if (m.type === 'assistant') {
      const content = inner.content;
      const messageId = isNonEmptyString(inner.id) ? inner.id : m.uuid;
      const text = textOf(content);
      const model = str(inner.model);
      // Every stored block of an API message carries its final stop_reason.
      const end = endOf(inner);
      if (turn && ctx.nativeTaskId === undefined && end !== 'none') turn.end = end;
      if (text !== '') {
        if (open?.id === messageId) {
          open.message = { ...open.message, text: open.message.text + text };
          entries[open.index] = { kind: 'message', message: open.message };
        } else {
          const message: Message = {
            id: MessageId.parse(messageId),
            ...placed(placement()),
            role: 'assistant',
            origin: { kind: 'agent' },
            text,
            attachments: [],
            ...opt('observedModel', isNonEmptyString(model) ? model : undefined),
            createdAt: at,
          };
          open = { id: messageId, index: entries.length, message };
          entries.push({ kind: 'message', message });
        }
      } else if (open?.id !== messageId) {
        open = undefined;
      }
      for (const use of toolUsesOf(content)) {
        if (AGENT_TOOLS.includes(use.name) && ctx.nativeTaskId === undefined) {
          const input = isObject(use.input) ? use.input : {};
          agentCalls.set(use.id, {
            toolUseId: use.id,
            label: str(input.description) ?? use.name,
            ...opt('agentType', str(input.subagent_type)),
            background: input.run_in_background === true,
            startedAt: at,
          });
        }
        const item = startItem(placement(), use, ctx.cwd, at);
        if (!item) continue;
        items.set(use.id, { item, index: entries.length, turnId: turn?.id });
        entries.push({ kind: 'item', item });
      }
    }
  }
  closeTurn();
  return { entries, agentCalls, notifications, complete };
};

const TASK_STATES: Record<string, NativeTask['state']> = { completed: 'completed', failed: 'failed', stopped: 'stopped', killed: 'stopped' };

/**
 * Native tasks of a stored session. `agentIds` is `listSubagents()`; `parentOf` maps each to the Agent
 * call that spawned it (its transcript's `parent_tool_use_id`). A task without an end in the transcript
 * stays `running`: the transcript cannot say whether it was cut off.
 */
export const rebuildNativeTasks = (
  mapped: Pick<MappedTranscript, 'agentCalls' | 'notifications'>,
  agents: { agentId: string; parentToolUseId?: string }[],
  sessionId: SessionId,
): { tasks: NativeTask[]; unlinked: number } => {
  const tasks: NativeTask[] = [];
  let unlinked = 0;
  for (const { agentId, parentToolUseId } of agents) {
    const notice = mapped.notifications.get(agentId);
    const toolUseId = parentToolUseId ?? notice?.toolUseId;
    const call = toolUseId === undefined ? undefined : mapped.agentCalls.get(toolUseId);
    if (!call || toolUseId === undefined) {
      unlinked++;
      continue;
    }
    let state: NativeTask['state'] = 'running';
    let endedAt: Timestamp | undefined;
    let summary: string | undefined;
    if (notice?.status !== undefined && TASK_STATES[notice.status]) {
      state = TASK_STATES[notice.status]!;
      endedAt = notice.at;
      summary = notice.summary;
    } else if (call.result && !(call.background && !call.result.isError)) {
      state = !call.result.isError ? 'completed' : call.result.text.startsWith(INTERRUPT_MARKER) ? 'stopped' : 'failed';
      endedAt = call.result.at;
    }
    tasks.push({
      id: NativeTaskId.parse(agentId),
      sessionId,
      runtime: 'claude',
      parentRef: toolUseId,
      nativeRef: agentId,
      label: call.label,
      ...opt('agentType', call.agentType),
      state,
      background: call.background,
      ...opt('summary', summary),
      startedAt: call.startedAt,
      ...opt('endedAt', state === 'running' ? undefined : endedAt),
    });
  }
  return { tasks, unlinked };
};

export interface PayloadRecord {
  /** The turn it entered, by the turn rules above. */
  turnRef: string;
  itemRef: string;
  sessionId: string | undefined;
  content: unknown;
}

/**
 * Every stored record of a dispatched payload, from the raw transcript lines (CR2_DELIVERY_FIX §4): a
 * line with this uuid, or a queued-command attachment carrying it as `source_uuid` (a payload taken in
 * while a turn ran; live-checked, T009). Raw lines are not deduplicated, so a payload stored twice is
 * seen twice; compaction leaves earlier lines in the file, so it does not hide them. Turns follow the
 * same rules as mapTranscript; the adapter prefers mapTranscript's own answer when the chain has it.
 */
export const payloadRecords = (lines: readonly WireTranscriptEntry[], uuid: string): PayloadRecord[] => {
  const out: PayloadRecord[] = [];
  let open: { id: string; end?: TurnEnd | undefined } | undefined;
  const record = (itemRef: string, e: WireTranscriptEntry, content: unknown) => out.push({ turnRef: open?.id ?? itemRef, itemRef, sessionId: str(e.sessionId), content });
  for (const e of lines) {
    if (e.isSidechain === true) continue;
    if (e.type === 'assistant' && isObject(e.message)) {
      const end = endOf(e.message);
      if (open && end !== 'none') open.end = end;
    } else if (e.type === 'user' && isNonEmptyString(e.uuid) && isObject(e.message)) {
      const content = e.message.content;
      const skip = notAPrompt(textOf(content));
      if (skip === 'interrupt' && open) open.end = { state: 'interrupted' };
      // The SDK's chain view leaves out meta lines (except those with an origin, like task notifications)
      // and shows the compaction summary as no prompt; mapTranscript then sees no turn start either.
      const startsTurn = isPrompt(content) && !skip && e.isCompactSummary !== true && (e.isMeta !== true || isObject(e.origin));
      if (startsTurn) open = { id: e.uuid };
      if (e.uuid === uuid) record(e.uuid, e, content);
    } else if (e.type === 'attachment' && isObject(e.attachment) && e.attachment.type === 'queued_command' && isNonEmptyString(e.attachment.source_uuid)) {
      const source = e.attachment.source_uuid;
      if (!joinsOpenTurn(true, open)) open = { id: source };
      if (source === uuid) record(uuid, e, e.attachment.prompt);
    }
  }
  return out;
};

/** The turn mapTranscript put a message in. */
export const turnOfMessage = (entries: readonly HistoryEntry[], messageId: string): string | undefined => {
  for (const e of entries) if (e.kind === 'message' && e.message.id === messageId) return e.message.turnId;
  return undefined;
};

/** A compaction boundary line: the conversation before it was replaced by a summary. */
export const isCompacted = (lines: readonly WireTranscriptEntry[]): boolean => lines.some((e) => e.type === 'system' && e.subtype === 'compact_boundary');

/** The folder the session ran in: the `cwd` its first conversation line recorded. */
export const recordedCwd = (lines: readonly WireTranscriptEntry[]): string | undefined => {
  const first = lines.find((e) => (e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true && isNonEmptyString(e.cwd));
  return first ? str(first.cwd) : undefined;
};


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
import type { WireSessionMessage } from './wire';

/** Text the CLI stores when the user interrupts a turn or a tool call. */
export const INTERRUPT_MARKER = '[Request interrupted by user';
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

/** Compaction replaces earlier turns with a summary, so the history is no longer whole. */
const isCompactBoundary = (m: WireSessionMessage): boolean => {
  const inner = messageOf(m);
  return m.type === 'system' && (inner?.subtype === 'compact_boundary' || (m as unknown as Json).subtype === 'compact_boundary');
};

export const mapTranscript = (messages: readonly WireSessionMessage[], ctx: TranscriptContext): MappedTranscript => {
  const entries: HistoryEntry[] = [];
  const agentCalls = new Map<string, AgentCall>();
  const notifications: MappedTranscript['notifications'] = new Map();
  const items = new Map<string, { item: SessionItem; index: number }>();
  let complete = true;
  let lastTime = ctx.fallbackTime;

  // Session turns (main transcript only).
  let turn: { id: string; index: number; startedAt: Timestamp; interrupted: boolean; lastAt: Timestamp } | undefined;
  const closeTurn = () => {
    if (!turn) return;
    const entry: Turn = {
      id: TurnId.parse(turn.id),
      sessionId: ctx.sessionId,
      state: turn.interrupted ? 'interrupted' : 'completed',
      startedAt: turn.startedAt,
      endedAt: turn.lastAt,
    };
    entries[turn.index] = { kind: 'turn', turn: entry };
    for (const [id, open] of items) {
      const closed = closeOpenItem(open.item, turn.interrupted ? 'interrupted' : 'failed', turn.lastAt);
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
    if (isCompactBoundary(m)) {
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
        if (text.startsWith(INTERRUPT_MARKER)) {
          if (turn) turn.interrupted = true;
          continue;
        }
        if (LOCAL_COMMAND.test(text)) continue;
        const notice = parseTaskNotification(text);
        if (ctx.nativeTaskId === undefined) {
          closeTurn();
          turn = { id: m.uuid, index: entries.length, startedAt: at, interrupted: false, lastAt: at };
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
        const message: Message = {
          id: MessageId.parse(m.uuid),
          ...placed(placement()),
          role: 'user',
          origin: ctx.nativeTaskId !== undefined ? { kind: 'user' } : ctx.userOrigin(m.uuid),
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
        items.set(use.id, { item, index: entries.length });
        entries.push({ kind: 'item', item });
      }
    }
  }
  // The last turn may still be running in a live session; it is closed only when the transcript says so.
  if (turn?.interrupted) closeTurn();
  else if (turn) {
    const last = turn;
    entries[last.index] = {
      kind: 'turn',
      turn: { id: TurnId.parse(last.id), sessionId: ctx.sessionId, state: 'completed', startedAt: last.startedAt, endedAt: last.lastAt },
    };
  }
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

export interface StoredUserMessage {
  uuid: string;
  sessionId: string;
  turnId: string;
  content: unknown;
}

/** Stored prompts with the turn each belongs to, for reconciliation (CR2_DELIVERY_FIX §4). */
export const storedPrompts = (messages: readonly WireSessionMessage[]): StoredUserMessage[] => {
  const out: StoredUserMessage[] = [];
  for (const m of messages) {
    const inner = messageOf(m);
    if (m.type !== 'user' || !inner || !isNonEmptyString(m.uuid) || !isPrompt(inner.content)) continue;
    const text = textOf(inner.content);
    if (text.startsWith(INTERRUPT_MARKER) || LOCAL_COMMAND.test(text)) continue;
    // Every prompt starts its own turn in the rebuilt history (see mapTranscript).
    out.push({ uuid: m.uuid, sessionId: m.session_id, turnId: m.uuid, content: inner.content });
  }
  return out;
};


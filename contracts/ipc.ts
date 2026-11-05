// IPC commands (renderer -> main), results, and events (main -> renderer). DATA_RUNTIME §7.
// Every command carries a requestId and explicit target IDs; the renderer's current selection is
// never used to decide where a command goes (HC-05). Commands that create something carry the new
// entity's ID, chosen by the renderer, so the caller can tell its own result apart from others'.
import { z } from 'zod';
import { AgentDefinition, ModelOption, ModelSelection, ObservedModel } from './agent';
import {
  AgentId,
  BackupId,
  EscalationId,
  HistoryCursor,
  InstanceId,
  ItemId,
  MessageId,
  NativeTaskId,
  ProjectId,
  RequestId,
  Revision,
  Runtime,
  SchemaVersion,
  SessionId,
  TaskId,
  Timestamp,
  TransferId,
  TurnId,
  WorkflowId,
} from './common';
import { PermissionRequest, SessionItem } from './items';
import { FileLock } from './locks';
import { ProjectSettings } from './project';
import { addRuleIssue, ruleIssue } from './rules';
import { RuntimeStatus } from './runtimes';
import { BackupInfo, ReadOnlyReason, StorageInfo } from './storage';
import { Artifact, Attachment, LogicalSession, Message, NativeTask, PeerMessage, SessionActivity, TokenUsage, Turn } from './session';
import { TransferProposal, UiPreferences } from './transfer';
import { Escalation, Handoff, WorkflowInstance, WorkflowTemplate } from './workflow';

const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), requestId: RequestId, ...shape });

export const Command = z.discriminatedUnion('type', [
  /**
   * No `agentId`: a session without an Agent (U-01). No `cwd`: the main process makes a new `YYYY-MM-DD-NNN` folder in
   * the default work folder location (U-02, T048), once per session ID, also when the command is sent again.
   */
  cmd('session.create', {
    sessionId: SessionId,
    kind: z.literal('ordinary'),
    agentId: AgentId.optional(),
    model: ModelSelection,
    cwd: z.string().min(1).optional(),
    parentId: SessionId.optional(),
  }),
  cmd('session.send', { sessionId: SessionId, messageId: MessageId, expectedRevision: Revision, text: z.string().min(1), attachments: z.array(Attachment).default([]) }),
  cmd('session.interrupt', { sessionId: SessionId }),
  /** Same-runtime model change only; changing runtime goes through transfer (R-02, R-12). */
  cmd('session.setModel', { sessionId: SessionId, expectedRevision: Revision, model: ModelSelection }),
  /** Rejected for workflow sessions (WB-02). `null` leaves an ordinary session without an Agent (T048). */
  cmd('session.setAgent', { sessionId: SessionId, expectedRevision: Revision, agentId: AgentId.nullable() }),
  /**
   * The title the user gives (T048); trimmed, 1 to SESSION_TITLE_MAX_LENGTH characters. The first message no longer renames
   * it. A repeat that finds the title already given changes nothing and succeeds (CR-2, 0.9).
   */
  cmd('session.rename', { sessionId: SessionId, expectedRevision: Revision, title: z.string() }),
  /** Refused with reason `archived` when the session's tree or the new parent's tree is archived (U4, 0.10). */
  cmd('session.reparent', { sessionId: SessionId, expectedRevision: Revision, parentId: SessionId.nullable() }),
  /**
   * Archives a conversation (U4, 0.10): the top session of an ordinary tree, with every session below it; only a mark
   * (`archivedAt` on that session), nothing is deleted, stopped or moved. `expectedRevision` is the top session's. Refused
   * (CommandResult `reason`) for a session below another (`not-top-level`), a workflow session (`workflow-session`: archive
   * its run), while a turn of the tree runs (`turn-running`) or an escalation of it is open (`escalation-open`). Its
   * sessions leave the pinned list (`preferences.updated`). A repeat that finds it archived changes nothing and succeeds
   * (CR-2). Announced with `session.updated`. `session.send` to a session of an archived tree unarchives it in the same
   * command.
   */
  cmd('session.archive', { sessionId: SessionId, expectedRevision: Revision }),
  /** Unarchives a conversation (U4, 0.10); its sessions are not pinned again. A repeat that finds it not archived succeeds. */
  cmd('session.unarchive', { sessionId: SessionId, expectedRevision: Revision }),
  cmd('nativeTask.stop', { sessionId: SessionId, nativeTaskId: NativeTaskId }),
  cmd('agent.save', { agent: AgentDefinition, expectedRevision: Revision.nullable() }),
  /** Rejected with `invalid_transition` while a workflow template or a session uses the Agent (C-01). */
  cmd('agent.delete', { agentId: AgentId, expectedRevision: Revision }),
  cmd('workflow.save', { workflow: WorkflowTemplate, expectedRevision: Revision.nullable() }),
  /**
   * Deletes a template (T063, 0.11). Refused with reason `template-in-use` while a run that is not completed or cancelled
   * uses it, or while a `workflow.start` of it is under way. Ended runs keep their own copy of the template
   * (`instance.template`) and still open. A repeat that finds it gone gets `not_found`. The views read the Snapshot again.
   */
  cmd('workflow.delete', { workflowId: WorkflowId, expectedRevision: Revision }),
  /**
   * Adds the starter set (T063, 0.11): the three Agents of STARTER_AGENT_IDS and the template STARTER_WORKFLOW_ID
   * 「規劃 → 實作 → 審查」. What already exists under those IDs is kept as it is (an edited Agent is not overwritten), so a
   * repeat adds nothing. The result's `revision` is the template's.
   */
  cmd('workflow.addStarter', {}),
  cmd('workflow.start', {
    instanceId: InstanceId,
    rootSessionId: SessionId,
    workflowId: WorkflowId,
    workflowRevision: Revision,
    title: z.string().min(1),
    /**
     * Where the run's reports and plans go and root works (Q-4, T048). Absent: a new `YYYY-MM-DD-NNN` folder in the
     * default location, made once per run, also when the command is sent again.
     */
    workFolder: z.string().min(1).optional(),
    /**
     * The repository whose code the run changes (Q-8): task worktrees are made from it. Required with worktree
     * isolation; in a same-folder run the non-root nodes work in it directly. Absent: they work in the work folder.
     */
    projectFolder: z.string().min(1).optional(),
    firstMessage: z.string().min(1),
    crossToolConsent: z.boolean(),
  }),
  /** `content`: the user's form answers when approving an MCP elicitation (becomes `PermissionDecision.content`). */
  cmd('escalation.respond', { escalationId: EscalationId, decision: z.enum(['approve', 'decline']), note: z.string().optional(), content: z.json().optional() }).refine(
    (c) => c.content === undefined || c.decision === 'approve',
    ruleIssue('escalation-respond.content-only-on-approve'),
  ),
  /**
   * The user's decision on a delivery whose outcome stayed unknown (CR2_DELIVERY_FIX §2). A retry may
   * deliver twice, so the user must acknowledge that explicitly.
   */
  cmd('delivery.resolve', { escalationId: EscalationId, decision: z.enum(['wait', 'cancel', 'retry']), acceptDuplicateRisk: z.boolean() }).refine(
    (c) => c.decision !== 'retry' || c.acceptDuplicateRisk,
    ruleIssue('delivery-resolve.retry-needs-risk-ack'),
  ),
  /**
   * The user ends a run (C-22; D-17: the user, not an agent, decides the work is done). `complete` marks every
   * task not yet final `completed`; `cancel` marks them `cancelled`. Both stop further handoffs and are
   * refused with `invalid_transition` while a merge is active or a delivery's outcome is unknown.
   */
  cmd('workflow.complete', { instanceId: InstanceId, expectedRevision: Revision }),
  /**
   * Renames a run (U2, 0.9): trimmed, 1 to SESSION_TITLE_MAX_LENGTH characters, as session.rename; in any state, ended
   * runs too. A repeat that finds the title already given changes nothing and succeeds (CR-2). Only the run's title: its
   * sessions and tasks keep theirs. Announced with `instance.updated`.
   */
  cmd('workflow.rename', { instanceId: InstanceId, expectedRevision: Revision, title: z.string() }),
  cmd('workflow.cancel', { instanceId: InstanceId, expectedRevision: Revision }),
  /**
   * Archives a run (U4, 0.10), as session.archive does a conversation: only an ended run (`run-not-ended`), not while a
   * turn of its sessions runs or an escalation of it is open. The run and its node sessions leave the pinned list.
   * Announced with `instance.updated`. `session.send` to one of its sessions unarchives it in the same command.
   */
  cmd('workflow.archive', { instanceId: InstanceId, expectedRevision: Revision }),
  /** Unarchives a run (U4, 0.10); nothing is pinned again. A repeat that finds it not archived succeeds. */
  cmd('workflow.unarchive', { instanceId: InstanceId, expectedRevision: Revision }),
  /** Retry removing a task's or a merge attempt's worktree recorded as `pending-cleanup` (SP-07). */
  cmd('task.retryCleanup', { instanceId: InstanceId, taskId: TaskId }),
  cmd('project.save', { project: ProjectSettings, expectedRevision: Revision.nullable() }),
  cmd('transfer.prepare', { transferId: TransferId, sourceSessionId: SessionId, target: ModelSelection, noteSource: z.enum(['agent', 'gui-digest']) }),
  cmd('transfer.confirm', { transferId: TransferId, expectedRevision: Revision }),
  cmd('transfer.cancel', { transferId: TransferId }),
  cmd('preferences.set', { preferences: UiPreferences }),
  /**
   * Restores a listed backup at the next start (C-28): only an ID from `backup.list`, never a path. The data in
   * use is backed up first (`pre-restore`); a backup that fails its checks then is not applied (StorageInfo).
   * Accepted in `read-only` too, so a full disk or a failed migration can be recovered from.
   */
  cmd('backup.restore', { backupId: BackupId }),
  /** Withdraws the pending restore before the next start. */
  cmd('backup.cancelRestore', {}),
  /**
   * Looks for the runtime again (C-33), or for both when `runtime` is absent: after the user installed, updated or
   * signed in. The result comes as `runtime.status`; nothing is installed or signed in by the GUI.
   */
  cmd('runtime.detect', { runtime: Runtime.optional() }),
]);
export type Command = z.infer<typeof Command>;

/** Error codes the renderer can act on; it must not parse message text (DATA_RUNTIME §7). */
export const ErrorCode = z.enum([
  'unsupported',
  'stale_revision',
  'permission_denied',
  'runtime_unavailable',
  'invalid_transition',
  'unknown_outcome',
  'storage_failed',
  'storage_read_only', // the data can be read but not written now (AppStatus `read-only`, C-29)
  'not_found',
  'already_exists', // a create command reused an existing ID
  'invalid_request',
  'usage_limit', // a RULES.md threshold stopped the action
  'internal_error', // the main process failed or produced a result outside the contracts (C-02)
]);

/**
 * Why a command was refused, when its code alone does not say (U4, 0.10), so the renderer can explain it without reading
 * the message. Every value and the code it comes with:
 * - `not-top-level` (`invalid_request`): the session sits below another; only the top session of a tree is archived.
 * - `workflow-session` (`invalid_request`): a workflow session; its run is archived instead (`workflow.archive`).
 * - `turn-running` (`invalid_transition`, retryable): a turn of a session of the tree or run is running (or waits for the
 *   user, a file lock or a delivery's outcome), or a transfer of one of its sessions is under way.
 * - `escalation-open` (`invalid_transition`): an escalation of the tree or run is still open, or a transfer of one of its
 *   sessions waits for the user's confirmation.
 * - `run-not-ended` (`invalid_transition`): the run is not completed or cancelled.
 * - `archived` (`invalid_transition`): the session (or the new parent of `session.reparent`, the parent of
 *   `session.create`, the source of `transfer.prepare`) is in an archived tree; unarchive it first.
 * - `template-in-use` (`invalid_transition`, T063, 0.11): `workflow.delete` of a template that a run not completed or
 *   cancelled uses (not retryable: end the run first), or while a `workflow.start` of it is under way (retryable).
 */
export const CommandRefusal = z.enum(['not-top-level', 'workflow-session', 'turn-running', 'escalation-open', 'run-not-ended', 'archived', 'template-in-use']);
export type CommandRefusal = z.infer<typeof CommandRefusal>;

/** Receipt of what a command created; the IDs are the ones the command carried. */
export const CreatedRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: SessionId }),
  z.strictObject({ kind: z.literal('message'), id: MessageId }),
  z.strictObject({ kind: z.literal('instance'), id: InstanceId }),
  z.strictObject({ kind: z.literal('transfer'), id: TransferId }),
]);

export const CommandResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), requestId: RequestId, revision: Revision.optional(), created: z.array(CreatedRef).default([]) }),
  z.strictObject({
    ok: z.literal(false),
    /** `null` only when the command could not be parsed far enough to read its requestId (C-02). */
    requestId: RequestId.nullable(),
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    /** True when a side effect may already have happened (do not blindly retry). */
    mayHaveSideEffects: z.boolean(),
    /** Why, when the code alone does not say (CommandRefusal, 0.10); absent otherwise and on results before 0.10. */
    reason: CommandRefusal.optional(),
  }),
]);
export type CommandResult = z.infer<typeof CommandResult>;

/** One plan-limit window (RULES.md §2). */
export const LimitWindow = z.strictObject({ percentUsed: z.number().min(0).max(100), resetsAt: Timestamp.optional() });

/** Push events. Each carries the target ID it belongs to; views filter by it (HC-05). */
export const AppEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session.updated'), session: LogicalSession }),
  /**
   * `cause` tells why a runtime was closed (C-30, T036 G-3): `idle` after the idle time, `process-limit` to stay
   * within `maxOpenRuntimes`. Only with `closed`; absent for other closes (exit, crash handling).
   */
  z
    .strictObject({
      type: z.literal('session.activity'),
      sessionId: SessionId,
      activity: SessionActivity,
      cause: z.enum(['idle', 'process-limit']).optional(),
      at: Timestamp,
    })
    .refine((e) => e.cause === undefined || e.activity === 'closed', ruleIssue('activity.cause-only-closed')),
  z.strictObject({ type: z.literal('turn.updated'), turn: Turn }),
  z.strictObject({
    type: z.literal('message.delta'),
    sessionId: SessionId,
    turnId: TurnId.optional(),
    nativeTaskId: NativeTaskId.optional(),
    messageId: MessageId,
    delta: z.string(),
  }),
  z.strictObject({ type: z.literal('message.completed'), message: Message }),
  z.strictObject({ type: z.literal('item.updated'), item: SessionItem }),
  z.strictObject({ type: z.literal('item.outputDelta'), sessionId: SessionId, itemId: ItemId, delta: z.string() }),
  z.strictObject({ type: z.literal('permission.updated'), request: PermissionRequest }),
  z.strictObject({ type: z.literal('nativeTask.updated'), task: NativeTask }),
  z.strictObject({ type: z.literal('artifact.updated'), artifact: Artifact }),
  z.strictObject({ type: z.literal('instance.updated'), instance: WorkflowInstance }),
  z.strictObject({ type: z.literal('handoff.updated'), handoff: Handoff }),
  z.strictObject({ type: z.literal('peerMessage.updated'), message: PeerMessage }),
  z.strictObject({ type: z.literal('escalation.updated'), escalation: Escalation }),
  z.strictObject({ type: z.literal('transfer.updated'), proposal: TransferProposal }),
  z.strictObject({ type: z.literal('usage.tokens'), usage: TokenUsage }),
  z.strictObject({
    type: z.literal('usage.limits'),
    claude5h: LimitWindow.optional(),
    claudeWeekly: LimitWindow.optional(),
    codexWeekly: LimitWindow.optional(),
    at: Timestamp,
  }),
  z.strictObject({ type: z.literal('modelOptions.updated'), runtime: Runtime, options: z.array(ModelOption), at: Timestamp }),
  /** The saved preferences after `preferences.set`, so every window shows the same (C-03). */
  z.strictObject({ type: z.literal('preferences.updated'), preferences: UiPreferences, at: Timestamp }),
  /** A saved Agent definition (C-05): after `agent.save`, so every view shows the stored revision. */
  z.strictObject({ type: z.literal('agent.updated'), agent: AgentDefinition }),
  z.strictObject({ type: z.literal('agent.deleted'), agentId: AgentId, at: Timestamp }),
  /** A saved workflow template (C-05), after `workflow.save`. */
  z.strictObject({ type: z.literal('workflow.updated'), workflow: WorkflowTemplate }),
  /** A saved project (C-17), after `project.save`. */
  z.strictObject({ type: z.literal('project.updated'), project: ProjectSettings }),
  /** Every file lock held now (R-07): the whole list, so a missed event never leaves a stale lock on screen. */
  z.strictObject({ type: z.literal('locks.updated'), locks: z.array(FileLock), at: Timestamp }),
  /**
   * What the renderer holds may differ from what is stored (C-05), e.g. an event could not be written and
   * was not pushed: read the Snapshot again. `reason` is a fixed code, never data.
   */
  z.strictObject({ type: z.literal('snapshot.invalidated'), reason: z.enum(['event-write-failed', 'recovered', 'event-overflow']), at: Timestamp }),
  /** A runtime was looked for again (C-33): its whole status. */
  z.strictObject({ type: z.literal('runtime.status'), status: RuntimeStatus }),
  /** Backups or a restore changed (C-28): the whole StorageInfo, so a missed event leaves nothing stale. */
  z.strictObject({ type: z.literal('storage.updated'), storage: StorageInfo, at: Timestamp }),
  /** The data became read-only while the app ran (C-29), e.g. the disk filled up; it never turns ready again before a restart. */
  z.strictObject({ type: z.literal('app.readOnly'), reason: ReadOnlyReason, location: z.string().min(1), at: Timestamp }),
  /** A new model observation for a session, including reroutes (R-12); Codex reports only "configured". */
  z.strictObject({ type: z.literal('model.observed'), sessionId: SessionId, observed: ObservedModel, at: Timestamp }),
  /**
   * A runtime host process ended. `expected` is false for crashes; sessions it hosted lose their turns and
   * open requests, and their pending deliveries stay as recorded (CR-2).
   */
  z.strictObject({
    type: z.literal('runtime.exited'),
    runtime: Runtime,
    sessionIds: z.array(SessionId),
    expected: z.boolean(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    error: z.string().optional(),
    at: Timestamp,
  }),
]);
export type AppEvent = z.infer<typeof AppEvent>;

/** Wire form of an event: versioned and sequenced so a reconnecting renderer can resume after a Snapshot. */
export const EventEnvelope = z.strictObject({ schemaVersion: SchemaVersion, seq: z.number().int().nonnegative(), event: AppEvent });
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/**
 * The only events a batch may merge (C-27): a delta is folded into a later delta of the same message (or item
 * output), taking that later envelope's seq, when no other event about the same session lies between them.
 * Every other event, above all permission requests, turn ends, escalations, handoffs and transfers, is
 * delivered unmerged, in seq order, and never dropped.
 */
export const MERGEABLE_EVENT_TYPES = ['message.delta', 'item.outputDelta'] as const satisfies readonly AppEvent['type'][];

/**
 * What the main process sends to a window (C-27): the envelopes of seqs `fromSeq`..`toSeq`, in order. A seq in
 * that range with no envelope was a delta merged into a later one. Batches follow each other without gaps: a
 * renderer whose last applied seq is not `fromSeq - 1` missed a batch and reads the Snapshot again. When a
 * window falls too far behind, the main process stops batching for it and sends `snapshot.invalidated`
 * (`event-overflow`) instead of dropping anything.
 */
export const EventBatch = z
  .strictObject({
    schemaVersion: SchemaVersion,
    fromSeq: z.number().int().positive(),
    toSeq: z.number().int().positive(),
    envelopes: z.array(EventEnvelope).min(1),
  })
  .superRefine((b, ctx) => {
    const seqs = b.envelopes.map((e) => e.seq);
    if (seqs.some((s, i) => i > 0 && s <= (seqs[i - 1] ?? 0))) addRuleIssue(ctx, 'batch.seq-increasing');
    if (b.fromSeq > b.toSeq || (seqs[0] ?? 0) < b.fromSeq || seqs.at(-1) !== b.toSeq) addRuleIssue(ctx, 'batch.seq-range');
  });
export type EventBatch = z.infer<typeof EventBatch>;

/**
 * Whether the main process could open its data (C-06). `damaged`: the database or a record failed its
 * checks at start; nothing else runs, the Snapshot's lists are empty and every command fails with
 * `storage_failed`. `reason` is a fixed code (the failing table and rule, never stored content);
 * `location` is the database file the user can open in the folder view.
 */
export const AppStatus = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('damaged'), reason: z.string().min(1), location: z.string().min(1) }),
  /**
   * The data can be read but not written (C-29): the Snapshot is complete, writing commands fail with
   * `storage_read_only` and nothing is dispatched to a runtime; `backup.restore` is still accepted.
   */
  z.strictObject({ status: z.literal('read-only'), reason: ReadOnlyReason, location: z.string().min(1) }),
]);
export type AppStatus = z.infer<typeof AppStatus>;

/**
 * Where a session's history continues before what the Snapshot holds (C-26). `olderCursor` null: the Snapshot
 * holds all of it.
 */
export const HistoryPageInfo = z.strictObject({ sessionId: SessionId, olderCursor: HistoryCursor.nullable() });
export type HistoryPageInfo = z.infer<typeof HistoryPageInfo>;

/**
 * Read-only snapshot the renderer loads on start / reconnect (UI re-mount never resends commands).
 *
 * Paging (C-26): for a session listed in `historyPages`, the lists hold only its most recent page of history,
 * in whole turns (every message, item, native task, permission request and artifact of a turn in the page; a
 * record without a turn is placed by its time). Whatever is still open is always included, wherever it falls:
 * running turns, pending permission requests, native tasks not ended. Older pages are read with
 * `session.history`. A session not listed has all of its history here.
 */
export const Snapshot = z.strictObject({
  schemaVersion: SchemaVersion,
  app: AppStatus.default({ status: 'ready' }),
  /** Last event seq already reflected here; apply only envelopes with a larger seq. */
  seq: z.number().int().nonnegative(),
  agents: z.array(AgentDefinition),
  workflows: z.array(WorkflowTemplate),
  modelOptions: z.array(ModelOption),
  sessions: z.array(LogicalSession),
  messages: z.array(Message),
  turns: z.array(Turn),
  items: z.array(SessionItem),
  permissionRequests: z.array(PermissionRequest),
  nativeTasks: z.array(NativeTask),
  artifacts: z.array(Artifact),
  instances: z.array(WorkflowInstance),
  handoffs: z.array(Handoff),
  peerMessages: z.array(PeerMessage),
  escalations: z.array(Escalation),
  transfers: z.array(TransferProposal),
  projects: z.array(ProjectSettings).default([]),
  /** Held in memory only (R-07): empty after a restart. */
  locks: z.array(FileLock).default([]),
  preferences: UiPreferences,
  /**
   * Where new work folders go when `preferences.workFolderRoot` is not set (Q-1, T048): `%USERPROFILE%\AgentWorkflowGui`,
   * as the main process found it.
   */
  defaultWorkFolderRoot: z.string().min(1),
  historyPages: z.array(HistoryPageInfo).default([]),
  storage: StorageInfo.default({}),
  /** What was found of each runtime (C-33); empty before the first detection. */
  runtimes: z.array(RuntimeStatus).default([]),
}).superRefine((s, ctx) => {
  const ids = s.historyPages.map((p) => p.sessionId);
  if (new Set(ids).size !== ids.length) addRuleIssue(ctx, 'snapshot.history-page-unique');
  const runtimes = s.runtimes.map((r) => r.runtime);
  if (new Set(runtimes).size !== runtimes.length) addRuleIssue(ctx, 'snapshot.runtime-unique');
});
export type Snapshot = z.infer<typeof Snapshot>;

/**
 * One older page of a session's history (C-26), shaped like the Snapshot's lists and holding whole turns.
 * `olderCursor` null: nothing older remains.
 */
export const HistoryPage = z
  .strictObject({
    sessionId: SessionId,
    turns: z.array(Turn),
    messages: z.array(Message),
    items: z.array(SessionItem),
    nativeTasks: z.array(NativeTask),
    permissionRequests: z.array(PermissionRequest),
    artifacts: z.array(Artifact),
    olderCursor: HistoryCursor.nullable(),
  })
  .superRefine((p, ctx) => {
    const records = [...p.turns, ...p.messages, ...p.items, ...p.nativeTasks, ...p.permissionRequests, ...p.artifacts];
    if (records.some((r) => r.sessionId !== p.sessionId)) addRuleIssue(ctx, 'history.one-session');
  });
export type HistoryPage = z.infer<typeof HistoryPage>;

/**
 * Read-only queries (C-26, C-28), on their own channel beside commands: they change no data and are answered
 * in read-only mode too. `session.history` reads the page before `before`, a cursor this session got from the
 * Snapshot or an earlier page; a cursor of another session is `invalid_request`.
 */
export const QueryRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session.history'), requestId: RequestId, sessionId: SessionId, before: HistoryCursor, limit: z.number().int().min(1).max(500) }),
  /** Verified backups, newest first. */
  z.strictObject({ type: z.literal('backup.list'), requestId: RequestId }),
]);
export type QueryRequest = z.infer<typeof QueryRequest>;

export const QueryResult = z.union([
  z.strictObject({ ok: z.literal(true), type: z.literal('session.history'), requestId: RequestId, page: HistoryPage }),
  z.strictObject({ ok: z.literal(true), type: z.literal('backup.list'), requestId: RequestId, backups: z.array(BackupInfo) }),
  z.strictObject({
    ok: z.literal(false),
    requestId: RequestId.nullable(),
    code: z.enum(['not_found', 'invalid_request', 'storage_failed', 'internal_error']),
    message: z.string(),
  }),
]);
export type QueryResult = z.infer<typeof QueryResult>;

/**
 * Folder requests (C-24), on their own channel beside commands: they open native windows and change no
 * data. `folder.pick` shows the folder dialog and returns only the folder the user chose. `folder.open`
 * shows a folder in the file explorer, named by what it belongs to, never by a path from the renderer, so
 * only folders the app already knows can be opened.
 */
export const FolderTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session-cwd'), sessionId: SessionId }),
  z.strictObject({ kind: z.literal('task-worktree'), instanceId: InstanceId, taskId: TaskId }),
  z.strictObject({ kind: z.literal('project'), projectId: ProjectId }),
  /** The folder of the app's database (the `damaged` screen points at it, C-06). */
  z.strictObject({ kind: z.literal('app-data') }),
]);
export type FolderTarget = z.infer<typeof FolderTarget>;

export const FolderRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('folder.pick'), requestId: RequestId, title: z.string().max(200).optional() }),
  z.strictObject({ type: z.literal('folder.open'), requestId: RequestId, target: FolderTarget }),
]);
export type FolderRequest = z.infer<typeof FolderRequest>;

export const FolderResult = z.discriminatedUnion('ok', [
  /** `path`: the chosen folder for `folder.pick`, `null` when the dialog was cancelled; absent for `folder.open`. */
  z.strictObject({ ok: z.literal(true), requestId: RequestId, path: z.string().min(1).nullable().optional() }),
  z.strictObject({ ok: z.literal(false), requestId: RequestId.nullable(), code: z.enum(['not_found', 'invalid_request', 'internal_error']), message: z.string() }),
]);
export type FolderResult = z.infer<typeof FolderResult>;

// Inferred types for schemas that are not typed next to their definition.
export type ErrorCode = z.infer<typeof ErrorCode>;
export type CreatedRef = z.infer<typeof CreatedRef>;
export type LimitWindow = z.infer<typeof LimitWindow>;

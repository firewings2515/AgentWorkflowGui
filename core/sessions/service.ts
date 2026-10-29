// Ordinary sessions over the ports (T017): the commands of the renderer, the runtime events that become the
// stored conversation, the GUI MCP server's `send_message`, and restart / exit. Workflow execution and
// cross-tool transfer come with batch 4 and answer `unsupported`.
//
// Every payload reaches a runtime through the CR-2 delivery service (T008); a session's runtime session is
// itself created as a provision delivery, so a lost create response is never followed by a second create.
// Approval requests go through the permission gate (policy first, the user for escalations; R-05, R-08).
import {
  type AgentDefinition,
  type AppEvent,
  type Command,
  type CommandResult,
  type Escalation,
  EscalationId,
  type LogicalSession,
  type Message,
  MessageId,
  type MessageOrigin,
  type ModelOption,
  type OperationId,
  OperationId as OperationIdSchema,
  type PayloadHash,
  type PeerMessage,
  PeerMessageId,
  type PermissionRequest,
  type Runtime,
  type SendMessageToolInput,
  type SendMessageToolResult,
  type SessionId,
  type SessionItem,
  type Timestamp,
  AttemptId,
} from '../../contracts';
import { DeliveryService, type DeliveryEscalation, type DispatchOutcome, type PayloadDelivery, type RecoveryReport } from '../delivery';
import type {
  AppRepositories,
  Conversation,
  DeliveryStore,
  DispatchEntry,
  McpMount,
  PermissionHandle,
  PermissionPolicy,
  RuntimeAdapter,
  RuntimeEvent,
  SessionSettings,
  StoredDelivery,
} from '../ports';
import { PermissionGate } from './permissions';
import { SessionRuntimes } from './runtimes';
import { WrittenPaths, type WrittenPathsOptions } from './written-paths';
import { gated, ServiceClosedError } from './write-gate';

type Failure = Extract<CommandResult, { ok: false }>;
type Success = Extract<CommandResult, { ok: true }>;
type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;

export interface SessionServiceOptions {
  repositories: AppRepositories;
  store: DeliveryStore;
  policy: PermissionPolicy;
  publish(event: AppEvent): void;
  now(): Timestamp;
  uuid(): string;
  /** `sha256:<hex>` of a text (core has no crypto). */
  hashPayload(text: string): PayloadHash | Promise<PayloadHash>;
  /** Node-side link resolution; null when it cannot be confirmed (PolicyContext.resolveRealPath). */
  resolveRealPath(absolutePath: string): string | null;
  /** The adapter that serves a session (see SessionRuntimes); its `onPermissionRequest` must call this service's. */
  createAdapter(runtime: Runtime, sessionId: SessionId): RuntimeAdapter;
  /** A new GUI MCP mount for a session (T016 `mount()`); the old token stops working. */
  mountMcp(sessionId: SessionId): McpMount | Promise<McpMount>;
  listModels(runtime: Runtime): Promise<ModelOption[]>;
  /** Whether a runtime can be used at all (e.g. its executable was found). Defaults to yes. */
  isRuntimeAvailable?(runtime: Runtime): boolean;
  /** A session's runtime came up / was released (the main process watches its folder, ends its Job, revokes its token). */
  onSessionOpened?(sessionId: SessionId, cwd: string): void;
  onSessionClosed?(sessionId: SessionId): Promise<void> | void;
  dispatchTimeoutMs?: number;
  /** Resolves after `ms`; bounds the wait for running work on exit (R-14). Without it, exit waits for all of it. */
  sleep?(ms: number): Promise<void>;
  written?: WrittenPathsOptions;
  log?(message: string): void;
}

const ok = (requestId: Success['requestId'], extra: Partial<Pick<Success, 'revision' | 'created'>> = {}): Success => ({
  ok: true,
  requestId,
  created: [],
  ...extra,
});

const fail = (
  requestId: Failure['requestId'],
  code: Failure['code'],
  message: string,
  flags: { retryable?: boolean; mayHaveSideEffects?: boolean } = {},
): Failure => ({
  ok: false,
  requestId,
  code,
  message,
  retryable: flags.retryable ?? false,
  mayHaveSideEffects: flags.mayHaveSideEffects ?? false,
});

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'non-error thrown');

/** Busy: running, or waiting for the user (R-05) or a file lock (R-07). Not proof that the main turn runs. */
const busy = (s: Pick<LogicalSession, 'activity'>) => s.activity === 'running' || s.activity === 'waiting-user' || s.activity === 'waiting-lock';
/** The session's own running turn, not a native sub-agent's (R-13). */
const runningMainTurn = (conversation: Conversation) => conversation.turns.find((t) => t.state === 'running' && t.nativeTaskId === undefined);

/** An item the last run left open, as ended by that run's exit (T021); undefined when it had ended. */
const endedByExit = (item: SessionItem, endedAt: Timestamp): SessionItem | undefined => {
  if (item.endedAt !== undefined) return undefined;
  switch (item.kind) {
    case 'command':
      return { ...item, state: 'interrupted', endedAt };
    case 'fileChange':
    case 'toolCall':
      return { ...item, state: 'failed', endedAt };
  }
};

/** Stable operation IDs: one runtime session per GUI session, one delivery per renderer message ID. */
const provisionOp = (sessionId: SessionId): OperationId => OperationIdSchema.parse(`provision:${sessionId}`);
const userMessageOp = (messageId: string): OperationId => OperationIdSchema.parse(`user-message:${messageId}`);
const peerIdOf = (operationId: OperationId) => PeerMessageId.parse(`peer-${operationId}`);

/** Why a `send_message` resend is refused (C-07); the details are fixed text, never the call's content. */
type Refusal = { reason: 'invalid-input' | 'not-owner' | 'resend-mismatch'; detail: string };
const NOT_OWNER: Refusal = { reason: 'not-owner', detail: 'this operation belongs to another call' };
const RESEND_MISMATCH: Refusal = { reason: 'resend-mismatch', detail: 'this operation carries another message' };
/** One queue per session for its commands and its runtime events (r1-P1-4). */
const sessionKey = (sessionId: SessionId) => `session:${sessionId}`;
const closingFailure = (requestId: Failure['requestId']) => fail(requestId, 'runtime_unavailable', 'The application is closing');

/** A user message this process sent, and how its runtime echo is recognised (r1-P1-9). */
interface Echo {
  /** Claude echoes the message under its clientMessageId. */
  clientMessageIds: string[];
  /** Codex echoes it in the turn the dispatch started. */
  turnRef?: string;
  text: string;
}
/** A delivery-unknown escalation is named after its attempt, so a restart never opens a second one. */
const deliveryEscalationId = (key: string) => EscalationId.parse(`delivery:${key}`);
const parseDeliveryEscalationId = (id: string): { operationId: OperationId; attemptId: AttemptId } | undefined => {
  if (!id.startsWith('delivery:')) return undefined;
  const key = id.slice('delivery:'.length);
  const cut = key.lastIndexOf('/');
  if (cut <= 0) return undefined;
  return {
    operationId: OperationIdSchema.parse(key.slice(0, cut)),
    attemptId: AttemptId.parse(key.slice(cut + 1)),
  };
};

/** Which session an event belongs to, for ordering its writes. */
const sessionOf = (event: RuntimeEvent): SessionId | undefined => {
  switch (event.type) {
    case 'session.activity':
    case 'message.delta':
    case 'item.outputDelta':
    case 'model.observed':
      return event.sessionId;
    case 'turn.updated':
      return event.turn.sessionId;
    case 'message.completed':
      return event.message.sessionId;
    case 'item.updated':
      return event.item.sessionId;
    case 'permission.updated':
      return event.request.sessionId;
    case 'nativeTask.updated':
      return event.task.sessionId;
    case 'usage.tokens':
      return event.usage.sessionId;
    default:
      return undefined;
  }
};

interface PendingConfirmation {
  from: SessionId;
  to: SessionId;
  content: string;
  operationId: OperationId;
  sourceCallRef: string;
}

type Provisioned =
  | { ok: true; nativeSessionRef: string }
  | {
      ok: false;
      code: Failure['code'];
      message: string;
      mayHaveSideEffects: boolean;
      retryable: boolean;
    };

export class SessionService {
  readonly written: WrittenPaths;
  readonly gate: PermissionGate;
  readonly runtimes: SessionRuntimes;
  readonly delivery: DeliveryService;
  private readonly repos: AppRepositories;
  private readonly store: DeliveryStore;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Latest session-level usage per session, written to the session when its turn ends. */
  private readonly usage = new Map<SessionId, LogicalSession['tokenUsage']>();
  /** Origins of payloads accepted in this process, for a user retry of an unknown delivery. */
  private readonly origins = new Map<OperationId, MessageOrigin>();
  private readonly confirmations = new Map<EscalationId, PendingConfirmation>();
  /** The session that created each peer operation in this process (contracts keep no sender). */
  private readonly owners = new Map<OperationId, SessionId>();
  /** Recent user messages per session whose runtime echo is not stored again (r1-P1-9). */
  private readonly echoes = new Map<SessionId, Echo[]>();
  /** Sessions whose last event could not be stored: the renderer needs a new Snapshot (contracts gap). */
  private readonly unsynced = new Set<SessionId>();
  private closing = false;
  /** Set when shutdown finished: nothing is stored any more (the database closes next). */
  private closed = false;

  constructor(private readonly options: SessionServiceOptions) {
    // Storage only through the write gate: once shutdown returned, nothing reaches it (r2-P1-4).
    this.repos = gated(options.repositories, () => this.closed);
    this.store = gated(options.store, () => this.closed);
    this.written = new WrittenPaths(options.written);
    this.gate = new PermissionGate({
      repositories: this.repos,
      policy: options.policy,
      written: this.written,
      resolveRealPath: (path) => options.resolveRealPath(path),
      publish: (escalation) => options.publish({ type: 'escalation.updated', escalation }),
      now: () => options.now(),
      uuid: () => options.uuid(),
      log: (message) => options.log?.(message),
      isClosing: () => this.closing,
    });
    this.runtimes = new SessionRuntimes({
      createAdapter: (runtime, sessionId) => options.createAdapter(runtime, sessionId),
      mountMcp: (sessionId) => options.mountMcp(sessionId),
      listModels: (runtime) => options.listModels(runtime),
      onOpened: (sessionId, cwd) => options.onSessionOpened?.(sessionId, cwd),
      onClosed: (sessionId) => options.onSessionClosed?.(sessionId),
      onEvent: (event) => this.record(event),
      ...(options.sleep !== undefined && { sleep: (ms: number) => this.options.sleep!(ms) }),
    });
    this.delivery = new DeliveryService({
      store: this.store,
      runtimes: this.runtimes.adapters,
      now: () => options.now(),
      uuid: () => options.uuid(),
      hashPayload: (text) => options.hashPayload(text),
      prepareTarget: (record) => this.prepareTarget(record),
      onEscalation: (item) =>
        void this.serial('escalations', () => this.escalateDelivery(item)).catch((error: unknown) =>
          this.log(`escalating an unknown delivery failed (${errorName(error)})`),
        ),
      ...(options.dispatchTimeoutMs !== undefined && {
        dispatchTimeoutMs: options.dispatchTimeoutMs,
      }),
    });
  }

  // ---- lifecycle ------------------------------------------------------------------------------------

  /**
   * After a (re)start, before the window opens: nothing runs yet, so sessions are closed; requests held for
   * the user cannot be answered any more; what each session wrote is rebuilt from its stored items; then
   * deliveries are recovered (CR-2: unknown only reconciled, pending through the one dispatch entry).
   */
  async start(): Promise<RecoveryReport> {
    const repositories = this.repos;
    for (const session of await repositories.sessions.list()) {
      const binding = await this.binding(session.id);
      if (binding !== undefined) this.runtimes.bind(session.id, binding);
      const conversation = await repositories.conversations.get(session.id);
      for (const item of conversation.items)
        if (item.kind === 'fileChange' && item.state !== 'declined')
          this.written.add(
            session.id,
            item.changes.flatMap((c) => [c.path, ...(c.movePath ? [c.movePath] : [])]),
            session.cwd,
          );
      // The last run's processes are gone (its Job ended them, D-03), so nothing of it is still running:
      // turns, items and sub-agents it left open were cut off by its exit (T021: a GUI killed mid-turn).
      const at = this.options.now();
      for (const turn of conversation.turns) if (turn.state === 'running') await repositories.conversations.upsertTurn({ ...turn, state: 'interrupted', endedAt: at });
      for (const item of conversation.items) {
        const ended = endedByExit(item, at);
        if (ended !== undefined) await repositories.conversations.upsertItem(ended);
      }
      for (const task of conversation.nativeTasks) if (task.state === 'running') await repositories.conversations.upsertNativeTask({ ...task, state: 'stopped', endedAt: at });
      for (const request of conversation.permissionRequests) {
        if ((request.kind === 'command' || request.kind === 'fileChange') && request.decision?.outcome === 'approve')
          this.written.add(session.id, request.paths, request.cwd ?? session.cwd);
        if (request.state === 'pending' || request.state === 'held') {
          const withdrawn = { ...request, state: 'withdrawn' as const };
          delete withdrawn.hold;
          await repositories.conversations.upsertPermissionRequest(withdrawn);
        }
      }
      if (session.activity !== 'closed' && session.activity !== 'reconciling') await this.setActivity(session.id, 'closed');
    }
    for (const escalation of await repositories.escalations.list({
      state: 'open',
    })) {
      // Nothing in this process holds the request or the message waiting for confirmation any more.
      if (escalation.kind === 'permission' || escalation.kind === 'confirmation') await this.closeEscalation(escalation, 'resolved');
    }
    // A message accepted before a crash but never written is written now (r1-P1-8).
    for (const state of ['pending', 'unknown'] as const) {
      for (const record of await this.store.listByState(state)) if (record.kind === 'user-message') await this.ensureUserMessage(record);
    }
    const userMessages: OperationId[] = [];
    const report = await this.delivery.recover({
      select: (record) => {
        if (record.kind === 'provision') return {};
        // Dispatched below, in the session's queue, so its echo is registered before its events (r2-P1-7).
        if (record.kind === 'user-message') {
          userMessages.push(record.operationId);
          return 'skip';
        }
        // The origin stored at acceptance (C-01); one stored before 0.5 is marked as not the user's.
        return { origin: record.context.origin ?? { kind: 'system' } };
      },
    });
    for (const operationId of userMessages) {
      const sessionId = (await this.store.get(operationId))?.target.sessionId;
      if (sessionId === undefined) continue;
      try {
        const outcome = await this.serial(sessionKey(sessionId), () => this.dispatchOne(operationId, { origin: { kind: 'user' } }));
        if (outcome !== undefined) report.dispatched.push({ operationId, outcome });
      } catch (error) {
        report.failed.push({ operationId, detail: errorName(error) });
      }
    }
    for (const { operationId, outcome } of [...report.reconciled, ...report.dispatched]) {
      if (outcome.status === 'sent' && !userMessages.includes(operationId)) await this.settled(operationId, outcome.attemptId);
    }
    return report;
  }

  /**
   * R-14, after the MCP server stopped: every open session is closed (Claude interrupts before closing,
   * Codex closes stdin; the main process then ends its Job), then the adapters themselves.
   */
  /**
   * Nothing new starts from now on (r1-P1-5, r3-P1-2): commands, MCP calls, permission checks and queued
   * work see this when their turn comes, and a start or resume still running is closed as soon as it returns.
   * The main process calls it first thing on exit; `shutdown` calls it too.
   */
  beginClose(): void {
    this.closing = true;
    this.runtimes.beginClose();
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    this.beginClose();
    // What already runs gets its chance to finish; past the deadline the sessions are closed anyway (R-14).
    await this.within(
      (async () => {
        while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
        await this.runtimes.settled();
      })(),
      timeoutMs,
    );
    const open = this.runtimes.openSessions();
    await Promise.allSettled(open.map(({ nativeSessionRef }) => this.runtimes.closeSession(nativeSessionRef, timeoutMs)));
    await this.runtimes.closeAll(timeoutMs);
    for (const { sessionId } of open) await this.setActivity(sessionId, 'closed').catch(() => undefined);
    // From here nothing is written: the main process closes the database next.
    this.closed = true;
  }

  /** `run`, or nothing once `ms` passed (core has no timers: the main process injects `sleep`). */
  private within(run: Promise<unknown>, ms: number): Promise<unknown> {
    return this.options.sleep === undefined ? run : Promise.race([run, this.options.sleep(ms)]);
  }

  /** What would be cut off by exiting now (R-14), for the exit confirmation. */
  async unfinishedWork(): Promise<{
    runningSessions: SessionId[];
    heldRequests: number;
    runningNativeTasks: number;
  }> {
    const open = new Set(this.runtimes.openSessions().map((s) => s.sessionId));
    const sessions = (await this.repos.sessions.list()).filter((s) => open.has(s.id));
    let runningNativeTasks = 0;
    for (const s of sessions)
      runningNativeTasks += (await this.repos.conversations.get(s.id)).nativeTasks.filter((t) => t.state === 'running').length;
    return {
      runningSessions: sessions.filter(busy).map((s) => s.id),
      heldRequests: sessions.reduce((n, s) => n + this.gate.heldFor(s.id).length, 0),
      runningNativeTasks,
    };
  }

  /** `RuntimeAdapterHooks.onPermissionRequest` for every adapter. */
  onPermissionRequest(handle: PermissionHandle): Promise<void> {
    // Once closing began nothing is approved, by the policy or anyone (r2-P1-6).
    if (this.closing) {
      handle.answer({ outcome: 'decline', decidedBy: 'policy', reason: 'the GUI is closing', at: this.options.now() });
      return Promise.resolve();
    }
    return this.gate.onPermissionRequest(handle);
  }

  /** A file changed in a session's workspace while its runtime ran (writtenPaths source 3). */
  workspaceChanged(sessionId: SessionId, root: string, path: string): void {
    this.written.changed(sessionId, root, path);
  }

  /** The workspace watch failed or cannot run: everything in it counts as written (fail closed). */
  workspaceWatchFailed(sessionId: SessionId, root: string): void {
    this.written.wholeWorkspace(sessionId, root);
  }

  // ---- commands -------------------------------------------------------------------------------------

  async execute(command: Command): Promise<CommandResult> {
    if (this.closing) return closingFailure(command.requestId);
    // Commands that change a session run in its one queue, in order with its runtime events (r1-P1-4);
    // each checks again for closing when its turn comes (r1-P1-5).
    const queued = (sessionId: SessionId, run: () => Promise<CommandResult>) =>
      this.serial(sessionKey(sessionId), () => (this.closing ? Promise.resolve(closingFailure(command.requestId)) : run()));
    switch (command.type) {
      case 'session.create':
        return this.create(command);
      case 'session.send':
        return queued(command.sessionId, () => this.send(command));
      case 'session.interrupt':
        return this.interrupt(command);
      case 'session.setModel':
        return queued(command.sessionId, () => this.setModel(command));
      case 'session.setAgent':
        return queued(command.sessionId, () => this.setAgent(command));
      case 'session.reparent':
        return this.serial('tree', () => (this.closing ? Promise.resolve(closingFailure(command.requestId)) : this.reparent(command)));
      case 'nativeTask.stop':
        return this.stopNativeTask(command);
      case 'agent.save':
        return this.saveAgent(command);
      case 'agent.delete':
        return this.deleteAgent(command);
      case 'workflow.save': {
        const saved = await this.repos.workflows.save(command.workflow, command.expectedRevision);
        if (saved.status === 'stale') return fail(command.requestId, 'stale_revision', 'The workflow has changed since it was loaded', { retryable: true });
        return ok(command.requestId, { revision: saved.record.revision });
      }
      case 'escalation.respond':
        return this.respond(command);
      case 'delivery.resolve':
        return this.resolveDelivery(command);
      case 'preferences.set': {
        const preferences = await this.repos.preferences.set(command.preferences);
        this.options.publish({
          type: 'preferences.updated',
          preferences,
          at: this.options.now(),
        });
        return ok(command.requestId);
      }
      case 'workflow.start':
      case 'transfer.prepare':
      case 'transfer.confirm':
      case 'transfer.cancel':
        return fail(command.requestId, 'unsupported', `${command.type} is not available yet`);
    }
  }

  private async create(command: CommandOf<'session.create'>): Promise<CommandResult> {
    const { requestId, sessionId, agentId, model, cwd, parentId } = command;
    const repositories = this.repos;
    const agent = await repositories.agents.get(agentId);
    if (agent === undefined) return fail(requestId, 'not_found', 'Unknown agent');
    if (!(this.options.isRuntimeAvailable?.(model.runtime) ?? true))
      return fail(requestId, 'runtime_unavailable', `${model.runtime} is not available on this computer`);
    if (parentId !== undefined && (await repositories.sessions.get(parentId)) === undefined) return fail(requestId, 'not_found', 'Unknown parent session');
    const root = this.options.resolveRealPath(cwd);
    if (root === null) return fail(requestId, 'invalid_request', 'The working folder cannot be resolved');
    const at = this.options.now();
    const session: LogicalSession = {
      id: sessionId,
      revision: 0,
      kind: 'ordinary',
      title: agent.name,
      agent: { id: agent.id, revision: agent.revision },
      requestedModel: model,
      observedModel: { source: 'unknown' },
      activity: 'closed',
      cwd,
      folderScope: {
        source: 'session-cwd',
        workspaceRoot: root,
        writableRoots: [root],
        readableRoots: [],
      },
      ...(parentId !== undefined && { parentId }),
      createdAt: at,
      updatedAt: at,
    };
    if (this.closing) return closingFailure(requestId);
    if ((await repositories.sessions.create(session)) === 'exists') return fail(requestId, 'already_exists', 'A session with this ID already exists');
    this.options.publish({ type: 'session.updated', session });
    // The runtime session is created in the background; a send waits for it.
    void this.serial(sessionKey(sessionId), () => (this.closing ? Promise.resolve(undefined) : this.ensureProvisioned(session))).catch((error: unknown) =>
      this.log(`starting session ${sessionId} failed (${errorName(error)})`),
    );
    return ok(requestId, {
      revision: session.revision,
      created: [{ kind: 'session', id: sessionId }],
    });
  }

  private async send(command: CommandOf<'session.send'>): Promise<CommandResult> {
    const { requestId, sessionId, messageId, expectedRevision, text, attachments } = command;
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return fail(requestId, 'not_found', 'Unknown session');
    if (session.revision !== expectedRevision) return fail(requestId, 'stale_revision', 'The session has changed since it was loaded', { retryable: true });
    if (attachments.length > 0) return fail(requestId, 'unsupported', 'Attachments are not available yet');
    const operationId = userMessageOp(messageId);
    const existing = await this.store.get(operationId);
    if (existing !== undefined && (existing.kind !== 'user-message' || existing.target.sessionId !== sessionId || existing.payload !== text)) {
      return fail(requestId, 'invalid_request', 'This message ID was already used for another message');
    }
    // The renderer's message under its ID comes first, and must really be in this session (r1-P1-8,
    // r2-P1-8): a message ID taken elsewhere is refused before anything is accepted or sent.
    const written = await this.writeUserMessage(sessionId, messageId, text, existing?.acceptedAt ?? this.options.now());
    if (written === 'taken') return fail(requestId, 'invalid_request', 'This message ID was already used for another message');
    if (this.closing) return closingFailure(requestId);
    if (existing === undefined) {
      const provisioned = await this.ensureProvisioned(session);
      if (this.closing) return closingFailure(requestId);
      if (!provisioned.ok) return fail(requestId, provisioned.code, provisioned.message, provisioned);
      const entry: DispatchEntry = (await this.inMainTurn(session)) ? { kind: 'insert' } : { kind: 'new-turn' };
      const accepted = await this.delivery.accept({
        kind: 'user-message',
        operationId,
        payloadHash: await this.options.hashPayload(text),
        payload: text,
        proposalRevision: session.revision,
        target: { sessionId, nativeSessionRef: provisioned.nativeSessionRef },
        at: this.options.now(),
        context: {
          runtime: session.requestedModel.runtime,
          cwd: session.cwd,
          entry,
          session: await this.settingsOf(session),
        },
      });
      if (accepted.status === 'conflict') return fail(requestId, 'invalid_request', 'This message ID was already used for another message');
      if (accepted.status === 'commit-uncertain')
        return fail(requestId, 'storage_failed', 'Saving the message could not be confirmed', { retryable: true, mayHaveSideEffects: true });
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') return fail(requestId, 'internal_error', 'The message could not be accepted');
    }
    if (this.closing) return closingFailure(requestId);
    const outcome = await this.dispatchPending(operationId, {
      origin: { kind: 'user' },
    });
    const created = [{ kind: 'message' as const, id: messageId }];
    switch (outcome) {
      case 'sent':
        return ok(requestId, { revision: session.revision, created });
      case 'unknown':
        await this.setActivity(sessionId, 'reconciling');
        return fail(requestId, 'unknown_outcome', 'It is not known whether the message reached the session; it is not sent again', {
          mayHaveSideEffects: true,
        });
      default:
        return fail(requestId, 'runtime_unavailable', 'The message is saved but could not be handed to the session yet', { retryable: true });
    }
  }

  private async interrupt(command: CommandOf<'session.interrupt'>): Promise<CommandResult> {
    const session = await this.repos.sessions.get(command.sessionId);
    if (session === undefined) return fail(command.requestId, 'not_found', 'Unknown session');
    const ref = await this.binding(session.id);
    // Nothing runs in a session that is not open.
    if (ref === undefined || !this.runtimes.isOpen(ref)) return ok(command.requestId);
    try {
      await this.runtimes.adapters[session.requestedModel.runtime].interrupt(ref);
      return ok(command.requestId);
    } catch (error) {
      this.log(`interrupting ${session.id} failed (${errorName(error)})`);
      return fail(command.requestId, 'runtime_unavailable', 'The session could not be interrupted', { retryable: true, mayHaveSideEffects: true });
    }
  }

  private async setModel(command: CommandOf<'session.setModel'>): Promise<CommandResult> {
    const { requestId, sessionId, expectedRevision, model } = command;
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return fail(requestId, 'not_found', 'Unknown session');
    // Another runtime means another session: that is a transfer (R-02, R-12).
    if (model.runtime !== session.requestedModel.runtime) return fail(requestId, 'invalid_request', 'Changing to another tool goes through a transfer');
    // The record first (compare-and-set), then the runtime, so the two never disagree (r1-P1-4).
    const saved = await this.updateFromCommand(requestId, sessionId, expectedRevision, (s) => ({ ...s, requestedModel: model }));
    if (!saved.ok) return saved;
    const ref = await this.binding(sessionId);
    if (ref !== undefined && this.runtimes.isOpen(ref)) {
      try {
        // Claude: from the next model call; Codex: from the next turn (R-12). A closed session gets it on resume.
        await this.runtimes.adapters[model.runtime].setModel(ref, model);
      } catch (error) {
        this.log(`changing the model of ${sessionId} failed (${errorName(error)})`);
        // Back to what the runtime still uses.
        await this.updateSession(sessionId, (s) => ({ ...s, requestedModel: session.requestedModel }));
        return fail(requestId, 'runtime_unavailable', 'The model could not be changed', { retryable: true });
      }
    }
    return saved;
  }

  private async setAgent(command: CommandOf<'session.setAgent'>): Promise<CommandResult> {
    const { requestId, sessionId, expectedRevision, agentId } = command;
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return fail(requestId, 'not_found', 'Unknown session');
    if (session.kind !== 'ordinary') return fail(requestId, 'invalid_transition', 'A workflow session keeps its agent');
    const agent = await this.repos.agents.get(agentId);
    if (agent === undefined) return fail(requestId, 'not_found', 'Unknown agent');
    // The new instructions take effect when the runtime session is next started or resumed.
    return this.updateFromCommand(requestId, sessionId, expectedRevision, (s) => ({ ...s, agent: { id: agent.id, revision: agent.revision } }));
  }

  private async reparent(command: CommandOf<'session.reparent'>): Promise<CommandResult> {
    const { requestId, sessionId, parentId, expectedRevision } = command;
    const sessions = await this.repos.sessions.list();
    const session = sessions.find((s) => s.id === sessionId);
    if (session === undefined) return fail(requestId, 'not_found', 'Unknown session');
    // A workflow session's parent is the session that created it; only the ordinary tree can be reorganised (WB-01).
    if (session.kind !== 'ordinary') return fail(requestId, 'invalid_transition', 'Only ordinary sessions can be moved in the tree');
    if (parentId !== null) {
      if (!sessions.some((s) => s.id === parentId)) return fail(requestId, 'not_found', 'Unknown parent session');
      // Walking up from the new parent must never reach the session itself.
      let cursor: SessionId | undefined = parentId;
      while (cursor !== undefined) {
        if (cursor === sessionId) return fail(requestId, 'invalid_request', 'A session cannot sit below itself');
        const above: SessionId = cursor;
        cursor = sessions.find((s) => s.id === above)?.parentId;
      }
    }
    return this.updateFromCommand(requestId, sessionId, expectedRevision, (s) => {
      const next = { ...s };
      if (parentId === null) delete next.parentId;
      else next.parentId = parentId;
      return next;
    });
  }

  private async stopNativeTask(command: CommandOf<'nativeTask.stop'>): Promise<CommandResult> {
    const { requestId, sessionId, nativeTaskId } = command;
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return fail(requestId, 'not_found', 'Unknown session');
    const task = (await this.repos.conversations.get(sessionId)).nativeTasks.find((t) => t.id === nativeTaskId);
    if (task === undefined) return fail(requestId, 'not_found', 'Unknown sub-agent');
    if (task.state !== 'running') return fail(requestId, 'invalid_transition', 'The sub-agent is not running');
    const ref = await this.binding(sessionId);
    if (ref === undefined || !this.runtimes.isOpen(ref)) return fail(requestId, 'invalid_transition', 'The session is not running');
    try {
      await this.runtimes.adapters[task.runtime].stopNativeTask(ref, task.nativeRef);
      return ok(requestId);
    } catch (error) {
      this.log(`stopping a sub-agent of ${sessionId} failed (${errorName(error)})`);
      return fail(requestId, 'runtime_unavailable', 'The sub-agent could not be stopped', { retryable: true, mayHaveSideEffects: true });
    }
  }

  private async saveAgent(command: CommandOf<'agent.save'>): Promise<CommandResult> {
    const saved = await this.repos.agents.save(command.agent, command.expectedRevision);
    if (saved.status === 'stale') return fail(command.requestId, 'stale_revision', 'The agent has changed since it was loaded', { retryable: true });
    return ok(command.requestId, { revision: saved.record.revision });
  }

  private async deleteAgent(command: CommandOf<'agent.delete'>): Promise<CommandResult> {
    const { requestId, agentId, expectedRevision } = command;
    const repositories = this.repos;
    const inUse =
      (await repositories.sessions.list()).some((s) => s.agent.id === agentId) ||
      (await repositories.workflows.list()).some((w) => w.nodes.some((n) => n.kind === 'agent' && n.agentId === agentId));
    // C-01: an agent a session or a workflow template uses stays.
    if (inUse) return fail(requestId, 'invalid_transition', 'The agent is used by a session or a workflow');
    const result = await repositories.agents.delete(agentId, expectedRevision);
    if (result === 'not-found') return fail(requestId, 'not_found', 'Unknown agent');
    if (result === 'stale') return fail(requestId, 'stale_revision', 'The agent has changed since it was loaded', { retryable: true });
    return ok(requestId);
  }

  private async respond(command: CommandOf<'escalation.respond'>): Promise<CommandResult> {
    const { requestId, escalationId, decision, note, content } = command;
    const escalation = await this.repos.escalations.get(escalationId);
    if (escalation === undefined) return fail(requestId, 'not_found', 'Unknown escalation');
    if (escalation.state !== 'open') return fail(requestId, 'invalid_transition', 'The escalation is already closed');
    if (escalation.kind === 'permission') {
      if (this.closing) return closingFailure(requestId);
      const answered = await this.gate.respond(escalation, {
        decision,
        note,
        content,
      });
      if (answered === 'answered') return ok(requestId);
      return fail(requestId, 'invalid_transition', 'The request is no longer open');
    }
    if (escalation.kind === 'confirmation') return this.confirm(requestId, escalation, decision);
    return fail(requestId, 'invalid_transition', 'This escalation is answered with another command');
  }

  /** The user's decision on a delivery whose outcome stayed unknown (CR2_DELIVERY_FIX §2). */
  private async resolveDelivery(command: CommandOf<'delivery.resolve'>): Promise<CommandResult> {
    const { requestId, escalationId, decision, acceptDuplicateRisk } = command;
    const escalation = await this.repos.escalations.get(escalationId);
    const attempt = parseDeliveryEscalationId(escalationId);
    if (escalation === undefined || attempt === undefined || escalation.kind !== 'delivery-unknown')
      return fail(requestId, 'not_found', 'Unknown delivery escalation');
    if (escalation.state !== 'open') return fail(requestId, 'invalid_transition', 'The escalation is already closed');
    const resolved = await this.delivery.resolve({
      ...attempt,
      decision,
      acceptDuplicateRisk,
    });
    switch (resolved.status) {
      case 'stale':
        await this.closeEscalation(escalation, 'resolved');
        return fail(requestId, 'invalid_transition', 'The delivery is no longer unknown');
      case 'refused':
        return fail(requestId, resolved.reason === 'in-flight' ? 'invalid_transition' : 'invalid_request', 'A retry cannot be made now', {
          retryable: resolved.reason === 'in-flight',
        });
      case 'commit-uncertain':
        return fail(requestId, 'storage_failed', 'The decision could not be saved for certain', { retryable: true, mayHaveSideEffects: true });
      case 'recorded':
        break;
    }
    // Waiting keeps the question open; cancel and retry close it.
    if (decision === 'wait') return ok(requestId);
    await this.closeEscalation(escalation, 'resolved', 'user');
    if (decision === 'retry') {
      await this.dispatchPending(attempt.operationId, {
        origin: await this.originOf(attempt.operationId),
      });
      if (escalation.ref?.kind === 'provision')
        for (const blocked of escalation.ref.blocked)
          await this.dispatchPending(blocked, {
            origin: await this.originOf(blocked),
          });
    }
    return ok(requestId);
  }

  // ---- MCP send_message -----------------------------------------------------------------------------

  /**
   * `send_message(to, content)` from `caller` (identified by its token only, T016). Same tool: accepted
   * and dispatched at once, marked as a peer message (R-03). Cross-tool between ordinary sessions: the user
   * confirms first (R-11).
   */
  async sendMessage(input: SendMessageToolInput, ctx: { caller: SessionId; operationId: OperationId; sourceCallRef: string }): Promise<SendMessageToolResult> {
    try {
      return await this.sendMessageGuarded(input, ctx);
    } catch (error) {
      // A call that ran into the exit (the write gate, or anything after closing began) is answered as such (r3-P2-2).
      if (this.closing || error instanceof ServiceClosedError) return { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } };
      throw error;
    }
  }

  private async sendMessageGuarded(input: SendMessageToolInput, ctx: { caller: SessionId; operationId: OperationId; sourceCallRef: string }): Promise<SendMessageToolResult> {
    const rejected = (reason: 'unknown-target' | 'invalid-input' | 'shutting-down', detail: string): SendMessageToolResult => ({
      status: 'rejected',
      rejection: { reason, detail },
    });
    if (this.closing) return rejected('shutting-down', 'the GUI is closing');
    const { sessions } = this.repos;
    const caller = await sessions.get(ctx.caller);
    const target = await sessions.get(input.to);
    if (caller === undefined || target === undefined) return rejected('unknown-target', 'no such session');
    if (caller.id === target.id) return rejected('invalid-input', 'a session cannot send a message to itself');
    const pending: PendingConfirmation = {
      from: caller.id,
      to: target.id,
      content: input.content,
      operationId: ctx.operationId,
      sourceCallRef: ctx.sourceCallRef,
    };
    // One call per operation at a time, so two calls racing for the same ID are checked against each other
    // (r2-P1-3); the target's part then runs in the target's queue.
    return this.serial(`op:${ctx.operationId}`, () => this.sendMessageNow(caller, target, pending));
  }

  private async sendMessageNow(caller: LogicalSession, target: LogicalSession, pending: PendingConfirmation): Promise<SendMessageToolResult> {
    const rejected = (reason: Refusal['reason'] | 'shutting-down', detail: string): SendMessageToolResult => ({ status: 'rejected', rejection: { reason, detail } });
    if (this.closing) return rejected('shutting-down', 'the GUI is closing');
    // A resend or a `retryOf` names an operation that already exists: it must be the same message from the
    // same session to the same target (CR-2's fixed content), or it is refused (r1-P1-3).
    const mismatch = await this.resendMismatch(pending);
    if (mismatch !== undefined) return rejected(mismatch.reason, mismatch.detail);
    if (caller.requestedModel.runtime !== target.requestedModel.runtime && (await this.store.get(pending.operationId)) === undefined) {
      const id = EscalationId.parse(`confirm-${pending.operationId}`);
      const existing = await this.repos.escalations.get(id);
      // Re-checked after every wait, before anything is written (r2-P1-6).
      if (this.closing) return rejected('shutting-down', 'the GUI is closing');
      if (existing === undefined) {
        const escalation: Escalation = {
          id,
          rootSessionId: caller.id,
          fromSessionId: caller.id,
          kind: 'confirmation',
          title: 'Message to a session of another tool',
          detail: `${caller.requestedModel.runtime} session "${caller.title}" asks to send a message to ${target.requestedModel.runtime} session "${target.title}"`,
          ref: {
            kind: 'peerMessage',
            peerMessageId: peerIdOf(pending.operationId),
          },
          state: 'open',
          createdAt: this.options.now(),
        };
        this.confirmations.set(id, pending);
        this.owners.set(pending.operationId, caller.id);
        await this.repos.escalations.upsert(escalation);
        this.options.publish({ type: 'escalation.updated', escalation });
      } else if (existing.state !== 'open') {
        return rejected('invalid-input', 'the user already answered this message');
      }
      return { status: 'awaiting-confirmation', escalationId: id };
    }
    return this.deliverPeer(pending);
  }

  private async confirm(requestId: Success['requestId'], escalation: Escalation, decision: 'approve' | 'decline'): Promise<CommandResult> {
    const pending = this.confirmations.get(escalation.id);
    this.confirmations.delete(escalation.id);
    if (pending === undefined) {
      await this.closeEscalation(escalation, 'resolved');
      return fail(requestId, 'invalid_transition', 'The message is no longer waiting');
    }
    await this.closeEscalation(escalation, decision === 'approve' ? 'approved' : 'declined', 'user');
    if (decision === 'approve') await this.deliverPeer(pending);
    return ok(requestId);
  }

  /**
   * Why an existing operation cannot be this call: another kind, target, payload or sender. The sender is
   * known only for operations this process accepted (contracts store none), so an unknown one is refused.
   */
  private async resendMismatch(p: PendingConfirmation): Promise<Refusal | undefined> {
    const record = await this.store.get(p.operationId);
    const waiting = this.confirmations.get(EscalationId.parse(`confirm-${p.operationId}`));
    if (record === undefined && waiting === undefined) {
      const escalation = await this.repos.escalations.get(EscalationId.parse(`confirm-${p.operationId}`));
      if (escalation === undefined) return undefined;
      // The user already answered the caller's own confirmation; anyone else, and anyone after a restart
      // (the owner is no longer known here), does not own it (T020 r2 P2).
      return this.owners.get(p.operationId) === p.from ? { reason: 'invalid-input', detail: 'this operation is no longer waiting' } : NOT_OWNER;
    }
    if (this.owners.get(p.operationId) !== p.from) return NOT_OWNER;
    if (waiting !== undefined) return waiting.to === p.to && waiting.content === p.content ? undefined : RESEND_MISMATCH;
    return record === undefined ? undefined : this.recordMismatch(record, p);
  }

  /**
   * The stored operation must be this call's message: sender, target and payload (r1-P1-3, r2-P1-3). An
   * operation of another (or, after a restart, an unknown) caller is `not-owner`; the caller's own with
   * another target or content is `resend-mismatch` (C-07).
   */
  private async recordMismatch(record: StoredDelivery, p: PendingConfirmation): Promise<Refusal | undefined> {
    if (record.kind !== 'peer-message') return { reason: 'invalid-input', detail: 'this operation is not a message' };
    if (this.owners.get(p.operationId) !== p.from) return NOT_OWNER;
    if (record.target.sessionId !== p.to || record.payloadHash !== (await this.options.hashPayload(p.content))) return RESEND_MISMATCH;
    return undefined;
  }

  /** The target's part runs in its queue, in order with its commands and events. */
  private deliverPeer(p: PendingConfirmation): Promise<SendMessageToolResult> {
    return this.serial(sessionKey(p.to), () =>
      this.closing ? Promise.resolve<SendMessageToolResult>({ status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } }) : this.deliverPeerNow(p),
    );
  }

  private async deliverPeerNow(p: PendingConfirmation): Promise<SendMessageToolResult> {
    const target = await this.repos.sessions.get(p.to);
    if (target === undefined)
      return {
        status: 'rejected',
        rejection: { reason: 'unknown-target', detail: 'no such session' },
      };
    const origin: MessageOrigin = {
      kind: 'peer',
      fromSessionId: p.from,
      peerMessageId: peerIdOf(p.operationId),
    };
    const shuttingDown: SendMessageToolResult = { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } };
    let record = await this.store.get(p.operationId);
    if (record === undefined) {
      if (this.closing) return shuttingDown;
      const provisioned = await this.ensureProvisioned(target);
      if (this.closing) return shuttingDown;
      const provision = await this.store.get(provisionOp(target.id));
      // Not started yet: the message waits for the target's provision (CR2 §3) instead of being refused.
      const bound = provisioned.ok
        ? {
            sessionId: target.id,
            nativeSessionRef: provisioned.nativeSessionRef,
          }
        : provision?.target.provision !== undefined
          ? { sessionId: target.id, provision: provision.target.provision }
          : undefined;
      if (bound === undefined)
        return {
          status: 'rejected',
          rejection: {
            reason: 'unknown-target',
            detail: 'the target session cannot be started',
          },
        };
      const accepted = await this.delivery.accept({
        kind: 'peer-message',
        operationId: p.operationId,
        sourceCallRef: p.sourceCallRef,
        payloadHash: await this.options.hashPayload(p.content),
        payload: p.content,
        proposalRevision: 0,
        target: bound,
        at: this.options.now(),
        context: {
          runtime: target.requestedModel.runtime,
          cwd: target.cwd,
          entry: { kind: 'new-turn' },
          session: await this.settingsOf(target),
          // C-01: a restarted GUI dispatches it as from the peer again, never as the user.
          origin,
        },
        peer: { peerMessageId: peerIdOf(p.operationId), fromSessionId: p.from, toSessionId: p.to },
      });
      if (accepted.status === 'conflict') return { status: 'rejected', rejection: RESEND_MISMATCH };
      if (accepted.status === 'invalid') return { status: 'rejected', rejection: { reason: 'invalid-input', detail: 'the message cannot be accepted' } };
      // Thrown, so the MCP server answers with a generic error and a resend tries the same operation again.
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') throw new Error(`accepting the peer message ended ${accepted.status}`);
      // Only the call that created the operation owns it; a duplicate is checked below like any resend.
      if (accepted.status === 'accepted') this.owners.set(p.operationId, p.from);
      record = await this.store.get(p.operationId);
    }
    // Checked again here, inside the target's queue, with the record this call will use (r2-P1-3).
    const mismatch: Refusal | undefined = record === undefined ? { reason: 'invalid-input', detail: 'this operation is not a message' } : await this.recordMismatch(record, p);
    if (mismatch !== undefined || record?.kind !== 'peer-message') return { status: 'rejected', rejection: mismatch ?? { reason: 'invalid-input', detail: 'this operation is not a message' } };
    this.origins.set(p.operationId, origin);
    const fresh = record.delivery.state === 'pending';
    if (fresh) {
      if (this.closing) return shuttingDown;
      // A busy target gets the message inside its running turn (SP-05).
      await this.dispatchPending(p.operationId, {
        origin,
        entry: (await this.inMainTurn(target)) ? { kind: 'insert' } : { kind: 'new-turn' },
      });
      record = (await this.store.get(p.operationId)) ?? record;
    }
    if (record.kind !== 'peer-message') throw new Error('the peer message record changed kind');
    this.publishPeer(record, p);
    return {
      status: fresh ? 'accepted' : 'duplicate',
      peerMessageId: peerIdOf(p.operationId),
      operationId: p.operationId,
      delivery: record.delivery.state,
    };
  }

  /** Who a payload comes from: as dispatched in this process, else as stored at acceptance (C-01), else not the user. */
  private async originOf(operationId: OperationId): Promise<MessageOrigin> {
    const known = this.origins.get(operationId);
    if (known !== undefined) return known;
    const record = await this.store.get(operationId);
    if (record?.kind === 'user-message') return { kind: 'user' };
    return (record?.kind !== 'provision' ? record?.context.origin : undefined) ?? { kind: 'system' };
  }

  /** `peerMessage.updated` (stored from T022 on, read back by the PeerMessage repository). */
  private publishPeer(record: PayloadDelivery, p: PendingConfirmation): void {
    const message: PeerMessage = {
      id: peerIdOf(record.operationId),
      operationId: record.operationId,
      sourceCallRef: record.sourceCallRef ?? p.sourceCallRef,
      fromSessionId: p.from,
      toSessionId: p.to,
      ...(record.target.nativeSessionRef !== undefined && {
        toNativeSessionRef: record.target.nativeSessionRef,
      }),
      text: record.payload,
      payloadHash: record.payloadHash,
      entry: record.context.entry.kind,
      delivery: record.delivery,
      createdAt: record.acceptedAt,
    };
    this.options.publish({ type: 'peerMessage.updated', message });
  }

  // ---- runtime sessions -----------------------------------------------------------------------------

  /** The session's runtime settings: its model and its agent's instructions (no MCP mount, C-07). */
  private async settingsOf(session: LogicalSession): Promise<SessionSettings> {
    const agent: AgentDefinition | undefined = await this.repos.agents.get(session.agent.id);
    return {
      model: session.requestedModel,
      readOnly: false,
      ...(agent !== undefined && { instructions: agent.instructions }),
    };
  }

  /** The native session bound to a GUI session: the one its provision created (contracts keep no binding). */
  private async binding(sessionId: SessionId): Promise<string | undefined> {
    const record = await this.store.get(provisionOp(sessionId));
    if (record?.delivery.state !== 'sent') return undefined;
    const last = record.delivery.attempts.at(-1);
    return record.target.nativeSessionRef ?? (last?.state === 'sent' ? last.nativeRef.sessionRef : undefined);
  }

  /**
   * Creates the session's runtime session once, as a provision delivery (CR2 §3): a lost create response
   * leaves it unknown for the user, and it is never created a second time on its own.
   */
  private async ensureProvisioned(session: LogicalSession): Promise<Provisioned> {
    const closing: Provisioned = { ok: false, code: 'runtime_unavailable', message: 'The application is closing', retryable: false, mayHaveSideEffects: false };
    if (this.closing) return closing;
    const operationId = provisionOp(session.id);
    let record = await this.store.get(operationId);
    if (record === undefined) {
      const { runtime } = session.requestedModel;
      if (!(this.options.isRuntimeAvailable?.(runtime) ?? true))
        return {
          ok: false,
          code: 'runtime_unavailable',
          message: `${runtime} is not available on this computer`,
          retryable: false,
          mayHaveSideEffects: false,
        };
      const preallocatedRef = runtime === 'claude' ? this.options.uuid() : undefined;
      const spec = {
        runtime,
        sessionId: session.id,
        cwd: session.cwd,
        ...(await this.settingsOf(session)),
        ...(preallocatedRef !== undefined && { preallocatedRef }),
      };
      const accepted = await this.delivery.accept({
        kind: 'provision',
        operationId,
        payloadHash: await this.options.hashPayload(JSON.stringify(spec)),
        proposalRevision: 0,
        target: {
          sessionId: session.id,
          provision: {
            operationId,
            bindingKey: `session:${session.id}`,
            state: 'pending',
            preallocated: preallocatedRef !== undefined,
            ...(preallocatedRef !== undefined && {
              nativeSessionRef: preallocatedRef,
            }),
          },
        },
        at: this.options.now(),
        spec,
      });
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
        return {
          ok: false,
          code: 'storage_failed',
          message: 'Starting the session could not be recorded',
          retryable: true,
          mayHaveSideEffects: false,
        };
      }
      record = await this.store.get(operationId);
    }
    if (record?.delivery.state === 'pending') {
      if (this.closing) return closing;
      const outcome = await this.delivery.dispatch(operationId);
      if (outcome.status === 'sent') await this.setActivity(session.id, 'idle');
      record = await this.store.get(operationId);
    }
    const ref = await this.binding(session.id);
    if (ref !== undefined) {
      this.runtimes.bind(session.id, ref);
      return { ok: true, nativeSessionRef: ref };
    }
    if (record?.delivery.state === 'unknown') {
      return {
        ok: false,
        code: 'unknown_outcome',
        message: 'It is not known whether the session was started; it is not started again',
        retryable: false,
        mayHaveSideEffects: true,
      };
    }
    return {
      ok: false,
      code: 'runtime_unavailable',
      message: 'The session could not be started',
      retryable: true,
      mayHaveSideEffects: false,
    };
  }

  /** Before a claim (DeliveryOptions.prepareTarget): the target session is resumed when it is not open. */
  private async prepareTarget(record: PayloadDelivery): Promise<void> {
    const ref = record.target.nativeSessionRef;
    const sessionId = record.target.sessionId;
    if (ref === undefined || sessionId === undefined || this.runtimes.isOpen(ref)) return;
    const session = await this.repos.sessions.get(sessionId);
    const settings = session === undefined ? record.context.session : await this.settingsOf(session);
    await this.runtimes.resumeSession(record.context.runtime, {
      sessionId,
      nativeSessionRef: ref,
      cwd: record.context.cwd,
      ...settings,
    });
    await this.setActivity(sessionId, 'idle');
  }

  /** Dispatches a delivery that is still pending; returns its state afterwards. */
  private async dispatchPending(operationId: OperationId, options: { origin?: MessageOrigin; entry?: DispatchEntry }): Promise<'sent' | 'unknown' | 'pending'> {
    const record = await this.store.get(operationId);
    if (record === undefined) return 'pending';
    if (record.delivery.state !== 'pending') return record.delivery.state;
    const outcome = await this.dispatchOne(operationId, options);
    return outcome?.status === 'sent' ? 'sent' : outcome?.status === 'unknown' ? 'unknown' : 'pending';
  }

  /**
   * One dispatch; undefined when closing began (nothing new reaches a runtime then, r2-P1-4). A user message
   * that was sent is registered for its echo from the outcome (r1-P1-9, r2-P1-7).
   */
  private async dispatchOne(operationId: OperationId, options: { origin?: MessageOrigin; entry?: DispatchEntry }): Promise<DispatchOutcome | undefined> {
    if (this.closing) return undefined;
    const outcome: DispatchOutcome = await this.delivery.dispatch(operationId, options);
    if (outcome.status === 'sent') {
      this.expectEcho(await this.store.get(operationId), outcome.attemptId);
      await this.settled(operationId, outcome.attemptId);
    }
    return outcome;
  }

  // ---- escalations ----------------------------------------------------------------------------------

  /** A delivery-unknown item becomes one escalation per attempt; an earlier user decision is kept. */
  private async escalateDelivery(item: DeliveryEscalation): Promise<void> {
    const sessionId = item.target.sessionId;
    if (sessionId === undefined) return;
    if (item.deliveryKind === 'user-message') {
      // Contracts have no escalation ref for a user's own message: the session shows it is reconciling.
      await this.setActivity(sessionId, 'reconciling');
      return;
    }
    const ref: Escalation['ref'] =
      item.deliveryKind === 'provision'
        ? {
            kind: 'provision',
            operationId: item.operationId,
            blocked: item.blocked ?? [],
          }
        : item.deliveryKind === 'peer-message'
          ? { kind: 'peerMessage', peerMessageId: peerIdOf(item.operationId) }
          : undefined;
    if (ref === undefined) return;
    const id = deliveryEscalationId(item.key);
    if ((await this.repos.escalations.get(id)) !== undefined) return;
    const escalation: Escalation = {
      id,
      rootSessionId: sessionId,
      fromSessionId: sessionId,
      kind: 'delivery-unknown',
      title: item.deliveryKind === 'provision' ? 'Session start outcome unknown' : 'Message delivery outcome unknown',
      // Fixed words only: the adapter's detail may quote paths or content.
      detail: `reason: ${item.reason}; duplicate risk on retry: ${item.duplicateRisk}`,
      ref,
      state: 'open',
      createdAt: this.options.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
  }

  /** An attempt turned out sent: its open delivery-unknown escalation, if any, is closed by the system. */
  private async settled(operationId: OperationId, attemptId: AttemptId): Promise<void> {
    const escalation = await this.repos.escalations.get(deliveryEscalationId(`${operationId}/${attemptId}`));
    if (escalation?.state === 'open') await this.closeEscalation(escalation, 'resolved');
    const record: StoredDelivery | undefined = await this.store.get(operationId);
    const sessionId = record?.target.sessionId;
    if (record?.kind === 'user-message' && sessionId !== undefined) {
      const session = await this.repos.sessions.get(sessionId);
      if (session?.activity === 'reconciling')
        await this.setActivity(sessionId, this.runtimes.isOpen(record.target.nativeSessionRef ?? '') ? 'idle' : 'closed');
    }
  }

  private async closeEscalation(
    escalation: Escalation,
    state: 'approved' | 'declined' | 'resolved',
    by: 'user' | 'system' = state === 'resolved' ? 'system' : 'user',
  ): Promise<void> {
    const closed: Escalation = {
      ...escalation,
      state,
      resolvedBy: by,
      resolvedAt: this.options.now(),
    };
    await this.repos.escalations.upsert(closed);
    this.options.publish({ type: 'escalation.updated', escalation: closed });
  }

  // ---- runtime events -------------------------------------------------------------------------------

  /**
   * Every adapter event (tokens already redacted by SessionRuntimes): stored in order in its session's
   * queue, then pushed. Deltas are not stored and are pushed at once. An event whose write fails is not
   * pushed (r1-P1-7): the Snapshot and the event stream must not disagree.
   */
  private record(event: RuntimeEvent): void {
    if (this.closed) return;
    if (event.type === 'runtime.exited') {
      this.runtimes.markExited(event.sessionIds);
      for (const sessionId of event.sessionIds) void this.setActivity(sessionId, event.expected ? 'closed' : 'error').catch(() => undefined);
      this.options.publish(event);
      return;
    }
    if (event.type === 'message.delta' || event.type === 'item.outputDelta') {
      this.options.publish(event);
      return;
    }
    const sessionId = sessionOf(event);
    if (sessionId === undefined) {
      this.options.publish(event);
      return;
    }
    void this.serial(sessionKey(sessionId), () => this.apply(event)).catch((error: unknown) => {
      // The code only: the error may quote what was being written.
      this.log(`recording ${event.type} of ${sessionId} failed (${errorName(error)}); it is not pushed`);
      // No AppEvent tells the renderer to reload its Snapshot (contracts gap): remembered for when there is one.
      this.unsynced.add(sessionId);
    });
  }

  private async apply(event: Exclude<RuntimeEvent, { type: 'runtime.exited' | 'message.delta' | 'item.outputDelta' }>): Promise<void> {
    if (this.closed) return;
    const { conversations } = this.repos;
    switch (event.type) {
      case 'session.activity':
        await this.setActivity(event.sessionId, event.activity);
        break;
      case 'turn.updated':
        await conversations.upsertTurn(event.turn);
        break;
      case 'message.completed':
        // The user's own message was stored by session.send under the renderer's ID; its echo is not kept.
        // A native sub-agent's prompt is a user message too, and is kept (R-13).
        if (this.isEcho(event.message)) return;
        await conversations.appendMessage(event.message);
        break;
      case 'item.updated': {
        const { item } = event;
        await conversations.upsertItem(item);
        if (item.kind === 'fileChange' && item.state !== 'declined') {
          const session = await this.repos.sessions.get(item.sessionId);
          this.written.add(
            item.sessionId,
            item.changes.flatMap((c) => [c.path, ...(c.movePath ? [c.movePath] : [])]),
            session?.cwd ?? '',
          );
        }
        break;
      }
      case 'permission.updated':
        await conversations.upsertPermissionRequest(event.request);
        if (event.request.state === 'withdrawn') await this.gate.withdrawn(event.request);
        await this.followHold(event.request);
        break;
      case 'nativeTask.updated':
        await conversations.upsertNativeTask(event.task);
        break;
      case 'usage.tokens':
        if (event.usage.nativeTaskId === undefined) this.usage.set(event.usage.sessionId, event.usage);
        break;
      case 'model.observed':
        await this.updateSession(event.sessionId, (s) => ({
          ...s,
          observedModel: event.observed,
        }));
        break;
      default:
        break;
    }
    const stored = sessionOf(event);
    if (stored !== undefined) this.unsynced.delete(stored);
    this.options.publish(event);
  }

  /** Remembers a user message this process dispatched, so its runtime echo is recognised. */
  /** Registers the echo of a user message that the runtime accepted with attempt `attemptId`. */
  private expectEcho(record: StoredDelivery | undefined, attemptId: AttemptId): void {
    const sessionId = record?.target.sessionId;
    if (record?.kind !== 'user-message' || sessionId === undefined) return;
    const attempt = record.delivery.attempts.find((a) => a.attemptId === attemptId);
    if (attempt?.state !== 'sent') return;
    const echo: Echo = {
      clientMessageIds: [attempt.clientMessageId],
      ...(attempt.nativeRef.turnRef !== undefined && { turnRef: attempt.nativeRef.turnRef }),
      text: record.payload,
    };
    // A few per session: an echo that never comes must not keep the list growing.
    this.echoes.set(sessionId, [...(this.echoes.get(sessionId) ?? []), echo].slice(-20));
  }

  /**
   * The runtime's echo of a user message this process sent: a session-level (no native task) user message
   * from the user with the same text, under the attempt's clientMessageId (Claude) or in the turn the
   * dispatch started (Codex), and in that turn whenever both are known. Without that proof it is kept: a
   * duplicate is better than a lost message (r2-P1-7). Consumed once.
   */
  private isEcho(message: Message): boolean {
    if (message.role !== 'user' || message.origin.kind !== 'user' || message.nativeTaskId !== undefined) return false;
    const list = this.echoes.get(message.sessionId) ?? [];
    const index = list.findIndex((e) => {
      if (message.text !== e.text) return false;
      const sameTurn = e.turnRef !== undefined && message.turnId === e.turnRef;
      const turnAgrees = e.turnRef === undefined || message.turnId === undefined || sameTurn;
      return (e.clientMessageIds.includes(message.id) && turnAgrees) || sameTurn;
    });
    if (index < 0) return false;
    this.echoes.set(
      message.sessionId,
      list.filter((_, i) => i !== index),
    );
    return true;
  }

  /**
   * Writes the user's message once under its renderer ID and confirms it is this session's (r2-P1-8):
   * message IDs are unique across sessions, and a write under an ID another session holds is ignored by
   * the store, so `taken` means it is not here. The same message already here is `written`.
   */
  private async writeUserMessage(sessionId: SessionId, id: MessageId, text: string, createdAt: Timestamp): Promise<'written' | 'taken'> {
    const same = (m: Message | undefined) => m !== undefined && m.role === 'user' && m.origin.kind === 'user' && m.text === text && m.nativeTaskId === undefined;
    const before = (await this.repos.conversations.get(sessionId)).messages.find((m) => m.id === id);
    if (before !== undefined) return same(before) ? 'written' : 'taken';
    const message: Message = { id, sessionId, role: 'user', origin: { kind: 'user' }, text, attachments: [], createdAt };
    await this.repos.conversations.appendMessage(message);
    const after = (await this.repos.conversations.get(sessionId)).messages.find((m) => m.id === id);
    if (!same(after)) return 'taken';
    this.options.publish({ type: 'message.completed', message });
    return 'written';
  }

  /** The user message of a user-message operation, written once under its renderer ID (r1-P1-8). */
  private async ensureUserMessage(record: PayloadDelivery): Promise<void> {
    const sessionId = record.target.sessionId;
    if (record.kind !== 'user-message' || sessionId === undefined) return;
    const id = MessageId.parse(record.operationId.slice('user-message:'.length));
    if ((await this.writeUserMessage(sessionId, id, record.payload, record.acceptedAt)) === 'taken') this.log(`the message of ${record.operationId} has an ID another message holds`);
  }

  // ---- session records ------------------------------------------------------------------------------

  /**
   * R-05: a session whose request is held for the user shows `waiting-user`, which no adapter reports; once
   * nothing of it waits any more it is back to running, or idle when its turn ended meanwhile (T021).
   */
  private async followHold(request: PermissionRequest): Promise<void> {
    const { sessionId } = request;
    const conversation = await this.repos.conversations.get(sessionId);
    // Only what blocks the session itself counts: a background sub-agent waiting for the user leaves an idle
    // session idle, so a new message still starts a turn (t021-r1-P1-2, R-13).
    const main = runningMainTurn(conversation);
    const waits = (r: PermissionRequest) =>
      r.state === 'held' && r.hold?.reason === 'awaiting-user' && (r.nativeTaskId === undefined || (main !== undefined && r.turnId === main.id));
    if (waits(request)) {
      await this.updateSession(sessionId, (s) => (s.activity === 'running' || s.activity === 'idle' ? { ...s, activity: 'waiting-user' } : undefined));
      return;
    }
    if ((await this.repos.sessions.get(sessionId))?.activity !== 'waiting-user') return;
    if (conversation.permissionRequests.some(waits)) return;
    await this.setActivity(sessionId, main !== undefined ? 'running' : 'idle');
  }

  /**
   * A message joins the running turn only when the session's own turn really runs: busy is not enough, since
   * waiting-user may come from a request outside any turn (t021-r1-P1-2).
   */
  private async inMainTurn(session: Pick<LogicalSession, 'id' | 'activity'>): Promise<boolean> {
    return busy(session) && runningMainTurn(await this.repos.conversations.get(session.id)) !== undefined;
  }

  private async setActivity(sessionId: SessionId, activity: LogicalSession['activity']): Promise<void> {
    await this.updateSession(sessionId, (s) => {
      if (s.activity === activity) return undefined;
      const usage = activity === 'running' ? undefined : this.usage.get(sessionId);
      return {
        ...s,
        activity,
        ...(usage !== undefined && { tokenUsage: usage }),
      };
    });
  }

  /** Read-modify-write of a session record, one at a time per session; `mutate` returns undefined for no change. */
  private updateSession(
    sessionId: SessionId,
    mutate: (s: LogicalSession) => LogicalSession | undefined,
    expectedRevision?: number,
  ): Promise<LogicalSession | 'stale' | undefined> {
    return this.serial(`row:${sessionId}`, async () => {
      const { sessions } = this.repos;
      const current = await sessions.get(sessionId);
      if (current === undefined) return undefined;
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return 'stale';
      const next = mutate(current);
      if (next === undefined) return current;
      const saved = await sessions.update({ ...next, updatedAt: this.options.now() }, current.revision);
      if (saved.status === 'stale') return 'stale';
      this.options.publish({ type: 'session.updated', session: saved.record });
      return saved.record;
    });
  }

  private async updateFromCommand(
    requestId: Success['requestId'],
    sessionId: SessionId,
    expectedRevision: number,
    mutate: (s: LogicalSession) => LogicalSession,
  ): Promise<CommandResult> {
    const result = await this.updateSession(sessionId, mutate, expectedRevision);
    if (result === undefined) return fail(requestId, 'not_found', 'Unknown session');
    if (result === 'stale') return fail(requestId, 'stale_revision', 'The session has changed since it was loaded', { retryable: true });
    return ok(requestId, { revision: result.revision });
  }

  /** Runs `fn` after everything queued under `key`; a failure does not block what comes next. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  private log(message: string): void {
    this.options.log?.(`[sessions] ${message}`);
  }
}

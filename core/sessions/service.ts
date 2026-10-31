// Ordinary sessions over the ports (T017): the commands of the renderer, the runtime events that become the
// stored conversation, the GUI MCP server's `send_message`, and restart / exit. Workflow execution belongs
// to the workflow engine (T024), attached with `attachWorkflow`; this service only gives it workflow
// sessions, their deliveries and their escalations. Cross-tool transfer (T023) belongs to the transfer
// service, attached with `attachTransfer` the same way.
//
// Every payload reaches a runtime through the CR-2 delivery service (T008); a session's runtime session is
// itself created as a provision delivery, so a lost create response is never followed by a second create.
// Approval requests go through the permission gate (policy first, the user for escalations; R-05, R-08).
import {
  type AgentDefinition,
  type AppEvent,
  type Command,
  type CommandResult,
  type DeliveryTarget,
  type Escalation,
  EscalationId,
  type InstanceId,
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
  type TaskId,
  type Timestamp,
  type Turn,
  type WaitForFileToolInput,
  type WaitForFileToolResult,
  type DeliveryState,
  type NodeId,
  type WorkflowInstance,
  AttemptId,
} from '../../contracts';
import { DeliveryService, type DeliveryEscalation, type DispatchOutcome, type PayloadDelivery, type RecoveryReport } from '../delivery';
import { type AbortLike, LockCoordinator, type LockCoordinatorOptions, type LockEscalation } from '../locks';
import type {
  AppRepositories,
  ClaimInput,
  ClaimResult,
  Conversation,
  DeliveryStore,
  DispatchEntry,
  HandoffMeta,
  McpMount,
  PayloadContext,
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
export type CommandOf<T extends Command['type']> = Extract<Command, { type: T }>;
export type WorkflowSession = Extract<LogicalSession, { kind: 'workflow' }>;

/**
 * What the workflow engine (T024) takes over from the session service, attached by the main process. The
 * service keeps sessions, delivery and permissions; the engine decides what a workflow does with them.
 */
export interface WorkflowHooks {
  start(command: CommandOf<'workflow.start'>): Promise<CommandResult>;
  /** A workflow escalation answered with `escalation.respond`; undefined when it is not one of the engine's. */
  respond(escalation: Escalation, command: CommandOf<'escalation.respond'>): Promise<CommandResult | undefined>;
  /** The session's own turn ended (not a native sub-agent's): formal handoffs queued for it may go now (SP-05). */
  turnEnded(sessionId: SessionId): void;
  /** The node's part of a workflow session's instructions (rules, task, rework limit; R-05). */
  briefing(session: WorkflowSession): Promise<string | undefined>;
  /** Whether a formal handoff may still go: not when its task stopped at a limit (R-05, T024 r2-P1-1). */
  mayDeliver(handoff: HandoffMeta): Promise<boolean>;
  /**
   * Whether a user message may be dispatched now (T024 r3-P1-2): a workflow's first message only to the root
   * session of its own run, once that run exists (`wait` until then); `cancel` when its session belongs
   * to anything else. Every other user message is `deliver`.
   */
  userMessageFate(record: StoredDelivery): Promise<'deliver' | 'wait' | 'cancel'>;
}

export type TransferCommand = CommandOf<'transfer.prepare' | 'transfer.confirm' | 'transfer.cancel'>;

/**
 * What the transfer service (T023, R-02) takes over from the session service. Every `transfer` delivery (a
 * proposal's payload, or the request for the source agent's note) is dispatched by it, in its own order
 * with the proposal's state, so a cancelled proposal never sends anything.
 */
export interface TransferHooks {
  execute(command: TransferCommand): Promise<CommandResult>;
  /**
   * A session's stored content changed (a turn, message, item or sub-agent written; T023 r2-P1-2): a draft of
   * it may finish now, or a proposal of it no longer holds. Called outside the session's queue.
   */
  contentChanged(sessionId: SessionId): void;
  /**
   * Asked synchronously right before a `transfer` delivery is claimed, with nothing awaited between the
   * answer and the claim (T023 r2-P1-1): false refuses the claim, which leaves the delivery pending.
   */
  claimAllowed(operationId: OperationId): boolean;
  /** Whether a `transfer` delivery may still go (the gate in `dispatchOne`). */
  mayDispatch(record: PayloadDelivery): Promise<boolean>;
  /** A session a transfer created: its provision is left to the transfer service at a restart. */
  isTarget(session: LogicalSession): boolean;
  /** Re-dispatches a `transfer` delivery the user retried, in the transfer's own order. */
  redeliver(operationId: OperationId): Promise<void>;
  /** Where an unknown transfer delivery, or a transfer target's provision, is shown: the source session. */
  escalationFor(item: DeliveryEscalation): Promise<{ ref: NonNullable<Escalation['ref']>; rootSessionId: SessionId } | undefined>;
  /** The user decided on an unknown delivery with `delivery.resolve` (already recorded). */
  deliveryResolved(operationId: OperationId, decision: 'wait' | 'cancel' | 'retry'): Promise<void>;
}

/** How a workflow payload enters its target: a formal handoff waits for the target's turn to end (SP-05). */
export type WorkflowEntry = 'after-turn' | 'insert-if-busy';

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
  /**
   * Same-folder file locks (T033, R-07): the file hash and the timers they need. Absent: nothing is locked
   * (tests that are not about locks).
   */
  locks?: Pick<LockCoordinatorOptions, 'hashFile' | 'setTimer' | 'holdMs' | 'waitMs' | 'isIgnored'>;
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
  /** Both sessions in one workflow instance whose start-time consent covers them (R-11). */
  instanceId?: InstanceId;
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
  /** Same-folder file locks (R-07), when the options gave what they need. */
  readonly locks: LockCoordinator | undefined;
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
  private workflow: WorkflowHooks | undefined;
  private transfer: TransferHooks | undefined;
  /**
   * Turns a dispatch's ack named that were not seen to end yet, per session (T023 r1-P1-4): the session is
   * not at its turn boundary while one is here, even before the runtime reported it running. Only an end of
   * that turn, the runtime's exit or a restart clears one (as T024 r2-P1-2 waits for the dispatched turn).
   */
  private readonly ackedTurns = new Map<SessionId, Set<string>>();
  /** The last own turns of each session seen to end, so an ack read after its turn's end adds nothing. */
  private readonly endedTurns = new Map<SessionId, string[]>();
  /**
   * How many content writes each session's conversation had in this process, counted synchronously as each
   * commits (T023 r2-P1-1): a transfer gate that saw the same count right before the claim saw no change.
   */
  private readonly contentWrites = new Map<SessionId, number>();
  /**
   * A formal handoff dispatched to a session whose turn has not been seen to end yet (SP-05, T024 r1-P1-2/3):
   * the main turns the session had before the dispatch, and the new one once it started. A replayed old turn
   * is in `known` and never ends the wait; until it ends, no other handoff goes to that session.
   */
  private readonly handoffTurns = new Map<SessionId, { operationId: OperationId; known: Set<string>; started?: string; expected?: string }>();

  constructor(private readonly options: SessionServiceOptions) {
    // Storage only through the write gate: once shutdown returned, nothing reaches it (r2-P1-4).
    this.repos = gated(options.repositories, () => this.closed);
    this.store = gated(options.store, () => this.closed);
    this.written = new WrittenPaths(options.written);
    if (options.locks !== undefined) {
      this.locks = new LockCoordinator({
        ...options.locks,
        now: () => options.now(),
        resolveRealPath: (path) => options.resolveRealPath(path),
        escalate: (escalation) => this.lockEscalation(escalation),
        publish: (locks) => options.publish({ type: 'locks.updated', locks, at: options.now() }),
        log: (message) => options.log?.(message),
      });
    }
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
      rootOf: (session) => this.rootOf(session),
      ...(this.locks !== undefined && { locks: this.locks }),
    });
    this.runtimes = new SessionRuntimes({
      createAdapter: (runtime, sessionId) => options.createAdapter(runtime, sessionId),
      mountMcp: (sessionId) => options.mountMcp(sessionId),
      listModels: (runtime) => options.listModels(runtime),
      onOpened: (sessionId, cwd) => {
        // The locks need its folder and mode before its first write or its folder's first change (R-07).
        if (this.locks !== undefined) void this.repos.sessions.get(sessionId).then((s) => s && this.locks?.track(s)).catch(() => undefined);
        options.onSessionOpened?.(sessionId, cwd);
      },
      onClosed: (sessionId) => {
        this.locks?.closed(sessionId);
        return options.onSessionClosed?.(sessionId);
      },
      onEvent: (event) => this.record(event),
      ...(options.sleep !== undefined && { sleep: (ms: number) => this.options.sleep!(ms) }),
    });
    // A transfer's claim is refused when its gate's view went out of date, decided synchronously in the call
    // that makes the claim (T023 r2-P1-1); every other claim goes straight to the store.
    const store = this.store;
    const claimGuarded = new Proxy(store, {
      get: (target, key): unknown =>
        key === 'claim'
          ? (input: ClaimInput): Promise<ClaimResult> =>
              this.transfer !== undefined && !this.transfer.claimAllowed(input.operationId) ? Promise.resolve({ status: 'revision-changed' }) : target.claim(input)
          : Reflect.get(target, key),
    });
    this.delivery = new DeliveryService({
      store: claimGuarded,
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

  /** The workflow engine (T024); without one, `workflow.start` answers `unsupported`. */
  attachWorkflow(hooks: WorkflowHooks): void {
    this.workflow = hooks;
  }

  /** The transfer service (T023); without one, `transfer.*` answers `unsupported`. */
  attachTransfer(hooks: TransferHooks): void {
    this.transfer = hooks;
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
      for (const turn of conversation.turns)
        if (turn.state === 'running') {
          this.contentWrite(session.id);
          await repositories.conversations.upsertTurn({ ...turn, state: 'interrupted', endedAt: at });
        }
      for (const item of conversation.items) {
        const ended = endedByExit(item, at);
        if (ended !== undefined) {
          this.contentWrite(session.id);
          await repositories.conversations.upsertItem(ended);
        }
      }
      for (const task of conversation.nativeTasks)
        if (task.state === 'running') {
          this.contentWrite(session.id);
          await repositories.conversations.upsertNativeTask({ ...task, state: 'stopped', endedAt: at });
        }
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
      // Nothing in this process holds the request or the message waiting for confirmation any more. A
      // report's question is not held anywhere: the report itself was delivered, so it stays for the user.
      if (escalation.kind === 'permission' || (escalation.kind === 'confirmation' && escalation.ref?.kind !== 'report')) await this.closeEscalation(escalation, 'resolved');
    }
    // A message accepted before a crash but never written is written now (r1-P1-8).
    for (const state of ['pending', 'unknown'] as const) {
      for (const record of await this.store.listByState(state)) if (record.kind === 'user-message') await this.ensureUserMessage(record);
    }
    const userMessages: OperationId[] = [];
    const handoffs: { operationId: OperationId; sessionId: SessionId }[] = [];
    // A workflow node's session is created for the work sent to it: a provision with none (a crash between
    // the two acceptances) waits for the first handoff instead of starting a runtime now (T024 r1-P2-1).
    const workflowSessions = new Set((await repositories.sessions.list()).filter((s) => s.kind === 'workflow').map((s) => s.id));
    // A transfer's payloads and its target's provision go in the transfer's own order, after this (T023).
    const transfer = this.transfer;
    const transferTargets = new Set(transfer === undefined ? [] : (await repositories.sessions.list()).filter((s) => transfer.isTarget(s)).map((s) => s.id));
    const withWork = new Set<string>();
    for (const state of ['pending', 'unknown', 'sent'] as const)
      for (const record of await this.store.listByState(state)) if (record.kind !== 'provision' && record.target.sessionId !== undefined) withWork.add(record.target.sessionId);
    const report = await this.delivery.recover({
      select: (record) => {
        if (record.kind === 'provision') {
          if (transferTargets.has(record.spec.sessionId)) return 'skip';
          return workflowSessions.has(record.spec.sessionId) && !withWork.has(record.spec.sessionId) ? 'skip' : {};
        }
        if (record.kind === 'transfer' && transfer !== undefined) return 'skip';
        // A formal handoff goes through the one queue of its target (T024 r1-P1-2), below.
        if (record.kind === 'handoff' && record.target.sessionId !== undefined) {
          handoffs.push({ operationId: record.operationId, sessionId: record.target.sessionId });
          return 'skip';
        }
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
    for (const { operationId, sessionId } of handoffs) {
      try {
        await this.deliverWorkflow(operationId, sessionId, 'after-turn');
      } catch (error) {
        report.failed.push({ operationId, detail: errorName(error) });
      }
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
    // A write held for a lock is declined now, like every other approval from here on (R-14).
    this.locks?.beginClose();
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
    // Also the after-the-fact check for writes no lock covered (R-07, SP-06 W5/W6).
    this.locks?.fileChanged(sessionId, path);
  }

  /** `wait_for_file` (R-07) of the calling session; not in same-folder mode, nothing is ever locked. */
  waitForFile(input: WaitForFileToolInput, ctx: { caller: SessionId; signal?: AbortLike }): Promise<WaitForFileToolResult> {
    if (this.locks === undefined || this.closing) return Promise.resolve(this.closing ? { status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is closing' } } : { status: 'not-locked' });
    return this.locks.waitForFile(input, ctx.caller, ctx.signal);
  }

  /**
   * A lock escalation (R-07) at the session's root: for the user to know, never something to approve. The
   * write it is about was already refused, or already happened.
   */
  private async lockEscalation(e: LockEscalation): Promise<EscalationId | undefined> {
    if (this.closing) return undefined;
    const session = await this.repos.sessions.get(e.sessionId);
    if (session === undefined || this.closing) return undefined;
    const root = await this.rootOf(session);
    const escalation: Escalation = {
      id: EscalationId.parse(`lock-${this.options.uuid()}`),
      ...(root.instanceId !== undefined && { instanceId: root.instanceId }),
      rootSessionId: root.rootSessionId,
      fromSessionId: e.sessionId,
      kind: e.kind,
      title: e.title,
      detail: e.detail,
      ref: { kind: 'lock', path: e.path, sessionId: e.sessionId, ...(e.holderSessionId !== undefined && { holderSessionId: e.holderSessionId }) },
      state: 'open',
      createdAt: this.options.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
    return escalation.id;
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
        if (this.workflow !== undefined) return this.workflow.start(command);
        return fail(command.requestId, 'unsupported', `${command.type} is not available yet`);
      case 'transfer.prepare':
      case 'transfer.confirm':
      case 'transfer.cancel':
        if (this.transfer !== undefined) return this.transfer.execute(command);
        return fail(command.requestId, 'unsupported', `${command.type} is not available yet`);
      case 'project.save': {
        const saved = await this.repos.projects.save(command.project, command.expectedRevision);
        if (saved.status === 'stale') return fail(command.requestId, 'stale_revision', 'The project has changed since it was loaded', { retryable: true });
        this.options.publish({ type: 'project.updated', project: saved.record });
        return ok(command.requestId, { revision: saved.record.revision });
      }
      // Ending a run and the task pipeline come with T032 (contracts 0.6).
      case 'workflow.complete':
      case 'workflow.cancel':
      case 'task.retryCleanup':
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
    return this.sendUserMessage(requestId, session, messageId, text);
  }

  /** The user's message to a session, written under its ID and sent once through the delivery service. */
  private async sendUserMessage(requestId: Success['requestId'], session: LogicalSession, messageId: MessageId, text: string): Promise<CommandResult> {
    const sessionId = session.id;
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
      // Stopped by the user: its locks go even if background work goes on (R-07).
      this.locks?.stopped(session.id);
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
    if (escalation.kind === 'lock-timeout' || escalation.kind === 'unlocked-write') {
      // Only for the user to know (R-07): the write was already refused, or already happened.
      await this.closeEscalation(escalation, 'resolved', 'user');
      this.locks?.escalationClosed(escalation.id);
      return ok(requestId);
    }
    const handled = await this.workflow?.respond(escalation, command);
    if (handled !== undefined) return handled;
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
    // The user decided on that attempt: its turn is no longer waited for (T024 r1-P1-2).
    for (const [sessionId, mark] of this.handoffTurns) if (mark.operationId === attempt.operationId) this.handoffTurns.delete(sessionId);
    if (decision === 'retry') {
      await this.retryPending(attempt.operationId);
      if (escalation.ref?.kind === 'provision') for (const blocked of escalation.ref.blocked) await this.retryPending(blocked);
    }
    // A transfer follows the user's decision on its target or payload (T023).
    if (decision === 'cancel') await this.transfer?.deliveryResolved(attempt.operationId, decision);
    return ok(requestId);
  }

  /** A pending delivery the user retried: a formal handoff waits in its target's queue like any other (r1-P1-2). */
  private async retryPending(operationId: OperationId): Promise<void> {
    const record = await this.store.get(operationId);
    // A transfer delivery goes in its transfer's order, which a cancel also takes (T023).
    if (record?.kind === 'transfer' && this.transfer !== undefined) {
      await this.transfer.redeliver(operationId);
      return;
    }
    if (record?.kind === 'handoff' && record.target.sessionId !== undefined) {
      await this.deliverWorkflow(operationId, record.target.sessionId, 'after-turn');
      return;
    }
    await this.dispatchPending(operationId, { origin: await this.originOf(operationId) });
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
    const instanceId = await this.consentedInstance(caller, target);
    const pending: PendingConfirmation = {
      from: caller.id,
      to: target.id,
      content: input.content,
      operationId: ctx.operationId,
      sourceCallRef: ctx.sourceCallRef,
      ...(instanceId !== undefined && { instanceId }),
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
    // Inside one started instance the start-time consent covers it (R-11); anywhere else the user confirms.
    const crossTool = caller.requestedModel.runtime !== target.requestedModel.runtime && pending.instanceId === undefined;
    if (crossTool && (await this.store.get(pending.operationId)) === undefined) {
      const id = EscalationId.parse(`confirm-${pending.operationId}`);
      const existing = await this.repos.escalations.get(id);
      // Re-checked after every wait, before anything is written (r2-P1-6).
      if (this.closing) return rejected('shutting-down', 'the GUI is closing');
      if (existing === undefined) {
        // A workflow session's question goes to its instance's root (R-05, T024 r1-P1-6).
        const root = await this.rootOf(caller);
        const escalation: Escalation = {
          id,
          ...(root.instanceId !== undefined && { instanceId: root.instanceId }),
          rootSessionId: root.rootSessionId,
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
        peer: { peerMessageId: peerIdOf(p.operationId), fromSessionId: p.from, toSessionId: p.to, ...(p.instanceId !== undefined && { instanceId: p.instanceId }) },
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
      ...(p.instanceId !== undefined && { instanceId: p.instanceId }),
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

  // ---- workflow sessions (T024) ---------------------------------------------------------------------

  /** True once closing began: the workflow engine starts nothing new either (R-14). */
  isClosing(): boolean {
    return this.closing;
  }

  /** Storage as this service reaches it: once shutdown returned, nothing gets through (r2-P1-4). */
  get storage(): { repositories: AppRepositories; store: DeliveryStore } {
    return { repositories: this.repos, store: this.store };
  }

  runtimeAvailable(runtime: Runtime): boolean {
    return this.options.isRuntimeAvailable?.(runtime) ?? true;
  }

  /** Whether a working folder resolves to a real folder (sessions are created only in those). */
  canResolve(cwd: string): boolean {
    return this.options.resolveRealPath(cwd) !== null;
  }

  /**
   * Creates the GUI session of a workflow node (R-06): agent and model from the node of the instance's pinned
   * template (C-13), folder scope from the node's write policy (read-only and exec-only nodes get no writable
   * root). `exists`: the ID already holds this same binding; `taken`: it holds anything else.
   */
  async createWorkflowSession(input: {
    sessionId: SessionId;
    instance: WorkflowInstance;
    nodeId: NodeId;
    taskId?: TaskId;
    cwd: string;
    parentId?: SessionId;
  }): Promise<'created' | 'exists' | 'taken' | 'unresolvable' | 'closing'> {
    const { sessionId, instance, nodeId, taskId, cwd, parentId } = input;
    const node = instance.template.nodes.find((n) => n.id === nodeId);
    if (node?.kind !== 'agent') return 'taken';
    // An existing session is this one only when everything the node gives it is the same (T024 r2-P1-4):
    // a session made from another revision of the node must not stand in for it.
    const same = (s: LogicalSession | undefined) =>
      s !== undefined &&
      s.kind === 'workflow' &&
      s.workflow.instanceId === instance.id &&
      s.workflow.nodeId === nodeId &&
      s.workflow.taskId === taskId &&
      s.cwd === cwd &&
      s.agent.id === node.agentId &&
      JSON.stringify([s.requestedModel.runtime, s.requestedModel.model, s.requestedModel.effort]) === JSON.stringify([node.model.runtime, node.model.model, node.model.effort]) &&
      (s.folderScope.writableRoots.length > 0) === (node.writePolicy === 'write');
    const existing = await this.repos.sessions.get(sessionId);
    if (existing !== undefined) return same(existing) ? 'exists' : 'taken';
    const root = this.options.resolveRealPath(cwd);
    if (root === null) return 'unresolvable';
    const agent = await this.repos.agents.get(node.agentId);
    const at = this.options.now();
    const session: WorkflowSession = {
      id: sessionId,
      revision: 0,
      kind: 'workflow',
      workflow: { instanceId: instance.id, nodeId, ...(taskId !== undefined && { taskId }) },
      title: node.label,
      agent: { id: node.agentId, revision: agent?.revision ?? 0 },
      requestedModel: node.model,
      observedModel: { source: 'unknown' },
      activity: 'closed',
      cwd,
      folderScope: { source: 'session-cwd', workspaceRoot: root, writableRoots: node.writePolicy === 'write' ? [root] : [], readableRoots: [] },
      ...(parentId !== undefined && { parentId }),
      createdAt: at,
      updatedAt: at,
    };
    if (this.closing) return 'closing';
    if ((await this.repos.sessions.create(session)) === 'exists') return same(await this.repos.sessions.get(sessionId)) ? 'exists' : 'taken';
    this.options.publish({ type: 'session.updated', session });
    return 'created';
  }

  /**
   * Where a workflow payload to this session goes (R-04 step 4): its bound native session, or else its
   * provision, recorded now but not dispatched (the payload is accepted and counted first).
   */
  async payloadTarget(sessionId: SessionId): Promise<DeliveryTarget | undefined> {
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const ref = await this.binding(sessionId);
    if (ref !== undefined) return { sessionId, nativeSessionRef: ref };
    const record = await this.acceptProvision(session);
    if ('ok' in record || record.target.provision === undefined) return undefined;
    return { sessionId, provision: record.target.provision };
  }

  /** What a payload to this session is stored with (C-01): runtime, original cwd, settings, its origin. */
  async payloadContext(sessionId: SessionId, origin: MessageOrigin): Promise<PayloadContext | undefined> {
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return undefined;
    return { runtime: session.requestedModel.runtime, cwd: session.cwd, entry: { kind: 'new-turn' }, session: await this.settingsOf(session), origin };
  }

  /**
   * Dispatches a pending workflow payload in its session's queue, in order with that session's events: its
   * provision first when needed. `after-turn` (a formal handoff) leaves it pending while the session's own
   * turn runs (SP-05), answering `queued`; `insert-if-busy` joins that turn.
   */
  deliverWorkflow(operationId: OperationId, sessionId: SessionId, entry: WorkflowEntry): Promise<DeliveryState | 'queued'> {
    return this.serial(sessionKey(sessionId), async (): Promise<DeliveryState | 'queued'> => {
      const record = await this.store.get(operationId);
      if (record === undefined || record.delivery.state !== 'pending') return record?.delivery.state ?? 'pending';
      const session = await this.repos.sessions.get(sessionId);
      if (this.closing || session === undefined) return 'pending';
      const provisioned = await this.ensureProvisioned(session);
      if (!provisioned.ok || this.closing) return 'pending';
      if (entry === 'after-turn') return this.dispatchHandoff(operationId, sessionId);
      const origin = await this.originOf(operationId);
      const current = (await this.repos.sessions.get(sessionId)) ?? session;
      const inTurn = await this.inMainTurn(current);
      return this.dispatchPending(operationId, { origin, entry: inTurn ? { kind: 'insert' } : { kind: 'new-turn' } });
    });
  }

  /**
   * The one gate of formal handoffs (SP-05, T024 r1-P1-2/3), in the target's queue: only the oldest pending
   * handoff to the session, only while no turn of its own runs (by the stored turns, which an old event
   * cannot undo, never by its activity), and only once the turn the previous handoff started has ended.
   * The gate always sends the oldest one, whichever handoff opened it, so one left pending (a resume that
   * failed) is never overtaken. It then starts a new turn; anything else waits (`queued`).
   */
  private async dispatchHandoff(operationId: OperationId, sessionId: SessionId): Promise<DeliveryState | 'queued'> {
    if (this.handoffTurns.has(sessionId)) return 'queued';
    const conversation = await this.repos.conversations.get(sessionId);
    if (runningMainTurn(conversation) !== undefined) return 'queued';
    const waiting = (await this.store.listByState('pending'))
      .filter((r) => r.kind === 'handoff' && r.target.sessionId === sessionId && r.outcome === undefined)
      .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : a.operationId < b.operationId ? -1 : 1));
    const next = waiting[0];
    if (next === undefined) return 'queued';
    // A task stopped at a limit sends nothing more, queued handoffs included (r2-P1-1).
    if (next.kind === 'handoff' && next.handoff !== undefined && this.workflow !== undefined && !(await this.workflow.mayDeliver(next.handoff))) return 'queued';
    const known = new Set<string>(conversation.turns.filter((t) => t.nativeTaskId === undefined).map((t) => t.id));
    const mark: { operationId: OperationId; known: Set<string>; started?: string; expected?: string } = { operationId: next.operationId, known };
    this.handoffTurns.set(sessionId, mark);
    const state = await this.dispatchPending(next.operationId, { origin: await this.originOf(next.operationId), entry: { kind: 'new-turn' } });
    // Nothing crossed the boundary: no turn to wait for. Sent or unknown: its turn is waited for.
    if (state === 'pending' && this.handoffTurns.get(sessionId) === mark) this.handoffTurns.delete(sessionId);
    // The runtime's ack names the turn it started (Claude's frame, Codex's turn/start): only that turn's end
    // ends the wait (r2-P1-2). Its events are applied after this, in this same queue.
    if (state === 'sent') {
      const sent = (await this.store.get(next.operationId))?.delivery.attempts.at(-1);
      if (sent?.state === 'sent' && sent.nativeRef.turnRef !== undefined) mark.expected = sent.nativeRef.turnRef;
    }
    return next.operationId === operationId ? state : 'queued';
  }

  /** The user's own message written under its ID before anything else is stored about it (a workflow's first message). */
  recordUserMessage(sessionId: SessionId, messageId: MessageId, text: string): Promise<'written' | 'taken'> {
    return this.serial(sessionKey(sessionId), () => this.writeUserMessage(sessionId, messageId, text, this.options.now()));
  }

  /**
   * The provision a payload to this session waits for before the session is created (T024 r2-P1-4): the same
   * operation and binding key the session's own provision is recorded under.
   */
  provisionFor(sessionId: SessionId): { operationId: OperationId; bindingKey: string; state: 'pending'; preallocated: false } {
    return { operationId: provisionOp(sessionId), bindingKey: `session:${sessionId}`, state: 'pending', preallocated: false };
  }

  // ---- transfers (T023) -----------------------------------------------------------------------------

  /** Whether the session's own turn runs, by the stored turns (an old event cannot undo them): its turn boundary. */
  async mainTurnRunning(sessionId: SessionId): Promise<boolean> {
    if (runningMainTurn(await this.repos.conversations.get(sessionId)) !== undefined) return true;
    return (this.ackedTurns.get(sessionId)?.size ?? 0) > 0;
  }

  /** How many content writes the session's conversation had in this process (read synchronously, T023 r2-P1-1). */
  contentWritesOf(sessionId: SessionId): number {
    return this.contentWrites.get(sessionId) ?? 0;
  }

  /** The native session a GUI session is bound to, once its provision was sent. */
  nativeSessionOf(sessionId: SessionId): Promise<string | undefined> {
    return this.binding(sessionId);
  }

  /**
   * Dispatches a pending `transfer` delivery in its session's queue, as a new turn and only at the session's
   * turn boundary (`queued` while its own turn runs); its provision first when needed (CR2 §3).
   */
  deliverTransfer(operationId: OperationId, sessionId: SessionId): Promise<DeliveryState | 'queued'> {
    return this.serial(sessionKey(sessionId), async (): Promise<DeliveryState | 'queued'> => {
      const record = await this.store.get(operationId);
      if (record === undefined || record.delivery.state !== 'pending') return record?.delivery.state ?? 'pending';
      const session = await this.repos.sessions.get(sessionId);
      if (this.closing || session === undefined) return 'pending';
      const provisioned = await this.ensureProvisioned(session);
      if (!provisioned.ok || this.closing) return 'pending';
      if (runningMainTurn(await this.repos.conversations.get(sessionId)) !== undefined) return 'queued';
      return this.dispatchPending(operationId, { origin: await this.originOf(operationId), entry: { kind: 'new-turn' } });
    });
  }

  /**
   * The user cancelled what an unknown delivery was for (`transfer.cancel`): the live unknown attempt gets
   * the user's cancel and its escalation is closed. It stays reconcilable (CR2 §2).
   */
  async cancelUnknownDelivery(operationId: OperationId): Promise<void> {
    const record = await this.store.get(operationId);
    const last = record?.delivery.attempts.at(-1);
    if (record?.delivery.state !== 'unknown' || last?.state !== 'unknown' || last.resolution?.decision === 'cancel') return;
    const resolved = await this.delivery.resolve({ operationId, attemptId: last.attemptId, decision: 'cancel', acceptDuplicateRisk: false });
    if (resolved.status === 'commit-uncertain') throw new Error('the cancel of an unknown delivery could not be saved for certain');
    const escalation = await this.repos.escalations.get(deliveryEscalationId(`${operationId}/${last.attemptId}`));
    if (escalation?.state === 'open') await this.closeEscalation(escalation, 'resolved', 'user');
  }

  /** Where a session's escalations go (R-05): a workflow session's to its instance's root. */
  private async rootOf(session: LogicalSession): Promise<{ rootSessionId: SessionId; instanceId?: InstanceId }> {
    if (session.kind !== 'workflow') return { rootSessionId: session.id };
    const instance = await this.repos.instances.get(session.workflow.instanceId);
    return instance === undefined ? { rootSessionId: session.id } : { rootSessionId: instance.rootSessionId, instanceId: instance.id };
  }

  /**
   * The instance both sessions work in, when its start-time consent covers messages between them (R-11):
   * same instance, and consent recorded or both on one tool. Anything else is outside the group.
   */
  private async consentedInstance(a: LogicalSession, b: LogicalSession): Promise<InstanceId | undefined> {
    if (a.kind !== 'workflow' || b.kind !== 'workflow' || a.workflow.instanceId !== b.workflow.instanceId) return undefined;
    const instance = await this.repos.instances.get(a.workflow.instanceId);
    if (instance === undefined) return undefined;
    return instance.crossToolConsentAt !== undefined || a.requestedModel.runtime === b.requestedModel.runtime ? instance.id : undefined;
  }

  private async handoffRef(operationId: OperationId): Promise<Escalation['ref']> {
    const record = await this.store.get(operationId);
    return record?.kind === 'handoff' && record.handoff !== undefined ? { kind: 'handoff', handoffId: record.handoff.handoffId } : undefined;
  }

  // ---- runtime sessions -----------------------------------------------------------------------------

  /** The session's runtime settings: its model and its agent's instructions (no MCP mount, C-07). */
  private async settingsOf(session: LogicalSession): Promise<SessionSettings> {
    const agent: AgentDefinition | undefined = await this.repos.agents.get(session.agent.id);
    // A workflow node that may not write (read-only, exec-only) gets no writable root (T024, R-04).
    if (session.kind === 'workflow') {
      const briefing = await this.workflow?.briefing(session);
      const instructions = [agent?.instructions, briefing].filter((t): t is string => t !== undefined && t.length > 0).join('\n\n');
      return {
        model: session.requestedModel,
        readOnly: session.folderScope.writableRoots.length === 0,
        ...(instructions.length > 0 && { instructions }),
      };
    }
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
    const accepted = await this.acceptProvision(session);
    if ('ok' in accepted) return accepted;
    let record: StoredDelivery | undefined = accepted;
    if (record.delivery.state === 'pending') {
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

  /** The session's provision, recorded once and not dispatched here (CR2 §3): its record, or why there is none. */
  private async acceptProvision(session: LogicalSession): Promise<StoredDelivery | Extract<Provisioned, { ok: false }>> {
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
    return (
      record ?? {
        ok: false,
        code: 'storage_failed',
        message: 'Starting the session could not be recorded',
        retryable: true,
        mayHaveSideEffects: false,
      }
    );
  }

  /**
   * Before a claim (DeliveryOptions.prepareTarget): the target session is resumed when it is not open. A
   * transfer delivery passes its gate again afterwards (T023 r1-P1-3): a cancel while the resume ran stops
   * it here, and the claim follows with nothing in between to wait for.
   */
  private async prepareTarget(record: PayloadDelivery): Promise<void> {
    await this.resumeTarget(record);
    if (record.kind === 'transfer' && this.transfer !== undefined && !(await this.transfer.mayDispatch(record))) throw new Error('the transfer no longer sends this');
  }

  private async resumeTarget(record: PayloadDelivery): Promise<void> {
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
    // Every way a user message is dispatched (sent at once, recovered, retried) passes here (T024 r3-P1-2).
    const record = this.workflow === undefined && this.transfer === undefined ? undefined : await this.store.get(operationId);
    // Every transfer delivery passes here too: never once its proposal is cancelled or failed (T023).
    if (record?.kind === 'transfer' && this.transfer !== undefined) {
      if (record.outcome !== undefined || !(await this.transfer.mayDispatch(record))) return undefined;
    }
    if (record?.kind === 'user-message' && this.workflow !== undefined) {
      if (record.outcome !== undefined) return undefined;
      const fate = await this.workflow.userMessageFate(record);
      if (fate === 'wait') return undefined;
      if (fate === 'cancel') {
        await this.store.recordOutcome(operationId, { kind: 'cancelled', detail: 'its workflow run did not start in this session', at: this.options.now() });
        return undefined;
      }
    }
    const outcome: DispatchOutcome = await this.delivery.dispatch(operationId, options);
    if (outcome.status === 'sent') {
      const sent = await this.store.get(operationId);
      this.followAckedTurn(sent?.target.sessionId, outcome.nativeRef.turnRef);
      this.expectEcho(sent, outcome.attemptId);
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
    // A transfer's own deliveries, and its target's creation, are shown at the source session (T023).
    const transferred = await this.transfer?.escalationFor(item);
    const ref: Escalation['ref'] = transferred
      ? transferred.ref
      : item.deliveryKind === 'provision'
        ? {
            kind: 'provision',
            operationId: item.operationId,
            blocked: item.blocked ?? [],
          }
        : item.deliveryKind === 'peer-message'
          ? { kind: 'peerMessage', peerMessageId: peerIdOf(item.operationId) }
          : item.deliveryKind === 'handoff'
            ? await this.handoffRef(item.operationId)
            : undefined;
    if (ref === undefined) return;
    const id = deliveryEscalationId(item.key);
    if ((await this.repos.escalations.get(id)) !== undefined) return;
    // A workflow session's question goes to its instance's root (R-05).
    const target = await this.repos.sessions.get(sessionId);
    const root = transferred ? { rootSessionId: transferred.rootSessionId } : target === undefined ? { rootSessionId: sessionId } : await this.rootOf(target);
    const escalation: Escalation = {
      id,
      ...(root.instanceId !== undefined && { instanceId: root.instanceId }),
      rootSessionId: root.rootSessionId,
      fromSessionId: sessionId,
      kind: 'delivery-unknown',
      title:
        item.deliveryKind === 'provision'
          ? 'Session start outcome unknown'
          : item.deliveryKind === 'handoff'
            ? 'Handoff delivery outcome unknown'
            : item.deliveryKind === 'transfer'
              ? 'Transfer delivery outcome unknown'
              : 'Message delivery outcome unknown',
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
    // The locks see each event as it arrives, before any await of storing it: a write's end, a turn's end
    // and an exit change who may write at once (R-07, KNOWLEDGE §5).
    this.locks?.observe(event);
    if (event.type === 'runtime.exited') {
      this.runtimes.markExited(event.sessionIds);
      // No turn of an exited runtime ends any more; the next handoff waits for a restart instead.
      for (const sessionId of event.sessionIds) this.handoffTurns.delete(sessionId);
      for (const sessionId of event.sessionIds) this.ackedTurns.delete(sessionId);
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
      case 'turn.updated': {
        const { turn } = event;
        // A turn that ended stays ended: a late `running` of it is dropped (T024 r2-P1-3).
        if (turn.state === 'running') {
          const stored = (await conversations.get(turn.sessionId)).turns.find((t) => t.id === turn.id);
          if (stored !== undefined && stored.state !== 'running') return;
        }
        this.contentWrite(turn.sessionId);
        await conversations.upsertTurn(turn);
        this.contentWritten(turn.sessionId);
        if (turn.nativeTaskId === undefined) this.followHandoffTurn(turn);
        if (turn.nativeTaskId === undefined && turn.state !== 'running') this.turnSeenEnded(turn);
        // Outside this queue: what the engine dispatches next runs in the same session's queue (T024).
        if (turn.state !== 'running' && turn.nativeTaskId === undefined && this.workflow !== undefined) {
          const hooks = this.workflow;
          void Promise.resolve().then(() => hooks.turnEnded(turn.sessionId));
        }
        break;
      }
      case 'message.completed':
        // The user's own message was stored by session.send under the renderer's ID; its echo is not kept.
        // A native sub-agent's prompt is a user message too, and is kept (R-13).
        if (this.isEcho(event.message)) return;
        this.contentWrite(event.message.sessionId);
        await conversations.appendMessage(event.message);
        this.contentWritten(event.message.sessionId);
        break;
      case 'item.updated': {
        const { item } = event;
        this.contentWrite(item.sessionId);
        await conversations.upsertItem(item);
        this.contentWritten(item.sessionId);
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
        this.contentWrite(event.task.sessionId);
        await conversations.upsertNativeTask(event.task);
        this.contentWritten(event.task.sessionId);
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

  /**
   * The turn a dispatched handoff started (r1-P1-3, r2-P1-2): the turn the runtime's ack named, else the
   * first main turn not known at dispatch that was seen running. Only that turn's end ends the wait: an
   * end of any other turn, recorded or not, changes nothing. Without either, the wait ends with the user's
   * decision on the delivery, the runtime's exit, or a restart.
   */
  private followHandoffTurn(turn: Turn): void {
    const mark = this.handoffTurns.get(turn.sessionId);
    if (mark === undefined) return;
    if (mark.expected !== undefined) {
      if (turn.id === mark.expected && turn.state !== 'running') this.handoffTurns.delete(turn.sessionId);
      return;
    }
    if (mark.known.has(turn.id)) return;
    if (turn.state === 'running') mark.started ??= turn.id;
    else if (mark.started === turn.id) this.handoffTurns.delete(turn.sessionId);
  }

  /**
   * Counts a write to a session's conversation (T023 r3-P1). Called right before the write's call, with no
   * await between: both repositories commit inside that call, so once a write is stored it is counted, and a
   * claim can never see the new content with the old count. A write that then fails counts once too often,
   * which at most makes a proposal stale; it is never counted too few times.
   */
  private contentWrite(sessionId: SessionId): void {
    this.contentWrites.set(sessionId, (this.contentWrites.get(sessionId) ?? 0) + 1);
  }

  /** A write to a session's conversation committed (T023 r2): the transfer service is told, outside this queue. */
  private contentWritten(sessionId: SessionId): void {
    const hooks = this.transfer;
    if (hooks !== undefined) void Promise.resolve().then(() => hooks.contentChanged(sessionId));
  }

  /** The turn a dispatch's ack named, until it is seen to end (T023 r1-P1-4). */
  private followAckedTurn(sessionId: SessionId | undefined, turnRef: string | undefined): void {
    if (sessionId === undefined || turnRef === undefined || this.endedTurns.get(sessionId)?.includes(turnRef)) return;
    const acked = this.ackedTurns.get(sessionId) ?? new Set<string>();
    acked.add(turnRef);
    this.ackedTurns.set(sessionId, acked);
  }

  private turnSeenEnded(turn: Turn): void {
    this.ackedTurns.get(turn.sessionId)?.delete(turn.id);
    // A few per session: enough to cover an ack that is read after its turn already ended.
    this.endedTurns.set(turn.sessionId, [...(this.endedTurns.get(turn.sessionId) ?? []), turn.id].slice(-50));
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
    this.contentWrite(sessionId);
    await this.repos.conversations.appendMessage(message);
    this.contentWritten(sessionId);
    const after = (await this.repos.conversations.get(sessionId)).messages.find((m) => m.id === id);
    if (!same(after)) return 'taken';
    this.options.publish({ type: 'message.completed', message });
    return 'written';
  }

  /** The user message of a user-message operation, written once under its renderer ID (r1-P1-8). */
  private async ensureUserMessage(record: PayloadDelivery): Promise<void> {
    const sessionId = record.target.sessionId;
    if (record.kind !== 'user-message' || sessionId === undefined) return;
    // A workflow's first message is accepted before its root session exists (T024): written once it does.
    if ((await this.repos.sessions.get(sessionId)) === undefined) return;
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
    // A write held for a file lock shows `waiting-lock` the same way (R-07); waiting for the user comes first.
    const waitsFor = (reason: 'awaiting-user' | 'file-lock') => (r: PermissionRequest) =>
      r.state === 'held' && r.hold?.reason === reason && (r.nativeTaskId === undefined || (main !== undefined && r.turnId === main.id));
    const waits = waitsFor('awaiting-user');
    const waitsLock = waitsFor('file-lock');
    const others = conversation.permissionRequests.filter((r) => r.id !== request.id);
    const wanted = waits(request) || others.some(waits) ? 'waiting-user' : waitsLock(request) || others.some(waitsLock) ? 'waiting-lock' : undefined;
    const activity = (await this.repos.sessions.get(sessionId))?.activity;
    if (wanted !== undefined) {
      if (activity === wanted || !(activity === 'running' || activity === 'idle' || activity === 'waiting-user' || activity === 'waiting-lock')) return;
      await this.updateSession(sessionId, (s) =>
        s.activity === 'running' || s.activity === 'idle' || s.activity === 'waiting-user' || s.activity === 'waiting-lock' ? { ...s, activity: wanted } : undefined,
      );
      return;
    }
    if (activity !== 'waiting-user' && activity !== 'waiting-lock') return;
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

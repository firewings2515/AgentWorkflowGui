// The workflow engine (T024, P3): one workflow carries one task through its graph. The user starts it; nodes
// hand off with the `handoff` tool; the GUI checks the edge and the limits and counts (R-04), and what needs
// the user goes to root (R-05). Semantic judgement stays with the agents; waiting and counting are the GUI's.
//
// Every payload goes through the session service's CR-2 delivery service: a handoff is accepted and counted
// once in the delivery store (`HandoffMeta`, `counts`), its target's session is created as its own provision,
// and it is dispatched only when the target's own turn is not running (SP-05). Approvals are never taken
// from here: permission requests stay with the session service's gate and the user's `escalation.respond`.
import {
  type AppEvent,
  type CommandResult,
  type CreateTasksToolInput,
  type CreateTasksToolResult,
  type DeliveryState,
  type DeliveryTarget,
  type Escalation,
  EscalationId,
  finalTaskStatuses,
  type Handoff,
  type ModelSelection,
  type WorkflowTemplate,
  type HandoffToolInput,
  type HandoffToolResult,
  type InstanceId,
  type JoinRound,
  type McpRejection,
  type MessageOrigin,
  type NodeId,
  type OperationId,
  OperationId as OperationIdSchema,
  type PayloadHash,
  type ReportToRootToolInput,
  type ReportToRootToolResult,
  SessionId,
  type TaskId,
  type Timestamp,
  type TurnState,
  type WorkflowInstance,
  type WorkflowTask,
} from '../../contracts';
import type { DeliveryService } from '../delivery';
import { type GuiHandoff, isResolverSession, resolverBriefing, TaskPipeline, type TaskPipelineOptions } from '../pipeline';
import type { AppRepositories, DeliveryStore, HandoffMeta, PayloadContext, StoredDelivery, WorkFolderClaim } from '../ports';
import type { CommandOf, SessionService, WorkflowHooks, WorkflowSession } from '../sessions';
import { type AgentNode, agentNodes, briefing, handoffCounts, handoffText, hasEdge, isRework, nodeOf, reportText, reworkKey, rootNode, runtimesOf, sameTarget, taskProgress } from './graph';
import {
  firstMessageIdOf,
  firstMessageOperationOf,
  startInstanceOf,
  startRefOf,
  handoffConfirmationId,
  handoffIdOf,
  limitEscalationBase,
  noRuleEscalationBase,
  peerIdOf,
  reportConfirmationId,
  roundEscalationId,
  taskIdOf,
} from './ids';
import { concurrencyOf, deriveRounds, dispatchedAt, isArrival, LEGACY_ROUND, lineageOf, nextRound, occupyingTasks, planArrival, roundNote, waitsForAll } from './rounds';

export interface WorkflowEngineOptions {
  sessions: SessionService;
  publish(event: AppEvent): void;
  now(): Timestamp;
  uuid(): string;
  /** `sha256:<hex>` of a text, the same function the delivery service checks with. */
  hashPayload(text: string): PayloadHash | Promise<PayloadHash>;
  /**
   * Calls `fn` once `at` has come (a round's wait limit, CR-4); the returned function cancels it. A call that
   * comes early or twice does no harm: the round is checked against `now`.
   */
  schedule(at: Timestamp, fn: () => void): () => void;
  /** The task pipeline's git, commands and files (T032); without it a run carries one task in its folder. */
  pipeline?: TaskPipelineOptions;
  log?(message: string): void;
}

/**
 * The handoffs one source session makes for a task within one turn of its own: one fan-out, one round (CR-4).
 * Held in memory: it closes when that turn has ended, and a restart closes every group.
 */
interface Group {
  instanceId: InstanceId;
  taskId: TaskId;
  sessionId: SessionId;
  round: number;
  /** The source's own turn the group belongs to; undefined when none was running (the group closes at once). */
  turnId?: string;
}

/** One group per source turn (r2-P1-1): `turn` is the turn the call came in with, or a token for a call without one. */
const groupKeyOf = (instanceId: InstanceId, taskId: TaskId, sessionId: SessionId, turn: string) => JSON.stringify([instanceId, taskId, sessionId, turn]);
const roundKeyOf = (instanceId: InstanceId, r: Pick<JoinRound, 'taskId' | 'nodeId' | 'round'>) => JSON.stringify([instanceId, r.taskId, r.nodeId, r.round]);

/** What the MCP server tells a tool handler about the call (adapters/mcp-server `DeliveryCallContext`). */
export interface HandoffCallContext {
  caller: SessionId;
  operationId: OperationId;
  sourceCallRef: string;
}

export interface ReportCallContext {
  caller: SessionId;
  sourceCallRef: string;
}

type Failure = Extract<CommandResult, { ok: false }>;
type Success = Extract<CommandResult, { ok: true }>;

const ok = (requestId: Success['requestId'], extra: Partial<Pick<Success, 'revision' | 'created'>> = {}): Success => ({ ok: true, requestId, created: [], ...extra });
const fail = (requestId: Failure['requestId'], code: Failure['code'], message: string, flags: { retryable?: boolean; mayHaveSideEffects?: boolean } = {}): Failure => ({
  ok: false,
  requestId,
  code,
  message,
  retryable: flags.retryable ?? false,
  mayHaveSideEffects: flags.mayHaveSideEffects ?? false,
});

const rejected = (reason: McpRejection['reason'], detail: string) => ({ status: 'rejected' as const, rejection: { reason, detail } });
const SHUTTING_DOWN = rejected('shutting-down', 'the GUI is closing');
const NOT_IN_WORKFLOW = rejected('not-in-workflow', 'this tool works in workflow sessions only');
const RESEND_MISMATCH = rejected('resend-mismatch', 'this operation carries another handoff');
const NOT_OWNER = rejected('not-owner', 'this operation belongs to another call');
const RESOLVER_ONLY = rejected('invalid-input', 'this session resolves a merge conflict: end your turn when it is resolved (or cannot be), and the GUI takes it from there');

/** Report operation IDs say whether the report asked for the user's confirmation (r1-P1-7). */
const REPORT = 'report-';
const REPORT_ASKING = 'report-c-';
const asksConfirmation = (operationId: OperationId) => operationId.startsWith(REPORT_ASKING);

/**
 * The run's other folder for a session working in `cwd` (Q-8, T048): root may read the project folder (never write it
 * directly: worktrees or the other nodes do); a node in the project folder may also use the work folder (writing
 * there only when the node writes). Nothing for runs started before 0.8, or when both are one folder.
 */
const extraRootsOf = (instance: WorkflowInstance, cwd: string, isRoot: boolean): { extraRoots?: { path: string; write: boolean }[] } => {
  const other = isRoot ? instance.projectFolder : instance.workFolder;
  if (other === undefined || other === cwd) return {};
  return { extraRoots: [{ path: other, write: !isRoot }] };
};

const sameModel = (a: ModelSelection, b: ModelSelection) => a.runtime === b.runtime && a.model === b.model && a.effort === b.effort;

/** Whether two `handoff` inputs ask for the same handoff (`retryOf` aside). */
const sameCall = (a: HandoffToolInput, b: HandoffToolInput): boolean =>
  a.ruleId === b.ruleId && a.content === b.content && a.taskId === b.taskId && JSON.stringify(a.target) === JSON.stringify(b.target);

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'non-error thrown');
const isClosedError = (error: unknown) => error instanceof Error && error.name === 'ServiceClosedError';

/** A handoff waiting for the user's confirmation (R-05). Held in memory, like a cross-tool message (T024 G-4). */
interface PendingHandoff {
  caller: SessionId;
  input: HandoffToolInput;
  ctx: HandoffCallContext;
  /** The handoff the caller was working on when it called: its round is fixed then, not at the approval (r1-P1-1). */
  lineageId: Handoff['id'] | undefined;
  /** The caller's own turn the call came in with: its fan-out, if still open at the approval, takes it (r3-P1). */
  turnId: string | undefined;
}

/** What a handoff call carries from where it came in. */
interface CallFacts {
  /** The caller's own turn running when the call came in (read before anything else waited, r1-P1-2). */
  turnAtCall?: Promise<string | undefined>;
  /** Set for a handoff the user confirmed: the lineage its call had. */
  confirmed?: { lineageId: Handoff['id'] | undefined; turnId: string | undefined };
}

/** Everything a handoff call resolves to before anything is written. */
interface Planned {
  instance: WorkflowInstance;
  taskId: TaskId;
  from: AgentNode;
  to: AgentNode;
  ruleId: string;
  requiresUserConfirmation: boolean;
  /** The agent's content; the payload is framed from it (`payloadOf`). */
  content: string;
  /** Root's handoff of a task whose list waits for the user's confirmation (T032 G-11): held until the decision. */
  held?: true;
}

/** A handoff to the merge node (T032): the task joins the merge queue; nothing is delivered to a session. */
interface MergePlanned extends Omit<Planned, 'to'> {
  merge: true;
  to: Extract<WorkflowTemplate['nodes'][number], { kind: 'merge' }>;
}

export class WorkflowEngine implements WorkflowHooks {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly confirmations = new Map<EscalationId, PendingHandoff>();
  /** Open fan-out groups by (instance, task, source session). */
  private readonly groups = new Map<string, Group>();
  /** `handoff` calls of a session on their way (r1-P1-2): its groups stay open meanwhile. */
  private readonly inFlight = new Map<SessionId, number>();
  /** Concurrency slots this process let a handoff take before it crossed the dispatch boundary, by node then task. */
  private readonly reserved = new Map<string, Map<TaskId, Handoff['id']>>();
  /** Wait-limit timers of waiting rounds, by round key. */
  private readonly timers = new Map<string, { at: Timestamp; cancel: () => void }>();
  /** Instances with a round check queued and not started yet (one more is queued when asked while one runs). */
  private readonly syncQueued = new Set<InstanceId>();

  /** Tasks, worktrees and the merge queue (T032). */
  readonly pipeline: TaskPipeline | undefined;

  constructor(private readonly options: WorkflowEngineOptions) {
    this.pipeline =
      options.pipeline === undefined
        ? undefined
        : new TaskPipeline({
            ...options.pipeline,
            // A session's runtime ends gracefully before its folder goes (R-14, SP-07 G1).
            closeRuntime: (sessionId) => options.pipeline?.closeRuntime?.(sessionId) ?? options.sessions.closeWorkflowRuntime(sessionId),
            sessions: options.sessions,
            publish: (event) => options.publish(event),
            now: () => options.now(),
            hash: (text) => options.hashPayload(text),
            log: (message) => this.options.log?.(message),
            host: {
              serial: (instanceId, fn) => this.serial(`instance:${instanceId}`, fn),
              openOnce: (base, fields) => this.openOnce(base, fields),
              closeEscalation: (escalation, state, by) => this.close(escalation, state, by),
              guiHandoff: (input) => this.guiHandoff(input),
              wakeTask: (instanceId, taskId) => this.wakeTask(instanceId, taskId),
              wakeNodes: (instanceId) => this.wakeNodes(instanceId),
              settleHeld: (instanceId) => this.settleHeldNow(instanceId),
              noticeRoot: (instanceId, operationId, text) => this.noticeRoot(instanceId, operationId, text),
            },
          });
  }

  private get repos(): AppRepositories {
    return this.options.sessions.storage.repositories;
  }

  private get store(): DeliveryStore {
    return this.options.sessions.storage.store;
  }

  private get delivery(): DeliveryService {
    return this.options.sessions.delivery;
  }

  // ---- workflow.start -------------------------------------------------------------------------------

  /**
   * Starts a run (R-11, R-06): pinned to the template revision the user saw, with the start-time consent
   * recorded; one task; the root node's session in the given folder (no worktree); the first message sent to
   * root as the user's. A repeat with the same IDs and contents finishes what the first one left undone.
   */
  start(command: CommandOf<'workflow.start'>): Promise<CommandResult> {
    if (this.options.sessions.isClosing()) return Promise.resolve(fail(command.requestId, 'runtime_unavailable', 'The application is closing'));
    return this.serial(`instance:${command.instanceId}`, () => this.startNow(command));
  }

  private async startNow(command: CommandOf<'workflow.start'>): Promise<CommandResult> {
    const { requestId, instanceId, rootSessionId, workflowId, workflowRevision, title, workFolder, projectFolder, firstMessage, crossToolConsent } = command;
    const sessions = this.options.sessions;
    const repos = this.repos;
    const messageId = firstMessageIdOf(instanceId);
    const operationId = firstMessageOperationOf(messageId);
    // Only a call that wrote something says it may have had side effects (r2-P2).
    let wrote = false;
    const taken = (message = 'A workflow run with this ID already exists') => fail(requestId, 'already_exists', message, { mayHaveSideEffects: wrote });
    // The first message's delivery is written before anything else, and it carries the whole start: the
    // text, the root session, the template revision, the folder, the root's tool, model and write access,
    // and (in its source call identity) the title and the consent. A repeat must match all of it, wherever
    // the first attempt stopped (r1-P1-4, r2-P1-4); nothing else is created before that is known.
    const intent = await this.store.get(operationId);
    let instance = await repos.instances.get(instanceId);
    if (intent === undefined && instance !== undefined) return taken();
    let template: WorkflowTemplate;
    if (instance !== undefined) {
      template = instance.template;
    } else {
      const current = await repos.workflows.get(workflowId);
      if (current === undefined) return fail(requestId, 'not_found', 'Unknown workflow');
      // Pinned to what the user saw and agreed to (R-11): a changed template is refused, never started.
      if (current.revision !== workflowRevision) return fail(requestId, 'stale_revision', 'The workflow has changed since it was loaded', { retryable: true });
      template = current;
    }
    const root = rootNode(template);
    const settings = { model: root.model, readOnly: root.writePolicy !== 'write' };
    // Which workflow, root node and limit, also while no instance exists yet (r3-P1-1).
    const startRef = startRefOf({ instanceId, workflowId, rootNodeId: root.id, reworkLimit: template.reworkLimit, title, crossToolConsent, ...(projectFolder !== undefined && { projectFolder }) });
    // Root works in the work folder (Q-4, T048): the one given, else the one the first attempt chose and wrote into its
    // first message, else a new one made below. A repeat that names another folder is not this run.
    let cwd = workFolder ?? (intent?.kind === 'user-message' ? intent.context.cwd : undefined);
    if (intent !== undefined) {
      const same =
        intent.kind === 'user-message' &&
        intent.outcome === undefined &&
        intent.payload === firstMessage &&
        intent.target.sessionId === rootSessionId &&
        intent.proposalRevision === workflowRevision &&
        intent.sourceCallRef === startRef &&
        intent.context.cwd === cwd &&
        intent.context.runtime === root.model.runtime &&
        sameModel(intent.context.session.model, root.model) &&
        intent.context.session.readOnly === settings.readOnly &&
        (instance === undefined ||
          (instance.workflowId === workflowId &&
            instance.workflowRevision === workflowRevision &&
            instance.rootSessionId === rootSessionId &&
            instance.title === title &&
            instance.projectFolder === projectFolder));
      if (!same) return taken();
    }
    if (instance === undefined) {
      for (const node of agentNodes(template)) {
        if ((await repos.agents.get(node.agentId)) === undefined) return fail(requestId, 'not_found', `Unknown agent of node "${node.label}"`);
        if (!sessions.runtimeAvailable(node.model.runtime)) return fail(requestId, 'runtime_unavailable', `${node.model.runtime} is not available on this computer`);
      }
      // Starting is the consent to cross-tool handoffs between the run's nodes (R-11); without it nothing starts.
      if (runtimesOf(template).size > 1 && !crossToolConsent) return fail(requestId, 'invalid_request', 'This workflow hands off between tools; starting it needs that consent');
      // Task worktrees come from the project folder: a run with worktrees cannot start without one (Q-8).
      if (template.isolation === 'worktree' && projectFolder === undefined)
        return fail(requestId, 'invalid_request', 'This workflow works in task worktrees; starting it needs a project folder');
      if (cwd !== undefined && !sessions.canResolve(cwd)) return fail(requestId, 'invalid_request', 'The working folder cannot be resolved');
      if (projectFolder !== undefined && !sessions.canResolve(projectFolder)) return fail(requestId, 'invalid_request', 'The project folder cannot be resolved');
    }
    let made: string | undefined;
    if (intent === undefined) {
      if ((await repos.sessions.get(rootSessionId)) !== undefined) return taken('A session with this ID already exists');
      // The root ID may be held by another run's start that stopped before creating the session (r3-P1-2).
      if (await this.rootClaimed(rootSessionId, operationId)) return taken('A session with this ID already exists');
      if (sessions.isClosing()) return fail(requestId, 'runtime_unavailable', 'The application is closing');
      // No work folder given: one is made now, the last step before the start is written (T048). The same root
      // session asking again gets the same folder; one whose start never got written is removed at the next start.
      if (cwd === undefined) {
        const allocated = await sessions.allocateWorkFolder(rootSessionId, instanceId);
        if (!allocated.ok) return allocated.taken === true ? taken('A session with this ID already exists') : fail(requestId, 'invalid_request', allocated.message);
        cwd = made = allocated.path;
        if (!sessions.canResolve(cwd)) {
          await sessions.releaseWorkFolder(rootSessionId, made);
          return fail(requestId, 'invalid_request', 'The working folder cannot be resolved');
        }
      }
    }
    // Set above: given, read from the stored start, or made just now.
    if (cwd === undefined) return fail(requestId, 'internal_error', 'The run has no work folder');
    if (intent === undefined) {
      const release = async () => {
        if (made !== undefined) await sessions.releaseWorkFolder(rootSessionId, made);
      };
      const accepted = await this.delivery.accept({
        kind: 'user-message',
        operationId,
        sourceCallRef: startRef,
        payloadHash: await this.options.hashPayload(firstMessage),
        payload: firstMessage,
        proposalRevision: workflowRevision,
        // The root session's provision does not exist yet: the message waits for it (CR2 §3).
        target: { sessionId: rootSessionId, provision: sessions.provisionFor(rootSessionId) },
        at: this.options.now(),
        context: { runtime: root.model.runtime, cwd, entry: { kind: 'new-turn' }, session: settings, origin: { kind: 'user' } },
      });
      if (accepted.status === 'conflict') {
        await release();
        return taken();
      }
      // Possibly written: the folder stays with its claim, for the repeat or the next start's check.
      if (accepted.status === 'commit-uncertain') return fail(requestId, 'storage_failed', 'Starting the run could not be saved for certain', { retryable: true, mayHaveSideEffects: true });
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
        await release();
        return fail(requestId, 'internal_error', 'The run could not be started');
      }
      wrote = true;
    }
    const at = this.options.now();
    // With worktrees every task comes from root's `create_tasks` (T032); a same-folder run starts with one.
    const tasks: WorkflowTask[] =
      template.isolation === 'worktree' && this.pipeline !== undefined
        ? []
        : [{ id: taskIdOf(instanceId), instanceId, title, dependsOn: [], status: 'running', currentNodeId: root.id, reworkCount: 0 }];
    const created: WorkflowInstance = instance ?? {
      id: instanceId,
      revision: 0,
      workflowId,
      workflowRevision,
      title,
      rootSessionId,
      state: 'running',
      ...(crossToolConsent && { crossToolConsentAt: at }),
      template,
      taskLimit: 3,
      tasks,
      rounds: [],
      mergeQueue: [],
      taskPlans: [],
      workFolder: cwd,
      ...(projectFolder !== undefined && { projectFolder }),
      createdAt: at,
    };
    if (sessions.isClosing()) return fail(requestId, 'runtime_unavailable', 'The application is closing', { mayHaveSideEffects: wrote });
    // A run already started is recognised by its instance and its stored start: its root session's model may
    // have been changed since (session.setModel), and that is no reason to refuse the repeat (r3-P2).
    const existingRoot = instance === undefined ? undefined : await repos.sessions.get(rootSessionId);
    if (existingRoot !== undefined) {
      const bound = existingRoot.kind === 'workflow' && existingRoot.workflow.instanceId === instanceId && existingRoot.workflow.nodeId === root.id && existingRoot.workflow.taskId === undefined;
      if (!bound) return taken('A session with this ID already exists');
    } else {
      // Root plans from the project's code: it may read the project folder, never write it directly (Q-8, T048).
      const rootMade = await sessions.createWorkflowSession({ sessionId: rootSessionId, instance: created, nodeId: root.id, cwd, ...extraRootsOf(created, cwd, true) });
      if (rootMade === 'taken') return taken('A session with this ID already exists');
      if (rootMade === 'unresolvable') return fail(requestId, 'invalid_request', 'The working folder cannot be resolved', { mayHaveSideEffects: wrote });
      if (rootMade === 'closing') return fail(requestId, 'runtime_unavailable', 'The application is closing', { mayHaveSideEffects: wrote });
      wrote ||= rootMade === 'created';
    }
    if ((await sessions.recordUserMessage(rootSessionId, messageId, firstMessage)) === 'taken') return taken();
    if (instance === undefined) {
      if ((await repos.instances.create(created)) === 'exists') return taken();
      instance = (await repos.instances.get(instanceId)) ?? created;
      this.options.publish({ type: 'instance.updated', instance });
    }
    const bound = await repos.instances.bindNodeSession({ instanceId, nodeId: root.id }, rootSessionId);
    if (bound.status === 'exists' && bound.sessionId !== rootSessionId) return fail(requestId, 'already_exists', 'The run already has another root session', { mayHaveSideEffects: true });
    const state = await sessions.deliverWorkflow(operationId, rootSessionId, 'insert-if-busy');
    if (state === 'unknown') return fail(requestId, 'unknown_outcome', 'It is not known whether the first message reached root; it is not sent again', { mayHaveSideEffects: true });
    if (state !== 'sent') return fail(requestId, 'runtime_unavailable', 'The run is started; its first message is saved but could not be handed to root yet', { retryable: true, mayHaveSideEffects: true });
    return ok(requestId, {
      revision: instance.revision,
      created: [
        { kind: 'instance', id: instanceId },
        { kind: 'session', id: rootSessionId },
        { kind: 'message', id: messageId },
      ],
    });
  }

  // ---- handoff --------------------------------------------------------------------------------------

  /**
   * `handoff` (R-04 steps 1-7). One instance's handoffs run one at a time, so what was counted before a call
   * is what its checks see; the store's counts decide in the end.
   */
  async handoff(input: HandoffToolInput, ctx: HandoffCallContext): Promise<HandoffToolResult> {
    // Counted before anything is awaited: while a call of the session is on its way, the end of its turn
    // closes none of its fan-outs, so every handoff of one turn stays in one group (r1-P1-2).
    this.inFlight.set(ctx.caller, (this.inFlight.get(ctx.caller) ?? 0) + 1);
    const turnAtCall = this.repos.conversations
      .get(ctx.caller)
      .then((c) => c.turns.filter((t) => t.nativeTaskId === undefined && t.state === 'running').at(-1)?.id)
      .catch(() => undefined);
    try {
      if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
      const caller = await this.repos.sessions.get(ctx.caller);
      if (caller?.kind !== 'workflow') return NOT_IN_WORKFLOW;
      if (isResolverSession(caller.id)) return RESOLVER_ONLY;
      return await this.serial(`instance:${caller.workflow.instanceId}`, () => this.handoffNow(caller, input, ctx, { turnAtCall }));
    } catch (error) {
      if (this.options.sessions.isClosing() || isClosedError(error)) return SHUTTING_DOWN;
      throw error;
    } finally {
      const left = (this.inFlight.get(ctx.caller) ?? 1) - 1;
      if (left > 0) this.inFlight.set(ctx.caller, left);
      else {
        this.inFlight.delete(ctx.caller);
        // The last call is in: a fan-out whose turn already ended closes now.
        void this.afterTurn(ctx.caller).catch((error: unknown) => this.log(`checking the rounds after a handoff of ${ctx.caller} failed (${errorName(error)})`));
      }
    }
  }

  private async handoffNow(caller: WorkflowSession, input: HandoffToolInput, ctx: HandoffCallContext, call: CallFacts): Promise<HandoffToolResult> {
    const confirmed = call.confirmed !== undefined;
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    // A `retryOf` of a handoff still waiting for the user is held to the same rules as any resend (r1-P1-5).
    const waiting = handoffConfirmationId(ctx.operationId);
    const pending = confirmed ? undefined : this.confirmations.get(waiting);
    if (pending !== undefined) {
      if (pending.caller !== caller.id) return NOT_OWNER;
      return sameCall(pending.input, input) ? { status: 'escalated', escalationId: waiting, reason: 'needs-confirmation' } : RESEND_MISMATCH;
    }
    const planned = await this.plan(caller, input);
    if ('status' in planned) return planned;
    const { taskId, from } = planned;
    let { instance } = planned;

    // A task stopped at a limit hands off nowhere, root included, until the user deals with it (R-05,
    // r1-P1-1); a resend of an earlier handoff of it gets the same answer (r2-P1-1). A task stopped at a
    // blocked round still takes handoffs (a late upstream is kept for the user's decision) and holds them.
    // A task stopped at its setup or merge is the pipeline's to answer (T032).
    const task = instance.tasks.find((t) => t.id === taskId);
    if (task?.status === 'blocked' && (task.blockedReason === 'limit-exceeded' || task.blockedReason === 'delivery-unknown' || task.blockedReason === undefined)) {
      return this.stillBlocked(instance, taskId, caller);
    }
    if ('merge' in planned) return this.toMerge(caller, planned, input, ctx, confirmed);
    const { to } = planned;

    // A resend: the same call after a restart (same sourceCallRef) or a `retryOf` (same operationId, CR2 §4).
    const known = (await this.store.get(ctx.operationId)) ?? (await this.store.findBySourceCallRef(ctx.sourceCallRef));
    if (known !== undefined) return this.resent(known, caller, planned);
    // Root's handoff of a task whose list waits for the user (T032 G-11): planned as any handoff (its fan-out
    // group, round and rework, r2 P1-1/P1-2), but nothing made, counted or sent before the decision.
    const held = planned.held === true;

    // The task's worktree is made the first time, and a writing node's changes are committed (T032, R-06).
    if (this.pipeline !== undefined && !held) {
      const refused = await this.pipeline.beforeHandoff(instance, taskId, from, to);
      if (refused !== undefined) return refused;
      instance = (await this.repos.instances.get(instance.id)) ?? instance;
      planned.instance = instance;
    }

    // Its round (CR-4): an arrival at a waiting node counts in the round of its sender's work; anything else
    // joins the caller's open fan-out or opens a new one. A waiting node counts rounds, not arrivals.
    const handoffs = await this.repos.handoffs.listByInstance(instance.id);
    const arrival = waitsForAll(to);
    // The fan-out of the turn the call came in with: a call of the next turn never joins a group still
    // waiting for calls of the previous one (r2-P1-1). A confirmed handoff is a group of its own.
    // A confirmed handoff belongs to the fan-out of the turn its call came in with while that is still open
    // (the turn runs on, r3-P1); once it closed, the handoff is a group of its own.
    const turnId = call.confirmed !== undefined ? call.confirmed.turnId : call.turnAtCall === undefined ? undefined : await call.turnAtCall;
    const ownKey = groupKeyOf(instance.id, taskId, caller.id, turnId ?? 'no-turn');
    const groupKey = call.confirmed === undefined || (turnId !== undefined && this.groups.has(ownKey)) ? ownKey : groupKeyOf(instance.id, taskId, caller.id, `confirmed:${ctx.operationId}`);
    const fresh = nextRound(handoffs, instance.rounds, taskId, this.openRounds(instance.id, taskId));
    // The work the caller was on when it called; a confirmed handoff keeps the one its call had (r1-P1-1).
    const lineage = call.confirmed !== undefined ? handoffs.find((h) => h.id === call.confirmed?.lineageId) : lineageOf(handoffs, taskId, from.id);
    const placed = arrival
      ? planArrival(instance.template, handoffs, instance.rounds, taskId, from.id, to.id, this.openRounds(instance.id, taskId), fresh, lineage)
      : { round: this.groups.get(groupKey)?.round ?? fresh, first: true };
    const { round, first } = placed;
    const expectedUpstream = 'expectedUpstream' in placed ? placed.expectedUpstream : undefined;
    const rework = first && isRework(handoffs, taskId, to.id, arrival ? round : undefined);
    const { counts, current } = handoffCounts(instance, handoffs, taskId, to, rework, arrival);
    // A held handoff is counted when its list is approved (`settleHeldNow`), in acceptance order.
    const over = first && !held ? current.find((c) => c.limit !== undefined && c.count >= c.limit) : undefined;
    if (over !== undefined) return this.limitReached(instance, taskId, caller, to, over.key, over.what, over.limit ?? 0);

    if (planned.requiresUserConfirmation && !confirmed) return this.askConfirmation(instance, caller, planned, input, ctx, lineage?.id, turnId);

    const handoffId = handoffIdOf(ctx.operationId);
    const origin: MessageOrigin = { kind: 'handoff', fromSessionId: caller.id, handoffId };
    const destination = held ? await this.heldDestination(instance, to, taskId, origin) : await this.destination(instance, to, taskId, caller, origin);
    if ('status' in destination) return destination;
    const { targetSessionId, target, context } = destination;
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    const payload = this.payloadOf(planned, arrival ? { round, expectedUpstream } : undefined);
    const accepted = await this.delivery.accept({
      kind: 'handoff',
      operationId: ctx.operationId,
      sourceCallRef: ctx.sourceCallRef,
      sender: caller.id,
      payloadHash: await this.options.hashPayload(payload),
      payload,
      proposalRevision: instance.workflowRevision,
      target,
      at: this.options.now(),
      context,
      // A later arrival of a round the node already received counts nothing; a held one is counted later.
      ...(first && !held && { counts }),
      handoff: {
        handoffId,
        instanceId: instance.id,
        taskId,
        fromNodeId: from.id,
        toNodeId: to.id,
        fromSessionId: caller.id,
        ruleId: planned.ruleId,
        rework,
        round,
        ...(expectedUpstream !== undefined && { expectedUpstream }),
      },
    });
    switch (accepted.status) {
      case 'accepted':
        break;
      case 'duplicate':
        return this.resent(accepted.record, caller, planned);
      case 'conflict':
        return accepted.existing.sender !== undefined && accepted.existing.sender !== caller.id ? NOT_OWNER : RESEND_MISMATCH;
      case 'limit-exceeded': {
        // Only when another writer counted meanwhile: the store's word is final.
        const what = current.find((c) => c.key === accepted.key)?.what ?? 'receive';
        return this.limitReached(instance, taskId, caller, to, accepted.key, what, accepted.limit);
      }
      case 'invalid':
        this.log(`a handoff of ${caller.id} was not accepted (${accepted.issues.length} issue(s))`);
        return rejected('invalid-input', 'the handoff cannot be accepted');
      case 'commit-uncertain':
        // Thrown: the agent gets a generic error, and a resend of the same call finds what was stored.
        throw new Error('accepting the handoff could not be confirmed');
    }
    // The caller's fan-out takes it in its own turn; with no turn of its own running, nothing else can join.
    if (!arrival) this.joinGroup({ instanceId: instance.id, taskId, sessionId: caller.id, round, ...(turnId !== undefined && { turnId }) }, groupKey);
    if (held) {
      await this.publishHandoff(handoffId);
      // Decided meanwhile (the user answered while this call ran): settled now rather than at the next restart.
      if (this.pipeline?.heldPlanOf((await this.repos.instances.get(instance.id)) ?? instance, taskId) === undefined) await this.settleHeldNow(instance.id);
      return { status: 'accepted', handoffId, operationId: ctx.operationId, delivery: 'pending' };
    }
    const reworkCount = accepted.counts?.find((c) => c.key === reworkKey(instance.id, taskId))?.count;
    // A task held at a blocked round stays held (the user decides it); one not started yet waits to start (T032).
    await this.updateTask(instance.id, taskId, (t) => ({
      ...t,
      status: t.status === 'blocked' || t.status === 'pending' ? t.status : 'running',
      currentNodeId: to.id,
      ...(reworkCount !== undefined && { reworkCount }),
    }));
    await this.publishHandoff(handoffId);
    await this.syncSafely(instance.id);
    // The caller handed its task on: a slot of its node may have come free for another task (R-06).
    if (concurrencyOf(from) !== undefined) this.wakeNode(instance.id, from.id);
    // Root gave a task its work: it may start now (dependencies, the run's limit, T032).
    if (this.pipeline !== undefined && task?.status === 'pending') await this.pipeline.admitNow(instance.id);
    // A task not started yet gets nothing delivered (its session is not even started, T032).
    if (!(await this.deliverableNow(instance.id, taskId, to))) return { status: 'accepted', handoffId, operationId: ctx.operationId, delivery: 'pending' };
    const delivery = await this.deliver(ctx.operationId, targetSessionId, handoffId);
    return { status: 'accepted', handoffId, operationId: ctx.operationId, delivery };
  }

  /** Whether a handoff of the task to this node may be dispatched now, as far as the pipeline is concerned (T032). */
  private async deliverableNow(instanceId: InstanceId, taskId: TaskId, to: WorkflowTemplate['nodes'][number] | undefined): Promise<boolean> {
    if (this.pipeline === undefined || (to?.kind === 'agent' && to.isRoot)) return true;
    const instance = await this.repos.instances.get(instanceId);
    return instance !== undefined && this.pipeline.deliverable(instance, taskId);
  }

  /**
   * A handoff to the merge node (T032, R-06): the task joins the merge queue, its changes committed first. A
   * resend finds the task already queued (or merged) and gets the same answer; nothing goes to a session.
   */
  private async toMerge(caller: WorkflowSession, planned: MergePlanned, input: HandoffToolInput, ctx: HandoffCallContext, confirmed: boolean): Promise<HandoffToolResult> {
    const { taskId, from, to } = planned;
    let { instance } = planned;
    const pipeline = this.pipeline;
    if (pipeline === undefined) return rejected('unsupported', 'merge nodes come with task pipelining');
    // A resend of the same call, or a `retryOf` (CR2 §4, r1 P1-1): the operation it made, never a second commit
    // or attempt; a crash after the acceptance and before the task joined the queue is finished here.
    const known = (await this.store.get(ctx.operationId)) ?? (await this.store.findBySourceCallRef(ctx.sourceCallRef));
    if (known !== undefined) {
      const result = await this.resent(known, caller, planned);
      if (result.status === 'duplicate' && known.outcome === undefined) await pipeline.enqueue(instance, taskId, to, known.acceptedAt);
      return result;
    }
    if (planned.requiresUserConfirmation && !confirmed) return this.askConfirmation(instance, caller, planned, input, ctx, undefined, undefined);
    const refused = await pipeline.beforeHandoff(instance, taskId, from, to);
    if (refused !== undefined) return refused;
    instance = (await this.repos.instances.get(instance.id)) ?? instance;
    // Recorded and counted like any handoff (R-04, r1 P1-7): the merge node's receive limit and the task's
    // rework limit hold. It goes to no session: the GUI's merge queue takes the task; it stays pending.
    const handoffs = await this.repos.handoffs.listByInstance(instance.id);
    const rework = isRework(handoffs, taskId, to.id);
    const { counts, current } = handoffCounts(instance, handoffs, taskId, to, rework);
    const over = current.find((c) => c.limit !== undefined && c.count >= c.limit);
    if (over !== undefined) return this.limitReached(instance, taskId, caller, to, over.key, over.what, over.limit ?? 0);
    const handoffId = handoffIdOf(ctx.operationId);
    const context = await this.options.sessions.payloadContext(caller.id, { kind: 'handoff', fromSessionId: caller.id, handoffId });
    if (context === undefined) return rejected('unknown-target', 'the calling session cannot be found');
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    const payload = this.payloadOf({ ...planned, instance });
    const accepted = await this.delivery.accept({
      kind: 'handoff',
      operationId: ctx.operationId,
      sourceCallRef: ctx.sourceCallRef,
      sender: caller.id,
      payloadHash: await this.options.hashPayload(payload),
      payload,
      proposalRevision: instance.workflowRevision,
      target: {},
      at: this.options.now(),
      context,
      counts,
      handoff: { handoffId, instanceId: instance.id, taskId, fromNodeId: from.id, toNodeId: to.id, fromSessionId: caller.id, ruleId: planned.ruleId, rework, round: nextRound(handoffs, instance.rounds, taskId, this.openRounds(instance.id, taskId)) },
    });
    switch (accepted.status) {
      case 'accepted':
        break;
      case 'duplicate':
        return this.resent(accepted.record, caller, planned);
      case 'conflict':
        return accepted.existing.sender !== undefined && accepted.existing.sender !== caller.id ? NOT_OWNER : RESEND_MISMATCH;
      case 'limit-exceeded': {
        const what = current.find((c) => c.key === accepted.key)?.what ?? 'receive';
        return this.limitReached(instance, taskId, caller, to, accepted.key, what, accepted.limit);
      }
      case 'invalid':
        this.log(`a handoff of ${caller.id} to the merge node was not accepted (${accepted.issues.length} issue(s))`);
        return rejected('invalid-input', 'the handoff cannot be accepted');
      case 'commit-uncertain':
        throw new Error('accepting the handoff could not be confirmed');
    }
    const reworkCount = accepted.counts?.find((c) => c.key === reworkKey(instance.id, taskId))?.count;
    if (reworkCount !== undefined) await this.updateTask(instance.id, taskId, (t) => ({ ...t, reworkCount }));
    await pipeline.enqueue((await this.repos.instances.get(instance.id)) ?? instance, taskId, to, accepted.record.acceptedAt);
    await this.publishHandoff(handoffId);
    // The caller handed its task on (T031 counts its outgoing handoff): its node's slot is free for another task.
    if (concurrencyOf(from) !== undefined) this.wakeNode(instance.id, from.id);
    return { status: 'accepted', handoffId, operationId: ctx.operationId, delivery: 'pending' };
  }

  /**
   * A handoff the GUI makes for the merge node (T032): a task given back to its implementation node (counted
   * as rework, R-05) or a merged task reported to root. Its operation is named after the attempt, so doing it
   * again finds the first one. Sent by root's session, the run's own.
   */
  private guiHandoff(input: GuiHandoff): Promise<'accepted' | 'duplicate' | 'limit-exceeded' | 'failed'> {
    return this.serial(`instance:${input.instanceId}`, async () => {
      const instance = await this.repos.instances.get(input.instanceId);
      const root = instance === undefined ? undefined : await this.repos.sessions.get(instance.rootSessionId);
      if (instance === undefined || root?.kind !== 'workflow' || instance.state === 'completed' || instance.state === 'cancelled') return 'failed';
      const known = await this.store.get(input.operationId);
      if (known !== undefined) {
        if (known.delivery.state === 'pending' && known.target.sessionId !== undefined && (await this.deliverableNow(instance.id, input.taskId, input.to))) {
          await this.deliver(input.operationId, known.target.sessionId, handoffIdOf(input.operationId));
        }
        return 'duplicate';
      }
      const { taskId, to } = input;
      const handoffs = await this.repos.handoffs.listByInstance(instance.id);
      const rework = isRework(handoffs, taskId, to.id);
      const { counts, current } = handoffCounts(instance, handoffs, taskId, to, rework);
      const over = input.count ? current.find((c) => c.limit !== undefined && c.count >= c.limit) : undefined;
      if (over !== undefined) {
        await this.limitReached(instance, taskId, root, to, over.key, over.what, over.limit ?? 0);
        return 'limit-exceeded';
      }
      const targetSessionId = await this.nodeSession(instance, to, taskId, root);
      if (targetSessionId === undefined) return 'failed';
      const handoffId = handoffIdOf(input.operationId);
      const target = await this.options.sessions.payloadTarget(targetSessionId);
      const context = await this.options.sessions.payloadContext(targetSessionId, { kind: 'handoff', fromSessionId: root.id, handoffId });
      if (target === undefined || context === undefined) return 'failed';
      const payload = handoffText(input.from, input.ruleId, taskId, input.content);
      const accepted = await this.delivery.accept({
        kind: 'handoff',
        operationId: input.operationId,
        sourceCallRef: input.operationId,
        sender: root.id,
        payloadHash: await this.options.hashPayload(payload),
        payload,
        proposalRevision: instance.workflowRevision,
        target,
        at: this.options.now(),
        context,
        ...(input.count && { counts }),
        handoff: {
          handoffId,
          instanceId: instance.id,
          taskId,
          fromNodeId: input.from.id,
          toNodeId: to.id,
          fromSessionId: root.id,
          ruleId: input.ruleId,
          rework,
          round: nextRound(handoffs, instance.rounds, taskId, this.openRounds(instance.id, taskId)),
        },
      });
      if (accepted.status === 'limit-exceeded') {
        const what = current.find((c) => c.key === accepted.key)?.what ?? 'receive';
        await this.limitReached(instance, taskId, root, to, accepted.key, what, accepted.limit);
        return 'limit-exceeded';
      }
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
        this.log(`the merge node's handoff of ${taskId} was not accepted (${accepted.status})`);
        return 'failed';
      }
      const reworkCount = accepted.status === 'accepted' ? accepted.counts?.find((c) => c.key === reworkKey(instance.id, taskId))?.count : undefined;
      if (reworkCount !== undefined) await this.updateTask(instance.id, taskId, (t) => ({ ...t, reworkCount }));
      await this.publishHandoff(handoffId);
      await this.syncSafely(instance.id);
      if (await this.deliverableNow(instance.id, taskId, to)) await this.deliver(input.operationId, targetSessionId, handoffId);
      return accepted.status;
    });
  }

  /**
   * A `system-notice` to root (C-31, T032 G-11 B): the GUI's own words, origin `system`, accepted and dispatched through
   * the delivery service like a report (it joins a running turn, SP-05). The operation is named by the caller, so a
   * second call (a restart, two paths at once) is the same operation: one record, one dispatch (CR-2); a pending one
   * goes on, an unknown one stays with its escalation. Called in the instance's queue (the pipeline holds it), so not
   * queued again here.
   */
  private async noticeRoot(instanceId: InstanceId, operationId: OperationId, text: string): Promise<'accepted' | 'duplicate' | 'failed'> {
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined || this.options.sessions.isClosing()) return 'failed';
    const rootId = instance.rootSessionId;
    const known = await this.store.get(operationId);
    if (known !== undefined) {
      if (known.kind !== 'system-notice') return 'failed';
      if (known.delivery.state === 'pending') await this.options.sessions.deliverWorkflow(operationId, rootId, 'insert-if-busy');
      return 'duplicate';
    }
    const target = await this.options.sessions.payloadTarget(rootId);
    const context = await this.options.sessions.payloadContext(rootId, { kind: 'system' });
    if (target === undefined || context === undefined) return 'failed';
    const accepted = await this.delivery.accept({
      kind: 'system-notice',
      operationId,
      sourceCallRef: operationId,
      payloadHash: await this.options.hashPayload(text),
      payload: text,
      proposalRevision: instance.workflowRevision,
      target,
      at: this.options.now(),
      context: { ...context, entry: { kind: 'new-turn' } },
    });
    if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
      this.log(`a notice to root of ${instanceId} was not accepted (${accepted.status})`);
      return 'failed';
    }
    await this.options.sessions.deliverWorkflow(operationId, rootId, 'insert-if-busy');
    return accepted.status;
  }

  /** Every node with a concurrency limit: its waiting handoffs are tried again (T032, after a merge ended). */
  private wakeNodes(instanceId: InstanceId): void {
    void this.repos.instances.get(instanceId).then(
      (instance) => {
        for (const node of instance === undefined ? [] : agentNodes(instance.template)) if (concurrencyOf(node) !== undefined) this.wakeNode(instanceId, node.id);
      },
      (error: unknown) => this.log(`waking the nodes of ${instanceId} failed (${errorName(error)})`),
    );
  }

  /** A task that started (T032): the handoffs that waited for it go now, one per target session (SP-05). */
  private async wakeTask(instanceId: InstanceId, taskId: TaskId): Promise<void> {
    // A held handoff whose adoption could not finish at the approval (its worktree failed then) is adopted now.
    await this.settleHeldNow(instanceId, taskId);
    const sessions = new Set<SessionId>();
    for (const handoff of await this.repos.handoffs.listByInstance(instanceId)) {
      if (handoff.taskId === taskId && handoff.delivery.state === 'pending' && handoff.outcome === undefined && handoff.target.sessionId !== undefined) sessions.add(handoff.target.sessionId);
    }
    for (const sessionId of sessions) await this.deliverQueued(sessionId);
  }

  /** The handoff's payload: an arrival at a waiting node names its round, from what its record stores (CR-4). */
  private payloadOf(planned: Planned | MergePlanned, round?: { round: number; expectedUpstream?: readonly NodeId[] | undefined }): string {
    const note = round === undefined ? undefined : roundNote(planned.instance.template, planned.to, round.round, round.expectedUpstream);
    return handoffText(planned.from, planned.ruleId, planned.taskId, planned.content, note);
  }

  /**
   * Adds an accepted handoff to the caller's open fan-out, or opens one with its round, tied to the caller's own
   * turn that ran when the call came in (not one read now: its end may have been told meanwhile, r1-P1-2). The
   * group closes once that turn has ended and no call of the caller is on its way; with no turn (a handoff the
   * user confirmed later, say), as soon as nothing else of the caller is.
   */
  private joinGroup(group: Group, key: string): void {
    if (!this.groups.has(key)) this.groups.set(key, group);
  }

  /** Rounds of a task whose fan-out is still open: their expected set is not fixed yet. */
  private openRounds(instanceId: InstanceId, taskId: TaskId): Set<number> {
    return new Set([...this.groups.values()].filter((g) => g.instanceId === instanceId && g.taskId === taskId).map((g) => g.round));
  }

  /** Closes the session's groups whose turn has ended by the stored turns (a replayed old turn end closes nothing). */
  private async closeEndedGroups(sessionId: SessionId): Promise<boolean> {
    const own = [...this.groups.entries()].filter(([, g]) => g.sessionId === sessionId);
    // A call of the session still on its way belongs to its group (r1-P1-2); the last one closes it.
    if (own.length === 0 || (this.inFlight.get(sessionId) ?? 0) > 0) return false;
    const turns = (await this.repos.conversations.get(sessionId)).turns;
    let closed = false;
    for (const [key, group] of own) {
      const turn = turns.find((t) => t.id === group.turnId);
      if (turn?.state === 'running') continue;
      if (this.groups.get(key) === group) this.groups.delete(key);
      closed = true;
    }
    return closed;
  }

  /** The checks of R-04 step 2 that need nothing counted: the caller's task, its rule and the edge. */
  private async plan(caller: WorkflowSession, input: HandoffToolInput): Promise<Planned | MergePlanned | HandoffToolResult> {
    const instance = await this.repos.instances.get(caller.workflow.instanceId);
    if (instance === undefined) return rejected('unknown-target', 'no such workflow run');
    if (instance.state === 'completed' || instance.state === 'cancelled') return rejected('invalid-input', 'this workflow run has ended');
    const { template } = instance;
    const from = nodeOf(template, caller.workflow.nodeId);
    if (from?.kind !== 'agent') return rejected('unknown-target', 'the calling node is not in this workflow');
    // A node works on its own task; root, which has none, names it or means the run's one task.
    const own = caller.workflow.taskId;
    if (own !== undefined && input.taskId !== undefined && input.taskId !== own) return rejected('invalid-input', 'a node hands off its own task only');
    // Root names the task when the run has several (T032); with one, that one.
    const taskId = own ?? input.taskId ?? (instance.tasks.length === 1 ? instance.tasks[0]?.id : undefined);
    if (taskId === undefined && instance.tasks.length === 0) return rejected('invalid-input', 'this run has no task yet: create the tasks with create_tasks first, then hand each one off naming its taskId');
    if (taskId === undefined) return rejected('invalid-input', 'this run has several tasks: name the task (taskId) this handoff is for');
    // A task of root's list that waits for the user (T032 G-11): root may hand it off now; the GUI holds it.
    const held = own === undefined && !instance.tasks.some((t) => t.id === taskId) && this.pipeline?.heldPlanOf(instance, taskId) !== undefined;
    if (!held && !instance.tasks.some((t) => t.id === taskId)) return rejected('unknown-target', 'no such task');
    // The edge first (R-04 step 2), so a target the graph does not connect is named as such (V-23).
    if (input.target.kind === 'node') {
      if (nodeOf(template, input.target.nodeId) === undefined) return rejected('unknown-target', 'no such node');
      if (!hasEdge(template, from.id, input.target.nodeId)) return rejected('not-connected', 'there is no edge from this node to the target');
    }
    const rule = from.outputRules.find((r) => r.id === input.ruleId && r.target.kind !== 'tasks' && sameTarget(r.target, input.target));
    if (rule === undefined) return this.noRuleMatched(instance, taskId, caller, from);
    const root = rootNode(template);
    const toId: NodeId = rule.target.kind === 'node' ? rule.target.nodeId : root.id;
    if (toId === from.id) return rejected('invalid-input', 'a node cannot hand off to itself');
    const to = nodeOf(template, toId);
    if (to === undefined) return rejected('unknown-target', 'no such node');
    const base = { instance, taskId, from, ruleId: rule.id, requiresUserConfirmation: rule.requiresUserConfirmation, content: input.content };
    if (to.kind !== 'agent') {
      if (held) return rejected('invalid-input', 'this task waits for the user to confirm its list; it cannot be merged before it exists');
      return this.pipeline === undefined ? rejected('unsupported', 'merge nodes come with task pipelining') : { ...base, merge: true, to };
    }
    return { ...base, to, ...(held && { held: true as const }) };
  }

  /** A known operation: the same handoff from the same caller is a duplicate; anything else is refused. */
  private async resent(record: StoredDelivery, caller: WorkflowSession, planned: Planned | MergePlanned): Promise<HandoffToolResult> {
    if (record.kind !== 'handoff' || record.handoff === undefined) return rejected('invalid-input', 'this operation is not a handoff');
    if (record.sender !== caller.id) return NOT_OWNER;
    const meta = record.handoff;
    // Framed from the stored round, never one worked out again now (CR-4).
    const payload = this.payloadOf(planned, isArrival(planned.instance.template, meta) ? meta : undefined);
    const same =
      meta.instanceId === planned.instance.id && meta.taskId === planned.taskId && meta.toNodeId === planned.to.id && meta.ruleId === planned.ruleId && record.payloadHash === (await this.options.hashPayload(payload));
    if (!same) return RESEND_MISMATCH;
    let delivery: DeliveryState = record.delivery.state;
    // A user retry of an unknown delivery put it back to pending: it goes the same way as a first dispatch.
    if (delivery === 'pending' && record.target.sessionId !== undefined) delivery = await this.deliver(record.operationId, record.target.sessionId, meta.handoffId);
    return { status: 'duplicate', handoffId: meta.handoffId, operationId: record.operationId, delivery };
  }

  /** The GUI session of a (node, task) (R-06): bound once, created on the first handoff to it, reused for rework. */
  private async nodeSession(instance: WorkflowInstance, node: AgentNode, taskId: TaskId, caller: WorkflowSession): Promise<SessionId | undefined> {
    const repos = this.repos;
    const root = await repos.sessions.get(instance.rootSessionId);
    if (root === undefined) return undefined;
    // Root has no task: a handoff back to the root node goes to the root session.
    if (node.isRoot) return instance.rootSessionId;
    const sessionId = await this.boundSession(instance, node, taskId);
    // The task's worktree with worktree isolation (T032), else root's folder; the source that created it is its parent (WB-01).
    const current = this.pipeline === undefined ? undefined : await repos.instances.get(instance.id);
    const worktree = current === undefined ? undefined : this.pipeline?.cwdOf(current, taskId);
    // A same-folder run with a project folder: the other nodes change its code in place and may also use the work
    // folder for reports (Q-8, T048). Without one, everything is in root's folder, as before.
    const inProject = worktree === undefined && instance.template.isolation !== 'worktree' && instance.projectFolder !== undefined;
    const cwd = worktree ?? (inProject ? instance.projectFolder : undefined) ?? root.cwd;
    const made = await this.options.sessions.createWorkflowSession({
      sessionId,
      instance,
      nodeId: node.id,
      taskId,
      cwd,
      parentId: caller.id,
      ...(worktree !== undefined && { worktree: true }),
      ...(inProject && extraRootsOf(instance, cwd, false)),
    });
    return made === 'created' || made === 'exists' ? sessionId : undefined;
  }

  /** The ID bound to a (node, task) of the instance, bound now when none was (once: two callers share it). */
  private async boundSession(instance: WorkflowInstance, node: AgentNode, taskId: TaskId): Promise<SessionId> {
    const key = { instanceId: instance.id, nodeId: node.id, taskId };
    const found = await this.repos.instances.findNodeSession(key);
    if (found !== undefined) return found;
    const fresh = SessionId.parse(`wf-${this.options.uuid()}`);
    const bound = await this.repos.instances.bindNodeSession(key, fresh);
    return bound.status === 'exists' ? bound.sessionId : fresh;
  }

  /** Where a handoff goes: the (node, task) session, made now if it is not there yet, and its delivery context. */
  private async destination(
    instance: WorkflowInstance,
    to: AgentNode,
    taskId: TaskId,
    caller: WorkflowSession,
    origin: MessageOrigin,
  ): Promise<{ targetSessionId: SessionId; target: DeliveryTarget; context: PayloadContext } | HandoffToolResult> {
    const targetSessionId = await this.nodeSession(instance, to, taskId, caller);
    if (targetSessionId === undefined) return rejected('unknown-target', 'the target session cannot be created');
    const target = await this.options.sessions.payloadTarget(targetSessionId);
    const context = await this.options.sessions.payloadContext(targetSessionId, origin);
    if (target === undefined || context === undefined) return rejected('unknown-target', 'the target session cannot be started');
    return { targetSessionId, target, context };
  }

  /**
   * Where a held handoff goes (T032 G-11): the (node, task) session bound now and created only once the list is
   * approved, in the task's worktree. The delivery waits for that session's own provision, as a run's first
   * message does (the store fixes the destination at acceptance), so nothing is created or sent before the
   * decision; its context names the node's runtime and the task's worktree.
   */
  private async heldDestination(
    instance: WorkflowInstance,
    to: AgentNode,
    taskId: TaskId,
    origin: MessageOrigin,
  ): Promise<{ targetSessionId: SessionId; target: DeliveryTarget; context: PayloadContext } | HandoffToolResult> {
    const root = await this.repos.sessions.get(instance.rootSessionId);
    if (root === undefined || this.pipeline === undefined) return rejected('unknown-target', 'the run has no root session');
    const targetSessionId = await this.boundSession(instance, to, taskId);
    return {
      targetSessionId,
      target: { sessionId: targetSessionId, provision: this.options.sessions.provisionFor(targetSessionId) },
      context: {
        runtime: to.model.runtime,
        cwd: (await this.pipeline.plannedCwd(instance, taskId)) ?? root.cwd,
        entry: { kind: 'new-turn' },
        session: { model: to.model, readOnly: to.writePolicy !== 'write' },
        origin,
      },
    };
  }

  /**
   * Root's held handoffs after the user decided their list (T032 G-11): of an approved list they are adopted (the
   * task's worktree, its session created under the bound ID; the receive and rework limits checked now, when
   * they are counted); of a declined one they end cancelled. Safe to repeat (a restart, a task that starts).
   */
  private async settleHeldNow(instanceId: InstanceId, onlyTask?: TaskId): Promise<void> {
    const pipeline = this.pipeline;
    const instance = await this.repos.instances.get(instanceId);
    const root = instance === undefined ? undefined : await this.repos.sessions.get(instance.rootSessionId);
    if (pipeline === undefined || instance === undefined || root?.kind !== 'workflow') return;
    const ended = instance.state === 'completed' || instance.state === 'cancelled';
    const handoffs = (await this.repos.handoffs.listByInstance(instanceId)).sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0));
    // Held: root's, pending, waiting for a session not created yet, of a list (root's own handoffs always have one).
    const held: Handoff[] = [];
    for (const h of handoffs) {
      if (h.delivery.state !== 'pending' || h.outcome !== undefined || h.fromSessionId !== root.id || h.target.sessionId === undefined) continue;
      if (!instance.taskPlans.some((p) => h.taskId.startsWith(`${p.id}:`))) continue;
      if ((await this.repos.sessions.get(h.target.sessionId)) === undefined) held.push(h);
    }
    const cancel = async (handoff: Handoff, detail: string) => {
      await this.store.recordOutcome(handoff.operationId, { kind: 'cancelled', detail, at: this.options.now() }).catch(() => undefined);
      await this.publishHandoff(handoff.id);
    };
    // First every decision and every count, each written before any session is made, so a crash between the two
    // steps leaves nothing that skipped its count: later held ones count the earlier ones kept (acceptance order).
    const kept: Handoff[] = [];
    const uncounted = new Set(held.map((h) => h.id));
    // A task stopped at a limit in this pass: the rest of it was cancelled with it (T024).
    const stopped = new Set<TaskId>(instance.tasks.filter((t) => t.status === 'blocked' && t.blockedReason === 'limit-exceeded').map((t) => t.id));
    for (const handoff of held) {
      if (stopped.has(handoff.taskId)) continue;
      const plan = instance.taskPlans.find((p) => handoff.taskId.startsWith(`${p.id}:`));
      const to = nodeOf(instance.template, handoff.toNodeId);
      if (plan === undefined || (plan.state === 'awaiting-confirmation' && !ended)) continue;
      if (plan.state === 'declined' || ended || to?.kind !== 'agent') {
        await cancel(handoff, ended ? 'the run ended before its task list was decided' : 'the user declined the task list');
        continue;
      }
      if (!instance.tasks.some((t) => t.id === handoff.taskId)) continue;
      // Counted now, as `handoffNow` counts (R-04, R-05, r2 P1-1): against what came before it, the held ones
      // after it left out; its rework flag was set at its acceptance by the same rule (T024). A later arrival of a
      // round already received counts nothing (CR-4).
      const others = handoffs.filter((h) => h.id !== handoff.id && !uncounted.has(h.id));
      const arrival = waitsForAll(to);
      const first = !arrival || !others.some((h) => h.taskId === handoff.taskId && h.toNodeId === to.id && h.round === handoff.round);
      const { current } = handoffCounts(instance, others, handoff.taskId, to, handoff.rework, arrival);
      const over = first ? current.find((c) => c.limit !== undefined && c.count >= c.limit) : undefined;
      if (over !== undefined) {
        // As any handoff over a limit (r2-P1-1): the stop is written first, then what is queued of the task is
        // cancelled, this one included (r3 P1-1); a restart finishes a stop cut short (`recover`).
        await this.limitReached(instance, handoff.taskId, root, to, over.key, over.what, over.limit ?? 0);
        stopped.add(handoff.taskId);
        continue;
      }
      uncounted.delete(handoff.id);
      kept.push(handoff);
    }
    // Then the sessions they wait for: the task's worktree first (the session's folder), then the session itself.
    for (const handoff of kept) {
      if ((onlyTask !== undefined && handoff.taskId !== onlyTask) || stopped.has(handoff.taskId)) continue;
      const to = nodeOf(instance.template, handoff.toNodeId);
      if (to?.kind !== 'agent') continue;
      const current = (await this.repos.instances.get(instanceId)) ?? instance;
      if ((await pipeline.beforeHandoff(current, handoff.taskId, rootNode(instance.template), to)) !== undefined) continue;
      await this.nodeSession((await this.repos.instances.get(instanceId)) ?? instance, to, handoff.taskId, root);
      await this.publishHandoff(handoff.id);
    }
    // The rework count of each task held handoffs touched, as a restart rebuilds it (r3 P2).
    const touched = new Set(held.map((h) => h.taskId));
    if (touched.size === 0) return;
    const after = await this.repos.handoffs.listByInstance(instanceId);
    const now = (await this.repos.instances.get(instanceId)) ?? instance;
    for (const taskId of touched) {
      const reworkCount = taskProgress(after, taskId, (h) => this.counted(now, h)).reworkCount;
      await this.updateTask(instanceId, taskId, (t) => (t.reworkCount === reworkCount ? undefined : { ...t, reworkCount }));
    }
  }

  /**
   * Whether a handoff counted (R-05): all do at their acceptance, but a handoff root made while its task list
   * waited for the user (G-11) is counted only at the approval; one cancelled before it was ever sent never was.
   */
  private counted(instance: WorkflowInstance, handoff: Handoff): boolean {
    const plan = instance.taskPlans.find((p) => handoff.taskId.startsWith(`${p.id}:`));
    const held = plan?.decidedAt !== undefined && handoff.fromSessionId === instance.rootSessionId && handoff.acceptedAt <= plan.decidedAt;
    return !(held && handoff.outcome !== undefined && handoff.delivery.attempts.length === 0);
  }

  /**
   * A task stopped at a limit whose stop a crash cut short (r3 P1-1): what is still queued of it is cancelled, and
   * root is asked if it never was (a question the user already answered is not asked again).
   */
  private async finishStop(instance: WorkflowInstance, taskId: TaskId): Promise<void> {
    await this.cancelQueued(instance, taskId);
    const asked = (await this.repos.escalations.list()).some((e) => e.instanceId === instance.id && e.kind === 'limit-exceeded' && e.ref?.kind === 'task' && e.ref.taskId === taskId);
    if (asked) return;
    await this.openOnce(limitEscalationBase(JSON.stringify(['blocked', instance.id, taskId])), {
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: instance.rootSessionId,
      kind: 'limit-exceeded',
      title: 'Handoff limit reached',
      detail: 'the task stopped at a handoff limit; no handoff of it is delivered any more',
      ref: { kind: 'task', taskId },
    });
  }

  /** Dispatches a pending handoff when its target's own turn is not running (SP-05); `pending` while it waits. */
  private async deliver(operationId: OperationId, sessionId: SessionId, handoffId: Handoff['id']): Promise<DeliveryState> {
    const state = await this.options.sessions.deliverWorkflow(operationId, sessionId, 'after-turn');
    // The gate may have sent an older handoff to the session instead: every one to it is pushed again.
    const target = await this.repos.sessions.get(sessionId);
    if (target?.kind === 'workflow') {
      for (const handoff of await this.repos.handoffs.listByInstance(target.workflow.instanceId))
        if (handoff.target.sessionId === sessionId || handoff.id === handoffId) this.options.publish({ type: 'handoff.updated', handoff });
    } else {
      await this.publishHandoff(handoffId);
    }
    return state === 'queued' ? 'pending' : state;
  }

  /**
   * The target's own turn ended: the oldest handoff waiting for it is sent and starts its next turn; the
   * rest wait for that turn to end in turn. A turn the session started on its own (a background sub-agent
   * that finished, R-05) is the same.
   */
  turnEnded(sessionId: SessionId): void {
    // The fan-outs of that turn close first (their expected sets are fixed), then what is queued goes.
    // A session resolving a merge conflict ended its one turn: the merge queue looks at its work (T032).
    void this.pipeline?.turnEnded(sessionId).catch((error: unknown) => this.log(`checking the merge after a turn of ${sessionId} failed (${errorName(error)})`));
    void this.afterTurn(sessionId)
      .catch((error: unknown) => this.log(`checking the rounds after a turn of ${sessionId} failed (${errorName(error)})`))
      .then(() => this.deliverQueued(sessionId))
      .catch((error: unknown) => this.log(`delivering the handoffs queued for ${sessionId} failed (${errorName(error)})`));
  }

  /** A turn of the session ended: its fan-outs close and the rounds are checked (an upstream's turn may have failed). */
  private async afterTurn(sessionId: SessionId): Promise<void> {
    if (this.options.sessions.isClosing()) return;
    const session = await this.repos.sessions.get(sessionId);
    if (session?.kind !== 'workflow') return;
    const { instanceId } = session.workflow;
    await this.serial(`instance:${instanceId}`, async () => {
      await this.closeEndedGroups(sessionId);
      await this.syncSafely(instanceId);
    });
  }

  private async deliverQueued(sessionId: SessionId): Promise<void> {
    if (this.options.sessions.isClosing()) return;
    const session = await this.repos.sessions.get(sessionId);
    if (session?.kind !== 'workflow') return;
    const waiting = (await this.repos.handoffs.listByInstance(session.workflow.instanceId))
      .filter((h) => h.target.sessionId === sessionId && h.delivery.state === 'pending' && h.outcome === undefined)
      .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0));
    const next = waiting[0];
    if (next !== undefined) await this.deliver(next.operationId, sessionId, next.id);
    // Reports of the run that are still pending (a delivery that could not go) go on too (r2-P1-5).
    for (const record of await this.store.listByState('pending')) {
      if (record.kind === 'peer-message' && record.peer?.instanceId === session.workflow.instanceId && record.target.sessionId === sessionId && record.outcome === undefined) {
        await this.deliverReport(record.operationId, sessionId);
      }
    }
  }

  // ---- report_to_root, create_tasks -----------------------------------------------------------------

  /**
   * `report_to_root` (R-05): delivered to root as a message from the node (not a formal handoff, so it joins a
   * running turn), within the run's consent (R-11). `needsUserConfirmation` opens a question for the user.
   */
  async reportToRoot(input: ReportToRootToolInput, ctx: ReportCallContext): Promise<ReportToRootToolResult> {
    try {
      if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
      const caller = await this.repos.sessions.get(ctx.caller);
      if (caller?.kind !== 'workflow') return NOT_IN_WORKFLOW;
      return await this.serial(`instance:${caller.workflow.instanceId}`, () => this.reportNow(caller, input, ctx));
    } catch (error) {
      if (this.options.sessions.isClosing() || isClosedError(error)) return SHUTTING_DOWN;
      throw error;
    }
  }

  private async reportNow(caller: WorkflowSession, input: ReportToRootToolInput, ctx: ReportCallContext): Promise<ReportToRootToolResult> {
    const instance = await this.repos.instances.get(caller.workflow.instanceId);
    if (instance === undefined) return rejected('unknown-target', 'no such workflow run');
    const from = nodeOf(instance.template, caller.workflow.nodeId);
    if (from === undefined) return rejected('unknown-target', 'the calling node is not in this workflow');
    const rootId = instance.rootSessionId;
    const taskId = caller.workflow.taskId;
    const payload = reportText(from, taskId, input.content, input.needsUserConfirmation);
    const hash = await this.options.hashPayload(payload);

    // Root reports to the user directly: nothing is delivered, only the question, named after the call so a
    // resend of it (even after a restart) finds the same one (r1-P1-7).
    if (caller.id === rootId) {
      if (!input.needsUserConfirmation) return { status: 'reported' };
      const digest = (await this.options.hashPayload(JSON.stringify([caller.id, ctx.sourceCallRef]))).slice('sha256:'.length, 'sha256:'.length + 40);
      const escalation = await this.openReportQuestion(instance, caller.id, from, OperationIdSchema.parse(`report-root-${digest}`));
      return { status: 'reported', escalationId: escalation.id };
    }
    // The same call again after a restart (CR2 §4): the report it made, with its question if it asked one
    // (written again if a crash came between the two, r1-P1-7).
    const known = await this.store.findBySourceCallRef(ctx.sourceCallRef);
    if (known !== undefined) {
      if (known.kind !== 'peer-message' || known.sender !== caller.id) return NOT_OWNER;
      if (known.payloadHash !== hash) return rejected('resend-mismatch', 'this call carried another report');
      const question = asksConfirmation(known.operationId) ? await this.openReportQuestion(instance, caller.id, from, known.operationId) : undefined;
      // A report accepted but not delivered yet goes on now (r2-P1-5).
      if (known.delivery.state === 'pending') await this.deliverReport(known.operationId, rootId);
      return { status: 'reported', ...(question !== undefined && { escalationId: question.id }) };
    }
    // Whether the report asks the user is part of its stored identity, so a restart can restore the question.
    const operationId = OperationIdSchema.parse(`${input.needsUserConfirmation ? REPORT_ASKING : REPORT}${this.options.uuid()}`);
    const peerMessageId = peerIdOf(operationId);
    const origin: MessageOrigin = { kind: 'peer', fromSessionId: caller.id, peerMessageId };
    const target = await this.options.sessions.payloadTarget(rootId);
    const context = await this.options.sessions.payloadContext(rootId, origin);
    if (target === undefined || context === undefined) return rejected('unknown-target', 'the root session cannot be started');
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    const accepted = await this.delivery.accept({
      kind: 'peer-message',
      operationId,
      sourceCallRef: ctx.sourceCallRef,
      sender: caller.id,
      payloadHash: hash,
      payload,
      proposalRevision: instance.workflowRevision,
      target,
      at: this.options.now(),
      context: { ...context, entry: { kind: 'new-turn' } },
      peer: { peerMessageId, fromSessionId: caller.id, toSessionId: rootId, instanceId: instance.id },
    });
    if (accepted.status === 'conflict') return NOT_OWNER;
    if (accepted.status === 'invalid') return rejected('invalid-input', 'the report cannot be accepted');
    if (accepted.status === 'commit-uncertain' || accepted.status === 'limit-exceeded') throw new Error(`accepting the report ended ${accepted.status}`);
    const escalation = input.needsUserConfirmation ? await this.openReportQuestion(instance, caller.id, from, operationId) : undefined;
    // A branch of a fan-out that reported instead of handing on may leave its round waiting for nothing (CR-4).
    this.requestSync(instance.id);
    await this.deliverReport(operationId, rootId);
    return { status: 'reported', ...(escalation !== undefined && { escalationId: escalation.id }) };
  }

  /** A report to root: not a formal handoff, so it joins a running turn (SP-05). */
  private async deliverReport(operationId: OperationId, rootId: SessionId): Promise<void> {
    await this.options.sessions.deliverWorkflow(operationId, rootId, 'insert-if-busy');
    const message = await this.repos.peerMessages.get(peerIdOf(operationId));
    if (message !== undefined) this.options.publish({ type: 'peerMessage.updated', message });
  }

  /** `create_tasks` (T032, R-06, O-07): root splits the work into tasks; the user confirms first when root's rule says so. */
  async createTasks(input: CreateTasksToolInput, ctx: { caller: SessionId; sourceCallRef: string }): Promise<CreateTasksToolResult> {
    try {
      if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
      const caller = await this.repos.sessions.get(ctx.caller).catch(() => undefined);
      if (caller?.kind !== 'workflow') return NOT_IN_WORKFLOW;
      const pipeline = this.pipeline;
      if (pipeline === undefined) return rejected('unsupported', 'create_tasks is not available in this version: a run carries one task');
      return await this.serial(`instance:${caller.workflow.instanceId}`, () => pipeline.createTasks(caller, input, ctx.sourceCallRef));
    } catch (error) {
      if (this.options.sessions.isClosing() || isClosedError(error)) return SHUTTING_DOWN;
      throw error;
    }
  }

  /** `workflow.complete`, `workflow.cancel` and `task.retryCleanup` (T032); undefined without the pipeline. */
  execute(command: CommandOf<'workflow.complete' | 'workflow.cancel' | 'task.retryCleanup'>): Promise<CommandResult> | undefined {
    if (this.pipeline === undefined) return undefined;
    return command.type === 'task.retryCleanup' ? this.pipeline.retryCleanup(command) : this.pipeline.end(command);
  }

  /** Why the user may not send to this session now (a task merged and cleaned up, a folder gone; R-06), or undefined. */
  sessionAccess(sessionId: SessionId): Promise<string | undefined> {
    return this.pipeline?.sessionAccess(sessionId) ?? Promise.resolve(undefined);
  }

  // ---- escalations ----------------------------------------------------------------------------------

  /** The user's answer to one of the engine's escalations (R-05); undefined for the session service's own. */
  async respond(escalation: Escalation, command: CommandOf<'escalation.respond'>): Promise<CommandResult | undefined> {
    const { requestId, decision } = command;
    if (escalation.instanceId === undefined) return undefined;
    const pipelined = await this.pipeline?.respond(escalation, command);
    if (pipelined !== undefined) return pipelined;
    if (escalation.kind === 'confirmation' && escalation.ref?.kind === 'handoff') {
      const pending = this.confirmations.get(escalation.id);
      this.confirmations.delete(escalation.id);
      if (pending === undefined) {
        await this.close(escalation, 'resolved', 'system');
        return fail(requestId, 'invalid_transition', 'The handoff is no longer waiting');
      }
      await this.close(escalation, decision === 'approve' ? 'approved' : 'declined', 'user');
      if (decision === 'approve') {
        const caller = await this.repos.sessions.get(pending.caller);
        if (caller?.kind === 'workflow') {
          const result = await this.serial(`instance:${caller.workflow.instanceId}`, () => this.handoffNow(caller, pending.input, pending.ctx, { confirmed: { lineageId: pending.lineageId, turnId: pending.turnId } }));
          // Its own group (the caller's turn is long over): closed once nothing else of the caller is on its way.
          await this.afterTurn(caller.id);
          if (result.status !== 'accepted' && result.status !== 'duplicate') this.log(`a confirmed handoff of ${caller.id} ended ${result.status}`);
        }
      }
      return ok(requestId);
    }
    if (escalation.kind === 'confirmation' && escalation.ref?.kind === 'report') {
      await this.close(escalation, decision === 'approve' ? 'approved' : 'declined', 'user');
      return ok(requestId);
    }
    if (escalation.kind === 'round-blocked' && escalation.ref?.kind === 'round') {
      // The decision is written first; the round check carries it out (and a restart finishes it): approve
      // delivers what arrived and what arrives later, decline cancels the round's held handoffs (CR-4).
      await this.close(escalation, decision === 'approve' ? 'approved' : 'declined', 'user');
      const instanceId = escalation.instanceId;
      await this.serial(`instance:${instanceId}`, () => this.syncSafely(instanceId));
      return ok(requestId);
    }
    if (escalation.kind === 'limit-exceeded' || escalation.kind === 'no-rule-matched') {
      // Seen by the user; the limit itself still holds (R-05).
      await this.close(escalation, 'resolved', 'user');
      return ok(requestId);
    }
    return undefined;
  }

  private async limitReached(instance: WorkflowInstance, taskId: TaskId, caller: WorkflowSession, to: { label: string }, key: string, what: 'receive' | 'rework', limit: number): Promise<HandoffToolResult> {
    // The GUI stops handing off this task until the user decides (R-05): what is still queued of it is
    // cancelled, so no later turn end sends it (r2-P1-1).
    await this.updateTask(instance.id, taskId, (t) =>
      t.status === 'blocked' && t.blockedReason !== 'round-blocked' ? undefined : { ...t, status: 'blocked', blockedReason: 'limit-exceeded' },
    );
    const cancelled = await this.cancelQueued(instance, taskId);
    // Arrivals it cancelled block their rounds (CR-4).
    await this.syncSafely(instance.id);
    const reached = what === 'rework' ? `the task reached its rework limit of ${String(limit)}` : `node "${to.label}" reached its receive limit of ${String(limit)} for the task`;
    const detail = cancelled > 0 ? `${reached}; ${String(cancelled)} queued handoff(s) of the task were cancelled` : reached;
    const escalation = await this.openOnce(limitEscalationBase(key), {
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: caller.id,
      kind: 'limit-exceeded',
      title: 'Handoff limit reached',
      detail,
      ref: { kind: 'task', taskId },
    });
    return { status: 'escalated', escalationId: escalation.id, reason: 'limit-exceeded' };
  }

  /** Cancels the task's handoffs still waiting to be sent (R-05): recorded as their outcome, kept in the view. */
  private async cancelQueued(instance: WorkflowInstance, taskId: TaskId): Promise<number> {
    let cancelled = 0;
    for (const handoff of await this.repos.handoffs.listByInstance(instance.id)) {
      if (handoff.taskId !== taskId || handoff.delivery.state !== 'pending' || handoff.outcome !== undefined) continue;
      // A handoff to the merge node is never delivered: its task is in the merge queue, nothing waits to be sent (T032).
      if (nodeOf(instance.template, handoff.toNodeId)?.kind === 'merge') continue;
      // Best effort: the delivery gate asks `mayDeliver` too, so one whose cancel failed is not sent either.
      const written = await this.store
        .recordOutcome(handoff.operationId, { kind: 'cancelled', detail: 'the task stopped at a handoff limit', at: this.options.now() })
        .catch((error: unknown) => {
          this.log(`cancelling handoff ${handoff.id} failed (${errorName(error)})`);
          return 'failed' as const;
        });
      if (written === 'recorded') cancelled++;
      await this.publishHandoff(handoff.id);
    }
    return cancelled;
  }

  /** Whether another run's first message, still on record, is meant for this root session ID (r3-P1-2). */
  private async rootClaimed(rootSessionId: SessionId, own: OperationId): Promise<boolean> {
    for (const state of ['pending', 'unknown', 'sent'] as const) {
      for (const record of await this.store.listByState(state)) {
        if (record.kind === 'user-message' && record.operationId !== own && record.target.sessionId === rootSessionId && startInstanceOf(record.sourceCallRef) !== undefined) return true;
      }
    }
    return false;
  }

  /**
   * `WorkflowHooks.retryEntry` (T040 r1): a report to root that the user retried joins root's running turn, as
   * `deliverReport` sent it the first time; only a report of a run to that run's root session.
   */
  async retryEntry(record: StoredDelivery): Promise<'insert-if-busy' | undefined> {
    if (record.kind !== 'peer-message' || !record.operationId.startsWith(REPORT) || record.peer?.instanceId === undefined) return undefined;
    const instance = await this.repos.instances.get(record.peer.instanceId);
    return instance !== undefined && record.target.sessionId === instance.rootSessionId && record.peer.toSessionId === instance.rootSessionId ? 'insert-if-busy' : undefined;
  }

  /**
   * `WorkflowHooks.userMessageFate` (r3-P1-2): a run's first message goes only to the root session of that
   * run, once the run exists. While its session or instance is not there yet it waits (the start is being
   * finished or repeated); when the session belongs to anything else it is cancelled and never sent.
   */
  async userMessageFate(record: StoredDelivery): Promise<'deliver' | 'wait' | 'cancel'> {
    const instanceId = startInstanceOf(record.sourceCallRef);
    const sessionId = record.target.sessionId;
    if (instanceId === undefined || sessionId === undefined) return 'deliver';
    const session = await this.repos.sessions.get(sessionId);
    if (session === undefined) return 'wait';
    if (session.kind !== 'workflow' || session.workflow.instanceId !== instanceId || session.workflow.taskId !== undefined) return 'cancel';
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined) return 'wait';
    return instance.rootSessionId === sessionId ? 'deliver' : 'cancel';
  }

  /**
   * `WorkflowHooks.mayDeliver`, asked in the target session's queue right before the dispatch. Not sent: a
   * handoff of a run that ended or of a blocked task; an arrival whose round is not ready (CR-4), unless the
   * user approved its blocked round; a handoff to a node whose concurrency the other tasks fill (R-06).
   */
  async mayDeliver(meta: HandoffMeta): Promise<boolean> {
    const instance = await this.repos.instances.get(meta.instanceId);
    if (instance === undefined || instance.state === 'completed' || instance.state === 'cancelled') return false;
    if (instance.tasks.find((t) => t.id === meta.taskId)?.status === 'blocked') return false;
    const to = nodeOf(instance.template, meta.toNodeId);
    // A task not started yet (or no longer at work) gets nothing; root still hears about it (T032).
    if (this.pipeline !== undefined && !(to?.kind === 'agent' && to.isRoot) && !this.pipeline.deliverable(instance, meta.taskId)) return false;
    const handoffs = await this.repos.handoffs.listByInstance(instance.id);
    // A handoff stored before T031 (round 0) belongs to no round and goes as T024 sent it (r1-P1-6).
    if (waitsForAll(to) && meta.round !== LEGACY_ROUND) {
      const round = instance.rounds.find((r) => r.taskId === meta.taskId && r.nodeId === meta.toNodeId && r.round === meta.round);
      if (round === undefined) {
        // Not written yet (a crash after the acceptance, or its fan-out still open): the check writes it.
        this.requestSync(instance.id);
        return false;
      }
      if (round !== (await this.roundDelivering(instance, handoffs, meta))) return false;
    }
    const limit = concurrencyOf(to);
    if (limit === undefined) return true;
    // From here to the reservation nothing is awaited, so two sessions' gates cannot both take the last slot.
    const nodeKey = JSON.stringify([instance.id, meta.toNodeId]);
    const reserved = this.reserved.get(nodeKey) ?? new Map<TaskId, Handoff['id']>();
    for (const [taskId, handoffId] of reserved) {
      // A reservation ends once its handoff crossed the boundary (the record counts it then) or was cancelled;
      // one this read does not show yet was made after it and stays.
      const handoff = handoffs.find((h) => h.id === handoffId);
      if (handoff !== undefined && (handoff.delivery.state !== 'pending' || handoff.outcome !== undefined)) reserved.delete(taskId);
    }
    const others = new Set([...occupyingTasks(instance, handoffs, meta.toNodeId), ...reserved.keys()]);
    others.delete(meta.taskId);
    if (others.size >= limit) return false;
    reserved.set(meta.taskId, meta.handoffId);
    this.reserved.set(nodeKey, reserved);
    return true;
  }

  /**
   * The one round a waiting node's session is given now (r1-P1-3): a round that may go (ready, or blocked and
   * approved by the user) with handoffs still to send; one already partly sent first, then the one that
   * became ready first (by round number on a tie). Another round's handoffs wait until it is all sent, so two
   * rounds never interleave, whatever order their handoffs were accepted in.
   */
  private async roundDelivering(instance: WorkflowInstance, handoffs: readonly Handoff[], meta: HandoffMeta): Promise<JoinRound | undefined> {
    const to = nodeOf(instance.template, meta.toNodeId);
    // Root has one session for every task; any other node one per task (R-06).
    const shared = to?.kind === 'agent' && to.isRoot;
    const own = (r: JoinRound) =>
      handoffs.filter((h) => h.taskId === r.taskId && h.toNodeId === r.nodeId && h.round === r.round && h.outcome === undefined && isArrival(instance.template, h));
    const candidates: JoinRound[] = [];
    for (const round of instance.rounds) {
      if (round.nodeId !== meta.toNodeId || (!shared && round.taskId !== meta.taskId)) continue;
      if (!own(round).some((h) => h.delivery.state === 'pending')) continue;
      if (round.state === 'waiting') continue;
      if (round.state === 'blocked' && (round.escalationId === undefined || (await this.repos.escalations.get(round.escalationId))?.state !== 'approved')) continue;
      candidates.push(round);
    }
    const started = candidates.find((r) => own(r).some((h) => h.delivery.state !== 'pending'));
    return started ?? candidates.sort((a, b) => ((a.settledAt ?? '') < (b.settledAt ?? '') ? -1 : (a.settledAt ?? '') > (b.settledAt ?? '') ? 1 : a.round - b.round))[0];
  }

  /** A slot of a node came free: the other tasks' handoffs waiting for it are tried again (R-06). */
  private wakeNode(instanceId: InstanceId, nodeId: NodeId): void {
    void (async () => {
      const sessions = new Set<SessionId>();
      const instance = this.pipeline === undefined ? undefined : await this.repos.instances.get(instanceId);
      for (const handoff of await this.repos.handoffs.listByInstance(instanceId)) {
        // A task not started yet is left alone: dispatching would start its session (T032).
        if (instance !== undefined && !this.pipeline?.deliverable(instance, handoff.taskId)) continue;
        if (handoff.toNodeId === nodeId && handoff.delivery.state === 'pending' && handoff.outcome === undefined && handoff.target.sessionId !== undefined) sessions.add(handoff.target.sessionId);
      }
      for (const sessionId of sessions) await this.deliverQueued(sessionId);
    })().catch((error: unknown) => this.log(`waking the handoffs waiting for node ${nodeId} failed (${errorName(error)})`));
  }

  /** The open limit escalation of a blocked task, or a new one when the user closed the earlier one. */
  private async stillBlocked(instance: WorkflowInstance, taskId: TaskId, caller: WorkflowSession): Promise<HandoffToolResult> {
    const open = (await this.repos.escalations.list({ state: 'open' })).find(
      (e) => e.kind === 'limit-exceeded' && e.instanceId === instance.id && e.ref?.kind === 'task' && e.ref.taskId === taskId,
    );
    const escalation =
      open ??
      (await this.openOnce(limitEscalationBase(JSON.stringify(['blocked', instance.id, taskId])), {
        instanceId: instance.id,
        rootSessionId: instance.rootSessionId,
        fromSessionId: caller.id,
        kind: 'limit-exceeded',
        title: 'Handoff limit reached',
        detail: 'the task stopped at a handoff limit; no handoff of it is delivered any more',
        ref: { kind: 'task', taskId },
      }));
    return { status: 'escalated', escalationId: escalation.id, reason: 'limit-exceeded' };
  }

  private async noRuleMatched(instance: WorkflowInstance, taskId: TaskId, caller: WorkflowSession, from: AgentNode): Promise<HandoffToolResult> {
    await this.openOnce(noRuleEscalationBase(instance.id, taskId, from.id), {
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: caller.id,
      kind: 'no-rule-matched',
      title: 'No output rule matched',
      // Fixed words: the rule ID and target are the agent's input.
      detail: `node "${from.label}" asked for a handoff that none of its output rules allows`,
      ref: { kind: 'task', taskId },
    });
    return rejected('no-matching-rule', 'no output rule of this node has this ruleId and target');
  }

  private async askConfirmation(instance: WorkflowInstance, caller: WorkflowSession, planned: Planned | MergePlanned, input: HandoffToolInput, ctx: HandoffCallContext, lineageId: Handoff['id'] | undefined, turnId: string | undefined): Promise<HandoffToolResult> {
    const id = handoffConfirmationId(ctx.operationId);
    const escalation: Escalation = {
      id,
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: caller.id,
      kind: 'confirmation',
      title: 'A handoff waits for your confirmation',
      detail: `node "${planned.from.label}" hands task ${planned.taskId} to node "${planned.to.label}" by rule ${planned.ruleId}`,
      ref: { kind: 'handoff', handoffId: handoffIdOf(ctx.operationId) },
      state: 'open',
      createdAt: this.options.now(),
    };
    this.confirmations.set(id, { caller: caller.id, input, ctx, lineageId, turnId });
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
    return { status: 'escalated', escalationId: id, reason: 'needs-confirmation' };
  }

  /** The question of a report that asks the user, once per report: an existing one (open or answered) is kept. */
  private async openReportQuestion(instance: WorkflowInstance, caller: SessionId, from: { label: string }, operationId: OperationId): Promise<Escalation> {
    const existing = await this.repos.escalations.get(reportConfirmationId(operationId));
    if (existing !== undefined) return existing;
    const escalation: Escalation = {
      id: reportConfirmationId(operationId),
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: caller,
      kind: 'confirmation',
      title: 'A node asks for your confirmation',
      detail: `node "${from.label}" asks for your confirmation; its report is in the root session`,
      ref: { kind: 'report', operationId },
      state: 'open',
      createdAt: this.options.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
    return escalation;
  }

  /** One open escalation per base ID: an open one is reused; after the user closed it, the next gets a new ID. */
  private async openOnce(base: string, fields: Omit<Escalation, 'id' | 'state' | 'createdAt'>): Promise<Escalation> {
    const first = EscalationId.parse(base);
    const existing = await this.repos.escalations.get(first);
    if (existing?.state === 'open') return existing;
    if (existing !== undefined) {
      const open = (await this.repos.escalations.list({ state: 'open' })).find((e) => e.id.startsWith(`${base}#`));
      if (open !== undefined) return open;
    }
    const escalation: Escalation = { ...fields, id: existing === undefined ? first : EscalationId.parse(`${base}#${this.options.uuid()}`), state: 'open', createdAt: this.options.now() };
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
    return escalation;
  }

  private async close(escalation: Escalation, state: 'approved' | 'declined' | 'resolved', by: 'user' | 'system'): Promise<void> {
    const closed: Escalation = { ...escalation, state, resolvedBy: by, resolvedAt: this.options.now() };
    await this.repos.escalations.upsert(closed);
    this.options.publish({ type: 'escalation.updated', escalation: closed });
  }

  // ---- instructions, restart ------------------------------------------------------------------------

  /** `WorkflowHooks.briefing`: the node's rules, task and limits, from the instance's pinned template. */
  async briefing(session: WorkflowSession): Promise<string | undefined> {
    if (isResolverSession(session.id)) return resolverBriefing();
    const instance = await this.repos.instances.get(session.workflow.instanceId);
    const node = instance === undefined ? undefined : nodeOf(instance.template, session.workflow.nodeId);
    if (instance === undefined || node?.kind !== 'agent') return undefined;
    // A run that has tasks to split or worktrees to work in is told so (T032); a one-task run as before.
    const pipelined = this.pipeline !== undefined && (instance.template.isolation === 'worktree' || rootNode(instance.template).outputRules.some((r) => r.target.kind === 'tasks'));
    if (pipelined) return briefing(instance, node, session.workflow.taskId, true);
    return briefing(instance, node, session.workflow.taskId ?? instance.tasks[0]?.id);
  }

  /**
   * Whether a run still counts on the work folder claimed for its root session (T048): its instance exists, or its
   * start was written (the first message), so a repeat or recovery goes on in that folder.
   */
  async workFolderInUse(claim: WorkFolderClaim): Promise<boolean> {
    if (claim.instanceId === undefined) return false;
    if ((await this.repos.instances.get(claim.instanceId)) !== undefined) return true;
    return (await this.store.get(firstMessageOperationOf(firstMessageIdOf(claim.instanceId)))) !== undefined;
  }

  /**
   * After the session service's start (CR-2 recovery done): each running run's tasks are rebuilt from its
   * handoffs, the one record of what was counted (`HandoffMeta.rework`), so the limit and the views agree.
   */
  async recover(): Promise<void> {
    const instances = await this.repos.instances.list();
    // A report that asked the user and was accepted before its question was written gets it now (r1-P1-7).
    for (const state of ['pending', 'unknown', 'sent'] as const) {
      for (const record of await this.store.listByState(state)) {
        if (record.kind !== 'peer-message' || record.peer?.instanceId === undefined || !asksConfirmation(record.operationId)) continue;
        const { instanceId, fromSessionId } = record.peer;
        const instance = instances.find((i) => i.id === instanceId);
        const caller = await this.repos.sessions.get(fromSessionId);
        const from = instance !== undefined && caller?.kind === 'workflow' ? nodeOf(instance.template, caller.workflow.nodeId) : undefined;
        if (instance !== undefined && from !== undefined) await this.openReportQuestion(instance, fromSessionId, from, record.operationId);
      }
    }
    for (const instance of instances) {
      if (instance.state !== 'running' && instance.state !== 'blocked') continue;
      const handoffs = await this.repos.handoffs.listByInstance(instance.id);
      const root = rootNode(instance.template);
      for (const task of instance.tasks) {
        // A stop at a limit that a crash cut short is finished: written first, its consequences now (r3 P1-1).
        if (task.status === 'blocked' && task.blockedReason === 'limit-exceeded') await this.finishStop(instance, task.id);
        // Where a task in or past the merge queue stands is the pipeline's record, not its last handoff (T032).
        if (task.status === 'awaiting-merge' || task.status === 'merging' || finalTaskStatuses.includes(task.status)) continue;
        const progress = taskProgress(handoffs, task.id, (h) => this.counted(instance, h));
        const currentNodeId = progress.lastNodeId ?? task.currentNodeId ?? root.id;
        if (task.reworkCount === progress.reworkCount && task.currentNodeId === currentNodeId) continue;
        await this.updateTask(instance.id, task.id, (t) => ({ ...t, reworkCount: progress.reworkCount, currentNodeId }));
      }
      // Every fan-out is closed now: the rounds are rebuilt from the handoffs, a wait limit that passed while
      // the GUI was down blocks its round, and decisions the user made are carried out (CR-4).
      await this.serial(`instance:${instance.id}`, () => this.syncNow(instance.id));
    }
    // Task lists, setups, merges and cleanups go on from where they stopped (T032).
    await this.pipeline?.recover();
  }

  /**
   * Events of the session service the rounds depend on (wired by the main process): a `delivery.resolve` that
   * cancelled an unknown delivery shows only as its escalation closing, and may cancel a round's branch.
   */
  observe(event: AppEvent): void {
    if (event.type !== 'escalation.updated') return;
    const { escalation } = event;
    if (escalation.kind === 'delivery-unknown' && escalation.instanceId !== undefined) {
      this.requestSync(escalation.instanceId);
      // A conflict's handover whose outcome the user decided: the merge queue looks again (T032).
      this.pipeline?.kick(escalation.instanceId);
    }
  }

  // ---- rounds (CR-4) --------------------------------------------------------------------------------

  /**
   * A round check after something was already stored (an acceptance, a decision): its failure is logged, not
   * returned, since every input is stored and the next check (a turn end, a restart) brings the rounds up.
   */
  private async syncSafely(instanceId: InstanceId): Promise<void> {
    await this.syncNow(instanceId).catch((error: unknown) => {
      if (isClosedError(error)) throw error;
      this.log(`checking the rounds of ${instanceId} failed (${errorName(error)})`);
    });
  }

  /** Queues a round check of the instance, unless one is queued and not started yet. */
  private requestSync(instanceId: InstanceId): void {
    if (this.syncQueued.has(instanceId) || this.options.sessions.isClosing()) return;
    this.syncQueued.add(instanceId);
    void this.serial(`instance:${instanceId}`, async () => {
      this.syncQueued.delete(instanceId);
      await this.syncNow(instanceId);
    }).catch((error: unknown) => this.log(`checking the rounds of ${instanceId} failed (${errorName(error)})`));
  }

  /**
   * Brings the instance's rounds up to its handoffs (run in the instance's queue): rounds made and settled,
   * tasks blocked at a blocked round or freed once the user decided it, all in one compare-and-set. Then what
   * follows from the stored state, each step safe to repeat: the escalation of a blocked round, delivery of
   * ready or approved rounds, cancelling declined ones, and the wait-limit timers.
   */
  private async syncNow(instanceId: InstanceId): Promise<void> {
    if (this.options.sessions.isClosing()) return;
    let instance: WorkflowInstance | undefined;
    let handoffs: Handoff[] = [];
    let decided = new Map<EscalationId, Escalation['state']>();
    for (let attempt = 0; ; attempt++) {
      const current = await this.repos.instances.get(instanceId);
      if (current === undefined || (current.state !== 'running' && current.state !== 'blocked')) return;
      handoffs = await this.repos.handoffs.listByInstance(instanceId);
      const branches = await this.branchFacts(current, handoffs);
      const now = this.options.now();
      const rounds = current.tasks.flatMap((task) =>
        deriveRounds(current.template, task.id, handoffs, current.rounds, {
          open: this.openRounds(instanceId, task.id),
          turnOf: (h) => branches.turns.get(h.id),
          provisionCancelled: (h) => branches.provisionCancelled.has(h.id),
          sentTo: (h) => branches.sentTo.get(h.id),
          now,
          escalationIdOf: (r) => roundEscalationId(instanceId, r.taskId, r.nodeId, r.round),
        }),
      );
      // Rounds of a task the instance no longer has are kept as they are.
      rounds.push(...current.rounds.filter((r) => !current.tasks.some((t) => t.id === r.taskId)));
      decided = new Map();
      for (const round of rounds) {
        if (round.state !== 'blocked' || round.escalationId === undefined) continue;
        const escalation = await this.repos.escalations.get(round.escalationId);
        if (escalation !== undefined) decided.set(round.escalationId, escalation.state);
      }
      const undecided = (taskId: TaskId) =>
        rounds.some((r) => r.taskId === taskId && r.state === 'blocked' && r.escalationId !== undefined && (decided.get(r.escalationId) ?? 'open') === 'open');
      const tasks = current.tasks.map((task): WorkflowTask => {
        if (finalTaskStatuses.includes(task.status)) return task;
        if (undecided(task.id)) return task.status === 'blocked' ? task : { ...task, status: 'blocked', blockedReason: 'round-blocked' };
        if (task.status === 'blocked' && task.blockedReason === 'round-blocked') {
          const freed: WorkflowTask = { ...task, status: 'running' };
          delete freed.blockedReason;
          return freed;
        }
        return task;
      });
      if (JSON.stringify(rounds) === JSON.stringify(current.rounds) && JSON.stringify(tasks) === JSON.stringify(current.tasks)) {
        instance = current;
        break;
      }
      const saved = await this.repos.instances.update({ ...current, revision: current.revision + 1, rounds, tasks }, current.revision);
      if (saved.status === 'saved') {
        instance = saved.record;
        this.options.publish({ type: 'instance.updated', instance });
        break;
      }
      if (attempt >= 4) {
        // Every input is stored, so the next check (a turn end, a handoff, a restart) writes it.
        this.log(`the rounds of ${instanceId} kept meeting newer revisions`);
        return;
      }
    }
    if (instance !== undefined) await this.followRounds(instance, handoffs, decided);
  }

  /**
   * What the fan-out branches a waiting round still expects say beyond their own records (CR-4): the state of
   * the turn each one started (a failed upstream); for one still pending, whether the user cancelled creating
   * its target session (a cancelled upstream); and, once the branch node has no turn running, where it sent
   * the task while working on that branch (handoffs, `report` for a report to root).
   */
  private async branchFacts(
    instance: WorkflowInstance,
    handoffs: readonly Handoff[],
  ): Promise<{ turns: Map<Handoff['id'], TurnState>; provisionCancelled: Set<Handoff['id']>; sentTo: Map<Handoff['id'], Set<string>> }> {
    const { template } = instance;
    const states = new Map<Handoff['id'], TurnState>();
    const provisionCancelled = new Set<Handoff['id']>();
    const sentTo = new Map<Handoff['id'], Set<string>>();
    let reports: Awaited<ReturnType<AppRepositories['peerMessages']['list']>> | undefined;
    const conversations = new Map<SessionId, Awaited<ReturnType<AppRepositories['conversations']['get']>>>();
    for (const member of handoffs) {
      if (isArrival(template, member) || member.delivery.state === 'unknown' || member.target.sessionId === undefined) continue;
      // Only a branch of a round some waiting node has arrivals in. Whether it arrived is judged per waiting
      // node (a branch that reached J has not reached K, r1-P1-4), so nothing else is left out here.
      if (!handoffs.some((a) => a.taskId === member.taskId && a.round === member.round && isArrival(template, a))) continue;
      const provision = member.target.provision;
      if (member.delivery.state === 'pending') {
        if (provision === undefined || member.target.nativeSessionRef !== undefined) continue;
        const record = await this.store.get(provision.operationId);
        const attempt = record?.delivery.attempts.at(-1);
        if (record?.outcome !== undefined || (record?.delivery.state === 'unknown' && attempt?.resolution?.decision === 'cancel')) provisionCancelled.add(member.id);
        continue;
      }
      const sessionId = member.target.sessionId;
      // A handoff call of the branch node still on its way may yet reach the waiting node: until it is in,
      // nothing about that node's turn or destinations decides the round (r2-P1-2).
      if ((this.inFlight.get(sessionId) ?? 0) > 0) continue;
      const last = member.delivery.attempts.at(-1);
      const turnRef = last?.state === 'sent' ? last.nativeRef.turnRef : undefined;
      if (turnRef !== undefined) {
        const conversation = conversations.get(sessionId) ?? (await this.repos.conversations.get(sessionId));
        conversations.set(sessionId, conversation);
        const turn = conversation.turns.find((t) => t.id === turnRef);
        if (turn !== undefined) states.set(member.id, turn.state);
      }
      // Where the branch node sent the task while this branch was its work (until the next handoff to it
      // crossed the boundary), once no turn of it runs: nothing more can come from that work then.
      if (member.delivery.state !== 'sent' || (await this.options.sessions.mainTurnRunning(sessionId))) continue;
      const from = dispatchedAt(member) ?? member.acceptedAt;
      const until = handoffs
        .filter((h) => h.taskId === member.taskId && h.toNodeId === member.toNodeId && h.id !== member.id && (dispatchedAt(h) ?? '') > from)
        .map((h) => dispatchedAt(h) ?? '')
        .sort()[0];
      const within = (at: string) => at > from && (until === undefined || at < until);
      const destinations = new Set<string>(handoffs.filter((h) => h.taskId === member.taskId && h.fromNodeId === member.toNodeId && within(h.acceptedAt)).map((h) => h.toNodeId));
      reports ??= await this.repos.peerMessages.list();
      if (reports.some((m) => m.instanceId === instance.id && m.fromSessionId === sessionId && m.toSessionId === instance.rootSessionId && within(m.createdAt))) destinations.add('report');
      if (destinations.size > 0) sentTo.set(member.id, destinations);
    }
    return { turns: states, provisionCancelled, sentTo };
  }

  /** What the stored rounds call for; every step is safe to repeat. */
  private async followRounds(instance: WorkflowInstance, handoffs: readonly Handoff[], decided: ReadonlyMap<EscalationId, Escalation['state']>): Promise<void> {
    const at = (r: JoinRound) => handoffs.filter((h) => h.taskId === r.taskId && h.toNodeId === r.nodeId && h.round === r.round);
    const waitingKeys = new Set<string>();
    for (const round of instance.rounds) {
      const held = at(round).filter((h) => h.delivery.state === 'pending' && h.outcome === undefined && h.target.sessionId !== undefined);
      if (round.state === 'waiting') {
        if (round.deadline !== undefined) {
          const key = roundKeyOf(instance.id, round);
          waitingKeys.add(key);
          this.armTimer(instance.id, key, round.deadline);
        }
        continue;
      }
      if (round.state === 'blocked') {
        const state = round.escalationId === undefined ? undefined : decided.get(round.escalationId);
        if (state === undefined) await this.openRoundEscalation(instance, round);
        if (state === 'declined' || state === 'resolved') {
          for (const handoff of held) {
            const written = await this.store
              .recordOutcome(handoff.operationId, { kind: 'cancelled', detail: 'the user declined its blocked round', at: this.options.now() })
              .catch((error: unknown) => {
                this.log(`cancelling handoff ${handoff.id} failed (${errorName(error)})`);
                return 'failed' as const;
              });
            if (written === 'recorded') await this.publishHandoff(handoff.id);
          }
        }
        if (state !== 'approved') continue;
      }
      // Ready, or approved by the user: the gate sends the oldest one, the rest after each turn (SP-05).
      const next = held.sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : 1))[0];
      if (next?.target.sessionId !== undefined) await this.deliver(next.operationId, next.target.sessionId, next.id);
    }
    const prefix = `${JSON.stringify([instance.id]).slice(0, -1)},`;
    for (const [key, timer] of this.timers) {
      if (key.startsWith(prefix) && !waitingKeys.has(key)) {
        timer.cancel();
        this.timers.delete(key);
      }
    }
  }

  /** One timer per waiting round with a wait limit; it only asks for a round check. */
  private armTimer(instanceId: InstanceId, key: string, deadline: Timestamp): void {
    if (this.timers.get(key)?.at === deadline) return;
    this.timers.get(key)?.cancel();
    const entry = { at: deadline, cancel: () => undefined as void };
    this.timers.set(key, entry);
    entry.cancel = this.options.schedule(deadline, () => {
      if (this.timers.get(key) === entry) this.timers.delete(key);
      this.requestSync(instanceId);
    });
  }

  /** The question of a blocked round, under its fixed ID (written again if a crash came between the two). */
  private async openRoundEscalation(instance: WorkflowInstance, round: JoinRound): Promise<void> {
    if (round.escalationId === undefined || (await this.repos.escalations.get(round.escalationId)) !== undefined) return;
    const { template } = instance;
    const label = (id: NodeId) => `"${nodeOf(template, id)?.label ?? id}"`;
    const why =
      round.blockedReason === 'timeout'
        ? 'its wait limit passed'
        : round.blockedReason === 'upstream-cancelled'
          ? `the work of node ${label(round.blockedUpstream ?? round.nodeId)} was cancelled`
          : `node ${label(round.blockedUpstream ?? round.nodeId)} failed`;
    const node = nodeOf(template, round.nodeId);
    const fromSessionId =
      node?.kind === 'agent' && node.isRoot
        ? instance.rootSessionId
        : ((await this.repos.instances.findNodeSession({ instanceId: instance.id, nodeId: round.nodeId, taskId: round.taskId })) ?? instance.rootSessionId);
    const escalation: Escalation = {
      id: round.escalationId,
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId,
      kind: 'round-blocked',
      title: 'A round stopped waiting',
      detail: `round ${String(round.round)} of node ${label(round.nodeId)} for task ${round.taskId}: ${why}; ${String(round.arrived.length)} of ${String(round.expectedUpstream.length)} upstream arrived. Approve to deliver what arrived (and anything arriving later); decline to cancel the round.`,
      ref: { kind: 'round', taskId: round.taskId, nodeId: round.nodeId, round: round.round },
      state: 'open',
      createdAt: this.options.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.options.publish({ type: 'escalation.updated', escalation });
  }

  // ---- records --------------------------------------------------------------------------------------

  /** Compare-and-set of one task of an instance; `mutate` returns undefined for no change. */
  private async updateTask(instanceId: InstanceId, taskId: TaskId, mutate: (task: WorkflowTask) => WorkflowTask | undefined): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.repos.instances.get(instanceId);
      const task = current?.tasks.find((t) => t.id === taskId);
      if (current === undefined || task === undefined) return;
      const next = mutate(task);
      if (next === undefined) return;
      const saved = await this.repos.instances.update({ ...current, revision: current.revision + 1, tasks: current.tasks.map((t) => (t.id === taskId ? next : t)) }, current.revision);
      if (saved.status === 'saved') {
        this.options.publish({ type: 'instance.updated', instance: saved.record });
        return;
      }
    }
    this.log(`updating task ${taskId} kept meeting newer revisions; it is rebuilt at the next start`);
  }

  private async publishHandoff(handoffId: Handoff['id']): Promise<void> {
    const handoff = await this.repos.handoffs.get(handoffId);
    if (handoff !== undefined) this.options.publish({ type: 'handoff.updated', handoff });
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
    this.options.log?.(`[workflow] ${message}`);
  }
}


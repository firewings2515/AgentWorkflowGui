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
  type Escalation,
  EscalationId,
  type Handoff,
  type HandoffToolInput,
  type HandoffToolResult,
  type InstanceId,
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
  type WorkflowInstance,
  type WorkflowTask,
} from '../../contracts';
import type { DeliveryService } from '../delivery';
import type { AppRepositories, DeliveryStore, StoredDelivery } from '../ports';
import type { CommandOf, SessionService, WorkflowHooks, WorkflowSession } from '../sessions';
import { type AgentNode, agentNodes, briefing, handoffCounts, handoffText, hasEdge, isRework, nodeOf, reportText, reworkKey, rootNode, runtimesOf, sameTarget, taskProgress } from './graph';
import {
  firstMessageIdOf,
  handoffConfirmationId,
  handoffIdOf,
  limitEscalationBase,
  noRuleEscalationBase,
  peerIdOf,
  reportConfirmationId,
  taskIdOf,
} from './ids';

export interface WorkflowEngineOptions {
  sessions: SessionService;
  publish(event: AppEvent): void;
  now(): Timestamp;
  uuid(): string;
  /** `sha256:<hex>` of a text, the same function the delivery service checks with. */
  hashPayload(text: string): PayloadHash | Promise<PayloadHash>;
  log?(message: string): void;
}

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

/** Report operation IDs say whether the report asked for the user's confirmation (r1-P1-7). */
const REPORT = 'report-';
const REPORT_ASKING = 'report-c-';
const asksConfirmation = (operationId: OperationId) => operationId.startsWith(REPORT_ASKING);

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
}

/** Everything a handoff call resolves to before anything is written. */
interface Planned {
  instance: WorkflowInstance;
  taskId: TaskId;
  from: AgentNode;
  to: AgentNode;
  ruleId: string;
  requiresUserConfirmation: boolean;
  payload: string;
}

export class WorkflowEngine implements WorkflowHooks {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly confirmations = new Map<EscalationId, PendingHandoff>();

  constructor(private readonly options: WorkflowEngineOptions) {}

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
    const { requestId, instanceId, rootSessionId, workflowId, workflowRevision, title, cwd, firstMessage, crossToolConsent } = command;
    const sessions = this.options.sessions;
    const repos = this.repos;
    const messageId = firstMessageIdOf(instanceId);
    const taken = () => fail(requestId, 'already_exists', 'A workflow run with this ID already exists');
    // What a start stores, in order: the root session (its cwd), the first message, then the instance (its
    // title, revision and consent). A repeat must match all of it, wherever the first one stopped (r1-P1-4).
    const sameSoFar = async (): Promise<boolean> => {
      const root = await repos.sessions.get(rootSessionId);
      if (root === undefined) return true;
      if (root.kind !== 'workflow' || root.workflow.instanceId !== instanceId || root.workflow.taskId !== undefined || root.cwd !== cwd) return false;
      const first = (await repos.conversations.get(rootSessionId)).messages.find((m) => m.id === messageId);
      return first === undefined || (first.role === 'user' && first.origin.kind === 'user' && first.text === firstMessage);
    };
    let instance = await repos.instances.get(instanceId);
    if (instance !== undefined) {
      const same =
        instance.workflowId === workflowId &&
        instance.workflowRevision === workflowRevision &&
        instance.rootSessionId === rootSessionId &&
        instance.title === title &&
        (instance.crossToolConsentAt !== undefined) === crossToolConsent &&
        (await repos.sessions.get(rootSessionId)) !== undefined &&
        (await sameSoFar());
      if (!same) return taken();
    } else {
      // A session under this ID is only an earlier attempt of this same start (r1-P1-4).
      if (!(await sameSoFar())) return taken();
      const template = await repos.workflows.get(workflowId);
      if (template === undefined) return fail(requestId, 'not_found', 'Unknown workflow');
      // Pinned to what the user saw and agreed to (R-11): a changed template is refused, never started.
      if (template.revision !== workflowRevision) return fail(requestId, 'stale_revision', 'The workflow has changed since it was loaded', { retryable: true });
      for (const node of agentNodes(template)) {
        if ((await repos.agents.get(node.agentId)) === undefined) return fail(requestId, 'not_found', `Unknown agent of node "${node.label}"`);
        if (!sessions.runtimeAvailable(node.model.runtime)) return fail(requestId, 'runtime_unavailable', `${node.model.runtime} is not available on this computer`);
      }
      // Starting is the consent to cross-tool handoffs between the run's nodes (R-11); without it nothing starts.
      if (runtimesOf(template).size > 1 && !crossToolConsent) return fail(requestId, 'invalid_request', 'This workflow hands off between tools; starting it needs that consent');
      if (!sessions.canResolve(cwd)) return fail(requestId, 'invalid_request', 'The working folder cannot be resolved');
      const at = this.options.now();
      const root = rootNode(template);
      const task: WorkflowTask = { id: taskIdOf(instanceId), instanceId, title, dependsOn: [], status: 'running', currentNodeId: root.id, reworkCount: 0 };
      const created: WorkflowInstance = {
        id: instanceId,
        revision: 0,
        workflowId,
        workflowRevision,
        title,
        rootSessionId,
        state: 'running',
        ...(crossToolConsent && { crossToolConsentAt: at }),
        template,
        tasks: [task],
        createdAt: at,
      };
      if (sessions.isClosing()) return fail(requestId, 'runtime_unavailable', 'The application is closing');
      const made = await sessions.createWorkflowSession({ sessionId: rootSessionId, instance: created, nodeId: root.id, cwd });
      if (made === 'taken') return fail(requestId, 'already_exists', 'A session with this ID already exists');
      if (made === 'unresolvable') return fail(requestId, 'invalid_request', 'The working folder cannot be resolved');
      if (made === 'closing') return fail(requestId, 'runtime_unavailable', 'The application is closing');
      if ((await sessions.recordUserMessage(rootSessionId, messageId, firstMessage)) === 'taken') return taken();
      if ((await repos.instances.create(created)) === 'exists') return taken();
      instance = (await repos.instances.get(instanceId)) ?? created;
      this.options.publish({ type: 'instance.updated', instance });
    }
    const root = rootNode(instance.template);
    const bound = await repos.instances.bindNodeSession({ instanceId, nodeId: root.id }, rootSessionId);
    if (bound.status === 'exists' && bound.sessionId !== rootSessionId) return fail(requestId, 'already_exists', 'The run already has another root session');
    const sent = await sessions.sendAsUser(requestId, rootSessionId, messageId, firstMessage);
    if (!sent.ok) return { ...sent, mayHaveSideEffects: true };
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
    try {
      if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
      const caller = await this.repos.sessions.get(ctx.caller);
      if (caller?.kind !== 'workflow') return NOT_IN_WORKFLOW;
      return await this.serial(`instance:${caller.workflow.instanceId}`, () => this.handoffNow(caller, input, ctx, false));
    } catch (error) {
      if (this.options.sessions.isClosing() || isClosedError(error)) return SHUTTING_DOWN;
      throw error;
    }
  }

  private async handoffNow(caller: WorkflowSession, input: HandoffToolInput, ctx: HandoffCallContext, confirmed: boolean): Promise<HandoffToolResult> {
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
    const { instance, taskId, from, to } = planned;

    // A resend: the same call after a restart (same sourceCallRef) or a `retryOf` (same operationId, CR2 §4).
    const known = (await this.store.get(ctx.operationId)) ?? (await this.store.findBySourceCallRef(ctx.sourceCallRef));
    if (known !== undefined) return this.resent(known, caller, planned);

    // A task stopped at a limit hands off nowhere, root included, until the user deals with it (R-05, r1-P1-1).
    if (instance.tasks.find((t) => t.id === taskId)?.status === 'blocked') return this.stillBlocked(instance, taskId, caller);

    const handoffs = await this.repos.handoffs.listByInstance(instance.id);
    const rework = isRework(handoffs, taskId, to.id);
    const { counts, current } = handoffCounts(instance, handoffs, taskId, to, rework);
    const over = current.find((c) => c.limit !== undefined && c.count >= c.limit);
    if (over !== undefined) return this.limitReached(instance, taskId, caller, to, over.key, over.what, over.limit ?? 0);

    if (planned.requiresUserConfirmation && !confirmed) return this.askConfirmation(instance, caller, planned, input, ctx);

    const targetSessionId = await this.nodeSession(instance, to, taskId, caller);
    if (targetSessionId === undefined) return rejected('unknown-target', 'the target session cannot be created');
    const target = await this.options.sessions.payloadTarget(targetSessionId);
    const handoffId = handoffIdOf(ctx.operationId);
    const origin: MessageOrigin = { kind: 'handoff', fromSessionId: caller.id, handoffId };
    const context = await this.options.sessions.payloadContext(targetSessionId, origin);
    if (target === undefined || context === undefined) return rejected('unknown-target', 'the target session cannot be started');
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    const accepted = await this.delivery.accept({
      kind: 'handoff',
      operationId: ctx.operationId,
      sourceCallRef: ctx.sourceCallRef,
      sender: caller.id,
      payloadHash: await this.options.hashPayload(planned.payload),
      payload: planned.payload,
      proposalRevision: instance.workflowRevision,
      target,
      at: this.options.now(),
      context,
      counts,
      handoff: { handoffId, instanceId: instance.id, taskId, fromNodeId: from.id, toNodeId: to.id, fromSessionId: caller.id, ruleId: planned.ruleId, rework, round: 0 },
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
    const reworkCount = accepted.counts?.find((c) => c.key === reworkKey(instance.id, taskId))?.count;
    await this.updateTask(instance.id, taskId, (t) => ({ ...t, status: 'running', currentNodeId: to.id, ...(reworkCount !== undefined && { reworkCount }) }));
    await this.publishHandoff(handoffId);
    const delivery = await this.deliver(ctx.operationId, targetSessionId, handoffId);
    return { status: 'accepted', handoffId, operationId: ctx.operationId, delivery };
  }

  /** The checks of R-04 step 2 that need nothing counted: the caller's task, its rule and the edge. */
  private async plan(caller: WorkflowSession, input: HandoffToolInput): Promise<Planned | HandoffToolResult> {
    const instance = await this.repos.instances.get(caller.workflow.instanceId);
    if (instance === undefined) return rejected('unknown-target', 'no such workflow run');
    if (instance.state === 'completed' || instance.state === 'cancelled') return rejected('invalid-input', 'this workflow run has ended');
    const { template } = instance;
    const from = nodeOf(template, caller.workflow.nodeId);
    if (from?.kind !== 'agent') return rejected('unknown-target', 'the calling node is not in this workflow');
    // A node works on its own task; root, which has none, names it or means the run's one task.
    const own = caller.workflow.taskId;
    if (own !== undefined && input.taskId !== undefined && input.taskId !== own) return rejected('invalid-input', 'a node hands off its own task only');
    const taskId = own ?? input.taskId ?? instance.tasks[0]?.id;
    if (taskId === undefined || !instance.tasks.some((t) => t.id === taskId)) return rejected('unknown-target', 'no such task');
    // The edge first (R-04 step 2), so a target the graph does not connect is named as such (V-23).
    if (input.target.kind === 'node') {
      if (nodeOf(template, input.target.nodeId) === undefined) return rejected('unknown-target', 'no such node');
      if (!hasEdge(template, from.id, input.target.nodeId)) return rejected('not-connected', 'there is no edge from this node to the target');
    }
    const rule = from.outputRules.find((r) => r.id === input.ruleId && sameTarget(r.target, input.target));
    if (rule === undefined) return this.noRuleMatched(instance, taskId, caller, from);
    const root = rootNode(template);
    const toId: NodeId = rule.target.kind === 'root' ? root.id : rule.target.nodeId;
    if (toId === from.id) return rejected('invalid-input', 'a node cannot hand off to itself');
    const to = nodeOf(template, toId);
    if (to === undefined) return rejected('unknown-target', 'no such node');
    if (to.kind !== 'agent') return rejected('unsupported', 'merge nodes come with task pipelining');
    return { instance, taskId, from, to, ruleId: rule.id, requiresUserConfirmation: rule.requiresUserConfirmation, payload: handoffText(from, rule.id, taskId, input.content) };
  }

  /** A known operation: the same handoff from the same caller is a duplicate; anything else is refused. */
  private async resent(record: StoredDelivery, caller: WorkflowSession, planned: Planned): Promise<HandoffToolResult> {
    if (record.kind !== 'handoff' || record.handoff === undefined) return rejected('invalid-input', 'this operation is not a handoff');
    if (record.sender !== caller.id) return NOT_OWNER;
    const meta = record.handoff;
    const same =
      meta.instanceId === planned.instance.id && meta.taskId === planned.taskId && meta.toNodeId === planned.to.id && meta.ruleId === planned.ruleId && record.payloadHash === (await this.options.hashPayload(planned.payload));
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
    const key = { instanceId: instance.id, nodeId: node.id, taskId };
    let sessionId = await repos.instances.findNodeSession(key);
    if (sessionId === undefined) {
      const fresh = SessionId.parse(`wf-${this.options.uuid()}`);
      const bound = await repos.instances.bindNodeSession(key, fresh);
      sessionId = bound.status === 'exists' ? bound.sessionId : fresh;
    }
    // Same folder as root in batch 4 (no worktree); the source that created it is its parent (WB-01).
    const made = await this.options.sessions.createWorkflowSession({ sessionId, instance, nodeId: node.id, taskId, cwd: root.cwd, parentId: caller.id });
    return made === 'created' || made === 'exists' ? sessionId : undefined;
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
    void this.deliverQueued(sessionId).catch((error: unknown) => this.log(`delivering the handoffs queued for ${sessionId} failed (${errorName(error)})`));
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
    await this.options.sessions.deliverWorkflow(operationId, rootId, 'insert-if-busy');
    const message = await this.repos.peerMessages.get(peerMessageId);
    if (message !== undefined) this.options.publish({ type: 'peerMessage.updated', message });
    return { status: 'reported', ...(escalation !== undefined && { escalationId: escalation.id }) };
  }

  /** `create_tasks` comes with task pipelining (batch 5). */
  async createTasks(_input: CreateTasksToolInput, ctx: { caller: SessionId }): Promise<CreateTasksToolResult> {
    if (this.options.sessions.isClosing()) return SHUTTING_DOWN;
    const caller = await this.repos.sessions.get(ctx.caller).catch(() => undefined);
    if (caller?.kind !== 'workflow') return NOT_IN_WORKFLOW;
    return rejected('unsupported', 'create_tasks is not available in this version: a run carries one task');
  }

  // ---- escalations ----------------------------------------------------------------------------------

  /** The user's answer to one of the engine's escalations (R-05); undefined for the session service's own. */
  async respond(escalation: Escalation, command: CommandOf<'escalation.respond'>): Promise<CommandResult | undefined> {
    const { requestId, decision } = command;
    if (escalation.instanceId === undefined) return undefined;
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
          const result = await this.serial(`instance:${caller.workflow.instanceId}`, () => this.handoffNow(caller, pending.input, pending.ctx, true));
          if (result.status !== 'accepted' && result.status !== 'duplicate') this.log(`a confirmed handoff of ${caller.id} ended ${result.status}`);
        }
      }
      return ok(requestId);
    }
    if (escalation.kind === 'confirmation' && escalation.ref?.kind === 'report') {
      await this.close(escalation, decision === 'approve' ? 'approved' : 'declined', 'user');
      return ok(requestId);
    }
    if (escalation.kind === 'limit-exceeded' || escalation.kind === 'no-rule-matched') {
      // Seen by the user; the limit itself still holds (R-05).
      await this.close(escalation, 'resolved', 'user');
      return ok(requestId);
    }
    return undefined;
  }

  private async limitReached(instance: WorkflowInstance, taskId: TaskId, caller: WorkflowSession, to: AgentNode, key: string, what: 'receive' | 'rework', limit: number): Promise<HandoffToolResult> {
    const detail = what === 'rework' ? `the task reached its rework limit of ${String(limit)}` : `node "${to.label}" reached its receive limit of ${String(limit)} for the task`;
    const escalation = await this.openOnce(limitEscalationBase(key), {
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: caller.id,
      kind: 'limit-exceeded',
      title: 'Handoff limit reached',
      detail,
      ref: { kind: 'task', taskId },
    });
    // The GUI stops handing off this task until the user decides (R-05).
    await this.updateTask(instance.id, taskId, (t) => (t.status === 'blocked' ? undefined : { ...t, status: 'blocked' }));
    return { status: 'escalated', escalationId: escalation.id, reason: 'limit-exceeded' };
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

  private async askConfirmation(instance: WorkflowInstance, caller: WorkflowSession, planned: Planned, input: HandoffToolInput, ctx: HandoffCallContext): Promise<HandoffToolResult> {
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
    this.confirmations.set(id, { caller: caller.id, input, ctx });
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
    const instance = await this.repos.instances.get(session.workflow.instanceId);
    const node = instance === undefined ? undefined : nodeOf(instance.template, session.workflow.nodeId);
    if (instance === undefined || node?.kind !== 'agent') return undefined;
    return briefing(instance, node, session.workflow.taskId ?? instance.tasks[0]?.id);
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
        const progress = taskProgress(handoffs, task.id);
        const currentNodeId = progress.lastNodeId ?? task.currentNodeId ?? root.id;
        if (task.reworkCount === progress.reworkCount && task.currentNodeId === currentNodeId) continue;
        await this.updateTask(instance.id, task.id, (t) => ({ ...t, reworkCount: progress.reworkCount, currentNodeId }));
      }
    }
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


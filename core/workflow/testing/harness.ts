// The workflow engine on the session service, memory ports and fake adapters (T024). Handoffs and peer
// messages are read back from the delivery store, as T022's repositories do, so counting, rework and the
// views come from one record. `restart()` gives a new service and engine on the same stored state.
import {
  type AgentDefinition,
  AgentId,
  type AppEvent,
  CONTRACTS_VERSION,
  type Command,
  type CommandResult,
  type Handoff,
  type HandoffToolInput,
  type InstanceId,
  NodeId,
  OperationId,
  type PeerMessage,
  RequestId,
  type Runtime,
  SessionId,
  TurnId,
  WorkflowId,
  type WorkflowNode,
  type WorkflowTemplate,
} from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import { MemoryDeliveryStore } from '../../delivery/testing/memory-store';
import type { WorktreeFiles } from '../../pipeline';
import type { AppRepositories, DeliveryStore, GitPort, McpMount, PermissionPolicy, PolicyDecision, StoredDelivery } from '../../ports';
import { SessionService } from '../../sessions';
import { FakeAdapter } from '../../sessions/testing/fake-adapter';
import { MemoryRepositories } from '../../sessions/testing/memory-repositories';
import { FakeCommands, FakeFiles } from '../../pipeline/testing/fakes';
import { MemoryGit } from '../../pipeline/testing/memory-git';
import { WorkflowEngine } from '../engine';

export const CWD = 'E:\\work\\project';
export const PLANNER = AgentId.parse('agent-planner');
export const BUILDER = AgentId.parse('agent-builder');
export const REVIEWER = AgentId.parse('agent-reviewer');
export const WORKFLOW = WorkflowId.parse('wf-build');
export const PLAN = NodeId.parse('plan');
export const IMPL = NodeId.parse('impl');
export const REVIEW = NodeId.parse('review');

const agent = (id: AgentId, name: string): AgentDefinition => ({
  schemaVersion: CONTRACTS_VERSION,
  id,
  revision: 0,
  name,
  description: '',
  instructions: `${name} instructions.`,
  updatedAt: '2026-10-29T00:00:00.000Z',
});

/** The three Agents of the template flow. */
export const agents = (): AgentDefinition[] => [agent(PLANNER, 'Planner'), agent(BUILDER, 'Builder'), agent(REVIEWER, 'Reviewer')];

export const node = (id: NodeId, extra: Partial<Extract<WorkflowNode, { kind: 'agent' }>>): Extract<WorkflowNode, { kind: 'agent' }> => ({
  id,
  kind: 'agent',
  label: id,
  agentId: PLANNER,
  model: { runtime: 'claude', model: 'haiku' },
  isRoot: false,
  writePolicy: 'write',
  concurrency: 1,
  inputRules: [],
  outputRules: [],
  position: { x: 0, y: 0 },
  ...extra,
});

/**
 * The template flow: plan (Claude, root) → implement (Codex) → review (Claude, read-only), which sends the
 * task back to implement or reports to root.
 */
export const template = (extra: Partial<WorkflowTemplate> = {}, nodes: Partial<Record<'plan' | 'impl' | 'review', Partial<Extract<WorkflowNode, { kind: 'agent' }>>>> = {}): WorkflowTemplate => ({
  schemaVersion: CONTRACTS_VERSION,
  id: WORKFLOW,
  revision: 0,
  name: 'Build',
  description: '',
  reworkLimit: 2,
  isolation: 'same-folder',
  nodes: [
    node(PLAN, {
      label: 'Plan',
      agentId: PLANNER,
      isRoot: true,
      outputRules: [{ id: 'to-impl', condition: 'the plan is ready', payload: 'the plan', target: { kind: 'node', nodeId: IMPL }, requiresUserConfirmation: false }],
      ...nodes.plan,
    }),
    node(IMPL, {
      label: 'Implement',
      agentId: BUILDER,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      inputRules: [{ id: 'work', condition: 'a plan or review findings', waitForAllUpstream: false }],
      outputRules: [{ id: 'to-review', condition: 'the change is done', payload: 'what changed', target: { kind: 'node', nodeId: REVIEW }, requiresUserConfirmation: false }],
      ...nodes.impl,
    }),
    node(REVIEW, {
      label: 'Review',
      agentId: REVIEWER,
      writePolicy: 'read-only',
      inputRules: [{ id: 'change', condition: 'a change to review', waitForAllUpstream: false }],
      outputRules: [
        { id: 'rework', condition: 'the change needs work', payload: 'the findings', target: { kind: 'node', nodeId: IMPL }, requiresUserConfirmation: false },
        { id: 'done', condition: 'the change is good', payload: 'the verdict', target: { kind: 'root' }, requiresUserConfirmation: false },
      ],
      ...nodes.review,
    }),
  ],
  edges: [
    { source: PLAN, target: IMPL },
    { source: IMPL, target: REVIEW },
    { source: REVIEW, target: IMPL },
  ],
  updatedAt: '2026-10-29T00:00:00.000Z',
  ...extra,
});

const handoffOf = (r: StoredDelivery): Handoff | undefined => {
  if (r.kind !== 'handoff' || r.handoff === undefined) return undefined;
  const m = r.handoff;
  return {
    id: m.handoffId,
    operationId: r.operationId,
    sourceCallRef: r.sourceCallRef ?? r.operationId,
    instanceId: m.instanceId,
    taskId: m.taskId,
    fromNodeId: m.fromNodeId,
    toNodeId: m.toNodeId,
    fromSessionId: m.fromSessionId,
    ruleId: m.ruleId,
    rework: m.rework,
    payload: r.payload,
    payloadHash: r.payloadHash,
    proposalRevision: r.proposalRevision,
    round: m.round,
    ...(m.expectedUpstream !== undefined && { expectedUpstream: [...m.expectedUpstream] }),
    target: r.target,
    delivery: r.delivery,
    ...(r.outcome !== undefined && { outcome: r.outcome }),
    acceptedAt: r.acceptedAt,
  };
};

const peerOf = (r: StoredDelivery): PeerMessage | undefined => {
  if (r.kind !== 'peer-message' || r.peer === undefined) return undefined;
  return {
    id: r.peer.peerMessageId,
    operationId: r.operationId,
    sourceCallRef: r.sourceCallRef ?? r.operationId,
    fromSessionId: r.peer.fromSessionId,
    toSessionId: r.peer.toSessionId,
    ...(r.target.nativeSessionRef !== undefined && { toNativeSessionRef: r.target.nativeSessionRef }),
    ...(r.peer.instanceId !== undefined && { instanceId: r.peer.instanceId }),
    text: r.payload,
    payloadHash: r.payloadHash,
    entry: r.context.entry.kind,
    delivery: r.delivery,
    createdAt: r.acceptedAt,
  };
};

const all = async (store: DeliveryStore) => [...(await store.listByState('pending')), ...(await store.listByState('unknown')), ...(await store.listByState('sent'))];

/** Memory repositories whose handoffs and peer messages are the delivery store's records (C-12). */
class WorkflowRepositories extends MemoryRepositories {
  constructor(private readonly store: MemoryDeliveryStore) {
    super();
  }

  override readonly handoffs = {
    get: async (id: string): Promise<Handoff | undefined> => (await all(this.store)).map(handoffOf).find((h) => h?.id === id),
    listByInstance: async (instanceId: InstanceId) =>
      (await all(this.store))
        .map(handoffOf)
        .filter((h): h is Handoff => h?.instanceId === instanceId)
        .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : 1)),
  };

  override readonly peerMessages = {
    get: async (id: string): Promise<PeerMessage | undefined> => (await all(this.store)).map(peerOf).find((m) => m?.id === id),
    list: async () => (await all(this.store)).map(peerOf).filter((m): m is PeerMessage => m !== undefined),
  };
}

let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;
let requests = 0;
export const rid = () => RequestId.parse(`r-${++requests}`);
/** Strictly increasing timestamps, so handoffs keep their order; `advanceClock` moves them on (wait limits, T031). */
let ticks = 0;
let skipped = 0;
const now = () => new Date(Date.UTC(2026, 9, 29, 1, 0, 0, ++ticks + skipped)).toISOString();
/** The harness clock (setup outputs are recorded with it, T032). */
export const clock = () => now();
export const advanceClock = (ms: number) => {
  skipped += ms;
};


export interface World {
  repositories: AppRepositories;
  store: DeliveryStore;
  codex: Map<string, FakeAdapter>;
  claude: FakeAdapter;
  events: AppEvent[];
  mounts: { sessionId: SessionId; mount: McpMount }[];
  decide: () => PolicyDecision;
  service: SessionService;
  engine: WorkflowEngine;
  logs: string[];
  /**
   * The runtime's turn after each new-turn dispatch (r1-P2-3): it starts, then completes at once, unless its
   * session is in `holding`; `finishTurn` then completes the turn the session runs.
   */
  holding: Set<SessionId>;
  /** Sessions whose runtime reports no turn at all after a dispatch (a lost notification). */
  silent: Set<SessionId>;
  open: Map<SessionId, string>;
  finishTurn(sessionId: SessionId): Promise<void>;
  /** Emits a turn event of a session as its runtime would (a replay of an old one included). */
  emitTurn(sessionId: SessionId, turnId: string, state: 'running' | 'completed'): void;
  run(command: Command): Promise<CommandResult>;
  restart(): Promise<World>;
  /** The engine's timers (wait limits, T031); they end with the process, so a restart's engine arms its own. */
  timers: Set<{ at: string; fn: () => void }>;
  /** Runs the timers that are due by the clock (see `advanceClock`). */
  fireTimers(): void;
  /** The task pipeline's git, commands and folders (T032): kept across a restart, like the disk. */
  git: MemoryGit;
  commands: FakeCommands;
  files: FakeFiles;
  /** Sessions whose runtime the pipeline closed before removing a folder. */
  closed: SessionId[];
}

let turns = 0;
const adapterOf = (w: World, sessionId: SessionId) => w.codex.get(sessionId) ?? w.claude;

/** Adds the turn a dispatch starts: Codex adapters serve one session; Claude's maps its refs back. */
const withTurns = (adapter: FakeAdapter, w: World, codexSession?: SessionId): FakeAdapter => {
  const dispatch = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = async (request) => {
    let result = await dispatch(request);
    const sessionId =
      codexSession ??
      [...adapter.started.map((o) => [o.preallocatedRef, o.sessionId] as const), ...adapter.resumed.map((o) => [o.nativeSessionRef, o.sessionId] as const)].find(
        ([ref]) => ref === request.nativeSessionRef,
      )?.[1];
    if (result.state === 'sent' && request.entry.kind === 'new-turn' && sessionId !== undefined) {
      // The ack names the turn the dispatch started, as both runtimes' acks do (r2-P1-2).
      const id = `turn-run-${String(++turns)}`;
      result = { ...result, nativeRef: { ...result.nativeRef, turnRef: id } };
      // After the dispatch returned, as a runtime's notifications arrive; a silent session reports none.
      void Promise.resolve().then(() => {
        if (w.silent.has(sessionId)) {
          w.open.set(sessionId, id);
          return;
        }
        w.emitTurn(sessionId, id, 'running');
        if (w.holding.has(sessionId)) w.open.set(sessionId, id);
        else w.emitTurn(sessionId, id, 'completed');
      });
    }
    return result;
  };
  return adapter;
};

/** A real git and real folders for the pipeline instead of the memory ones (T032 integration tests). */
export interface RealFolders {
  git: GitPort;
  files: WorktreeFiles;
}

const build = (repositories: AppRepositories, store: DeliveryStore, previous?: World, real?: RealFolders): World => {
  const world = {
    repositories,
    store,
    codex: new Map<string, FakeAdapter>(),
    events: [] as AppEvent[],
    mounts: [] as World['mounts'],
    decide: previous?.decide ?? ((): PolicyDecision => ({ action: 'approve' })),
    logs: [] as string[],
    holding: previous?.holding ?? new Set<SessionId>(),
    silent: previous?.silent ?? new Set<SessionId>(),
    open: new Map<SessionId, string>(),
    timers: new Set<{ at: string; fn: () => void }>(),
    closed: [] as SessionId[],
  } as unknown as World;
  world.git = previous?.git ?? new MemoryGit();
  if (previous === undefined) world.git.init(CWD, { 'README.md': 'readme\n', 'src/app.txt': 'app\n' });
  world.commands = previous?.commands ?? new FakeCommands();
  world.files = previous?.files ?? new FakeFiles(world.git);
  const schedule = (at: string, fn: () => void) => {
    const timer = { at, fn };
    world.timers.add(timer);
    return () => void world.timers.delete(timer);
  };
  world.fireTimers = () => {
    const due = Date.parse(now());
    for (const timer of [...world.timers]) {
      if (Date.parse(timer.at) > due) continue;
      world.timers.delete(timer);
      timer.fn();
    }
  };
  const policy: PermissionPolicy = { evaluate: () => world.decide() };
  let mounts = 0;
  world.claude = withTurns(new FakeAdapter('claude', (handle) => world.service.onPermissionRequest(handle)), world);
  world.service = new SessionService({
    repositories,
    store,
    policy,
    publish: (event) => {
      world.events.push(event);
      world.engine?.observe(event);
    },
    now,
    uuid,
    hashPayload: hashOf,
    resolveRealPath: (path) => (real !== undefined ? path : path.startsWith('E:\\work') ? path.replace('E:\\work', 'E:\\real') : null),
    createAdapter: (runtime: Runtime, sessionId: SessionId) => {
      if (runtime === 'claude') return world.claude;
      const adapter = withTurns(new FakeAdapter('codex', (handle) => world.service.onPermissionRequest(handle)), world, sessionId);
      world.codex.set(sessionId, adapter);
      return adapter;
    },
    mountMcp: (sessionId) => {
      const mount = { url: 'http://127.0.0.1:4000/mcp', token: `token-${sessionId}-${++mounts}` };
      world.mounts.push({ sessionId, mount });
      return mount;
    },
    listModels: () => Promise.resolve([]),
    log: (message) => world.logs.push(message),
    sleep: () => new Promise<void>(() => undefined),
  });
  world.engine = new WorkflowEngine({
    sessions: world.service,
    publish: (event) => world.events.push(event),
    now,
    uuid,
    hashPayload: hashOf,
    schedule,
    pipeline: {
      git: real?.git ?? world.git,
      commands: world.commands,
      files: real?.files ?? world.files,
      closeRuntime: (sessionId) => {
        world.closed.push(sessionId);
        return world.service.closeWorkflowRuntime(sessionId);
      },
    },
    log: (m) => world.logs.push(m),
  });
  world.service.attachWorkflow(world.engine);
  world.emitTurn = (sessionId, turnId, state) => {
    const adapter = adapterOf(world, sessionId);
    adapter.emit({
      type: 'turn.updated',
      turn: { id: TurnId.parse(turnId), sessionId, state, startedAt: '2026-10-29T01:00:00.000Z', ...(state !== 'running' && { endedAt: '2026-10-29T01:00:01.000Z' }) },
    });
    adapter.emit({ type: 'session.activity', sessionId, activity: state === 'running' ? 'running' : 'idle', at: '2026-10-29T01:00:00.000Z' });
  };
  world.finishTurn = async (sessionId) => {
    const id = world.open.get(sessionId);
    if (id === undefined) throw new Error(`no open turn of ${sessionId}`);
    world.open.delete(sessionId);
    world.emitTurn(sessionId, id, 'completed');
    await settle();
  };
  world.run = (command) => world.service.execute(command);
  world.restart = async () => {
    const next = build(repositories, store, world, real);
    await next.service.start();
    await next.engine.recover();
    return next;
  };
  return world;
};

export const world = async (workflow: WorkflowTemplate = template()): Promise<World> => {
  const store = new MemoryDeliveryStore();
  return worldOn(new WorkflowRepositories(store), store, workflow);
};

/** The same world on other storage (the SQLite repositories and store in app/main's tests, r2). */
export const worldOn = async (repositories: AppRepositories, store: DeliveryStore, workflow: WorkflowTemplate = template(), real?: RealFolders): Promise<World> => {
  const w = build(repositories, store, undefined, real);
  for (const a of agents()) await w.repositories.agents.save(a, null);
  await w.repositories.workflows.save(workflow, null);
  return w;
};

/** Waits for the background work a call started (provisioning, event writes, queued dispatches). */
export const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve();
};

export const INSTANCE = 'run-1' as InstanceId;
export const ROOT = SessionId.parse('root-1');

export const startCommand = (extra: Partial<Extract<Command, { type: 'workflow.start' }>> = {}): Extract<Command, { type: 'workflow.start' }> => ({
  type: 'workflow.start',
  requestId: rid(),
  instanceId: INSTANCE,
  rootSessionId: ROOT,
  workflowId: WORKFLOW,
  workflowRevision: 0,
  title: 'Add a login page',
  cwd: CWD,
  firstMessage: 'Plan a login page.',
  crossToolConsent: true,
  ...extra,
});

export const started = async (w: World, extra: Partial<Extract<Command, { type: 'workflow.start' }>> = {}) => {
  const result = await w.run(startCommand(extra));
  await settle();
  return result;
};

let calls = 0;
/** A `handoff` tool call of `caller`; a fresh operation and source call unless given. */
export const handoff = (w: World, caller: SessionId, input: Partial<HandoffToolInput> & Pick<HandoffToolInput, 'ruleId' | 'target'>, ctx: { operationId?: string; sourceCallRef?: string } = {}) => {
  const n = ++calls;
  return w.engine.handoff(
    { content: `work ${String(n)}`, ...input },
    { caller, operationId: OperationId.parse(ctx.operationId ?? `op-${String(n)}`), sourceCallRef: ctx.sourceCallRef ?? `call-${String(n)}` },
  );
};

/** The session bound to a (node, task) of the run. */
export const sessionOf = async (w: World, nodeId: NodeId) => {
  const instance = await w.repositories.instances.get(INSTANCE);
  const id = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId, ...(nodeId !== PLAN && { taskId: instance!.tasks[0]!.id }) });
  if (id === undefined) throw new Error(`no session for ${nodeId}`);
  return id;
};

export const instanceOf = async (w: World) => {
  const instance = await w.repositories.instances.get(INSTANCE);
  if (instance === undefined) throw new Error('no instance');
  return instance;
};

/** Every adapter call that delivered a payload, in order, with the session it went to. */
export const dispatches = (w: World) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)];

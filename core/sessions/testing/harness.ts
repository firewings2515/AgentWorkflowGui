// The session service on memory ports and fake adapters: Codex gets one adapter per GUI session (CR-7),
// Claude one shared adapter. `restart()` gives a new service on the same stored state, as after a crash.
import { type AgentDefinition, AgentId, type AppEvent, CONTRACTS_VERSION, type Command, type CommandResult, RequestId, type Runtime, SessionId } from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import { MemoryDeliveryStore } from '../../delivery/testing/memory-store';
import type { McpMount, PermissionPolicy, PolicyContext, PolicyDecision } from '../../ports';
import { SessionService } from '../service';
import { FakeAdapter } from './fake-adapter';
import { MemoryRepositories } from './memory-repositories';

export const AGENT = AgentId.parse('agent-1');
export const CWD = 'E:\\work\\project';
export const REAL_CWD = 'E:\\real\\project';

export const agent = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  schemaVersion: CONTRACTS_VERSION,
  id: AGENT,
  revision: 0,
  name: 'Reviewer',
  description: '',
  instructions: 'Review carefully.',
  updatedAt: '2026-10-29T00:00:00.000Z',
  ...extra,
});

let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;
let requests = 0;
export const rid = () => RequestId.parse(`r-${++requests}`);

export interface World {
  repositories: MemoryRepositories;
  store: MemoryDeliveryStore;
  /** Every Codex adapter by GUI session; one Claude adapter for all. */
  codex: Map<string, FakeAdapter>;
  claude: FakeAdapter;
  events: AppEvent[];
  mounts: { sessionId: SessionId; mount: McpMount }[];
  closed: SessionId[];
  contexts: PolicyContext[];
  decide: (context: PolicyContext) => PolicyDecision;
  realPath: (path: string) => string | null;
  /** Called with every new Codex adapter before it is used. */
  configure: (adapter: FakeAdapter) => void;
  /** The exit deadline (SessionServiceOptions.sleep); by default it never passes. */
  sleeper: (ms: number) => Promise<void>;
  service: SessionService;
  logs: string[];
  run(command: Command): Promise<CommandResult>;
  restart(): World;
}

const build = (repositories: MemoryRepositories, store: MemoryDeliveryStore, previous?: World): World => {
  const world = {
    repositories,
    store,
    codex: new Map<string, FakeAdapter>(),
    events: [] as AppEvent[],
    mounts: [] as World['mounts'],
    closed: [] as SessionId[],
    contexts: [] as PolicyContext[],
    decide: previous?.decide ?? ((): PolicyDecision => ({ action: 'approve' })),
    // E:\work is a junction to E:\real; anything else cannot be resolved.
    realPath: previous?.realPath ?? ((path: string) => (path.startsWith('E:\\work') ? path.replace('E:\\work', 'E:\\real') : path.startsWith('E:\\real') ? path : null)),
    logs: [] as string[],
    configure: previous?.configure ?? (() => undefined),
    sleeper: (): Promise<void> => new Promise<void>(() => undefined),
  } as unknown as World;
  const policy: PermissionPolicy = {
    evaluate: (_request, context) => {
      world.contexts.push(context);
      return world.decide(context);
    },
  };
  let mounts = 0;
  world.claude = new FakeAdapter('claude', (handle) => world.service.onPermissionRequest(handle));
  world.service = new SessionService({
    repositories,
    store,
    policy,
    publish: (event) => world.events.push(event),
    now: () => '2026-10-29T01:00:00.000Z',
    uuid,
    hashPayload: hashOf,
    resolveRealPath: (path) => world.realPath(path),
    createAdapter: (runtime: Runtime, sessionId: SessionId) => {
      if (runtime === 'claude') return world.claude;
      const adapter = new FakeAdapter('codex', (handle) => world.service.onPermissionRequest(handle));
      world.configure(adapter);
      world.codex.set(sessionId, adapter);
      return adapter;
    },
    mountMcp: (sessionId) => {
      const mount = { url: 'http://127.0.0.1:4000/mcp', token: `token-${sessionId}-${++mounts}` };
      world.mounts.push({ sessionId, mount });
      return mount;
    },
    listModels: (runtime) => world.claude.listModels().then((m) => m.map((o) => ({ ...o, runtime }))),
    onSessionClosed: (sessionId) => {
      world.closed.push(sessionId);
    },
    log: (message) => world.logs.push(message),
    sleep: (ms) => world.sleeper(ms),
  });
  world.run = (command) => world.service.execute(command);
  world.restart = () => build(repositories, store, world);
  return world;
};

export const world = async (): Promise<World> => {
  const w = build(new MemoryRepositories(), new MemoryDeliveryStore());
  await w.repositories.agents.save(agent(), null);
  return w;
};

/** Waits for the background work a command started (provisioning, event writes) to finish. */
export const settle = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve();
};

export const created = async (w: World, runtime: Runtime = 'codex', id = 'session-a', extra: Partial<Extract<Command, { type: 'session.create' }>> = {}) => {
  const sessionId = SessionId.parse(id);
  const result = await w.run({
    type: 'session.create',
    requestId: rid(),
    sessionId,
    kind: 'ordinary',
    agentId: AGENT,
    model: { runtime, model: runtime === 'codex' ? 'gpt-6-luna' : 'haiku' },
    cwd: CWD,
    ...extra,
  });
  await settle();
  return { result, sessionId };
};

export const session = async (w: World, id: string) => {
  const s = await w.repositories.sessions.get(SessionId.parse(id));
  if (s === undefined) throw new Error(`no session ${id}`);
  return s;
};

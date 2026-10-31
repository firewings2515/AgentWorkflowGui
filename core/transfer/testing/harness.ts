// The transfer service on the session service, memory ports and fake adapters (T023). The fake runtimes keep
// what the GUI stored as their own history (readHistory), start a turn for every new-turn dispatch and end
// it at once unless told to hold it, and answer the note request with a note when given one. `restart()`
// gives a new service on the same stored state, as after a crash; `worldOn` runs the same on other storage.
import {
  type AgentDefinition,
  AgentId,
  type AppEvent,
  CONTRACTS_VERSION,
  type Command,
  type CommandResult,
  ItemId,
  MessageId,
  type ModelSelection,
  RequestId,
  type Runtime,
  SessionId,
  type SessionItem,
  type TransferId,
  TurnId,
} from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import { MemoryDeliveryStore } from '../../delivery/testing/memory-store';
import type { AppRepositories, DeliveryStore, DispatchRequest, HistoryRequest, PermissionPolicy, RuntimeAdapter } from '../../ports';
import { SessionService } from '../../sessions';
import { FakeAdapter } from '../../sessions/testing/fake-adapter';
import { entriesOf, NOTE_REQUEST } from '../frame';
import { TransferService } from '../service';
import { TransferRepositories } from './memory-transfers';

export const AGENT = AgentId.parse('agent-1');
export const CWD = 'E:\\work\\project';
export const CLAUDE: ModelSelection = { runtime: 'claude', model: 'haiku' };
export const CODEX: ModelSelection = { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' };

const agent: AgentDefinition = {
  schemaVersion: CONTRACTS_VERSION,
  id: AGENT,
  revision: 0,
  name: 'Builder',
  description: '',
  instructions: 'Build carefully.',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;
let requests = 0;
export const rid = () => RequestId.parse(`r-${String(++requests)}`);
let ticks = 0;
/** Strictly increasing, so the order of records is their time order. */
const now = () => new Date(Date.UTC(2026, 9, 30, 1, 0, 0, ++ticks)).toISOString();
let counter = 0;
const next = () => String(++counter);

export interface World {
  repositories: AppRepositories;
  store: DeliveryStore;
  claude: FakeAdapter;
  codex: Map<string, FakeAdapter>;
  events: AppEvent[];
  logs: string[];
  service: SessionService;
  transfers: TransferService;
  /** Runtimes the computer has (`isRuntimeAvailable`); both by default. */
  available: Set<Runtime>;
  /** Sessions whose next dispatched turns stay running until `finishTurn`. */
  holding: Set<SessionId>;
  /** Sessions whose runtime acks a dispatch but reports nothing of its turn until `finishTurn` (a late notice). */
  silent: Set<SessionId>;
  /** What the source agent answers to the note request, per session. */
  notes: Map<SessionId, string>;
  /** Runtimes whose readHistory throws (the GUI then uses its own record). */
  historyFails: Set<Runtime>;
  /** Native session ref → GUI session, as the fake runtimes created or resumed them. */
  refs: Map<string, SessionId>;
  open: Map<SessionId, string>;
  /** Called with every new Codex adapter (one per session) before it is used. */
  configure: (adapter: FakeAdapter, sessionId: SessionId) => void;
  adapterOf(sessionId: SessionId): FakeAdapter;
  emitTurn(sessionId: SessionId, turnId: string, state: 'running' | 'completed' | 'interrupted'): void;
  finishTurn(sessionId: SessionId): Promise<void>;
  run(command: Command): Promise<CommandResult>;
  /** `recover: false` stops after the session service's start, before the transfers go on. */
  restart(options?: { recover?: boolean }): Promise<World>;
}

/** A fake runtime that keeps the GUI's record of each session as its history and starts turns on dispatches. */
const wire = (adapter: FakeAdapter, w: World): FakeAdapter => {
  const start = adapter.startSession.bind(adapter);
  adapter.startSession = async (options) => {
    const info = await start(options);
    w.refs.set(info.nativeSessionRef, options.sessionId);
    return info;
  };
  const resume = adapter.resumeSession.bind(adapter);
  adapter.resumeSession = async (options) => {
    const info = await resume(options);
    w.refs.set(info.nativeSessionRef, options.sessionId);
    return info;
  };
  // FakeAdapter declares it without the request; the port passes one.
  (adapter as RuntimeAdapter).readHistory = async (request: HistoryRequest) => {
    if (w.historyFails.has(adapter.runtime)) throw new Error('the history cannot be read');
    return { entries: entriesOf(await w.repositories.conversations.get(request.sessionId)), nativeTasks: [], complete: true };
  };
  const dispatch = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = async (request: DispatchRequest) => {
    let result = await dispatch(request);
    const sessionId = w.refs.get(request.nativeSessionRef);
    if (result.state === 'sent' && request.entry.kind === 'new-turn' && sessionId !== undefined) {
      // The ack names the turn the dispatch started, as both runtimes' acks do.
      const id = `turn-run-${next()}`;
      result = { ...result, nativeRef: { ...result.nativeRef, turnRef: id } };
      void Promise.resolve().then(() => {
        if (w.silent.has(sessionId)) {
          w.open.set(sessionId, id);
          return;
        }
        w.emitTurn(sessionId, id, 'running');
        // The runtime echoes what it received, with the origin it was dispatched with (both adapters do).
        adapter.emit({
          type: 'message.completed',
          message: { id: MessageId.parse(request.attempt.clientMessageId), sessionId, turnId: TurnId.parse(id), role: 'user', origin: request.origin ?? { kind: 'user' }, text: request.text, attachments: [], createdAt: now() },
        });
        const note = w.notes.get(sessionId);
        if (note !== undefined && request.text.includes(NOTE_REQUEST)) {
          adapter.emit({
            type: 'message.completed',
            message: { id: MessageId.parse(`note-${next()}`), sessionId, turnId: TurnId.parse(id), role: 'assistant', origin: { kind: 'agent' }, text: note, attachments: [], createdAt: now() },
          });
        }
        if (w.holding.has(sessionId)) w.open.set(sessionId, id);
        else w.emitTurn(sessionId, id, 'completed');
      });
    }
    return result;
  };
  return adapter;
};

const build = (repositories: AppRepositories, store: DeliveryStore, previous?: World): World => {
  const w = {
    repositories,
    store,
    codex: new Map<string, FakeAdapter>(),
    events: [] as AppEvent[],
    logs: [] as string[],
    available: previous?.available ?? new Set<Runtime>(['claude', 'codex']),
    holding: previous?.holding ?? new Set<SessionId>(),
    silent: previous?.silent ?? new Set<SessionId>(),
    notes: previous?.notes ?? new Map<SessionId, string>(),
    historyFails: previous?.historyFails ?? new Set<Runtime>(),
    refs: previous?.refs ?? new Map<string, SessionId>(),
    open: new Map<SessionId, string>(),
    configure: previous?.configure ?? (() => undefined),
  } as unknown as World;
  const policy: PermissionPolicy = { evaluate: () => ({ action: 'approve' }) };
  w.claude = wire(new FakeAdapter('claude', (handle) => w.service.onPermissionRequest(handle)), w);
  w.service = new SessionService({
    repositories,
    store,
    policy,
    publish: (event) => w.events.push(event),
    now,
    uuid,
    hashPayload: hashOf,
    resolveRealPath: (path) => (path.startsWith('E:\\work') ? path.replace('E:\\work', 'E:\\real') : null),
    createAdapter: (runtime: Runtime, sessionId: SessionId) => {
      if (runtime === 'claude') return w.claude;
      const adapter = wire(new FakeAdapter('codex', (handle) => w.service.onPermissionRequest(handle)), w);
      w.codex.set(sessionId, adapter);
      w.configure(adapter, sessionId);
      return adapter;
    },
    mountMcp: (sessionId) => ({ url: 'http://127.0.0.1:4000/mcp', token: `secret-token-of-${sessionId}-${next()}` }),
    listModels: () => Promise.resolve([]),
    isRuntimeAvailable: (runtime) => w.available.has(runtime),
    log: (message) => w.logs.push(message),
    sleep: () => new Promise<void>(() => undefined),
  });
  w.transfers = new TransferService({ sessions: w.service, publish: (event) => w.events.push(event), now, hashPayload: hashOf, log: (m) => w.logs.push(m) });
  w.service.attachTransfer(w.transfers);
  w.adapterOf = (sessionId) => w.codex.get(sessionId) ?? w.claude;
  w.emitTurn = (sessionId, turnId, state) => {
    const adapter = w.adapterOf(sessionId);
    const at = now();
    adapter.emit({ type: 'turn.updated', turn: { id: TurnId.parse(turnId), sessionId, state, startedAt: at, ...(state !== 'running' && { endedAt: at }) } });
    adapter.emit({ type: 'session.activity', sessionId, activity: state === 'running' ? 'running' : 'idle', at });
  };
  w.finishTurn = async (sessionId) => {
    const id = w.open.get(sessionId);
    if (id === undefined) throw new Error(`no open turn of ${sessionId}`);
    w.open.delete(sessionId);
    w.emitTurn(sessionId, id, 'completed');
    await settle();
  };
  w.run = async (command) => {
    const result = await w.service.execute(command);
    await settle();
    return result;
  };
  w.restart = async (options = {}) => {
    const after = build(repositories, store, w);
    await after.service.start();
    if (options.recover !== false) await after.transfers.recover();
    await settle();
    return after;
  };
  return w;
};

export const world = async (): Promise<World & { store: MemoryDeliveryStore }> => {
  const store = new MemoryDeliveryStore();
  return (await worldOn(new TransferRepositories(store), store)) as World & { store: MemoryDeliveryStore };
};

export const worldOn = async (repositories: AppRepositories, store: DeliveryStore): Promise<World> => {
  const w = build(repositories, store);
  await w.repositories.agents.save(agent, null);
  return w;
};

/** Waits for the background work a call started (provisioning, event writes, hooks). */
export const settle = async () => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};

/** An ordinary session that did some work: the user's message, a command, a file change, a test run and the agent's reply. */
export const source = async (w: World, model: ModelSelection = CLAUDE, id = 'source-1'): Promise<SessionId> => {
  const sessionId = SessionId.parse(id);
  const created = await w.run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: AGENT, model, cwd: CWD });
  if (!created.ok) throw new Error(`session.create failed: ${created.code}`);
  const sent = await w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(`m-${id}`), expectedRevision: (await w.repositories.sessions.get(sessionId))!.revision, text: 'Implement add() and subtract() in calc.js.', attachments: [] });
  if (!sent.ok) throw new Error(`session.send failed: ${sent.code}`);
  await work(w, sessionId, {
    items: [
      fileChange(sessionId, 'calc.js', '--- a/calc.js\n+++ b/calc.js\n@@\n-export const add = () => {};\n+export const add = (a, b) => a + b;'),
      command(sessionId, 'node test.js', 1, 'add: ok\nsubtract: FAIL'),
    ],
    reply: 'add() is done; subtract() is still missing.',
  });
  return sessionId;
};

/** A turn of the source's own, as its runtime would report it: running, its items and reply, completed. */
export const work = async (w: World, sessionId: SessionId, what: { items?: SessionItem[]; reply?: string; keepRunning?: boolean } = {}): Promise<string> => {
  const adapter = w.adapterOf(sessionId);
  const turnId = `own-${next()}`;
  w.emitTurn(sessionId, turnId, 'running');
  for (const item of what.items ?? []) adapter.emit({ type: 'item.updated', item: { ...item, turnId: TurnId.parse(turnId) } });
  if (what.reply !== undefined)
    adapter.emit({
      type: 'message.completed',
      message: { id: MessageId.parse(`reply-${next()}`), sessionId, turnId: TurnId.parse(turnId), role: 'assistant', origin: { kind: 'agent' }, text: what.reply, attachments: [], createdAt: now() },
    });
  if (!what.keepRunning) w.emitTurn(sessionId, turnId, 'completed');
  await settle();
  return turnId;
};

export const command = (sessionId: SessionId, cmd: string, exitCode: number, output: string): SessionItem => {
  const at = now();
  return { id: ItemId.parse(`cmd-${next()}`), sessionId, kind: 'command', command: cmd, cwd: 'E:\\real\\project', state: exitCode === 0 ? 'completed' : 'failed', exitCode, output, outputTruncated: false, startedAt: at, endedAt: at };
};

export const fileChange = (sessionId: SessionId, path: string, diff: string): SessionItem => {
  const at = now();
  return { id: ItemId.parse(`fc-${next()}`), sessionId, kind: 'fileChange', changes: [{ path, change: 'update' }], state: 'applied', diff, startedAt: at, endedAt: at };
};

export const prepare = (w: World, sourceId: SessionId, transferId: TransferId, extra: Partial<Extract<Command, { type: 'transfer.prepare' }>> = {}) =>
  w.run({ type: 'transfer.prepare', requestId: rid(), transferId, sourceSessionId: sourceId, target: CODEX, noteSource: 'gui-digest', ...extra });

export const confirm = async (w: World, transferId: TransferId, expectedRevision?: number) =>
  w.run({ type: 'transfer.confirm', requestId: rid(), transferId, expectedRevision: expectedRevision ?? (await proposal(w, transferId)).revision });

export const cancel = (w: World, transferId: TransferId) => w.run({ type: 'transfer.cancel', requestId: rid(), transferId });

export const proposal = async (w: World, transferId: TransferId) => {
  const p = await w.repositories.transfers.get(transferId);
  if (p === undefined) throw new Error(`no transfer ${transferId}`);
  return p;
};

/** Every payload the fake runtimes received, in order. */
export const dispatches = (w: World) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)];
/** Every runtime session the fake runtimes created. */
export const starts = (w: World) => [...w.claude.started, ...[...w.codex.values()].flatMap((a) => a.started)];

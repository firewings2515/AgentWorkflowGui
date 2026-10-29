// The assembled backend (T017) on a real SQLite file with fake adapters and a fake process host: commands
// through the facade, the Snapshot from storage, recovery after a restart, damaged data, the MCP token
// kept out of storage and logs, and the R-14 exit order. No runtime is started (no live test).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, MessageId, OperationId, RequestId, type Runtime, SessionId, Snapshot, type EventEnvelope } from '../../contracts';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import type { OwnedProcess } from '../../contracts';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter, permissionRequest } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type Backend, type BackendProcessHost, type DamagedBackend, STORAGE_DAMAGED, startBackend } from './backend';
import { EventBus } from './event-bus';
import { ClaudeAdapter } from '../../adapters/claude';
import { FakeSdk } from '../../adapters/claude/testing/fake-sdk';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t017-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  constructor(readonly order: string[]) {}
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob(sessionId: SessionId) {
    this.order.push(`closeJob:${sessionId}`);
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned() {
    return Promise.resolve([] as OwnedProcess[]);
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    this.order.push('cleanupOrphans');
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

interface Started {
  backend: Backend;
  bus: EventBus;
  envelopes: EventEnvelope[];
  adapters: FakeAdapter[];
  order: string[];
  logs: string[];
  run(command: Command): Promise<CommandResult>;
}

let requests = 0;
const rid = () => RequestId.parse(`r-${++requests}`);

const start = async (options: { order?: string[]; realModels?: boolean; configure?: (adapter: FakeAdapter) => void; closeTimeoutMs?: number } = {}): Promise<Started> => {
  const order = options.order ?? [];
  const logs: string[] = [];
  const adapters: FakeAdapter[] = [];
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  let claude: FakeAdapter | undefined;
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(order),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      if (runtime === 'claude' && claude !== undefined) return claude;
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      const closeSession = adapter.closeSession.bind(adapter);
      adapter.closeSession = (ref: string) => {
        order.push(`closeSession:${ref}`);
        return closeSession(ref);
      };
      if (runtime === 'claude') claude = adapter;
      options.configure?.(adapter);
      adapters.push(adapter);
      return adapter;
    },
    ...(options.realModels !== true && {
      listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    }),
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
    ...(options.closeTimeoutMs !== undefined && { closeTimeoutMs: options.closeTimeoutMs }),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  return { backend: result, bus, envelopes, adapters, order, logs, run: (command) => result.facade.execute(command) as Promise<CommandResult> };
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

const createSession = async (s: Started, id = 'session-a', runtime: Runtime = 'codex') => {
  await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
  const result = await s.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir });
  await settle();
  return result;
};

/** Every byte the database files hold, to search for a secret. */
const databaseBytes = () =>
  readdirSync(dir)
    .filter((f) => f.startsWith('awg.sqlite'))
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n');

describe('the assembled backend', () => {
  it('creates a session, sends a message through CR-2 and serves both from storage in the Snapshot', async () => {
    const s = await start();
    expect((await createSession(s)).ok).toBe(true);
    const snapshot = Snapshot.parse(await s.backend.facade.snapshot());
    const session = snapshot.sessions[0]!;
    expect(session).toMatchObject({ id: 'session-a', kind: 'ordinary', activity: 'idle' });

    const sent = await s.run({ type: 'session.send', requestId: rid(), sessionId: session.id, messageId: MessageId.parse('m-1'), expectedRevision: session.revision, text: 'hello', attachments: [] });
    expect(sent).toMatchObject({ ok: true, created: [{ kind: 'message', id: 'm-1' }] });
    const adapter = s.adapters[0]!;
    expect(adapter.dispatched).toMatchObject([{ text: 'hello', origin: { kind: 'user' } }]);

    const after = Snapshot.parse(await s.backend.facade.snapshot());
    expect(after.messages).toMatchObject([{ id: 'm-1', text: 'hello', role: 'user' }]);
    expect(after.seq).toBe(s.bus.seq);
    expect(after.modelOptions.map((m) => m.runtime).sort()).toEqual(['claude', 'codex']);
    await s.backend.shutdown();
    const db = openDatabase(join(dir, 'awg.sqlite'));
    expect((await new SqliteDeliveryStore(db).get(OperationId.parse('user-message:m-1')))?.delivery.state).toBe('sent');
    db.close();
  });

  it('mounts the GUI MCP server with a token that never reaches the database or the log', async () => {
    const s = await start();
    await createSession(s);
    const token = s.adapters[0]!.started[0]?.mcp?.token;
    expect(token).toMatch(/^[\w-]{20,}$/);
    expect(s.adapters[0]!.started[0]?.mcp?.url).toBe(s.backend.mcp.url);
    await s.backend.shutdown();
    expect(databaseBytes()).not.toContain(token!);
    expect(s.logs.join('\n')).not.toContain(token!);
    expect(JSON.stringify(s.envelopes)).not.toContain(token!);
  });

  it('pushes runtime events as envelopes and stores what they carry', async () => {
    const s = await start();
    await createSession(s);
    const sessionId = SessionId.parse('session-a');
    s.adapters[0]!.emit({ type: 'turn.updated', turn: { id: 'turn-1' as never, sessionId, state: 'running', startedAt: '2026-10-29T01:00:00.000Z' } });
    await settle();
    expect(s.envelopes.at(-1)?.event).toMatchObject({ type: 'turn.updated' });
    expect(Snapshot.parse(await s.backend.facade.snapshot()).turns).toHaveLength(1);
    await s.backend.shutdown();
  });

  it('after a restart recovers a pending message: the session is resumed with a new token and the message sent once', async () => {
    const first = await start();
    await createSession(first);
    const firstToken = first.adapters[0]!.started[0]!.mcp!.token;
    await first.backend.shutdown();

    // A message accepted just before a crash, never dispatched.
    const db = openDatabase(join(dir, 'awg.sqlite'));
    const store = new SqliteDeliveryStore(db);
    const { createHash } = await import('node:crypto');
    await store.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-2'),
      payloadHash: `sha256:${createHash('sha256').update('later').digest('hex')}`,
      payload: 'later',
      proposalRevision: 0,
      target: { sessionId: SessionId.parse('session-a'), nativeSessionRef: 'thread-1' },
      at: '2026-10-29T01:00:00.000Z',
      context: { runtime: 'codex', cwd: dir, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'codex-m' }, readOnly: false } },
    });
    db.close();

    const second = await start();
    const adapter = second.adapters.find((a) => a.runtime === 'codex')!;
    expect(adapter.resumed).toMatchObject([{ nativeSessionRef: 'thread-1', cwd: dir }]);
    expect(adapter.resumed[0]!.mcp!.token).not.toBe(firstToken);
    expect(adapter.dispatched).toMatchObject([{ text: 'later', origin: { kind: 'user' } }]);
    await second.backend.shutdown();
  });

  it('exits in the R-14 order: MCP server closed, then each session closed, then its Job ended, then the database', async () => {
    const order: string[] = [];
    const s = await start({ order });
    await createSession(s);
    order.length = 0;
    const mount = s.backend.mcp.mount.bind(s.backend.mcp);
    let mcpClosedFirst = false;
    s.adapters[0]!.closeSession = (ref: string) => {
      try {
        mount(SessionId.parse('probe'));
      } catch {
        mcpClosedFirst = true;
      }
      order.push(`closeSession:${ref}`);
      return Promise.resolve({ forced: false });
    };
    await s.backend.shutdown();
    expect(mcpClosedFirst).toBe(true);
    expect(order).toEqual(['closeSession:thread-1', 'closeJob:session-a']);
    expect(await s.run({ type: 'session.interrupt', requestId: rid(), sessionId: SessionId.parse('session-a') })).toMatchObject({ ok: false, code: 'runtime_unavailable' });
  });

  it('lists models outside any session without taking the shared Claude adapter’s permission hook', async () => {
    const s = await start({ realModels: true });
    await settle();
    await createSession(s, 'c-1', 'claude');
    const claude = s.adapters.find((a) => a.runtime === 'claude')!;
    const handle = claude.ask(permissionRequest(SessionId.parse('c-1'), { kind: 'permissions', summary: 'ToolSearch select:mcp__gui__send_message' }));
    await settle();
    expect(handle.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });
    // The Codex probe ran in a Job of its own, ended right after.
    expect(s.order).toContain('closeJob:models-codex');
    await s.backend.shutdown();
  });

  it('fails closed on damaged data: nothing starts, no empty Snapshot, every command storage_failed', async () => {
    const db = openDatabase(join(dir, 'awg.sqlite'));
    const repositories = createRepositories(db);
    await repositories.agents.save(agent(), null);
    db.exec(`UPDATE agent SET body = '{"secret":"DATA_MARKER"'`);
    db.close();

    const logs: string[] = [];
    let adapters = 0;
    const result = (await startBackend({
      dbPath: join(dir, 'awg.sqlite'),
      bus: new EventBus(),
      createHost: () => new FakeHost([]),
      createAdapter: () => {
        adapters++;
        return new FakeAdapter('codex');
      },
      resolveRealPath: (p) => p,
      log: (m) => logs.push(m),
    })) as DamagedBackend;
    expect(result.status).toBe('damaged');
    expect(result.reason).toMatch(/^StoredDataError: agent/);
    expect(adapters).toBe(0);
    expect(() => result.facade.snapshot()).toThrow(STORAGE_DAMAGED);
    expect(await result.facade.execute({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'light' } })).toMatchObject({ ok: false, code: 'storage_failed' });
    expect(logs.join('\n')).not.toContain('DATA_MARKER');
    expect(result.reason).not.toContain('DATA_MARKER');
  });
});

describe('review round 1 (T017-r1-result.md)', () => {
  it('r1-P1-1 a mount nested in a model never reaches the SQLite body', async () => {
    const s = await start();
    const token = 'NESTED_TOKEN_0123456789';
    const outcome = await s.backend.service.delivery.accept({
      kind: 'provision',
      operationId: OperationId.parse('provision:nested'),
      payloadHash: `sha256:${'0'.repeat(64)}`,
      proposalRevision: 0,
      target: { sessionId: SessionId.parse('nested'), provision: { operationId: OperationId.parse('provision:nested'), bindingKey: 'session:nested', state: 'pending', preallocated: false } },
      at: '2026-10-29T01:00:00.000Z',
      spec: { runtime: 'codex', sessionId: SessionId.parse('nested'), cwd: dir, model: { runtime: 'codex', model: 'm', mcp: { token } } as never, readOnly: false },
    });
    expect(outcome.status).toBe('accepted');
    await s.backend.shutdown();
    expect(databaseBytes()).not.toContain(token);
  });

  it('r1-P1-2 a token quoted by the runtime reaches neither the database, the envelopes nor the log', async () => {
    const s = await start();
    await createSession(s);
    const sessionId = SessionId.parse('session-a');
    const token = s.adapters[0]!.started[0]!.mcp!.token;
    const adapter = s.adapters[0]!;
    adapter.emit({ type: 'message.completed', message: { id: MessageId.parse('a-1'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: `Bearer ${token}`, attachments: [], createdAt: '2026-10-29T01:00:00.000Z' } });
    adapter.emit({ type: 'runtime.exited', runtime: 'codex', sessionIds: [sessionId], expected: false, code: 1, signal: null, error: `gui: ${token}`, at: '2026-10-29T01:00:00.000Z' });
    await settle();
    await s.backend.shutdown();
    expect(databaseBytes()).not.toContain(token);
    expect(JSON.stringify(s.envelopes)).not.toContain(token);
    expect(JSON.stringify(s.envelopes)).toContain('[redacted]');
    expect(s.logs.join('\n')).not.toContain(token);
  });

  it('r1-P1-5 the database closes only after the core settled: a start still running at exit is closed first', async () => {
    const order: string[] = [];
    const s = await start({ order, configure: (adapter) => adapter.startModes.push('held') });
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    await s.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('slow'), kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: dir });
    await settle();
    const adapter = s.adapters.at(-1)!;
    expect(adapter.calls).toContain('startSession');
    order.length = 0;
    let done = false;
    const shutdown = s.backend.shutdown().then(() => (done = true));
    await settle();
    // The exit waits for the start that is still running.
    expect(done).toBe(false);
    adapter.release();
    await shutdown;
    expect(s.backend.service.runtimes.openSessions()).toEqual([]);
    expect(order).toEqual(['closeSession:thread-1', 'closeJob:slow']);
    // Only now is the database closed.
    await expect(s.backend.repositories.sessions.list()).rejects.toThrow();
  });

  it('r1-P1-6 a damaged delivery record stops the start: no ready backend, no model probe, no runtime', async () => {
    const db = openDatabase(join(dir, 'awg.sqlite'));
    const store = new SqliteDeliveryStore(db);
    await store.accept({
      kind: 'provision',
      operationId: OperationId.parse('provision:x'),
      payloadHash: `sha256:${'0'.repeat(64)}`,
      proposalRevision: 0,
      target: { sessionId: SessionId.parse('x'), provision: { operationId: OperationId.parse('provision:x'), bindingKey: 'session:x', state: 'pending', preallocated: false } },
      at: '2026-10-29T01:00:00.000Z',
      spec: { runtime: 'codex', sessionId: SessionId.parse('x'), cwd: dir, model: { runtime: 'codex', model: 'm' }, readOnly: false },
    });
    db.exec(`UPDATE delivery SET body = '{not json DATA_MARKER'`);
    db.close();
    let probes = 0;
    let adapters = 0;
    const logs: string[] = [];
    const result = await startBackend({
      dbPath: join(dir, 'awg.sqlite'),
      bus: new EventBus(),
      createHost: () => new FakeHost([]),
      createAdapter: () => {
        adapters++;
        return new FakeAdapter('codex');
      },
      listModels: () => {
        probes++;
        return Promise.resolve([]);
      },
      resolveRealPath: (p) => p,
      log: (m) => logs.push(m),
    });
    expect(result.status).toBe('damaged');
    expect({ probes, adapters }).toEqual({ probes: 0, adapters: 0 });
    expect(() => result.facade.snapshot()).toThrow(STORAGE_DAMAGED);
    expect(logs.join('\n')).not.toContain('DATA_MARKER');
  });
});

describe('review round 2 (T017-r2-result.md)', () => {
  it('r2-P1-8 on SQLite, a message ID another session holds is refused before anything is accepted or sent', async () => {
    const s = await start();
    await createSession(s, 'session-a');
    await createSession(s, 'session-b');
    const [a, b] = s.adapters;
    b!.emit({ type: 'message.completed', message: { id: MessageId.parse('collision'), sessionId: SessionId.parse('session-b'), role: 'assistant', origin: { kind: 'agent' }, text: 'mine', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' } });
    await settle();
    const session = Snapshot.parse(await s.backend.facade.snapshot()).sessions.find((x) => x.id === 'session-a')!;
    const result = await s.run({ type: 'session.send', requestId: rid(), sessionId: session.id, messageId: MessageId.parse('collision'), expectedRevision: session.revision, text: 'hello', attachments: [] });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(a!.dispatched).toEqual([]);
    expect(s.envelopes.filter((e) => e.event.type === 'message.completed' && e.event.message.sessionId === 'session-a')).toEqual([]);
    await s.backend.shutdown();
    const db = openDatabase(join(dir, 'awg.sqlite'));
    expect(await new SqliteDeliveryStore(db).get(OperationId.parse('user-message:collision'))).toBeUndefined();
    db.close();
  });

  it('r2-P1-4 a start that answers after a timed-out exit writes nothing to the closed database', async () => {
    const s = await start({ closeTimeoutMs: 10, configure: (adapter) => adapter.startModes.push('held') });
    await createSession(s, 'slow');
    const adapter = s.adapters.at(-1)!;
    await s.backend.shutdown();
    adapter.release();
    await settle();
    expect(adapter.closedSessions).toEqual(['thread-1']);
    // The create call is recorded as crossed (unknown) and stays so: nothing was written after the exit.
    const db = openDatabase(join(dir, 'awg.sqlite'));
    expect((await new SqliteDeliveryStore(db).get(OperationId.parse('provision:slow')))?.delivery.state).toBe('unknown');
    db.close();
  });
});

describe('review round 3 (T017-r3-result.md)', () => {
  it('r3-P1-2 with the real ClaudeAdapter, a PreToolUse answered while the exit begins is denied, never allowed', async () => {
    const sdk = new FakeSdk();
    let claude: ClaudeAdapter | undefined;
    const result = await startBackend({
      dbPath: join(dir, 'awg.sqlite'),
      bus: new EventBus(),
      createHost: () => new FakeHost([]),
      createAdapter: (_runtime, _sessionId, hooks) =>
        (claude ??= new ClaudeAdapter({ sdk, onPermissionRequest: (h) => hooks.onPermissionRequest(h), cwdExists: () => true })),
      listModels: () => Promise.resolve([]),
      resolveRealPath: (p) => p,
      log: () => undefined,
    });
    if (result.status !== 'ready') throw new Error('not ready');
    const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
    await run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    await run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('c-1'), kind: 'ordinary', agentId: agent().id, model: { runtime: 'claude', model: 'haiku' }, cwd: dir });
    await settle();
    // A read inside the session folder: the policy would approve it.
    const { output } = sdk.last.callHook({ tool_name: 'Read', tool_input: { file_path: join(dir, 'a.txt') }, tool_use_id: 't-read' });
    const shutdown = result.shutdown();
    expect((await output).hookSpecificOutput?.permissionDecision).toBe('deny');
    await shutdown;
  });
});

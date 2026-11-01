// T045: the backend with a RuntimeLocator. Availability follows the last detection, an unavailable runtime lists no
// models, a command that needs one looks again first, and `runtime.detect` publishes the new status (C-33).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, type EventEnvelope, type OwnedProcess, RequestId, type Runtime, type RuntimeStatus, SessionId } from '../../contracts';
import type { RuntimeLocator } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t045-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob() {
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned() {
    return Promise.resolve([] as OwnedProcess[]);
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

const AT = '2026-11-01T10:00:00.000Z';
const available = (runtime: Runtime): RuntimeStatus => ({
  runtime, state: 'available', executable: `C:/bin/${runtime}.exe`, source: 'path', version: '9.9.9', requiredVersion: '1.0.0', auth: 'subscription', modelCount: 0, checkedAt: AT,
});
const missing = (runtime: Runtime): RuntimeStatus => ({
  runtime, state: 'not-installed', requiredVersion: '1.0.0', auth: 'unknown', modelCount: 0, checkedAt: AT, detail: `no ${runtime}`,
});

/** A locator whose answers the test changes; `calls` lists what was asked. */
const locator = (answers: Record<Runtime, RuntimeStatus>) => {
  const calls: Runtime[] = [];
  const port: RuntimeLocator = {
    detect: (runtime, at) => {
      calls.push(runtime);
      return Promise.resolve({ ...answers[runtime], checkedAt: at });
    },
    current: (runtime) => answers[runtime],
  };
  return { port, answers, calls };
};

let n = 0;
const rid = () => RequestId.parse(`t045-${++n}`);
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

const start = async (loc: RuntimeLocator) => {
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    runtimes: loc,
    redetectMinMs: 0,
    createAdapter: (runtime, _id, hooks) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
    listModels: (runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: `${runtime} m`, efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: () => undefined,
  });
  if (result.status !== 'ready') throw new Error('not ready');
  const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
  return { backend: result, envelopes, run };
};

const create = (runtime: Runtime, id: string): Command => ({
  type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir,
});

describe('T045 runtime detection in the backend', () => {
  it('puts the statuses in the Snapshot with the model counts, and lists no models of an unavailable runtime', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    const s = await start(loc.port);
    await settle();
    const snapshot = await s.backend.facade.snapshot();
    expect(snapshot.runtimes.map((r) => [r.runtime, r.state, r.modelCount])).toEqual([['claude', 'available', 1], ['codex', 'not-installed', 0]]);
    expect(snapshot.modelOptions.map((m) => m.runtime)).toEqual(['claude']);
    await s.backend.shutdown();
  });

  it('refuses a session of an unavailable runtime with runtime_unavailable, and Claude is unaffected', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    const s = await start(loc.port);
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    const codex = await s.run(create('codex', 'codex-1'));
    expect(codex).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(await s.run(create('claude', 'claude-1'))).toMatchObject({ ok: true });
    await s.backend.shutdown();
  });

  it('looks again before creating a session when the runtime was unavailable, and uses it once it is there', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    const s = await start(loc.port);
    await settle();
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    const before = loc.calls.filter((c) => c === 'codex').length;
    loc.answers.codex = available('codex');
    expect(await s.run(create('codex', 'codex-2'))).toMatchObject({ ok: true });
    expect(loc.calls.filter((c) => c === 'codex').length).toBe(before + 1);
    // Claude was available: not looked at again for this command.
    const claudeCalls = loc.calls.filter((c) => c === 'claude').length;
    await s.run(create('claude', 'claude-2'));
    expect(loc.calls.filter((c) => c === 'claude').length).toBe(claudeCalls);
    await s.backend.shutdown();
  });

  it('does not look more often than redetectMinMs', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    const bus = new EventBus();
    const result = await startBackend({
      dbPath: join(dir, 'awg.sqlite'), bus, createHost: () => new FakeHost(), runtimes: loc.port, redetectMinMs: 60_000,
      createAdapter: (runtime, _id, hooks) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
      listModels: () => Promise.resolve([]), resolveRealPath: (p) => p, log: () => undefined,
    });
    if (result.status !== 'ready') throw new Error('not ready');
    await settle();
    await result.facade.execute({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    const first = await result.facade.execute(create('codex', 'c1'));
    expect(first).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    const afterFirst = loc.calls.length;
    await result.facade.execute(create('codex', 'c2'));
    await result.facade.execute(create('codex', 'c3'));
    expect(loc.calls.length).toBe(afterFirst);
    await result.shutdown();
  });

  it('runtime.detect looks again, publishes runtime.status, and clears the models of a runtime that went away', async () => {
    const loc = locator({ claude: available('claude'), codex: available('codex') });
    const s = await start(loc.port);
    await settle();
    s.envelopes.length = 0;
    loc.answers.claude = { ...missing('claude'), detail: 'gone' };
    const result = await s.run({ type: 'runtime.detect', requestId: rid(), runtime: 'claude' });
    expect(result).toMatchObject({ ok: true });
    const status = s.envelopes.map((e) => e.event).find((e) => e.type === 'runtime.status');
    expect(status).toMatchObject({ type: 'runtime.status', status: { runtime: 'claude', state: 'not-installed' } });
    expect(s.envelopes.map((e) => e.event).find((e) => e.type === 'modelOptions.updated' && e.runtime === 'claude')).toMatchObject({ options: [] });
    const snapshot = await s.backend.facade.snapshot();
    expect(snapshot.modelOptions.map((m) => m.runtime)).toEqual(['codex']);
    expect(snapshot.runtimes.find((r) => r.runtime === 'claude')?.state).toBe('not-installed');
    // Both runtimes when none is named.
    loc.calls.length = 0;
    await s.run({ type: 'runtime.detect', requestId: rid() });
    expect([...loc.calls].sort()).toEqual(['claude', 'codex']);
    await s.backend.shutdown();
  });

  it('keeps a model count of 0 and still lists the runtime when its models cannot be listed', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    const bus = new EventBus();
    const result = await startBackend({
      dbPath: join(dir, 'awg.sqlite'), bus, createHost: () => new FakeHost(), runtimes: loc.port,
      createAdapter: (runtime, _id, hooks) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
      listModels: () => Promise.reject(new Error('boom')), resolveRealPath: (p) => p, log: () => undefined,
    });
    if (result.status !== 'ready') throw new Error('not ready');
    await settle();
    const snapshot = await result.facade.snapshot();
    expect(snapshot.runtimes.find((r) => r.runtime === 'claude')).toMatchObject({ state: 'available', modelCount: 0 });
    await result.shutdown();
  });
});

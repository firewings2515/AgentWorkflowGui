// T045: the backend with a RuntimeLocator. Availability follows the last detection, an unavailable runtime lists no
// models, a command that needs one looks again first, and `runtime.detect` publishes the new status (C-33).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, type EventEnvelope, InstanceId, MessageId, type OwnedProcess, RequestId, type Runtime, type RuntimeStatus, SessionId } from '../../contracts';
import type { RuntimeLocator } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { agents, template, WORKFLOW } from '../../core/workflow/testing/harness';
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
  /** A detection of these runtimes never answers; `gate` holds every detection until it is opened. */
  const hang = new Set<Runtime>();
  const state: { gate?: Promise<void> } = {};
  const port: RuntimeLocator = {
    detect: async (runtime, at) => {
      calls.push(runtime);
      if (hang.has(runtime)) await new Promise<never>(() => undefined);
      await state.gate;
      return { ...answers[runtime], checkedAt: at };
    },
    current: (runtime) => answers[runtime],
  };
  return { port, answers, calls, hang, state };
};

let n = 0;
const rid = () => RequestId.parse(`t045-${++n}`);
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

const start = async (loc: RuntimeLocator, redetectMinMs = 0, extra: { dbPath?: string; supervisor?: { idleMs: number; maxOpen: number; tickMs: number } } = {}) => {
  /** Every adapter the factory made, in order. */
  const adapters: FakeAdapter[] = [];
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  const result = await startBackend({
    dbPath: extra.dbPath ?? join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    runtimes: loc,
    redetectMinMs,
    ...(extra.supervisor !== undefined && { supervisor: extra.supervisor }),
    createAdapter: (runtime, _id, hooks) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.push(adapter);
      return adapter;
    },
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
  return { backend: result, envelopes, run, adapters };
};

const create = (runtime: Runtime, id: string): Command => ({
  type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir,
});

/** A candidate the locator shows but must never run: the name says .exe, the link points at something else. */
const notExe = (runtime: Runtime): RuntimeStatus => ({
  runtime, state: 'failed', executable: `C:/links/${runtime}.exe`, source: 'path', requiredVersion: '1.0.0', auth: 'unknown', modelCount: 0, checkedAt: AT,
  detail: 'points at something that is not an .exe',
});

describe.each([':memory:', 'SQLite file'])('T045 review r3: a session resumed after its runtime became unusable (%s)', (store) => {
  it('is refused with runtime_unavailable before any adapter is made; the message stays pending; it is sent once the runtime is usable again', async () => {
    const loc = locator({ claude: available('claude'), codex: available('codex') });
    const s = await start(loc.port, 0, { ...(store === ':memory:' && { dbPath: ':memory:' }), supervisor: { idleMs: 1, maxOpen: 0, tickMs: 3_600_000 } });
    await settle();
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    expect(await s.run(create('claude', 'resume-me'))).toMatchObject({ ok: true });
    await settle();
    // The idle supervisor closes the runtime of the idle session.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.backend.supervisor.tick();
    await settle();
    expect(s.backend.service.openSessions().length).toBe(0);
    const made = s.adapters.length;
    const resumed = () => s.adapters.filter((a) => a.calls.includes('resumeSession')).length;
    const dispatched = () => s.adapters.filter((a) => a.calls.includes('dispatchOnce')).length;
    const resumedBefore = resumed();
    const dispatchedBefore = dispatched();

    // The candidate becomes a link to something that is not an .exe; the detection says failed.
    loc.answers.claude = notExe('claude');
    expect(await s.run({ type: 'runtime.detect', requestId: rid(), runtime: 'claude' })).toMatchObject({ ok: true });
    expect((await s.backend.facade.snapshot()).runtimes.find((r) => r.runtime === 'claude')?.state).toBe('failed');

    const session = (await s.backend.facade.snapshot()).sessions.find((x) => x.id === 'resume-me');
    const send = (messageId: string) =>
      s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('resume-me'), messageId: MessageId.parse(messageId), expectedRevision: session?.revision ?? 0, text: 'hello again', attachments: [] });
    expect(await send('m-1')).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    // Nothing was made or called: not the factory, not the resume, not the dispatch.
    expect(s.adapters.length).toBe(made);
    expect(resumed()).toBe(resumedBefore);
    expect(dispatched()).toBe(dispatchedBefore);
    // The message is saved and waits: pending, never claimed and never unknown (CR-2).
    const { store: deliveries } = s.backend.service.storage;
    expect((await deliveries.listByState('pending')).filter((d) => d.kind === 'user-message').length).toBe(1);
    expect((await deliveries.listByState('unknown')).length).toBe(0);

    // Usable again: the same message goes out now.
    loc.answers.claude = available('claude');
    expect(await s.run({ type: 'runtime.detect', requestId: rid(), runtime: 'claude' })).toMatchObject({ ok: true });
    expect(await send('m-1')).toMatchObject({ ok: true });
    expect(resumed()).toBe(resumedBefore + 1);
    expect(dispatched()).toBe(dispatchedBefore + 1);
    expect((await deliveries.listByState('pending')).length).toBe(0);
    await s.backend.shutdown();
  });

  it('a runtime that is not available gets no adapter from any door, a model probe included', async () => {
    const loc = locator({ claude: notExe('claude'), codex: available('codex') });
    const s = await start(loc.port, 0, store === ':memory:' ? { dbPath: ':memory:' } : {});
    await settle();
    expect(s.adapters.map((a) => a.runtime)).not.toContain('claude');
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    expect(await s.run(create('claude', 'never'))).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(s.adapters.map((a) => a.runtime)).not.toContain('claude');
    await s.backend.shutdown();
  });
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

  it('Claude unavailable: session.create(claude) is refused with runtime_unavailable, and Codex can still be created', async () => {
    const loc = locator({ claude: missing('claude'), codex: available('codex') });
    const s = await start(loc.port);
    await settle();
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    const refused = await s.run(create('claude', 'claude-refused'));
    expect(refused).toMatchObject({ ok: false, code: 'runtime_unavailable' });
    expect(refused.ok ? '' : refused.message).toContain('claude');
    expect(await s.run(create('codex', 'codex-ok'))).toMatchObject({ ok: true });
    const snapshot = await s.backend.facade.snapshot();
    expect(snapshot.sessions.map((x) => x.id)).toEqual(['codex-ok']);
    expect(snapshot.modelOptions.map((m) => m.runtime)).toEqual(['codex']);
    await s.backend.shutdown();
  });

  it('two commands that need the same unavailable runtime at once both wait for the one detection that runs', async () => {
    const loc = locator({ claude: available('claude'), codex: missing('codex') });
    // A pause between detections that is long: only the wait for the running detection can let the second one through.
    const s = await start(loc.port, 60_000);
    await settle();
    await s.run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
    const before = loc.calls.filter((c) => c === 'codex').length;
    let open: () => void = () => undefined;
    loc.state.gate = new Promise<void>((resolve) => { open = resolve; });
    loc.answers.codex = available('codex');
    let answered = 0;
    const first = s.run(create('codex', 'codex-a')).finally(() => answered++);
    await settle();
    // The second asks while the first one's detection is still running: inside the pause, but it must not skip it.
    const second = s.run(create('codex', 'codex-b')).finally(() => answered++);
    await settle();
    // Neither is answered before the detection is: the second is not refused on the old status.
    expect(answered).toBe(0);
    open();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(loc.calls.filter((c) => c === 'codex').length).toBe(before + 1);
    await s.backend.shutdown();
  });

  it('a workflow that only uses Codex does not wait for Claude to be looked for', async () => {
    const loc = locator({ claude: missing('claude'), codex: available('codex') });
    const s = await start(loc.port);
    await settle();
    loc.hang.add('claude');
    for (const a of agents()) await s.run({ type: 'agent.save', requestId: rid(), agent: a, expectedRevision: null });
    const codex = { model: { runtime: 'codex' as const, model: 'codex-m' } };
    await s.run({ type: 'workflow.save', requestId: rid(), workflow: template({}, { plan: codex, impl: codex, review: codex }), expectedRevision: null });
    const started = await Promise.race([
      s.run({ type: 'workflow.start', requestId: rid(), instanceId: InstanceId.parse('run-codex'), rootSessionId: SessionId.parse('root-codex'), workflowId: WORKFLOW, workflowRevision: 0, title: 'Codex only', cwd: dir, firstMessage: 'Go.', crossToolConsent: true }),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 3000)),
    ]);
    expect(started).toMatchObject({ ok: true });
    expect(loc.calls.filter((c) => c === 'claude').length).toBe(1); // the one at startup
    await s.backend.shutdown();
  });

  it('a workflow that uses Claude does look for it again first', async () => {
    const loc = locator({ claude: missing('claude'), codex: available('codex') });
    const s = await start(loc.port);
    await settle();
    for (const a of agents()) await s.run({ type: 'agent.save', requestId: rid(), agent: a, expectedRevision: null });
    await s.run({ type: 'workflow.save', requestId: rid(), workflow: template({}), expectedRevision: null });
    loc.answers.claude = available('claude');
    const before = loc.calls.filter((c) => c === 'claude').length;
    await s.run({ type: 'workflow.start', requestId: rid(), instanceId: InstanceId.parse('run-mixed'), rootSessionId: SessionId.parse('root-mixed'), workflowId: WORKFLOW, workflowRevision: 0, title: 'Mixed', cwd: dir, firstMessage: 'Go.', crossToolConsent: true });
    expect(loc.calls.filter((c) => c === 'claude').length).toBe(before + 1);
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

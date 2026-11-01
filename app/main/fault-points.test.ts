// T039: the crash tests' fault points. Without the variables nothing is wrapped; with them, only the named session's
// (or runtime's) adapter stops at the named call, after one log line with IDs only, and the real call never happens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { MessageId, type OwnedProcess, RequestId, type Runtime, SessionId } from '../../contracts';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';
import { type FaultPoint, faultApplies, faultPointFrom, withFaultPoint } from './fault-points';

describe('T039 fault points: reading the environment', () => {
  it('reads a point with a session or a runtime, and nothing else', () => {
    expect(faultPointFrom({})).toBeUndefined();
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: 's-1' })).toEqual({ point: 'dispatch', sessionId: 's-1' });
    expect(faultPointFrom({ AWG_FAULT_POINT: 'close-session', AWG_FAULT_RUNTIME: 'codex' })).toEqual({ point: 'close-session', runtime: 'codex' });
    // Unknown points, no target, both targets, an unknown runtime: no fault point at all.
    expect(faultPointFrom({ AWG_FAULT_POINT: 'exit', AWG_FAULT_SESSION: 's-1' })).toBeUndefined();
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch' })).toBeUndefined();
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: 's-1', AWG_FAULT_RUNTIME: 'codex' })).toBeUndefined();
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_RUNTIME: 'gemini' })).toBeUndefined();
  });

  it('reads how many calls go through first; anything but a whole number is no fault point', () => {
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: 's-1', AWG_FAULT_SKIP: '1' })).toEqual({ point: 'dispatch', sessionId: 's-1', skip: 1 });
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_RUNTIME: 'codex', AWG_FAULT_SKIP: '0' })).toEqual({ point: 'dispatch', runtime: 'codex' });
    expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: 's-1', AWG_FAULT_SKIP: '' })).toEqual({ point: 'dispatch', sessionId: 's-1' });
    for (const bad of ['-1', '1.5', 'one', ' 1', '1000'])
      expect(faultPointFrom({ AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: 's-1', AWG_FAULT_SKIP: bad })).toBeUndefined();
  });

  it('applies to the named session or runtime, never to a model probe', () => {
    const bySession: FaultPoint = { point: 'dispatch', sessionId: 's-1' };
    const byRuntime: FaultPoint = { point: 'dispatch', runtime: 'codex' };
    expect(faultApplies(bySession, 'claude', SessionId.parse('s-1'))).toBe(true);
    expect(faultApplies(bySession, 'claude', SessionId.parse('s-2'))).toBe(false);
    expect(faultApplies(byRuntime, 'codex', SessionId.parse('s-2'))).toBe(true);
    expect(faultApplies(byRuntime, 'claude', SessionId.parse('s-2'))).toBe(false);
    expect(faultApplies(byRuntime, 'codex', SessionId.parse('models-codex'))).toBe(false);
  });

  it('stops only the named call: it logs IDs only and never reaches the adapter; the rest is the adapter’s own', async () => {
    const adapter = new FakeAdapter('codex', () => undefined);
    const logs: string[] = [];
    const wrapped = withFaultPoint(adapter, SessionId.parse('s-1'), { point: 'close-session', sessionId: 's-1' }, (m) => logs.push(m));
    let settled = false;
    void wrapped.closeSession('thread-9').then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(adapter.closedSessions).toEqual([]);
    expect(logs).toEqual(['[fault] close-session reached session=s-1 ref=thread-9']);
    expect(wrapped.runtime).toBe('codex');
    await wrapped.start();
    expect(adapter.calls).toContain('start');
  });
});

class Host implements BackendProcessHost {
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

describe('T039 fault points in the backend', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'awg-t039-fault-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const start = async (faultPoint?: FaultPoint) => {
    const adapters: FakeAdapter[] = [];
    const logs: string[] = [];
    const backend = await startBackend({
      dbPath: join(dir, 'awg.sqlite'),
      bus: new EventBus(),
      createHost: () => new Host(),
      createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
        const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
        adapters.push(adapter);
        return adapter;
      },
      listModels: () => Promise.resolve([]),
      resolveRealPath: (p) => p,
      watch: () => {
        const watcher = { close: () => undefined, on: () => watcher };
        return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
      },
      log: (m) => logs.push(m),
      closeTimeoutMs: 50,
      ...(faultPoint !== undefined && { faultPoint }),
    });
    if (backend.status !== 'ready') throw new Error('not ready');
    let requests = 0;
    const run = (command: object) => backend.facade.execute({ requestId: RequestId.parse(`f-${String(++requests)}`), ...command } as never);
    await run({ type: 'agent.save', agent: agent(), expectedRevision: null });
    for (const id of ['s-1', 's-2'])
      await run({ type: 'session.create', sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: dir });
    // The created sessions settle first (their provision updates them once more).
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    const send = async (id: string, text: string) => {
      const session = (await backend.facade.snapshot()).sessions.find((s) => s.id === id)!;
      return run({ type: 'session.send', sessionId: session.id, messageId: MessageId.parse(`${id}-${text}`), expectedRevision: session.revision, text, attachments: [] });
    };
    return { backend, adapters, logs, send };
  };

  it('without a fault point nothing stops', async () => {
    const s = await start();
    expect(await s.send('s-1', 'hello')).toMatchObject({ ok: true });
    expect(s.logs.some((l) => l.includes('[fault]'))).toBe(false);
    await s.backend.shutdown();
  });

  it('dispatch: the named session’s delivery is committed unknown and never reaches its runtime; another session is untouched', async () => {
    const s = await start({ point: 'dispatch', sessionId: 's-1' });
    expect(s.logs).toContain('[fault] armed: dispatch of s-1');
    let answered = false;
    void s.send('s-1', 'secret text').then(() => (answered = true));
    for (let i = 0; i < 50 && !s.logs.some((l) => l.startsWith('[fault] dispatch reached')); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const line = s.logs.find((l) => l.startsWith('[fault] dispatch reached'))!;
    expect(line).toMatch(/^\[fault\] dispatch reached session=s-1 attempt=\S+$/);
    expect(line).not.toContain('secret text');
    expect(answered).toBe(false);
    const db = openDatabase(join(dir, 'awg.sqlite'));
    const [unknown] = await new SqliteDeliveryStore(db).listByState('unknown');
    db.close();
    expect(unknown).toMatchObject({ kind: 'user-message', target: { sessionId: 's-1' } });
    expect(unknown!.delivery.attempts).toHaveLength(1);
    expect(s.adapters.flatMap((a) => a.dispatched.map((d) => d.text))).toEqual([]);
    // The other session sends as always.
    expect(await s.send('s-2', 'other')).toMatchObject({ ok: true });
    expect(s.adapters.flatMap((a) => a.dispatched.map((d) => d.text))).toEqual(['other']);
    await s.backend.shutdown();
  });

  it('dispatch after one: the first message reaches the runtime as always, the second stops committed unknown', async () => {
    const s = await start({ point: 'dispatch', sessionId: 's-1', skip: 1 });
    expect(await s.send('s-1', 'first')).toMatchObject({ ok: true });
    expect(s.logs.some((l) => l.startsWith('[fault] dispatch reached'))).toBe(false);
    let answered = false;
    void s.send('s-1', 'second').then(() => (answered = true));
    for (let i = 0; i < 50 && !s.logs.some((l) => l.startsWith('[fault] dispatch reached')); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(s.logs.filter((l) => l.startsWith('[fault] dispatch reached session=s-1 '))).toHaveLength(1);
    expect(answered).toBe(false);
    expect(s.adapters.flatMap((a) => a.dispatched.map((d) => d.text))).toEqual(['first']);
    const db = openDatabase(join(dir, 'awg.sqlite'));
    const store = new SqliteDeliveryStore(db);
    const unknown = await store.listByState('unknown');
    const sent = await store.listByState('sent');
    db.close();
    expect(unknown.map((d) => d.operationId)).toEqual(['user-message:s-1-second']);
    expect(sent.filter((d) => d.kind === 'user-message').map((d) => d.operationId)).toEqual(['user-message:s-1-first']);
    await s.backend.shutdown();
  });
});

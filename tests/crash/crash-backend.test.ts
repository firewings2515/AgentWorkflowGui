// T039 crash matrix, P6 (V-28) through the assembled backend on a real SQLite file: the GUI dies with a command
// running (the first backend is never shut down), and the next start, in its own order (database, snapshot, orphan
// cleanup, MCP, sessions, recovery), hands the process host exactly the records left without an end, records what it
// ended or found gone as ended, and records the turn and the command as cut off. The real Job Object and the real
// cleanup of a matching PID and creation time are adapters/process's tests and the live run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemId, MessageId, type OwnedProcess, RequestId, type Runtime, SessionId, TurnId } from '../../contracts';
import type { OwnedProcessRepository, PermissionHandle } from '../../core/ports';
import { FakeAdapter, RuntimeDisk } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type Backend, type BackendProcessHost, startBackend } from '../../app/main/backend';
import { EventBus } from '../../app/main/event-bus';
import type { FaultPoint } from '../../app/main/fault-points';

class Host implements BackendProcessHost {
  readonly cleanups: OwnedProcess[][] = [];
  constructor(
    readonly repository: OwnedProcessRepository,
    private readonly stillRunning: (p: OwnedProcess) => boolean,
  ) {}
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
    this.cleanups.push([...records]);
    const at = '2026-11-01T00:00:09.000Z';
    return Promise.resolve({ ended: records.filter(this.stillRunning).map((p) => ({ ...p, endedAt: at })), gone: records.filter((p) => !this.stillRunning(p)) });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

let dir: string;
const backends: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t039-crash-backend-'));
});
afterEach(async () => {
  for (const b of backends.splice(0).reverse()) await b.shutdown().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

const start = async (stillRunning: (p: OwnedProcess) => boolean = () => true, faultPoint?: FaultPoint, disk?: RuntimeDisk) => {
  const adapters: FakeAdapter[] = [];
  const logs: string[] = [];
  let host: Host | undefined;
  const backend = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus: new EventBus(),
    createHost: (repository) => (host = new Host(repository, stillRunning)),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapter.diskOf = () => disk;
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
  backends.push(backend);
  return { backend, adapters, logs, host: host! };
};

let requests = 0;
const rid = () => RequestId.parse(`crash-${String(++requests)}`);
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('T039 P6 through the backend: a crash with a command running', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    it(`${runtime}: the next start ends what is left of the earlier run, records it ended, and records the turn and the command as cut off`, async () => {
      const first = await start();
      const sessionId = SessionId.parse(`crash-${runtime}`);
      const run = (command: object) => first.backend.facade.execute({ requestId: rid(), ...command } as never);
      await run({ type: 'agent.save', agent: agent(), expectedRevision: null });
      expect(await run({ type: 'session.create', sessionId, kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir })).toMatchObject({ ok: true });
      await settle();
      const session = (await first.backend.facade.snapshot()).sessions.find((s) => s.id === sessionId)!;
      expect(await run({ type: 'session.send', sessionId, messageId: MessageId.parse(`m-${runtime}`), expectedRevision: session.revision, text: 'run it', attachments: [] })).toMatchObject({ ok: true });
      const adapter = first.adapters.find((a) => a.runtime === runtime)!;
      const turn = TurnId.parse(`turn-${runtime}`);
      adapter.emit({ type: 'turn.updated', turn: { id: turn, sessionId, state: 'running', startedAt: '2026-11-01T00:00:01.000Z' } });
      adapter.emit({
        type: 'item.updated',
        item: { id: `cmd-${runtime}` as ItemId, sessionId, turnId: turn, kind: 'command', command: 'Start-Sleep -Seconds 240', cwd: dir, state: 'running', output: '', outputTruncated: false, startedAt: '2026-11-01T00:00:01.000Z' },
      });
      // What the process host recorded in the session's Job: the runtime host and the command's tree.
      const recorded: OwnedProcess[] = [
        { pid: 4101, startedAt: '2026-11-01T00:00:00.100Z', sessionId, runtime, kind: 'runtime-host', jobRef: 'job-1', recordedAt: '2026-11-01T00:00:00.200Z' },
        { pid: 4102, startedAt: '2026-11-01T00:00:01.100Z', sessionId, runtime, kind: 'command', jobRef: 'job-1', recordedAt: '2026-11-01T00:00:01.200Z' },
        { pid: 4103, startedAt: '2026-11-01T00:00:01.300Z', sessionId, runtime, kind: 'command', jobRef: 'job-1', recordedAt: '2026-11-01T00:00:01.400Z' },
      ];
      for (const p of recorded) await first.host.repository.record(p);
      // An earlier run's record that was already ended stays out of the cleanup.
      await first.host.repository.record({ pid: 4000, startedAt: '2026-10-31T00:00:00.000Z', sessionId, runtime, kind: 'command', jobRef: 'job-0', recordedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:01:00.000Z' });
      await settle();

      // The GUI dies here: the first backend is never shut down. One command outlived it (no Job would let it; the
      // start-up cleanup is the second line), the rest went with the Job.
      const second = await start((p) => p.pid === 4103);
      expect(second.host.cleanups).toHaveLength(1);
      expect(second.host.cleanups[0]!.map((p) => p.pid).sort()).toEqual([4101, 4102, 4103]);
      expect(second.logs).toContain('[backend] ended 1 process(es) left by an earlier run');
      expect(await second.host.repository.listLive()).toEqual([]);
      const snapshot = await second.backend.facade.snapshot();
      expect(snapshot.turns.find((t) => t.id === turn)).toMatchObject({ state: 'interrupted' });
      expect(snapshot.items.find((i) => i.id === `cmd-${runtime}`)).toMatchObject({ state: 'interrupted' });
      expect(snapshot.sessions.find((s) => s.id === sessionId)?.activity).toBe('closed');
      // Nothing was sent again by the restart.
      expect(second.adapters.flatMap((a) => a.dispatched)).toEqual([]);
      // A third start finds nothing left to clean.
      const third = await start();
      expect(third.host.cleanups).toEqual([[]]);
    });
  }
});

describe('T039 r1-P1-1: a normal exit after a restart that only reconciled', () => {
  for (const runtime of ['codex', 'claude'] as const) {
    it(`${runtime}: the processes of this run that exited by themselves are recorded ended too`, async () => {
      // The GUI dies with the message's dispatch committed unknown (the fault point stops it there).
      const sessionId = SessionId.parse(`reconcile-${runtime}`);
      const first = await start(() => true, { point: 'dispatch', sessionId });
      const run = (command: object) => first.backend.facade.execute({ requestId: rid(), ...command } as never);
      await run({ type: 'agent.save', agent: agent(), expectedRevision: null });
      await run({ type: 'session.create', sessionId, kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir });
      await settle();
      const session = (await first.backend.facade.snapshot()).sessions.find((s) => s.id === sessionId)!;
      void run({ type: 'session.send', sessionId, messageId: MessageId.parse(`r-${runtime}`), expectedRevision: session.revision, text: 'hello', attachments: [] });
      await settle();

      // The next start only reconciles it; the runtime it opened for that, recorded in the session's Job, has exited
      // by itself by the time the user exits (nothing of it is in a Job any more).
      const second = await start(() => false);
      expect((await second.backend.facade.snapshot()).sessions.find((s) => s.id === sessionId)?.activity).toBe('reconciling');
      const reconciler: OwnedProcess = { pid: 5101, startedAt: '2026-11-01T00:00:05.000Z', sessionId, runtime, kind: 'runtime-host', jobRef: 'job-r', recordedAt: '2026-11-01T00:00:05.100Z' };
      const helper: OwnedProcess = { ...reconciler, pid: 5102, startedAt: '2026-11-01T00:00:05.200Z', kind: 'helper', recordedAt: '2026-11-01T00:00:05.300Z' };
      await second.host.repository.record(reconciler);
      await second.host.repository.record(helper);
      backends.splice(backends.indexOf(second.backend), 1);
      await second.backend.shutdown();

      // Every record of that run has its end: the next start finds nothing to clean.
      const third = await start();
      expect(await third.host.repository.listLive()).toEqual([]);
      expect(third.host.cleanups).toEqual([[]]);
      const db = new DatabaseSync(join(dir, 'awg.sqlite'), { readOnly: true });
      const rows = db.prepare('SELECT pid, ended_at FROM owned_process WHERE pid IN (5101, 5102) ORDER BY pid').all();
      db.close();
      expect(rows.map((r) => r['pid'])).toEqual([5101, 5102]);
      expect(rows.every((r) => typeof r['ended_at'] === 'string')).toBe(true);
    });
  }
});

describe('T046 through the backend: a session its runtime stored nothing of, after a crash', () => {
  for (const runtime of ['claude', 'codex'] as const) {
    const sessionOf = async (b: Backend, sessionId: SessionId) => (await b.facade.snapshot()).sessions.find((s) => s.id === sessionId)!;
    const sendTo = async (b: Backend, sessionId: SessionId, id: string, text: string) =>
      b.facade.execute({ requestId: rid(), type: 'session.send', sessionId, messageId: MessageId.parse(id), expectedRevision: (await sessionOf(b, sessionId)).revision, text, attachments: [] });
    const make = async (b: Backend, sessionId: SessionId) => {
      const run = (command: object) => b.facade.execute({ requestId: rid(), ...command } as never);
      await run({ type: 'agent.save', agent: agent(), expectedRevision: null });
      expect(await run({ type: 'session.create', sessionId, kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd: dir })).toMatchObject({ ok: true });
      await settle();
    };

    it(`${runtime}: created, never sent to, then the GUI dies: the first message ${runtime === 'claude' ? 'opens it again under its own session ID' : 'is refused plainly; the session shows error'}`, async () => {
      const disk = new RuntimeDisk();
      const sessionId = SessionId.parse(`t046-none-${runtime}`);
      const first = await start(() => false, undefined, disk);
      await make(first.backend, sessionId);
      const ref = first.adapters.flatMap((a) => a.started).find((s) => s.sessionId === sessionId)?.preallocatedRef;

      const second = await start(() => false, undefined, disk);
      const result = await sendTo(second.backend, sessionId, `t046-none-${runtime}-1`, 'first');
      await settle();
      const mine = second.adapters.filter((a) => a.runtime === runtime);
      expect(mine.flatMap((a) => a.resumed).map((o) => o.sessionId)).toEqual([sessionId]);
      if (runtime === 'claude') {
        expect(result).toMatchObject({ ok: true });
        expect(mine.flatMap((a) => a.started).map((s) => s.preallocatedRef)).toEqual([ref]);
        expect(mine.flatMap((a) => a.dispatched).map((d) => d.text)).toEqual(['first']);
      } else {
        expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
        expect(mine.flatMap((a) => a.started)).toEqual([]);
        expect(mine.flatMap((a) => a.dispatched)).toEqual([]);
        expect((await sessionOf(second.backend, sessionId)).activity).toBe('error');
      }
    });

    it(`${runtime}: the GUI dies at the dispatch fault point of its first message: escalated (G-1), not opened or sent again; the user's retry ${runtime === 'claude' ? 'opens it again and sends once' : 'is refused plainly'}`, async () => {
      const disk = new RuntimeDisk();
      const sessionId = SessionId.parse(`t046-fault-${runtime}`);
      const first = await start(() => false, { point: 'dispatch', sessionId }, disk);
      await make(first.backend, sessionId);
      const ref = first.adapters.flatMap((a) => a.started).find((s) => s.sessionId === sessionId)?.preallocatedRef;
      void sendTo(first.backend, sessionId, `t046-fault-${runtime}-1`, 'the work');
      await settle();
      expect(first.logs.some((l) => l.startsWith(`[fault] dispatch reached session=${sessionId} `))).toBe(true);
      expect(first.adapters.flatMap((a) => a.dispatched)).toEqual([]);

      const second = await start(() => false, undefined, disk);
      const snapshot = await second.backend.facade.snapshot();
      const escalation = snapshot.escalations.find((e) => e.kind === 'delivery-unknown' && e.state === 'open');
      expect(escalation).toMatchObject({ rootSessionId: sessionId, fromSessionId: sessionId, ref: { kind: 'message', messageId: `t046-fault-${runtime}-1` } });
      expect(snapshot.sessions.find((s) => s.id === sessionId)?.activity).toBe('reconciling');
      const mine = () => second.adapters.filter((a) => a.runtime === runtime);

      // Another message cannot be told apart from what may have arrived: nothing is opened, nothing sent.
      expect(await sendTo(second.backend, sessionId, `t046-fault-${runtime}-2`, 'next')).toMatchObject({ ok: false, code: 'invalid_transition' });
      await settle();
      expect(mine().flatMap((a) => a.started)).toEqual([]);
      expect(mine().flatMap((a) => a.dispatched)).toEqual([]);
      expect((await sessionOf(second.backend, sessionId)).activity).toBe('error');

      const retried = await second.backend.facade.execute({ requestId: rid(), type: 'delivery.resolve', escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: true });
      await settle();
      if (runtime === 'claude') {
        expect(retried).toMatchObject({ ok: true });
        expect(mine().flatMap((a) => a.started).map((s) => s.preallocatedRef)).toEqual([ref]);
        expect(mine().flatMap((a) => a.dispatched).map((d) => d.text)).toEqual(['the work']);
        expect((await sessionOf(second.backend, sessionId)).activity).toBe('idle');
      } else {
        expect(retried).toMatchObject({ ok: false, code: 'runtime_unavailable' });
        expect(mine().flatMap((a) => a.dispatched)).toEqual([]);
        expect((await sessionOf(second.backend, sessionId)).activity).toBe('error');
      }
    });
  }
});

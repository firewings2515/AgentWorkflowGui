// T039 crash matrix, P6 (V-28) through the assembled backend on a real SQLite file: the GUI dies with a command
// running (the first backend is never shut down), and the next start, in its own order (database, snapshot, orphan
// cleanup, MCP, sessions, recovery), hands the process host exactly the records left without an end, records what it
// ended or found gone as ended, and records the turn and the command as cut off. The real Job Object and the real
// cleanup of a matching PID and creation time are adapters/process's tests and the live run.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ItemId, MessageId, type OwnedProcess, RequestId, type Runtime, SessionId, TurnId } from '../../contracts';
import type { OwnedProcessRepository, PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type Backend, type BackendProcessHost, startBackend } from '../../app/main/backend';
import { EventBus } from '../../app/main/event-bus';

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

const start = async (stillRunning: (p: OwnedProcess) => boolean = () => true) => {
  const adapters: FakeAdapter[] = [];
  const logs: string[] = [];
  let host: Host | undefined;
  const backend = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus: new EventBus(),
    createHost: (repository) => (host = new Host(repository, stillRunning)),
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

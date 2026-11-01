// T036 wiring in the assembled backend (real SQLite, fake adapters and process host): the backend's timer runs the
// idle supervisor with its settings, a command alive in the session's Job keeps it open, the exit stops the timer,
// and the settings read from the environment.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, MessageId, type OwnedProcess, RequestId, type Runtime, SessionId, TurnId } from '../../contracts';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type Backend, type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';
import { supervisorSettings } from './supervisor-settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t036-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  readonly closedJobs: SessionId[] = [];
  /** Live processes by session, as listOwned reports them. */
  readonly live = new Map<SessionId, OwnedProcess[]>();
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob(sessionId: SessionId) {
    this.closedJobs.push(sessionId);
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned(sessionId?: SessionId) {
    return Promise.resolve(sessionId === undefined ? [...this.live.values()].flat() : (this.live.get(sessionId) ?? []));
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

const IDLE_MS = 60_000;
let requests = 0;
const rid = () => RequestId.parse(`t036-r-${String(++requests)}`);
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** Real time passes for the timer (10 ms ticks) to run a few times. */
const ticks = () => new Promise((resolve) => setTimeout(resolve, 80));

const start = async () => {
  let ms = Date.parse('2026-11-01T00:00:00.000Z');
  const host = new FakeHost();
  const adapters = new Map<SessionId, FakeAdapter>();
  const logs: string[] = [];
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus: new EventBus(),
    createHost: () => host,
    createAdapter: (runtime: Runtime, sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.set(sessionId, adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    now: () => new Date(ms),
    supervisor: { idleMs: IDLE_MS, maxOpen: 0, tickMs: 10 },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  const backend: Backend = result;
  const run = (command: Command) => backend.facade.execute(command) as Promise<CommandResult>;
  const sessionId = SessionId.parse('session-a');
  await run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
  await run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: dir });
  await settle();
  // The session's adapter now: each opening gets its own (T036 r2 P1-1).
  const current = () => adapters.get(sessionId)!;
  const send = async (text: string) => {
    const s = await backend.repositories.sessions.get(sessionId);
    const out = await run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(`t036-${text}`), expectedRevision: s!.revision, text, attachments: [] });
    // The turn the ack named ends.
    const adapter = current();
    const id = TurnId.parse(`turn-${String(adapter.dispatched.length)}`);
    adapter.emit({ type: 'turn.updated', turn: { id, sessionId, state: 'completed', startedAt: new Date(ms).toISOString(), endedAt: new Date(ms).toISOString() } });
    await settle();
    return out;
  };
  return {
    backend,
    host,
    get adapter() {
      return current();
    },
    sessionId,
    logs,
    send,
    advance: (by: number) => (ms += by),
  };
};

describe('the idle supervisor in the backend (T036)', () => {
  it('the backend’s timer closes an idle session (adapter close, then its Job) and the next message resumes it in its folder', async () => {
    const s = await start();
    expect((await s.send('first')).ok).toBe(true);
    await ticks();
    expect(s.adapter.closedSessions).toEqual([]);
    s.advance(IDLE_MS);
    await ticks();
    expect(s.adapter.closedSessions).toHaveLength(1);
    expect(s.host.closedJobs).toEqual([s.sessionId]);
    expect((await s.backend.facade.snapshot()).sessions.find((x) => x.id === s.sessionId)?.activity).toBe('closed');
    expect((await s.send('second')).ok).toBe(true);
    expect(s.adapter.resumed).toEqual([expect.objectContaining({ cwd: dir })]);
    await s.backend.shutdown();
  });

  it('a command process alive in the session’s Job keeps it open (R-14: the Job would end it)', async () => {
    const s = await start();
    await s.send('first');
    s.host.live.set(s.sessionId, [
      { pid: 4242, startedAt: '2026-11-01T00:00:00.000Z', sessionId: s.sessionId, runtime: 'codex', kind: 'command', jobRef: 'job-a', recordedAt: '2026-11-01T00:00:00.000Z' },
    ]);
    s.advance(IDLE_MS);
    await ticks();
    expect(s.adapter.closedSessions).toEqual([]);
    expect(s.logs.some((l) => l.includes('owned-process'))).toBe(true);
    // A runtime host or helper does not count.
    s.host.live.set(s.sessionId, [
      { pid: 4243, startedAt: '2026-11-01T00:00:00.000Z', sessionId: s.sessionId, runtime: 'codex', kind: 'runtime-host', jobRef: 'job-a', recordedAt: '2026-11-01T00:00:00.000Z' },
    ]);
    await ticks();
    expect(s.adapter.closedSessions).toHaveLength(1);
    await s.backend.shutdown();
  });

  it('the exit stops the timer: nothing is closed by the supervisor afterwards', async () => {
    const s = await start();
    await s.send('first');
    await s.backend.shutdown();
    const closedByExit = s.adapter.closedSessions.length;
    s.advance(IDLE_MS);
    await ticks();
    expect(s.adapter.closedSessions).toHaveLength(closedByExit);
    expect(s.logs.filter((l) => l.includes('[supervisor] closed'))).toEqual([]);
  });
});

describe('supervisorSettings', () => {
  it('reads whole numbers from the environment and leaves the rest to the defaults', () => {
    expect(supervisorSettings({})).toEqual({});
    expect(supervisorSettings({ AWG_IDLE_CLOSE_MS: '20000', AWG_MAX_OPEN_RUNTIMES: '0', AWG_IDLE_TICK_MS: '5000' })).toEqual({ idleMs: 20000, maxOpen: 0, tickMs: 5000 });
    expect(supervisorSettings({ AWG_IDLE_CLOSE_MS: '10', AWG_MAX_OPEN_RUNTIMES: '-1', AWG_IDLE_TICK_MS: '1.5' })).toEqual({});
    expect(supervisorSettings({ AWG_IDLE_CLOSE_MS: 'soon' })).toEqual({});
  });
});

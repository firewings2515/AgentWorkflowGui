// WindowsProcessHost against real Job Objects (spike job-test.mjs, job-session-test.mjs): two sessions at
// once, closing A's Job leaves B running; killing the host process ends every recorded process; start-up
// cleanup ends only records whose PID and creation time both still match. The tests end only processes
// they started, through their own handles.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnedProcess, SessionId } from '../../contracts';
import type { OwnedProcessRepository } from '../../core/ports/repository';
import { WindowsProcessHost } from './host';
import type { JobChild } from './launch';
import { RUNTIME_WITH_DETACHED_WORKER, isAlive, waitUntil } from './testing/workers';
import { closeHandle, creationTime, openProcess } from './win32';

const here = dirname(fileURLToPath(import.meta.url));
const windows = process.platform === 'win32';
const A = 'session-A' as SessionId;
const B = 'session-B' as SessionId;

const memoryRepository = () => {
  const rows: OwnedProcess[] = [];
  const repository: OwnedProcessRepository = {
    record: (p) => Promise.resolve(void rows.push({ ...p })),
    markEnded: (pid, startedAt, at) => {
      for (const r of rows) if (r.pid === pid && r.startedAt === startedAt) r.endedAt = at;
      return Promise.resolve();
    },
    listLive: () => Promise.resolve(rows.filter((r) => r.endedAt === undefined)),
  };
  return { rows, repository };
};

/** Starts the runtime stand-in in a session and waits for its detached worker's PID. */
const startRuntime = async (host: WindowsProcessHost, sessionId: SessionId): Promise<{ child: JobChild; worker: number }> => {
  const child = host.spawn(sessionId, 'codex', { command: process.execPath, args: ['-e', RUNTIME_WITH_DETACHED_WORKER] });
  const [line] = (await once(child.stdout, 'data')) as [Buffer];
  return { child, worker: (JSON.parse(line.toString()) as { worker: number }).worker };
};

const identity = (pid: number) => {
  const handle = openProcess(pid);
  if (handle === undefined) throw new Error(`process ${pid} is gone`);
  try {
    return { pid, startedAt: new Date(creationTime(handle)).toISOString() };
  } finally {
    closeHandle(handle);
  }
};

describe.runIf(windows)('WindowsProcessHost', () => {
  let buildDir = '';
  let hostChild = '';

  beforeAll(async () => {
    // Inside the repository so the bundle finds koffi in node_modules.
    buildDir = mkdtempSync(join(here, '../../node_modules/.cache-awg-t013-'));
    await build({
      configFile: false,
      logLevel: 'silent',
      root: here,
      ssr: { noExternal: true, external: ['koffi'], target: 'node' },
      build: {
        ssr: join(here, 'testing/host-child.ts'),
        outDir: buildDir,
        write: true,
        minify: false,
        rolldownOptions: { external: ['koffi'], output: { format: 'es', entryFileNames: 'host-child.mjs' } },
      },
    });
    hostChild = join(buildDir, 'host-child.mjs');
  }, 60_000);

  afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

  it('runs two sessions at once; closing A ends A’s whole tree and leaves B running', async () => {
    const { rows, repository } = memoryRepository();
    const host = new WindowsProcessHost({ repository });
    try {
      const jobA = await host.openJob(A);
      expect(await host.openJob(A)).toEqual(jobA);
      const a = await startRuntime(host, A);
      const b = await startRuntime(host, B);

      const ownedA = await host.listOwned(A);
      const ownedB = await host.listOwned(B);
      expect(ownedA.map((p) => p.pid)).toEqual(expect.arrayContaining([a.child.pid, a.worker]));
      expect(ownedB.map((p) => p.pid)).toEqual(expect.arrayContaining([b.child.pid, b.worker]));
      expect(ownedA.find((p) => p.pid === a.child.pid)).toMatchObject({ kind: 'runtime-host', sessionId: A, runtime: 'codex', jobRef: jobA.jobRef });
      expect(ownedA.find((p) => p.pid === a.worker)).toMatchObject({ kind: 'command', sessionId: A });
      expect(ownedA.some((p) => ownedB.some((q) => q.pid === p.pid))).toBe(false);
      expect((await host.listOwned()).length).toBe(ownedA.length + ownedB.length);

      const { ended } = await host.closeJob(A);
      expect(ended.map((p) => p.pid).sort()).toEqual(ownedA.map((p) => p.pid).sort());
      expect(ownedA.some(isAlive)).toBe(false);
      expect(ownedB.every(isAlive)).toBe(true);
      expect(await host.listOwned(A)).toEqual([]);
      expect(await host.closeJob(A)).toEqual({ ended: [] });

      // Recorded as started, then marked ended; B's stay live.
      const live = rows.filter((r) => r.endedAt === undefined);
      expect(live.map((r) => r.sessionId)).toEqual(live.map(() => B));
      expect(rows.filter((r) => r.sessionId === A).every((r) => r.endedAt !== undefined)).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('a killed host takes every recorded process with it', async () => {
    const proc: ChildProcess = spawn(process.execPath, [hostChild], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let owned: OwnedProcess[] = [];
    try {
      const [line] = (await once(proc.stdout!, 'data')) as [Buffer];
      owned = JSON.parse(line.toString()) as OwnedProcess[];
      expect(new Set(owned.map((p) => p.sessionId))).toEqual(new Set([A, B]));
      expect(owned.filter((p) => p.kind === 'command').length).toBeGreaterThanOrEqual(2);
      expect(owned.every(isAlive)).toBe(true);
      // TerminateProcess on the host only: no tree kill, no cleanup code runs in it.
      proc.kill();
      expect(await waitUntil(() => !owned.some(isAlive), 2000)).toBe(true);
    } finally {
      proc.kill();
    }
  }, 30_000);

  it('cleans up at start only records whose PID and creation time both match', async () => {
    // Plain processes outside any Job, as if left behind by a GUI whose Job did not hold.
    const spawned = [0, 1].map(() => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }));
    try {
      const [orphan, stranger] = spawned.map((p) => identity(p.pid!));
      const base = { sessionId: A, runtime: 'claude', kind: 'command', jobRef: 'job-old', recordedAt: '2026-10-26T00:00:00.000Z' } as const;
      const records: OwnedProcess[] = [
        { ...base, ...orphan! },
        // Same PID, other creation time: the PID now belongs to another process.
        { ...base, pid: stranger!.pid, startedAt: new Date(Date.parse(stranger!.startedAt) - 1000).toISOString() },
        { ...base, pid: 4_000_000, startedAt: orphan!.startedAt },
        { ...base, ...stranger!, endedAt: '2026-10-26T00:01:00.000Z' },
      ];
      const { rows, repository } = memoryRepository();
      rows.push(...records.map((r) => ({ ...r })));
      const host = new WindowsProcessHost({ repository });
      const result = await host.cleanupOrphans(records);
      expect(result.ended.map((p) => p.pid)).toEqual([orphan!.pid]);
      expect(result.gone.map((p) => p.pid)).toEqual([stranger!.pid, 4_000_000]);
      expect(await waitUntil(() => !isAlive(orphan!))).toBe(true);
      expect(isAlive(stranger!)).toBe(true);
      expect((await repository.listLive()).length).toBe(0);
    } finally {
      for (const p of spawned) p.kill();
    }
  });
});

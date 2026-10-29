// WindowsProcessHost against real Job Objects (spike job-test.mjs, job-session-test.mjs): two sessions at
// once, closing A's Job leaves B running; killing the host process ends every recorded process; start-up
// cleanup ends only records whose PID and creation time both still match. The tests end only processes
// they started, through their own handles.
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnedProcess, SessionId } from '../../contracts';
import type { OwnedProcessRepository } from '../../core/ports/repository';
import { type HostNative, WindowsProcessHost } from './host';
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

describe('WindowsProcessHost Job scan (simulated kernel32)', () => {
  it('skips a listed PID that another process took over before it was opened', async () => {
    const opened: bigint[] = [];
    const closed: bigint[] = [];
    // PID 100 is the runtime host. PID 200 was in the Job when the list was read, then exited, and an
    // outside process got the PID before it was opened: its handle is not in the Job.
    const native: HostNative = {
      createKillOnCloseJob: () => 1n,
      terminateJob: () => undefined,
      jobProcessIds: () => [100, 200],
      openProcess: (pid) => (opened.push(BigInt(pid)), BigInt(pid)),
      isProcessInJob: (handle, job) => job === 1n && handle === 100n,
      creationTime: (handle) => Number(handle) * 1000,
      imagePath: () => 'C:\tools\node.exe',
      exitCodeOf: () => undefined,
      terminateProcess: () => true,
      closeHandle: (handle) => void closed.push(handle),
    };
    const launch = () => Object.assign(new EventEmitter(), { pid: 100, startedAt: 100_000 }) as unknown as JobChild;
    const { rows, repository } = memoryRepository();
    const host = new WindowsProcessHost({ repository, native, launch });
    host.spawn(A, 'codex', { command: 'codex.exe' });

    expect((await host.listOwned(A)).map((p) => p.pid)).toEqual([100]);
    expect(rows.map((r) => [r.pid, r.kind])).toEqual([[100, 'runtime-host']]);
    expect(opened.sort()).toEqual(closed.filter((h) => h !== 1n).sort());
  });
});

describe('T021 Job members on the real machine (simulated kernel32)', () => {
  /** A Job with the runtime host (PID 100) and whatever `members` lists; `images` names each PID's file. */
  const simulated = (members: number[], images: Record<number, string>) => {
    const native: HostNative = {
      createKillOnCloseJob: () => 1n,
      terminateJob: () => undefined,
      jobProcessIds: () => members,
      openProcess: (pid) => (members.includes(pid) ? BigInt(pid) : undefined),
      isProcessInJob: (handle, job) => job === 1n && members.includes(Number(handle)),
      creationTime: (handle) => Number(handle) * 1000,
      imagePath: (handle) => images[Number(handle)] ?? 'C:/tools/node.exe',
      exitCodeOf: (handle) => (members.includes(Number(handle)) ? undefined : 0),
      terminateProcess: () => true,
      closeHandle: () => undefined,
    };
    const launch = () => Object.assign(new EventEmitter(), { pid: 100, startedAt: 100_000 }) as unknown as JobChild;
    const { rows, repository } = memoryRepository();
    const host = new WindowsProcessHost({ repository, native, launch });
    host.spawn(A, 'codex', { command: 'codex.exe' });
    return { host, rows };
  };
  const images = {
    // Forward slashes, so the file names are found on any CI platform's path module.
    100: 'C:/Users/u/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',
    200: 'C:/Windows/System32/conhost.exe',
    300: 'C:/Users/u/.codex/packages/standalone/releases/0.160.0-x86_64-pc-windows-msvc/bin/codex-code-mode-host.exe',
    400: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  };

  it("T021 Codex's resident codex-code-mode-host is a helper, not a command, so exiting does not warn of it", async () => {
    const { host } = simulated([100, 200, 300, 400], images);
    const kinds = Object.fromEntries((await host.listOwned(A)).map((p) => [p.pid, p.kind]));
    expect(kinds).toEqual({ 100: 'runtime-host', 200: 'helper', 300: 'helper', 400: 'command' });
  });

  it('T021 processes that exited before their Job was ended (a graceful close) are recorded as ended too', async () => {
    const members = [100, 200, 300, 400];
    const { host, rows } = simulated(members, images);
    expect((await host.listOwned(A)).length).toBe(4);
    // Closing stdin let the app-server end itself and everything it ran.
    members.splice(0, members.length);
    expect(await host.closeJob(A)).toEqual({ ended: [] });
    expect(rows.map((r) => [r.pid, r.endedAt !== undefined])).toEqual([
      [100, true],
      [200, true],
      [300, true],
      [400, true],
    ]);
  });
});

describe('t021-r1-P2-1 a PID reused inside a Job is another process (simulated kernel32)', () => {
  it("t021-r1-P2-1 the reviewer's case: PID 200 at A exits, PID 200 at B appears; closing marks both ended", async () => {
    const members = [100, 200];
    const created: Record<number, number> = { 100: 100_000, 200: 200_000 };
    const native: HostNative = {
      createKillOnCloseJob: () => 1n,
      terminateJob: () => undefined,
      jobProcessIds: () => members,
      openProcess: (pid) => (members.includes(pid) ? BigInt(pid) : undefined),
      isProcessInJob: (handle, job) => job === 1n && members.includes(Number(handle)),
      creationTime: (handle) => created[Number(handle)]!,
      imagePath: () => 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      exitCodeOf: (handle) => (members.includes(Number(handle)) ? undefined : 0),
      terminateProcess: () => true,
      closeHandle: () => undefined,
    };
    const launch = () => Object.assign(new EventEmitter(), { pid: 100, startedAt: 100_000 }) as unknown as JobChild;
    const { rows, repository } = memoryRepository();
    const host = new WindowsProcessHost({ repository, native, launch });
    host.spawn(A, 'codex', { command: 'codex.exe' });

    expect((await host.listOwned(A)).map((p) => [p.pid, p.startedAt])).toEqual([
      [100, new Date(100_000).toISOString()],
      [200, new Date(200_000).toISOString()],
    ]);
    // The first PID 200 exits and the OS hands the PID to a new command in the same Job.
    created[200] = 300_000;
    expect((await host.listOwned(A)).map((p) => [p.pid, p.startedAt])).toEqual([
      [100, new Date(100_000).toISOString()],
      [200, new Date(300_000).toISOString()],
    ]);
    members.splice(0, members.length);
    await host.closeJob(A);
    expect(rows.map((r) => [r.pid, r.startedAt, r.endedAt !== undefined])).toEqual([
      [100, new Date(100_000).toISOString(), true],
      [200, new Date(200_000).toISOString(), true],
      [200, new Date(300_000).toISOString(), true],
    ]);
  });
});

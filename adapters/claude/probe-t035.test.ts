// T035 (T021 report §3 item 7): every model-listing probe left an empty scratch folder in
// `%TEMP%\claude\<cwd>\<uuid>\scratchpad`, and a wildcard cleanup once removed other programs' folders there.
// The probe now runs in a fixed folder, gives its claude.exe a temp folder of its own (CLAUDE_CODE_TMPDIR) and
// removes exactly that folder by its path once that claude.exe has exited (r1: not when the SDK's stream ends).
// The fake CLI makes the scratch folder the way the real one does, under the temp folder it was given.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TMPDIR_ENV, type ClaudeAdapterOptions, PROBE_SESSION_ID } from './adapter';
import { FakeProcess } from './testing/fake-process';
import type { FakeQuery } from './testing/fake-sdk';
import { setup, started, until } from './testing/harness';

/**
 * The fake SDK starts claude.exe through the probe's spawn when the query is made, as the SDK does. With
 * `exitOnClose` the process exits a moment after close(); otherwise it lives until the test ends it. Without
 * `ownSpawn` the adapter picks its spawn itself (spawnProcess, as the GUI gives it).
 */
const probeSetup = (options: Partial<ClaudeAdapterOptions>, exitOnClose = true, ownSpawn = true) => {
  const processes: FakeProcess[] = [];
  const h = setup({
    ...(ownSpawn && {
      spawnProbe: () => {
        const p = new FakeProcess();
        processes.push(p);
        return p;
      },
    }),
    ...options,
  });
  const query = h.sdk.query.bind(h.sdk);
  h.sdk.query = (params) => {
    const q = query(params);
    const child = params.options.spawnClaudeCodeProcess?.({ command: 'claude.exe', args: [], cwd: params.options.cwd, env: params.options.env ?? {}, signal: new AbortController().signal });
    if (exitOnClose && child instanceof FakeProcess) {
      const close = q.close.bind(q);
      q.close = () => {
        close();
        setTimeout(() => child.exit(), 5);
      };
    }
    return q;
  };
  return { h, processes };
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'awg-t035-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const MODELS = [{ value: 'sonnet', displayName: 'Sonnet' }];
const tempOf = (q: FakeQuery) => q.options.env?.[CLI_TMPDIR_ENV];
/** What Claude Code makes in the temp folder it was given. */
const makeScratch = (q: FakeQuery) => {
  const temp = tempOf(q);
  if (temp === undefined) throw new Error('the probe gave its CLI no temp folder');
  mkdirSync(join(temp, 'claude', 'C--probe', '9f1c2d3e-4b5a-4c6d-8e7f-001122334455', 'scratchpad'), { recursive: true });
};

describe('T035 the model-listing probe cleans up after itself', () => {
  it('T035 runs in its fixed folder, and its own temp folder there is removed by its path; nothing else is touched', async () => {
    const probeCwd = join(root, 'probe');
    // Someone else's scratch folder, as in %TEMP%\claude, and things already in the probe folder.
    const others = [join(root, 'claude', 'C--Users-u-AppData-Local-Temp-claude-sandbox-status-abc'), join(probeCwd, 'keep'), join(probeCwd, 'tmp-other')];
    for (const folder of others) mkdirSync(folder, { recursive: true });
    const h = setup({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.onSupportedModels = makeScratch;
    await h.adapter.start();

    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    const q = h.sdk.last;
    const temp = tempOf(q)!;
    expect(q.options.cwd).toBe(probeCwd);
    expect(dirname(temp)).toBe(probeCwd);
    expect(q.options.env?.PATH).toBe(process.env.PATH);
    expect(q.closed).toBe(true);
    expect(existsSync(temp)).toBe(false);
    for (const folder of others) expect(existsSync(folder)).toBe(true);
    expect(readdirSync(probeCwd).sort()).toEqual(['keep', 'tmp-other']);
  });

  it('T035 makes the fixed folder when it is missing', async () => {
    const probeCwd = join(root, 'a', 'b');
    const h = setup({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    await h.adapter.listModels();
    expect(h.sdk.last.options.cwd).toBe(probeCwd);
    expect(readdirSync(probeCwd)).toEqual([]);
  });

  it('T035 two probes at once each remove their own folder only', async () => {
    const probeCwd = join(root, 'probe');
    const h = setup({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.onSupportedModels = makeScratch;
    await h.adapter.start();
    await Promise.all([h.adapter.listModels(), h.adapter.listModels()]);
    const temps = h.sdk.queries.map(tempOf);
    expect(new Set(temps).size).toBe(2);
    for (const temp of temps) expect(existsSync(temp!)).toBe(false);
    expect(readdirSync(probeCwd)).toEqual([]);
  });

  it('T035 with its claude.exe started by the probe, the folder goes once that process exits', async () => {
    const probeCwd = join(root, 'probe');
    const { h, processes } = probeSetup({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.onSupportedModels = makeScratch;
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    expect(processes).toHaveLength(1);
    expect(processes[0]!.exitCode).toBe(0);
    expect(existsSync(tempOf(h.sdk.last)!)).toBe(false);
    expect(readdirSync(probeCwd)).toEqual([]);
  });

  it('T035 a failed removal is only logged: the models are still returned', async () => {
    const h = setup({ probeCwd: join(root, 'probe'), removeFolder: () => Promise.reject(new Error('EBUSY')) });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    expect(h.logs).toContain('warn: listModels: could not remove the probe temp folder');
  });

  it('T035 a probe that fails still removes its folder', async () => {
    const probeCwd = join(root, 'probe');
    const h = setup({ probeCwd, startTimeoutMs: 20 });
    await h.adapter.start();
    // A CLI that never answers.
    const original = h.sdk.query.bind(h.sdk);
    h.sdk.query = (params) => {
      const q = original(params);
      q.supportedModels = () => {
        makeScratch(q);
        return new Promise(() => undefined);
      };
      return q;
    };
    await expect(h.adapter.listModels()).rejects.toThrow(/did not answer/);
    expect(existsSync(tempOf(h.sdk.last)!)).toBe(false);
    expect(readdirSync(probeCwd)).toEqual([]);
  });

  it('T035 a fixed folder that cannot be made: the probe still runs, in the OS temp folder as before', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    const removed: string[] = [];
    const h = setup({ probeCwd: join(file, 'probe'), removeFolder: (path) => Promise.resolve(void removed.push(path)) });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    expect(h.sdk.last.options.cwd).toBe(tmpdir());
    expect(h.sdk.last.options.env).toBeUndefined();
    expect(removed).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('warn: listModels: could not make the probe folder'))).toBe(true);
  });

  it('T035 with a session open there is no probe and no folder', async () => {
    const probeCwd = join(root, 'probe');
    const h = await started({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.listModels();
    expect(h.sdk.queries).toHaveLength(1);
    expect(existsSync(probeCwd)).toBe(false);
  });
});

describe('T035 r1 P1 the folder is removed only after claude.exe has exited, never before', () => {
  it("t035-r1-P1 the reviewer's case: the stream never ends and the process stays: nothing is removed after the wait", async () => {
    const removed: string[] = [];
    const { h, processes } = probeSetup({ probeCwd: join(root, 'probe'), probeExitTimeoutMs: 30, removeFolder: (path) => Promise.resolve(void removed.push(path)) }, false);
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.closeEnds = false;
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual([]);
    expect(h.logs).toContain('warn: listModels: the probe CLI has not exited; it is ended, and its temp folder removed once it exits');
    // r2: it is ended (this process only); this one does not go at once.
    expect(processes[0]!.kills).toBe(1);
    // When it does exit, its own folder goes, by its path.
    processes[0]!.exit();
    await until(() => removed.length === 1, 'removal after the exit');
    expect(removed).toEqual([tempOf(h.sdk.last)]);
  });

  it('t035-r1-P1 the stream has ended but the process is still alive: not removed until it exits', async () => {
    const removed: string[] = [];
    const { h, processes } = probeSetup({ probeCwd: join(root, 'probe'), removeFolder: (path) => Promise.resolve(void removed.push(path)) }, false);
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    let done = false;
    const listing = h.adapter.listModels().then((models) => {
      done = true;
      return models;
    });
    await until(() => h.sdk.queries.length === 1 && h.sdk.last.closed, 'probe closed');
    // close() ended the SDK stream (closeEnds), as the SDK does after its grace period.
    await new Promise((r) => setTimeout(r, 30));
    expect(removed).toEqual([]);
    expect(done).toBe(false);
    processes[0]!.exit();
    expect(await listing).toMatchObject([{ model: 'sonnet' }]);
    expect(removed).toEqual([tempOf(h.sdk.last)]);
  });

  it('t035-r1-P1 a claude.exe that could not be started: removed at once', async () => {
    const probeCwd = join(root, 'probe');
    const { h } = probeSetup({
      probeCwd,
      probeExitTimeoutMs: 1000,
      spawnProbe: () => {
        const p = new FakeProcess();
        setTimeout(() => p.emit('error', Object.assign(new Error('spawn claude.exe ENOENT'), { code: 'ENOENT', syscall: 'spawn claude.exe' })), 1);
        return p;
      },
    });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    const started = Date.now();
    await h.adapter.listModels();
    expect(Date.now() - started).toBeLessThan(500);
    expect(readdirSync(probeCwd)).toEqual([]);
  });
});

describe('T035 r1 P2 a query that cannot even be made still removes the folder', () => {
  it('t035-r1-P2 the SDK throws while making the query: the error stands and the folder is gone', async () => {
    const probeCwd = join(root, 'probe');
    const h = setup({ probeCwd });
    h.sdk.query = () => {
      throw new Error('synchronous startup failure');
    };
    await h.adapter.start();
    await expect(h.adapter.listModels()).rejects.toThrow('synchronous startup failure');
    expect(readdirSync(probeCwd)).toEqual([]);
  });

  it('t035-r1-P2 the probe spawn throws: the error stands and the folder is gone', async () => {
    const probeCwd = join(root, 'probe');
    const { h } = probeSetup({
      probeCwd,
      spawnProbe: () => {
        throw new Error('spawn failed');
      },
    });
    await h.adapter.start();
    await expect(h.adapter.listModels()).rejects.toThrow('spawn failed');
    expect(readdirSync(probeCwd)).toEqual([]);
  });
});

describe('T035 r2 P1 a probe claude.exe is managed like a session one, and the GUI closing ends it', () => {
  it('t035-r2-P1 with spawnProcess given (the GUI), the probe starts its claude.exe through it, in the probe Job', async () => {
    const jobs: string[] = [];
    const processes: FakeProcess[] = [];
    const { h } = probeSetup({
      probeCwd: join(root, 'probe'),
      spawnProcess: ({ sessionId }) => {
        jobs.push(sessionId);
        return () => {
          const p = new FakeProcess();
          processes.push(p);
          return p;
        };
      },
    }, true, false);
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    expect(await h.adapter.listModels()).toMatchObject([{ model: 'sonnet' }]);
    expect(jobs).toEqual([PROBE_SESSION_ID]);
    expect(processes).toHaveLength(1);
    expect(readdirSync(join(root, 'probe'))).toEqual([]);
  });

  it("t035-r2-P1 the reviewer's case: two probes still running after the wait; close() ends both, and each folder goes once its process exited", async () => {
    const probeCwd = join(root, 'probe');
    const { h, processes } = probeSetup({ probeCwd, probeExitTimeoutMs: 30 }, false);
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.closeEnds = false;
    h.sdk.behaviour.onSupportedModels = makeScratch;
    await h.adapter.start();
    await Promise.all([h.adapter.listModels(), h.adapter.listModels()]);
    const temps = h.sdk.queries.map(tempOf);
    expect(processes).toHaveLength(2);
    // Ended once after the wait, but these ones did not go.
    for (const p of processes) expect(p.kills).toBe(1);
    for (const temp of temps) expect(existsSync(temp!)).toBe(true);
    for (const p of processes) p.exitOnKill = true;

    expect(await h.adapter.close(1000)).toEqual({ forced: false });
    for (const p of processes) expect(p.kills).toBe(2);
    for (const p of processes) expect(p.exitCode).toBe(1);
    for (const temp of temps) expect(existsSync(temp!)).toBe(false);
    expect(readdirSync(probeCwd)).toEqual([]);
    for (const p of processes) expect([p.listenerCount('exit'), p.listenerCount('error')]).toEqual([0, 0]);
  });

  it('t035-r2-P1 close() ends a probe still waiting for its answer, and removes its folder after the exit', async () => {
    const probeCwd = join(root, 'probe');
    const { h, processes } = probeSetup({ probeCwd, startTimeoutMs: 200 }, false);
    const original = h.sdk.query.bind(h.sdk);
    h.sdk.query = (params) => {
      const q = original(params);
      q.supportedModels = () => new Promise(() => undefined);
      return q;
    };
    await h.adapter.start();
    const listing = h.adapter.listModels();
    await until(() => processes.length === 1, 'probe started');
    processes[0]!.exitOnKill = true;
    expect(await h.adapter.close(1000)).toEqual({ forced: false });
    expect(processes[0]!.kills).toBe(1);
    expect(readdirSync(probeCwd)).toEqual([]);
    await expect(listing).rejects.toThrow(/did not answer/);
  });

  it('t035-r2-P1 a kill that fails: close() reports forced, drops its listeners, leaves its folder and logs it', async () => {
    const probeCwd = join(root, 'probe');
    const removed: string[] = [];
    const { h, processes } = probeSetup({ probeCwd, probeExitTimeoutMs: 20, removeFolder: (path) => Promise.resolve(void removed.push(path)) }, false);
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.onSupportedModels = () => {
      processes[0]!.killWorks = false;
    };
    await h.adapter.start();
    await h.adapter.listModels();
    const p = processes[0]!;
    expect(await h.adapter.close(30)).toEqual({ forced: true });
    expect(h.logs).toContain('warn: listModels: could not end the probe CLI');
    expect(h.logs).toContain('warn: close: could not end a probe CLI');
    expect(h.logs).toContain('warn: close: a probe CLI did not exit; its temp folder is left');
    expect([p.listenerCount('exit'), p.listenerCount('error')]).toEqual([0, 0]);
    expect(removed).toEqual([]);
    // Nothing is left waiting on it: a late exit removes nothing, and a second close has nothing to end.
    p.exit();
    await new Promise((r) => setTimeout(r, 10));
    expect(removed).toEqual([]);
    expect(await h.adapter.close(30)).toEqual({ forced: false });
    expect(p.kills).toBe(2);
  });

  it('T043 a second close() does not wait again for a folder removal the first one already waited for', async () => {
    const probeCwd = join(root, 'probe');
    let removals = 0;
    const { h } = probeSetup({
      probeCwd,
      probeExitTimeoutMs: 20,
      removeFolder: () => {
        removals += 1;
        return new Promise<void>(() => undefined); // never finishes: the folder is held
      },
    });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    await h.adapter.listModels();
    expect(removals).toBe(1);
    const first = Date.now();
    expect(await h.adapter.close(150)).toEqual({ forced: false }); // the process had exited: waited, not forced
    expect(Date.now() - first).toBeGreaterThanOrEqual(120);
    const second = Date.now();
    expect(await h.adapter.close(2000)).toEqual({ forced: false });
    expect(Date.now() - second).toBeLessThan(500);
    expect(removals).toBe(1); // not asked again either
  });

  it('t035-r2-P1 a probe whose folder could not be made is ended by close() too', async () => {
    const file = join(root, 'a-file');
    writeFileSync(file, '');
    const { h, processes } = probeSetup({ probeCwd: join(file, 'probe'), probeExitTimeoutMs: 20 }, false);
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    await h.adapter.listModels();
    expect(processes).toHaveLength(1);
    processes[0]!.exitOnKill = true;
    expect(await h.adapter.close(1000)).toEqual({ forced: false });
    expect(processes[0]!.exitCode).toBe(1);
  });
});

describe('T035 r2 no probe is started once the adapter is closing', () => {
  it('t035-r2 listModels after close() is refused: no claude.exe, no folder', async () => {
    const probeCwd = join(root, 'probe');
    const { h, processes } = probeSetup({ probeCwd });
    h.sdk.behaviour.models = MODELS;
    await h.adapter.start();
    await h.adapter.close();
    await expect(h.adapter.listModels()).rejects.toThrow(/closing/);
    expect(h.sdk.queries).toHaveLength(0);
    expect(processes).toHaveLength(0);
    expect(existsSync(probeCwd)).toBe(false);
  });
});

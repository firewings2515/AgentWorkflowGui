// T035 (T021 report §3 item 7): every model-listing probe left an empty scratch folder in
// `%TEMP%\claude\<cwd>\<uuid>\scratchpad`, and a wildcard cleanup once removed other programs' folders there.
// The probe now runs in a fixed folder, gives its claude.exe a temp folder of its own (CLAUDE_CODE_TMPDIR) and
// removes exactly that folder by its path once that claude.exe has exited (r1: not when the SDK's stream ends).
// The fake CLI makes the scratch folder the way the real one does, under the temp folder it was given.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TMPDIR_ENV, type ClaudeAdapterOptions } from './adapter';
import type { FakeQuery } from './testing/fake-sdk';
import { setup, started, until } from './testing/harness';
import type { WireSpawnedProcess } from './wire';

/** A claude.exe that exits when the test says so. */
class FakeProcess extends EventEmitter implements WireSpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/**
 * The fake SDK starts claude.exe through the probe's spawn when the query is made, as the SDK does. With
 * `exitOnClose` the process exits a moment after close(); otherwise it lives until the test ends it.
 */
const probeSetup = (options: Partial<ClaudeAdapterOptions>, exitOnClose = true) => {
  const processes: FakeProcess[] = [];
  const h = setup({
    spawnProbe: () => {
      const p = new FakeProcess();
      processes.push(p);
      return p;
    },
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
    expect(h.logs).toContain('warn: listModels: the probe CLI has not exited; its temp folder is removed once it does');
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

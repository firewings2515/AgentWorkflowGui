// T035 (T021 report §3 item 7): every model-listing probe left an empty scratch folder in
// `%TEMP%\claude\<cwd>\<uuid>\scratchpad`, and a wildcard cleanup once removed other programs' folders there.
// The probe now runs in a fixed folder, gives its claude.exe a temp folder of its own (CLAUDE_CODE_TMPDIR) and
// removes exactly that folder by its path after the CLI has ended. The fake CLI makes the scratch folder the
// way the real one does, under the temp folder it was given.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_TMPDIR_ENV } from './adapter';
import type { FakeQuery } from './testing/fake-sdk';
import { setup, started, until } from './testing/harness';

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

  it('T035 the folder is removed only after the CLI has ended', async () => {
    const removed: string[] = [];
    const h = setup({ probeCwd: join(root, 'probe'), removeFolder: (path) => Promise.resolve(void removed.push(path)) });
    h.sdk.behaviour.models = MODELS;
    h.sdk.behaviour.closeEnds = false;
    await h.adapter.start();
    let done = false;
    const listing = h.adapter.listModels().then((models) => {
      done = true;
      return models;
    });
    await until(() => h.sdk.queries.length === 1 && h.sdk.last.closed, 'probe closed');
    await new Promise((r) => setTimeout(r, 20));
    expect(removed).toEqual([]);
    expect(done).toBe(false);
    h.sdk.last.end();
    expect(await listing).toMatchObject([{ model: 'sonnet' }]);
    expect(removed).toEqual([tempOf(h.sdk.last)]);
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

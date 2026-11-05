// T063 r1 P1: the starter set is written in ONE transaction on SQLite. A failure after the Agents were inserted (the
// injected fault fires after every row, before the commit; an invalid template after valid Agents) leaves no Agent, no
// template and no mark, and the next first start adds all of it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTER_WORKFLOW_ID } from '../../contracts';
import { installStarter, STARTER_MARKER, starterSet } from '../../core/workflow/starter';
import { openDatabase } from './database';
import { createRepositories } from './repositories';
import { InjectedStorageFaults } from './testing/storage-faults';

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t063-seed-'));
  db = openDatabase(join(dir, 'awg.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  // Only the temporary directory this test made.
  rmSync(dir, { recursive: true, force: true });
});

const now = '2026-11-06T00:00:00.000Z';
const nothingStored = async (repos: ReturnType<typeof createRepositories>) => {
  expect(await repos.agents.list()).toEqual([]);
  expect(await repos.workflows.list()).toEqual([]);
  expect(await repos.markers.has(STARTER_MARKER)).toBe(false);
};

describe('T063 the starter set in one transaction (SQLite)', () => {
  it('a write failure after the Agents leaves nothing; the next first start adds all of it', async () => {
    const faults = new InjectedStorageFaults(db);
    const repos = createRepositories(db);
    faults.failNextWrite('io');
    await expect(installStarter(repos, { models: [], now, mode: 'first-start' })).rejects.toThrow();
    await nothingStored(repos);
    const again = await installStarter(repos, { models: [], now, mode: 'first-start' });
    expect(again.added).toHaveLength(4);
    expect(again.workflow?.id).toBe(STARTER_WORKFLOW_ID);
    expect((await repos.agents.list()).map((a) => a.revision)).toEqual([0, 0, 0]);
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
  });

  it('r1 repro: workflows.save failing after the Agents can no longer leave half of it (the seed never uses it)', async () => {
    const repos = createRepositories(db);
    const save = repos.workflows.save.bind(repos.workflows);
    repos.workflows.save = () => Promise.reject(new Error('injected:workflows.save'));
    const installed = await installStarter(repos, { models: [], now, mode: 'first-start' });
    expect(installed.added).toHaveLength(4);
    expect((await repos.workflows.list()).map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
    repos.workflows.save = save;
  });

  it('an invalid template after valid Agents rolls the Agents back', async () => {
    const repos = createRepositories(db);
    const set = starterSet([], now);
    const broken = { ...set.workflow, nodes: [] } as unknown as typeof set.workflow;
    await expect(repos.seedDefinitions({ agents: set.agents, workflows: [broken], mark: { name: STARTER_MARKER, at: now } })).rejects.toThrow();
    await nothingStored(repos);
  });

  it('keeps what exists under a starter ID and stores only the rest; nothing new and marked already writes nothing', async () => {
    const repos = createRepositories(db);
    const set = starterSet([], now);
    const plan = set.agents[0]!;
    expect(await repos.agents.save({ ...plan, instructions: '自己的說明' }, null)).toMatchObject({ status: 'saved' });
    const added = await repos.seedDefinitions({ agents: set.agents, workflows: [set.workflow], mark: { name: STARTER_MARKER, at: now } });
    expect(added).toEqual([set.agents[1]!.id, set.agents[2]!.id, set.workflow.id]);
    expect(await repos.agents.get(plan.id)).toMatchObject({ instructions: '自己的說明' });
    expect(await repos.seedDefinitions({ agents: set.agents, workflows: [set.workflow], mark: { name: STARTER_MARKER, at: now } })).toEqual([]);
  });
});

// T070 r1 P2-4: a built-in template is added in ONE transaction on SQLite. The third of its Agents fails to insert (a
// trigger aborts it, after two were inserted in the same transaction): nothing of the template or its Agents is left, and
// the next add writes all of it. An injected failure before the commit, after every row, leaves nothing either.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_IDS, BUILTIN_WORKFLOW_IDS } from '../../contracts';
import { installBuiltin } from '../../core/workflow/builtin-templates';
import { openDatabase } from './database';
import { createRepositories } from './repositories';
import { InjectedStorageFaults } from './testing/storage-faults';

let dir: string;
let db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t070-seed-'));
  db = openDatabase(join(dir, 'awg.sqlite'));
});
afterEach(() => {
  if (db.isOpen) db.close();
  // Only the temporary directory this test made.
  rmSync(dir, { recursive: true, force: true });
});

const now = '2026-11-10T00:00:00.000Z';
const add = (repos: ReturnType<typeof createRepositories>) => installBuiltin(repos, { key: 'tdd', models: [], now });
const nothingStored = async (repos: ReturnType<typeof createRepositories>) => {
  expect(await repos.agents.list()).toEqual([]);
  expect(await repos.workflows.list()).toEqual([]);
};

describe('T070 a built-in template in one transaction (SQLite)', () => {
  it('the third Agent failing after two were inserted leaves none of it; the next add writes all of it', async () => {
    const repos = createRepositories(db);
    // The Agents go in the set's order (lead, tester, builder, verifier): the builder's insert is the third.
    db.exec(`CREATE TEMP TRIGGER t070_fail_third BEFORE INSERT ON agent WHEN NEW.id = '${BUILTIN_AGENT_IDS.tdd.builder}' BEGIN SELECT RAISE(ABORT, 'injected:third-agent'); END`);
    db.exec('CREATE TEMP TABLE t070_inserted (id TEXT)');
    db.exec('CREATE TEMP TRIGGER t070_count AFTER INSERT ON agent BEGIN INSERT INTO t070_inserted (id) VALUES (NEW.id); END');
    await expect(add(repos)).rejects.toThrow();
    await nothingStored(repos);
    // The two inserted before it were rolled back with the rest (the counting rows too: the same transaction).
    expect(db.prepare('SELECT count(*) AS n FROM t070_inserted').get()?.n).toBe(0);
    db.exec('DROP TRIGGER t070_fail_third');
    const again = await add(repos);
    expect(again.added).toHaveLength(5);
    expect(again.addedAgents).toHaveLength(4);
    expect(again.workflowAdded).toBe(true);
    expect((await repos.workflows.list()).map((w) => w.id)).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
    expect(db.prepare('SELECT count(*) AS n FROM t070_inserted').get()?.n).toBe(4);
  });

  it('a failure before the commit, after every row, leaves nothing; an Agent kept from before stays as it was', async () => {
    const repos = createRepositories(db);
    const first = await add(repos);
    expect(first.added).toHaveLength(5);
    expect(await repos.workflows.delete(BUILTIN_WORKFLOW_IDS.tdd, 0)).toBe('deleted');
    for (const id of [BUILTIN_AGENT_IDS.tdd.tester, BUILTIN_AGENT_IDS.tdd.builder]) expect(await repos.agents.delete(id, 0)).toBe('deleted');
    const faults = new InjectedStorageFaults(db);
    faults.failNextWrite('io');
    await expect(add(repos)).rejects.toThrow();
    expect((await repos.agents.list()).map((a) => a.id).sort()).toEqual([BUILTIN_AGENT_IDS.tdd.lead, BUILTIN_AGENT_IDS.tdd.verifier].sort());
    expect(await repos.workflows.list()).toEqual([]);
    const again = await add(repos);
    expect(again.addedAgents.sort()).toEqual([BUILTIN_AGENT_IDS.tdd.tester, BUILTIN_AGENT_IDS.tdd.builder].sort());
    expect(again.workflowAdded).toBe(true);
  });
});

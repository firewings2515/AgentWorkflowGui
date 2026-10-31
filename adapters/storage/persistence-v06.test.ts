import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HandoffId, Revision, TransferId, TransferProposal, WorkflowInstance } from '../../contracts';
import { fixtureSnapshot as fx } from '../../contracts/fixtures/snapshot';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import type { AppRepositories } from '../../core/ports';
import { InvalidRecordError, StoredDataError } from './codec';
import { openDatabase } from './database';
import { createRepositories } from './repositories';
import { at, op, provisionInput } from './testing/fixtures';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const sqlite = () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t029-persistence-'));
  const path = join(dir, 'app.sqlite');
  let db = openDatabase(path);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get db() { return db; }, reopen: () => { db.close(); db = openDatabase(path); return createRepositories(db); } };
};
const instances = (): WorkflowInstance[] => {
  const login = WorkflowInstance.parse({ ...fx.instances[0], revision: 0, taskLimit: 5 });
  const docs = WorkflowInstance.parse({ ...fx.instances[1], revision: 0 });
  const first = docs.rounds[0]!;
  docs.rounds.push({ ...first, round: 2, state: 'ready', arrived: first.expectedUpstream.map((fromNodeId, i) => ({ fromNodeId, handoffId: HandoffId.parse(`arrived-${i}`) })), settledAt: at() });
  for (const [i, blockedReason] of (['upstream-failed', 'upstream-cancelled', 'timeout'] as const).entries()) {
    docs.rounds.push({ ...first, round: i + 3, state: 'blocked', blockedReason, blockedUpstream: first.expectedUpstream[1], settledAt: at() });
  }
  return [WorkflowInstance.parse(login), WorkflowInstance.parse(docs)];
};
const ended = (instance: WorkflowInstance, state: 'completed' | 'cancelled') => WorkflowInstance.parse({
  ...instance, state, endedAt: at(30),
  tasks: instance.tasks.map((t) => ({ ...t, status: state, blockedReason: undefined, completedAt: state === 'completed' ? at(29) : undefined,
    worktree: t.worktree && { ...t.worktree, cleanup: 'removed' } })),
  mergeQueue: instance.mergeQueue.map((m) => ({ ...m, state: 'cancelled', endedAt: at(28) })),
});

describe.each(['memory', 'SQLite'] as const)('0.6 shared repository cases: %s', (adapter) => {
  const setup = () => {
    const disk = adapter === 'SQLite' ? sqlite() : undefined;
    let repos: AppRepositories = disk ? createRepositories(disk.db) : new MemoryRepositories();
    return { get repos() { return repos; }, reopen: () => { if (disk) repos = disk.reopen(); return repos; } };
  };

  it.each(['completed', 'cancelled'] as const)('rounds, merge queue, plans, task details and %s runs survive CAS and snapshot/reopen', async (state) => {
    const harness = setup();
    const expected = instances();
    const project = { ...fx.projects[0]!, revision: Revision.parse(0) };
    expect((await harness.repos.projects.save(project, null)).status).toBe('saved');
    for (const instance of expected) {
      expect(await harness.repos.instances.create(instance)).toBe('created');
      expect(await harness.repos.instances.create({ ...instance, title: 'must not replace' })).toBe('exists');
      expect(await harness.repos.instances.get(instance.id)).toEqual(instance);
    }
    let repos = harness.reopen();
    expect(await repos.instances.list()).toEqual(expected);
    expect((await repos.readSnapshotData()).instances).toEqual(expected);
    expect((await repos.readSnapshotData()).projects).toEqual([project]);
    const login = expected[0]!;
    const next = ended(login, state);
    const saved = { ...next, revision: Revision.parse(1) };
    expect(await repos.instances.update(next, Revision.parse(0))).toEqual({ status: 'saved', record: saved });
    expect(await repos.instances.update(login, Revision.parse(0))).toEqual({ status: 'stale', current: saved });
    repos = harness.reopen();
    expect(await repos.instances.get(login.id)).toEqual(saved);
    expect((await repos.readSnapshotData()).instances).toEqual([saved, expected[1]]);
  });

  it.each(['user', 'source-changed', 'failed'] as const)('cancelReason %s survives create/update, stale CAS and snapshot/reopen', async (cancelReason) => {
    const harness = setup();
    const draft = TransferProposal.parse({ ...fx.transfers[1], revision: 0, id: `cancel-${cancelReason}`, operationId: `cancel-op-${cancelReason}` });
    expect(await harness.repos.transfers.create(draft)).toBe('created');
    expect(await harness.repos.transfers.create({ ...draft, content: { ...draft.content, note: 'must not replace' } })).toBe('exists');
    const cancelled = TransferProposal.parse({ ...draft, revision: 1, state: 'cancelled', cancelledAt: at(), cancelReason });
    expect(await harness.repos.transfers.update(cancelled, Revision.parse(0))).toEqual({ status: 'saved', record: cancelled });
    expect(await harness.repos.transfers.update({ ...cancelled, cancelReason: 'user' }, Revision.parse(0))).toEqual({ status: 'stale', current: cancelled });
    await expect(harness.repos.transfers.update(cancelled, Revision.parse(1))).rejects.toBeInstanceOf(TypeError);
    const repos = harness.reopen();
    expect(await repos.transfers.get(draft.id)).toEqual(cancelled);
    expect(await repos.transfers.list()).toEqual([cancelled]);
    expect((await repos.readSnapshotData()).transfers).toEqual([cancelled]);
    // A proposal first persisted after cancellation also retains the new field.
    const createdCancelled = TransferProposal.parse({ ...cancelled, id: `created-${cancelReason}`, revision: 0, operationId: `created-op-${cancelReason}` });
    expect(await repos.transfers.create(createdCancelled)).toBe('created');
    expect(await harness.reopen().transfers.get(createdCancelled.id)).toEqual(createdCancelled);
  });

  it('retains cancellation reason and approval facts across the approval/acceptance gap', async () => {
    const harness = setup();
    const draft = TransferProposal.parse({ ...fx.transfers[1], revision: 0 });
    await harness.repos.transfers.create(draft);
    const approved = TransferProposal.parse({ ...draft, revision: 1, state: 'approved', approvedRevision: 1, approvedAt: at(), provision: provisionInput().target.provision });
    expect((await harness.repos.transfers.update(approved, Revision.parse(0))).status).toBe('saved');
    const cancelled = TransferProposal.parse({ ...approved, revision: 2, state: 'cancelled', cancelledAt: at(1), cancelReason: 'source-changed' });
    expect((await harness.repos.transfers.update(cancelled, Revision.parse(1))).status).toBe('saved');
    expect(await harness.reopen().transfers.get(draft.id)).toEqual(cancelled);
  });
});

describe('0.6 SQLite validation is atomic and fail closed', () => {
  it('rejects invalid new fields on writes without replacing a valid instance or proposal', async () => {
    const disk = sqlite();
    const repos = createRepositories(disk.db);
    const instance = instances()[0]!;
    await repos.instances.create(instance);
    await expect(repos.instances.update({ ...instance, state: 'completed', endedAt: at() }, Revision.parse(0))).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repos.instances.get(instance.id)).toEqual(instance);
    const draft = TransferProposal.parse({ ...fx.transfers[1], revision: 0, id: 'bad-cancel', operationId: op('bad-cancel') });
    await repos.transfers.create(draft);
    await expect(repos.transfers.update({ ...draft, revision: Revision.parse(1), cancelReason: 'user' }, Revision.parse(0))).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repos.transfers.get(draft.id)).toEqual(draft);
  });

  it.each(['workflow_instance', 'transfer_proposal'] as const)('damaged 0.6 %s fields fail get/list/snapshot without leaking values', async (table) => {
    const disk = sqlite();
    const repos = createRepositories(disk.db);
    const instance = instances()[0]!;
    const proposal = TransferProposal.parse({ ...fx.transfers[1], revision: 0 });
    await repos.instances.create(instance);
    await repos.transfers.create(proposal);
    const field = table === 'workflow_instance' ? '$.taskLimit' : '$.cancelReason';
    disk.db.prepare(`UPDATE ${table} SET body = json_set(body, ?, ?)`).run(field, 'SECRET-CONTENT');
    const reads = table === 'workflow_instance'
      ? [() => repos.instances.get(instance.id), () => repos.instances.list()]
      : [() => repos.transfers.get(TransferId.parse(proposal.id)), () => repos.transfers.list()];
    for (const read of [...reads, () => repos.readSnapshotData()]) {
      await expect(read()).rejects.toBeInstanceOf(StoredDataError);
      await expect(read()).rejects.not.toThrow('SECRET-CONTENT');
    }
  });
});

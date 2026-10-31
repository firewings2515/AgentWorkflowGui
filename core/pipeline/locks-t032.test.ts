// T032 live run 1 with T033's locks: a worktree run's task and resolver sessions are worktree work (their folder
// scope says `task-worktree`), so they take no locks; root's same-folder watch covers its whole folder, and the
// pipeline's own worktrees below it are skipped, so writes there open no `unlocked-write`.
import { describe, expect, it } from 'vitest';
import { type PayloadHash, type SessionId, TurnId } from '../../contracts';
import { hashOf } from '../delivery/testing/fixtures';
import { type LockEscalation, LockCoordinator } from '../locks';
import { ManualClock } from '../locks/testing/clock';
import { handoff, IMPL, INSTANCE, instanceOf, ROOT, started, world } from '../workflow/testing/harness';
import { integrationRef } from './naming';
import { createTasks, pipelineTemplate, project, until } from './testing/t032-cases';

const h = (n: number): PayloadHash => `sha256:${String(n).repeat(64).slice(0, 64)}`;

const run = async (isolation: 'worktree' | 'same-folder') => {
  const w = await world(pipelineTemplate({ isolation }));
  await w.repositories.projects.save(project(), null);
  await started(w);
  const made = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-locks');
  if (made.status !== 'created') throw new Error('not created');
  const taskId = made.tasks[0]!.taskId;
  await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId });
  const sessionId = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId });
  return { w, taskId, task: await w.repositories.sessions.get(sessionId!) };
};

const coordinator = (isIgnored?: (path: string) => boolean) => {
  const clock = new ManualClock('2026-10-31T00:00:00.000Z');
  const escalations: LockEscalation[] = [];
  let n = 0;
  const locks = new LockCoordinator({
    now: clock.now,
    setTimer: clock.setTimer,
    hashFile: () => h(++n),
    // As the harness resolves folders (and the session service did for the sessions' scopes).
    resolveRealPath: (p) => p.replace('E:\\work', 'E:\\real'),
    escalate: (e) => {
      escalations.push(e);
      return Promise.resolve(undefined);
    },
    publish: () => undefined,
    ...(isIgnored !== undefined && { isIgnored }),
  });
  return { locks, escalations };
};
const running = (sessionId: SessionId) => ({ type: 'turn.updated' as const, turn: { id: TurnId.parse(`turn-${sessionId}`), sessionId, state: 'running' as const, startedAt: '2026-10-31T00:00:00.000Z' } as never });

describe('T032 worktree sessions and the same-folder locks (T033)', () => {
  it('task and resolver sessions say task-worktree; root and same-folder task sessions stay session-cwd', async () => {
    const { w, task } = await run('worktree');
    expect(task?.folderScope.source).toBe('task-worktree');
    expect(LockCoordinator.sameFolder(task!)).toBe(false);
    const root = await w.repositories.sessions.get(ROOT);
    expect(root?.folderScope.source).toBe('session-cwd');
    // The resolver of a conflict is made the same way (pipeline.startResolver passes `worktree: true`).
    const same = await run('same-folder');
    expect(same.task?.folderScope.source).toBe('session-cwd');
    expect(LockCoordinator.sameFolder(same.task!)).toBe(true);
  });

  it('a write in a task worktree, seen by root\'s watch while root works, opens no unlocked-write; one in root\'s own folder still does', async () => {
    const { w, taskId, task } = await run('worktree');
    await until(async () => (await instanceOf(w)).tasks[0]?.worktree?.baseCommit !== undefined, 'worktree');
    const worktree = (await instanceOf(w)).tasks.find((t) => t.id === taskId)!.worktree!.path;
    const root = (await w.repositories.sessions.get(ROOT))!;
    const pipeline = w.engine.pipeline!;
    expect(pipeline.ownsPath(`${worktree}\\greet.js`)).toBe(true);
    expect(pipeline.ownsPath(worktree)).toBe(true);
    expect(pipeline.ownsPath(`${root.cwd}\\README.md`)).toBe(false);
    expect(pipeline.ownsPath(`${root.cwd}\\.awg\\wt\\t-someoneelse\\x.js`)).toBe(false);
    // An integration worktree is recorded once its attempt begins; one the pipeline never made is not.
    expect(pipeline.ownsPath((await integrationRef(hashOf, root.cwd, INSTANCE, taskId, 0)).path)).toBe(false);

    const watched = (ignore: boolean) => {
      const { locks, escalations } = coordinator(ignore ? (p) => pipeline.ownsPath(p) : undefined);
      locks.track(root);
      locks.track(task!);
      locks.observe(running(ROOT));
      locks.observe(running(task!.id));
      return { locks, escalations };
    };
    // Without the pipeline's folders skipped, root's same-folder watch takes the worktree write for its own.
    const before = watched(false);
    before.locks.fileChanged(ROOT, `${worktree}\\greet.js`);
    await Promise.resolve();
    expect(before.escalations.map((e) => e.kind)).toEqual(['unlocked-write']);
    // As wired (T032): nothing in the worktree, by either watch; a file of root's own folder still counts.
    const after = watched(true);
    after.locks.fileChanged(ROOT, `${worktree}\\greet.js`);
    after.locks.fileChanged(task!.id, `${worktree}\\node_modules\\.setup-done`);
    await Promise.resolve();
    expect(after.escalations).toEqual([]);
    after.locks.fileChanged(ROOT, `${root.cwd}\\README.md`);
    await Promise.resolve();
    expect(after.escalations.map((e) => e.kind)).toEqual(['unlocked-write']);
    // And a task-worktree session takes no lock for a write of its own.
    expect(after.locks.list()).toEqual([]);
  });
});

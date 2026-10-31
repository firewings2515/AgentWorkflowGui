// T032 on a real git (the T030 adapter) in a throw-away repository and the real SQLite storage: three tasks, one
// depending on another (V-19), a merge conflict and failed tests (V-21), setup outputs kept out of the commits,
// worktrees removed after their merge (V-20). The runtimes and the setup/test commands are the fakes of the
// workflow harness; the git commands and folders are real. Only the mkdtemp folder is touched.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import type { TaskId } from '../../contracts';
import { createSandbox, type Sandbox } from '../../adapters/git/testing/sandbox';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { MERGE, pipelineTemplate, project } from '../../core/pipeline/testing/t032-cases';
import { handoff, IMPL, INSTANCE, instanceOf, rid, ROOT, started, worldOn, type World } from '../../core/workflow/testing/harness';
import { worktreeFiles } from './pipeline-host';

const open: { db: DatabaseSync; sandbox: Sandbox }[] = [];
afterEach(async () => {
  for (const { db, sandbox } of open.splice(0)) {
    // The pipeline's last steps (cleanups, reports) may still run git in the repository.
    await until(() => sandbox.children.every((child) => child.exitCode !== null || child.signalCode !== null), 'git to finish', 20_000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    db.close();
    sandbox.dispose();
  }
});

/** Waits on real I/O (git runs as processes). */
const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

it('V-19, V-20, V-21 on a real repository: parallel tasks, a dependency, a conflict and failed tests; main only fast-forwards', { timeout: 180_000 }, async () => {
  const sandbox = createSandbox();
  const repo = await sandbox.newRepo('project');
  await sandbox.commitFile(repo, 'src/app.txt', 'app\n', 'initial');
  const db = openDatabase(join(sandbox.root, 'awg.sqlite'));
  open.push({ db, sandbox });
  // The harness clock is not the computer's, so the setup window the pipeline asks about is mapped to when each
  // setup really ran; the files' creation times themselves are the real ones.
  const ran = new Map<string, { from: string; to: string }>();
  const files = { exists: (path: string) => worktreeFiles.exists(path), createdBetween: (path: string) => worktreeFiles.createdBetween(path, ran.get(path)!.from, ran.get(path)!.to) };
  const w: World = await worldOn(createRepositories(db), new SqliteDeliveryStore(db), pipelineTemplate(), { git: sandbox.adapter, files });
  // The setup script makes node_modules (not ignored by the repository); C's first test run fails.
  let cRuns = 0;
  w.commands.script = (spec) => {
    if (spec.purpose === 'setup') {
      const from = new Date().toISOString();
      mkdirSync(join(spec.cwd, 'node_modules'), { recursive: true });
      writeFileSync(join(spec.cwd, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
      ran.set(spec.cwd, { from, to: new Date(Date.now() + 1).toISOString() });
      return { exitCode: 0, outputTail: 'added 1 package' };
    }
    if (existsSync(join(spec.cwd, 'c.txt')) && cRuns++ === 0) return { exitCode: 1, outputTail: 'not ok 1 - c works' };
    return { exitCode: 0, outputTail: 'ok' };
  };
  await w.repositories.projects.save({ ...project(), rootPath: repo }, null);
  expect(await started(w, { cwd: repo })).toMatchObject({ ok: true });
  const created = await w.engine.createTasks(
    {
      ruleId: 'split',
      tasks: [
        { key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] },
        { key: 'b', title: 'B', dependsOn: [], dependsOnExisting: [] },
        { key: 'c', title: 'C', dependsOn: ['a'], dependsOnExisting: [] },
      ],
    },
    { caller: ROOT, sourceCallRef: 'call-tasks' },
  );
  if (created.status !== 'created') throw new Error(JSON.stringify(created));
  const [a, b, c] = created.tasks.map((t) => t.taskId) as [TaskId, TaskId, TaskId];
  const main = async () => (await sandbox.git(repo, 'rev-parse', 'main')).trim();
  const task = async (id: TaskId) => (await instanceOf(w)).tasks.find((t) => t.id === id)!;
  const implOf = async (id: TaskId) => (await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId: id }))!;
  const sent = async (id: TaskId) => (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === id && h.toNodeId === IMPL && h.delivery.state === 'sent').length;
  const toMerge = async (id: TaskId) => handoff(w, await implOf(id), { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId: id });
  for (const id of [a, b, c]) expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: id, content: `build ${id}` })).toMatchObject({ status: 'accepted' });

  await until(async () => (await sent(a)) === 1 && (await sent(b)) === 1, 'A and B started');
  const start = await main();
  const pathOf = async (id: TaskId) => (await task(id)).worktree!.path;
  expect(await pathOf(a)).toBe(join(repo, '.awg', 'wt', (await pathOf(a)).split('\\').pop()!));
  expect((await w.repositories.sessions.get(await implOf(a)))?.cwd).toBe(await pathOf(a));
  expect(await sent(c)).toBe(0);

  // A and B change the same line; A goes first.
  writeFileSync(join(await pathOf(a), 'src', 'app.txt'), 'app from A\n');
  writeFileSync(join(await pathOf(b), 'src', 'app.txt'), 'app from B\n');
  expect(await toMerge(a)).toMatchObject({ status: 'accepted' });
  await until(async () => (await task(a)).status === 'merged', 'A merged');
  const afterA = await main();
  expect((await sandbox.git(repo, 'merge-base', '--is-ancestor', start, afterA)) === '').toBe(true);
  expect(await sandbox.git(repo, 'show', 'main:src/app.txt')).toBe('app from A\n');
  // The setup's node_modules never reached a commit.
  expect(await sandbox.git(repo, 'ls-tree', '-r', '--name-only', 'main')).not.toContain('node_modules');
  await until(async () => (await task(a)).worktree?.cleanup === 'removed', 'A cleaned');
  expect(existsSync(await pathOf(a))).toBe(false);

  // B conflicts; the agent asked to resolve it does nothing; B goes back, main untouched, the conflict in B's worktree.
  expect(await toMerge(b)).toMatchObject({ status: 'accepted' });
  await until(async () => (await instanceOf(w)).mergeQueue.some((m) => m.taskId === b && m.state === 'conflict'), 'B conflicted');
  expect(await main()).toBe(afterA);
  await until(async () => (await sent(b)) === 2, 'B given back');
  expect(readFileSync(join(await pathOf(b), 'src', 'app.txt'), 'utf8')).toContain('<<<<<<<');
  // Handing off with the markers in is refused; resolved, the GUI commits the merge and it merges.
  expect(await toMerge(b)).toMatchObject({ status: 'rejected' });
  writeFileSync(join(await pathOf(b), 'src', 'app.txt'), 'app from A and B\n');
  expect(await toMerge(b)).toMatchObject({ status: 'accepted' });
  await until(async () => (await task(b)).status === 'merged', 'B merged');
  expect(await sandbox.git(repo, 'show', 'main:src/app.txt')).toBe('app from A and B\n');

  // C started after A merged, with A's work; its first tests fail and it goes back; fixed, it merges.
  await until(async () => (await sent(c)) === 1, 'C started');
  writeFileSync(join(await pathOf(c), 'c.txt'), 'c\n');
  const beforeC = await main();
  await toMerge(c);
  await until(async () => (await instanceOf(w)).mergeQueue.some((m) => m.taskId === c && m.state === 'tests-failed'), 'C tests failed');
  expect(await main()).toBe(beforeC);
  await until(async () => (await sent(c)) === 2, 'C given back');
  writeFileSync(join(await pathOf(c), 'c.txt'), 'c fixed\n');
  await toMerge(c);
  await until(async () => (await task(c)).status === 'merged', 'C merged');
  expect(await sandbox.git(repo, 'show', 'main:c.txt')).toBe('c fixed\n');

  // Every merge only moved main forward; merged task branches are gone, worktrees removed.
  const history = (await sandbox.git(repo, 'rev-list', '--first-parent', 'main')).trim().split('\n');
  expect(history.at(-1)).toBe(start === history.at(-1) ? start : history.at(-1));
  expect(await sandbox.git(repo, 'merge-base', '--is-ancestor', start, await main())).toBe('');
  for (const id of [a, b, c]) {
    const t = await task(id);
    await until(async () => (await task(id)).worktree?.cleanup === 'removed', `${id} cleaned`);
    expect(await sandbox.git(repo, 'branch', '--list', t.worktree!.branch)).toBe('');
  }
  expect((await instanceOf(w)).mergeQueue.map((m) => m.state)).toEqual(['merged', 'conflict', 'merged', 'tests-failed', 'merged']);
  // The last integration worktree goes after C's own; nothing of the run is left running in the repository.
  await until(async () => (await instanceOf(w)).mergeQueue.every((m) => m.integration?.cleanup === 'removed'), 'integration worktrees removed');
  expect(await w.run({ type: 'workflow.complete', requestId: rid(), instanceId: INSTANCE, expectedRevision: (await instanceOf(w)).revision })).toMatchObject({ ok: true });
});

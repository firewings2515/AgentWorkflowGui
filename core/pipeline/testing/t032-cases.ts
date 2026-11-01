// T032: the task pipeline (R-06, CR-3, V-19..V-21) on the memory ports here and on the SQLite repositories and
// delivery store in app/main. Restarts (merging, testing, around the fast-forward, during setup), a crash
// between two steps, repeated and out-of-order calls and the windows between awaits are part of the cases.
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_VERSION,
  type Escalation,
  NodeId,
  ProjectId,
  type ProjectSettings,
  type SessionId,
  type TaskId,
  type TaskPlanItem,
  type WorkflowInstance,
  type WorkflowTemplate,
} from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import { crashOnce } from '../../workflow/testing/r2-cases';
import { BUILDER, CWD, handoff, IMPL, INSTANCE, instanceOf, node, PLAN, PLANNER, rid, ROOT, settle, started, WORKFLOW, type World } from '../../workflow/testing/harness';
import { integrationRef, resolveOperationOf, resolverSessionIdOf, taskWorktreeRef } from '../naming';
import { fanTemplate, JOIN, RA, RB } from '../../workflow/testing/t031-cases';

export const MERGE = NodeId.parse('merge');
const PROJECT = ProjectId.parse('project-1');

/** Plan (root) splits the work, Implement (Codex, writes) builds a task, the merge node merges it and reports to root. */
export const pipelineTemplate = (options: { confirm?: boolean; concurrency?: number; reworkLimit?: number; isolation?: 'worktree' | 'same-folder' } = {}): WorkflowTemplate => ({
  schemaVersion: CONTRACTS_VERSION,
  id: WORKFLOW,
  revision: 0,
  name: 'Pipeline',
  description: '',
  reworkLimit: options.reworkLimit ?? 3,
  isolation: options.isolation ?? 'worktree',
  nodes: [
    node(PLAN, {
      label: 'Plan',
      agentId: PLANNER,
      isRoot: true,
      writePolicy: 'read-only',
      outputRules: [
        { id: 'split', condition: 'the work splits into tasks', payload: 'the tasks', target: { kind: 'tasks' }, requiresUserConfirmation: options.confirm ?? false },
        { id: 'to-impl', condition: 'a task is ready to build', payload: 'what to build', target: { kind: 'node', nodeId: IMPL }, requiresUserConfirmation: false },
      ],
    }),
    node(IMPL, {
      label: 'Implement',
      agentId: BUILDER,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      concurrency: options.concurrency ?? 3,
      inputRules: [{ id: 'work', condition: 'a task', waitForAllUpstream: false }],
      outputRules: [{ id: 'to-merge', condition: 'the task is done', payload: 'what changed', target: { kind: 'node', nodeId: MERGE }, requiresUserConfirmation: false }],
    }),
    {
      id: MERGE,
      kind: 'merge',
      label: 'Merge',
      writePolicy: 'write',
      concurrency: 1,
      inputRules: [],
      outputRules: [{ id: 'merged', condition: 'merged after its tests passed', payload: 'the merge commit', target: { kind: 'root' }, requiresUserConfirmation: false }],
      position: { x: 0, y: 0 },
    },
  ],
  edges: [
    { source: PLAN, target: IMPL },
    { source: IMPL, target: MERGE },
  ],
  updatedAt: '2026-10-29T00:00:00.000Z',
});

export const project = (commands: ProjectSettings['commands'] = { setup: 'npm ci', test: 'npm test' }): ProjectSettings => ({
  schemaVersion: CONTRACTS_VERSION,
  id: PROJECT,
  revision: 0,
  name: 'Project',
  rootPath: CWD,
  defaultBranch: 'main',
  commands,
  updatedAt: '2026-10-29T00:00:00.000Z',
});

/** Waits until `check` holds, letting the background work (setup, the merge queue) run. */
export const until = async (check: () => boolean | Promise<boolean>, what = 'the condition') => {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
};

const item = (key: string, title: string, dependsOn: string[] = []): TaskPlanItem => ({ key, title, dependsOn, dependsOnExisting: [] });
let calls = 0;
export const createTasks = (w: World, items: TaskPlanItem[], sourceCallRef = `tasks-${String(++calls)}`, caller: SessionId = ROOT) =>
  w.engine.createTasks({ ruleId: 'split', tasks: items }, { caller, sourceCallRef });

const taskOf = async (w: World, id: TaskId) => {
  const task = (await instanceOf(w)).tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`no task ${id}`);
  return task;
};
const statusOf = async (w: World, id: TaskId) => (await taskOf(w, id)).status;
const attemptsOf = async (w: World, id: TaskId) => (await instanceOf(w)).mergeQueue.filter((m) => m.taskId === id);
const implOf = async (w: World, id: TaskId) => {
  const sessionId = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId: id });
  if (sessionId === undefined) throw new Error(`no implement session of ${id}`);
  return sessionId;
};
/** Root hands a task its work. */
const give = (w: World, taskId: TaskId, content = `build ${taskId}`) => handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId, content });
/** The agent of a task writes files in its worktree and hands the task to the merge node. */
const finish = async (w: World, taskId: TaskId, files: Record<string, string>) => {
  const task = await taskOf(w, taskId);
  for (const [f, c] of Object.entries(files)) w.git.write(task.worktree!.path, f, c);
  return handoff(w, await implOf(w, taskId), { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId });
};
const delivered = async (w: World, taskId: TaskId) => (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === taskId && h.toNodeId === IMPL && h.delivery.state === 'sent').length;
const main = (w: World) => w.git.tip(CWD, 'main');
const openEscalations = async (w: World, kind: Escalation['kind']) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === kind);
const respond = (w: World, escalationId: Escalation['id'], decision: 'approve' | 'decline') => w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision });

/** A run with the pipeline template and the project; three tasks made unless `items` says otherwise. */
const begin = async (make: (workflow?: WorkflowTemplate) => Promise<World>, options: Parameters<typeof pipelineTemplate>[0] = {}, commands?: ProjectSettings['commands']) => {
  const w = await make(pipelineTemplate(options));
  await w.repositories.projects.save(project(commands), null);
  expect(await started(w)).toMatchObject({ ok: true });
  return w;
};
const made = async (w: World, items: TaskPlanItem[]) => {
  const result = await createTasks(w, items);
  if (result.status !== 'created') throw new Error(`tasks not created: ${JSON.stringify(result)}`);
  return Object.fromEntries(result.tasks.map((t) => [t.key, t.taskId])) as Record<string, TaskId>;
};

export const t032Cases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`T032 task pipeline (${backend})`, () => {
    it('create_tasks asks the user when root\'s rule says so; a resend finds the same list; approve creates the tasks once', async () => {
      const w = await begin(make, { confirm: true });
      const first = await createTasks(w, [item('a', 'A'), item('b', 'B', ['a'])], 'call-1');
      expect(first).toMatchObject({ status: 'awaiting-confirmation' });
      if (first.status !== 'awaiting-confirmation') return;
      expect((await instanceOf(w)).tasks).toHaveLength(0);
      // The same call again: the same list, no second question; another list under the same call is refused.
      expect(await createTasks(w, [item('a', 'A'), item('b', 'B', ['a'])], 'call-1')).toEqual(first);
      expect(await createTasks(w, [item('a', 'A2')], 'call-1')).toMatchObject({ status: 'rejected', rejection: { reason: 'resend-mismatch' } });
      expect(await openEscalations(w, 'confirmation')).toHaveLength(1);
      // A restart keeps the question; the user approves; the tasks are made once, with their dependency.
      const r = await w.restart();
      expect(await respond(r, first.escalationId, 'approve')).toMatchObject({ ok: true });
      const instance = await instanceOf(r);
      expect(instance.taskPlans[0]).toMatchObject({ state: 'created', escalationId: first.escalationId });
      expect(instance.tasks.map((t) => [t.title, t.status, t.dependsOn.length])).toEqual([
        ['A', 'pending', 0],
        ['B', 'pending', 1],
      ]);
      expect(await createTasks(r, [item('a', 'A'), item('b', 'B', ['a'])], 'call-1')).toMatchObject({ status: 'created', tasks: instance.taskPlans[0]?.created });
      expect((await instanceOf(r)).tasks).toHaveLength(2);
      expect(await respond(r, first.escalationId, 'approve')).toMatchObject({ ok: false });
    });

    it('create_tasks: declined lists make nothing; root only; a tasks rule only; cycles and unknown tasks are refused', async () => {
      const w = await begin(make, { confirm: true });
      const asked = await createTasks(w, [item('a', 'A')], 'call-x');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      await respond(w, asked.escalationId, 'decline');
      expect((await instanceOf(w)).taskPlans[0]?.state).toBe('declined');
      expect((await instanceOf(w)).tasks).toHaveLength(0);
      expect(await createTasks(w, [item('a', 'A')], 'call-x')).toMatchObject({ status: 'rejected' });
      expect(await createTasks(w, [item('a', 'A', ['b']), item('b', 'B', ['a'])])).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
      expect(await w.engine.createTasks({ ruleId: 'split', tasks: [{ ...item('a', 'A'), dependsOnExisting: ['nope' as TaskId] }] }, { caller: ROOT, sourceCallRef: 'c-unknown' })).toMatchObject({
        status: 'rejected',
        rejection: { reason: 'invalid-input' },
      });
      expect(await w.engine.createTasks({ ruleId: 'to-impl', tasks: [item('a', 'A')] }, { caller: ROOT, sourceCallRef: 'c-rule' })).toMatchObject({ status: 'rejected', rejection: { reason: 'no-matching-rule' } });
      // Root names the task once the run has tasks; before, it is told to create them.
      const none = await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL } });
      expect(none).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
      expect(none.status === 'rejected' && none.rejection.detail).toContain('create_tasks first');
      // Root is told the order in its briefing.
      const root = await w.repositories.sessions.get(ROOT);
      const told = root?.kind === 'workflow' ? await w.engine.briefing(root) : undefined;
      expect(told).toContain('There is no task until you create them');
    });

    it('V-19: B does not wait for A; C starts only after A is merged, from the target branch with A in it', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B'), item('c', 'C', ['a'])]);
      for (const id of [t.a!, t.b!, t.c!]) expect(await give(w, id)).toMatchObject({ status: 'accepted' });
      await until(async () => (await delivered(w, t.a!)) === 1 && (await delivered(w, t.b!)) === 1, 'A and B delivered');
      // C has its worktree (its session's folder) but is not started: nothing delivered, no setup.
      expect(await statusOf(w, t.c!)).toBe('pending');
      expect(await delivered(w, t.c!)).toBe(0);
      expect(w.commands.of('setup').map((s) => s.cwd)).toEqual([(await taskOf(w, t.a!)).worktree!.path, (await taskOf(w, t.b!)).worktree!.path]);
      // Each session works in its own worktree.
      const implA = await w.repositories.sessions.get(await implOf(w, t.a!));
      expect(implA?.cwd).toBe((await taskOf(w, t.a!)).worktree!.path);
      expect(implA?.cwd).toBe((await taskWorktreeRef(hashOf, CWD, INSTANCE, t.a!)).path);
      // B finishes first and merges; C still waits for A.
      expect(await finish(w, t.b!, { 'b.txt': 'b\n' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await statusOf(w, t.b!)) === 'merged', 'B merged');
      expect(await statusOf(w, t.c!)).toBe('pending');
      const beforeA = main(w);
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      expect(main(w)).not.toBe(beforeA);
      expect(w.git.fileAt(main(w), 'a.txt')).toBe('a\n');
      await until(async () => (await delivered(w, t.c!)) === 1, 'C delivered');
      // C took in A's work before it started.
      expect(w.git.tree((await taskOf(w, t.c!)).worktree!.path)?.files.get('a.txt')).toBe('a\n');
      // Root heard of each merge through the merge node's rule.
      const reports = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.fromNodeId === MERGE && h.toNodeId === PLAN);
      expect(reports).toHaveLength(2);
      // Merged tasks' worktrees are gone, their branches deleted, their sessions closed first.
      const a = await taskOf(w, t.a!);
      expect(a).toMatchObject({ status: 'merged', worktree: { cleanup: 'removed' } });
      expect(a.completedAt).toBeDefined();
      expect(w.git.tip(CWD, a.worktree!.branch)).toBeUndefined();
      expect(w.closed).toContain(await implOf(w, t.a!));
      expect((await attemptsOf(w, t.a!))[0]).toMatchObject({ state: 'merged', integration: { cleanup: 'removed' }, test: { passed: true } });
    });

    it('a restart, which sends every pending handoff through the gate again, delivers nothing of a task not started', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('c', 'C', ['a'])]);
      await give(w, t.a!);
      await give(w, t.c!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered');
      const r = await w.restart();
      await settle();
      expect(await delivered(r, t.c!)).toBe(0);
      expect(await statusOf(r, t.c!)).toBe('pending');
      await finish(r, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await delivered(r, t.c!)) === 1, 'C delivered once A merged');
    });

    it('O-05: at most three tasks are in progress; the fourth starts when one is merged', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B'), item('c', 'C'), item('d', 'D')]);
      // Two handoffs racing for places: the instance's queue lets only the limit in.
      await Promise.all([t.a!, t.b!, t.c!, t.d!].map((id) => give(w, id)));
      await until(async () => (await instanceOf(w)).tasks.filter((x) => x.status === 'running').length === 3, 'three running');
      expect(await statusOf(w, t.d!)).toBe('pending');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await delivered(w, t.d!)) === 1, 'D delivered');
      expect((await instanceOf(w)).tasks.filter((x) => ['running', 'awaiting-merge', 'merging', 'blocked'].includes(x.status)).length).toBe(3);
    });

    it('V-20: a setup that fails blocks its task and asks root; approve runs it again; other tasks go on', async () => {
      const w = await begin(make);
      let failures = 1;
      w.commands.script = (spec) => (spec.purpose === 'setup' && failures-- > 0 ? { exitCode: 1, outputTail: 'npm ERR! boom' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await until(async () => (await statusOf(w, t.a!)) === 'blocked', 'A blocked');
      expect(await taskOf(w, t.a!)).toMatchObject({ blockedReason: 'setup-failed', setup: { state: 'failed', exitCode: 1, outputTail: 'npm ERR! boom' } });
      expect(await delivered(w, t.a!)).toBe(0);
      const [question] = await openEscalations(w, 'setup-failed');
      expect(question).toMatchObject({ ref: { kind: 'task', taskId: t.a } });
      // Another task is not held up by it.
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      await respond(w, question!.id, 'approve');
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered after its setup ran again');
      expect(await taskOf(w, t.a!)).toMatchObject({ status: 'running', setup: { state: 'succeeded' } });
    });

    it('declining a failed setup gives the task up: failed, worktree removed, branch kept, its handoff cancelled', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'setup' ? { exitCode: 2, outputTail: 'no' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B', ['a'])]);
      await give(w, t.a!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1, 'asked');
      const [question] = await openEscalations(w, 'setup-failed');
      await respond(w, question!.id, 'decline');
      const a = await taskOf(w, t.a!);
      expect(a).toMatchObject({ status: 'failed', worktree: { cleanup: 'removed' } });
      expect(w.git.tip(CWD, a.worktree!.branch)).toBeDefined();
      expect((await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.taskId === t.a)?.outcome?.kind).toBe('cancelled');
      // Its dependent can never start: a handoff of it is refused as such.
      expect(await give(w, t.b!)).toMatchObject({ status: 'rejected', rejection: { reason: 'dependency-unmet' } });
    });

    it('the GUI commits at the handoff, without what the setup made; conflict markers are refused back to the agent', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => {
        if (spec.purpose === 'setup') w.git.write(spec.cwd, 'node_modules/pkg.js', 'x');
        return { exitCode: 0, outputTail: 'ok' };
      };
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.write(path, 'src/app.txt', 'app\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n');
      // Only a file of a merge is checked for markers (T030); here the agent's commit goes through.
      w.git.write(path, 'src/app.txt', 'app v2\n');
      expect(await finish(w, t.a!, { 'feature.txt': 'f\n' })).toMatchObject({ status: 'accepted' });
      const branchTip = w.git.tip(CWD, (await taskOf(w, t.a!)).worktree!.branch);
      expect(w.git.fileAt(branchTip, 'feature.txt')).toBe('f\n');
      expect(w.git.fileAt(branchTip, 'src/app.txt')).toBe('app v2\n');
      expect(w.git.fileAt(branchTip, 'node_modules/pkg.js')).toBeUndefined();
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      expect(w.git.fileAt(main(w), 'node_modules/pkg.js')).toBeUndefined();
    });

    it('r1 P1-6 / r2 P1-4: a file the setup added in an existing folder stays out of commits, also when it was staged, unless the agent changed it', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => {
        if (spec.purpose === 'setup') {
          w.git.write(spec.cwd, 'src/generated.txt', 'generated\n');
          // The setup stages what it made (`git add`): the index would carry it into a commit.
          w.git.stage(spec.cwd, 'src/generated.txt');
          w.git.write(spec.cwd, 'src/config.local', 'port=1\n');
        }
        return { exitCode: 0, outputTail: 'ok' };
      };
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      // The agent changes one of the setup's files (its own work now) and adds its own.
      w.git.write(path, 'src/config.local', 'port=2 (agent)\n');
      expect(await finish(w, t.a!, { 'feature.txt': 'f\n' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      expect(w.git.fileAt(main(w), 'src/generated.txt')).toBeUndefined();
      expect(w.git.fileAt(main(w), 'src/config.local')).toBe('port=2 (agent)\n');
      expect(w.git.fileAt(main(w), 'feature.txt')).toBe('f\n');
    });

    it('G-13 / r3 P1-2: a setup that changes tracked files fails and names them; a retry puts back only those it left untouched, and a file someone else changed is never taken for the setup\'s, across retries', async () => {
      const w = await begin(make);
      let runs = 0;
      w.commands.script = (spec) => {
        if (spec.purpose !== 'setup') return { exitCode: 0, outputTail: 'ok' };
        runs++;
        // First run: rewrites two tracked files. Second run (the script was fixed to leave them alone): fails for
        // another reason. Third: clean.
        if (runs === 1) {
          w.git.write(spec.cwd, 'README.md', 'readme with a local port\n');
          w.git.write(spec.cwd, 'src/app.txt', 'app, rewritten by the setup\n');
        }
        return runs === 2 ? { exitCode: 1, outputTail: 'network down' } : { exitCode: 0, outputTail: 'ok' };
      };
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1, 'asked');
      expect(await taskOf(w, t.a!)).toMatchObject({ status: 'blocked', blockedReason: 'setup-failed', setup: { state: 'failed' } });
      expect(await delivered(w, t.a!)).toBe(0);
      const [question] = await openEscalations(w, 'setup-failed');
      expect(question?.detail).toContain('README.md');
      expect(question?.detail).toContain('src/app.txt');
      expect(question?.detail).toContain('.gitignore');
      // Someone edits one of them by hand before the retry.
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.write(path, 'src/app.txt', 'app, edited by hand\n');
      await respond(w, question!.id, 'approve');
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1 && w.commands.of('setup').length === 2, 'the second run failed');
      // The untouched one was put back; the hand edit stayed, and the second run did not take it for its own.
      expect(w.git.tree(path)?.files.get('README.md')).toBe('readme\n');
      expect(w.git.tree(path)?.files.get('src/app.txt')).toBe('app, edited by hand\n');
      const [again] = await openEscalations(w, 'setup-failed');
      expect(again?.detail).not.toContain('src/app.txt');
      // The second approve keeps the hand edit too (r3 P1-2: it used to put it back).
      await respond(w, again!.id, 'approve');
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered after the third run');
      expect(w.git.tree(path)?.files.get('src/app.txt')).toBe('app, edited by hand\n');
      expect(w.commands.of('setup')).toHaveLength(3);
      // Not the setup's: it is committed as any work in the task.
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      expect(w.git.fileAt(w.git.tip(CWD, (await taskOf(w, t.a!)).worktree!.branch), 'src/app.txt')).toBe('app, edited by hand\n');
    });

    it('r2 P2: a finished setup whose record is gone refuses the commit and asks root; approve lets it commit without the record', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => {
        if (spec.purpose === 'setup') w.git.write(spec.cwd, 'src/generated.txt', 'generated\n');
        return { exitCode: 0, outputTail: 'ok' };
      };
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      const branch = (await taskOf(w, t.a!)).worktree!.branch;
      const tip = w.git.tip(CWD, branch);
      // The record goes missing from the worktree's git folder.
      w.files.saved.delete(path.toLowerCase());
      expect(await finish(w, t.a!, { 'a.txt': 'a\n' })).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
      expect(w.git.tip(CWD, branch)).toBe(tip);
      const [question] = await openEscalations(w, 'setup-failed');
      expect(question?.title).toContain('record');
      await respond(w, question!.id, 'approve');
      expect(await finish(w, t.a!, { 'a.txt': 'a\n' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      // Without the record everything not ignored is the agent's: the user chose that.
      expect(w.git.fileAt(main(w), 'src/generated.txt')).toBe('generated\n');
    });

    it('r1 P1-6: when what the setup made cannot be recorded the task does not start; when it cannot be read nothing is committed', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      w.files.failNext = 'changes';
      await give(w, t.a!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1, 'asked');
      expect(await delivered(w, t.a!)).toBe(0);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      const branch = (await taskOf(w, t.b!)).worktree!.branch;
      const tip = w.git.tip(CWD, branch);
      w.files.failNext = 'load';
      expect(await finish(w, t.b!, { 'b.txt': 'b\n' })).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
      expect(w.git.tip(CWD, branch)).toBe(tip);
    });

    it('V-21: a conflict the agent cannot resolve goes back to the task; the target branch stays, dependents wait; once fixed it merges', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B'), item('c', 'C', ['b'])]);
      for (const id of [t.a!, t.b!, t.c!]) await give(w, id);
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      await finish(w, t.a!, { 'src/app.txt': 'app from A\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      const afterA = main(w);
      // B changed the same line: the merge conflicts; the agent resolving it ends its turn with nothing done.
      const resolver = await resolverSessionIdOf(hashOf, INSTANCE, t.b!, 0);
      await finish(w, t.b!, { 'src/app.txt': 'app from B\n' });
      await until(async () => (await attemptsOf(w, t.b!))[0]?.state === 'conflict', 'B conflicted');
      const [attempt] = await attemptsOf(w, t.b!);
      expect(attempt).toMatchObject({ conflictFiles: ['src/app.txt'], integration: { cleanup: 'removed' } });
      const resolverSession = await w.repositories.sessions.get(resolver);
      expect(resolverSession?.cwd).toBe((await integrationRef(hashOf, CWD, INSTANCE, t.b!, 0)).path);
      expect(main(w)).toBe(afterA);
      expect(await statusOf(w, t.c!)).toBe('pending');
      // B is back at Implement, as rework, with the conflict left in its worktree.
      await until(async () => (await delivered(w, t.b!)) === 2, 'B given back');
      const back = (await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.taskId === t.b && h.fromNodeId === MERGE);
      expect(back).toMatchObject({ toNodeId: IMPL, rework: true });
      expect(back?.payload).toContain('src/app.txt');
      const bPath = (await taskOf(w, t.b!)).worktree!.path;
      expect(w.git.tree(bPath)?.merging).toBeDefined();
      expect(await taskOf(w, t.b!)).toMatchObject({ status: 'running', reworkCount: 1 });
      // A hand-off with the markers still in is refused; resolved, it merges, and C starts.
      expect(await handoff(w, await implOf(w, t.b!), { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId: t.b! })).toMatchObject({
        status: 'rejected',
        rejection: { reason: 'invalid-input' },
      });
      expect(await finish(w, t.b!, { 'src/app.txt': 'app from A and B\n' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await statusOf(w, t.b!)) === 'merged', 'B merged');
      expect(w.git.fileAt(main(w), 'src/app.txt')).toBe('app from A and B\n');
      await until(async () => (await delivered(w, t.c!)) === 1, 'C delivered');
    });

    it('V-21: a conflict the agent resolves in the integration worktree is committed by the GUI, tested and merged', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      await finish(w, t.a!, { 'src/app.txt': 'A\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      const resolver = await resolverSessionIdOf(hashOf, INSTANCE, t.b!, 0);
      w.holding.add(resolver);
      await finish(w, t.b!, { 'src/app.txt': 'B\n' });
      await until(() => w.open.has(resolver), 'resolver working');
      expect((await attemptsOf(w, t.b!))[0]?.state).toBe('resolving');
      // A turn end replayed for another session changes nothing; the resolver's own does.
      const integ = await integrationRef(hashOf, CWD, INSTANCE, t.b!, 0);
      w.git.write(integ.path, 'src/app.txt', 'A and B\n');
      await w.finishTurn(resolver);
      await until(async () => (await statusOf(w, t.b!)) === 'merged', 'B merged');
      expect(w.git.fileAt(main(w), 'src/app.txt')).toBe('A and B\n');
      expect(await delivered(w, t.b!)).toBe(1);
      // The resolver cannot hand off.
      expect(await handoff(w, resolver, { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId: t.b! })).toMatchObject({ status: 'rejected' });
    });

    it('V-21: failed tests give the task back with their output; the target branch stays and the dependent waits', async () => {
      const w = await begin(make);
      let red = true;
      w.commands.script = (spec) => (spec.purpose === 'test' && red ? { exitCode: 1, outputTail: '1 failing: login' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('c', 'C', ['a'])]);
      await give(w, t.a!);
      await give(w, t.c!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered');
      const before = main(w);
      await finish(w, t.a!, { 'a.txt': 'broken\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.state === 'tests-failed', 'tests failed');
      expect((await attemptsOf(w, t.a!))[0]).toMatchObject({ test: { passed: false, exitCode: 1, outputTail: '1 failing: login' }, integration: { cleanup: 'removed' } });
      expect(main(w)).toBe(before);
      await until(async () => (await delivered(w, t.a!)) === 2, 'A given back');
      expect((await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.fromNodeId === MERGE && h.taskId === t.a)?.payload).toContain('1 failing: login');
      expect(await statusOf(w, t.c!)).toBe('pending');
      red = false;
      await finish(w, t.a!, { 'a.txt': 'fixed\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      expect((await attemptsOf(w, t.a!)).map((m) => m.state)).toEqual(['tests-failed', 'merged']);
      await until(async () => (await delivered(w, t.c!)) === 1, 'C delivered');
    });

    it('a target branch moved before the fast-forward starts the merge again from its new commit', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      // Someone commits on main while the tests run.
      w.commands.script = (spec) => {
        if (spec.purpose === 'test' && w.commands.of('test').length === 1) w.git.commitOn(CWD, 'main', { 'other.txt': 'someone\n' });
        return { exitCode: 0, outputTail: 'ok' };
      };
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      const attempts = await attemptsOf(w, t.a!);
      expect(attempts.map((m) => [m.state, m.restarts])).toEqual([
        ['cancelled', 0],
        ['merged', 1],
      ]);
      expect(w.git.fileAt(main(w), 'other.txt')).toBe('someone\n');
      expect(w.git.fileAt(main(w), 'a.txt')).toBe('a\n');
    });

    it('no test command: the merge fails and asks root; approve after a test is set merges it', async () => {
      const w = await begin(make, {}, { setup: 'npm ci' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const before = main(w);
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await openEscalations(w, 'merge-failed')).length === 1, 'asked');
      expect(await taskOf(w, t.a!)).toMatchObject({ status: 'blocked', blockedReason: 'merge-failed' });
      expect(main(w)).toBe(before);
      const [question] = await openEscalations(w, 'merge-failed');
      expect(question?.ref).toEqual({ kind: 'merge', taskId: t.a, attempt: 0 });
      expect(question?.detail).toContain('Add a test command to the project settings');
      // No test result is made up: the attempt failed without one.
      expect((await attemptsOf(w, t.a!))[0]).toMatchObject({ state: 'failed' });
      expect((await attemptsOf(w, t.a!))[0]?.test).toBeUndefined();
      await w.repositories.projects.save({ ...project(), revision: 0 }, 0);
      const implementing = await delivered(w, t.a!);
      await respond(w, question!.id, 'approve');
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      // Merged from the task as it was: nothing went back to its node.
      expect(await delivered(w, t.a!)).toBe(implementing);
      expect(w.git.fileAt(main(w), 'a.txt')).toBe('a\n');
    });

    it('a merge quicker than the turn that handed the task on: cleanup waits for that turn to end instead of cutting it off (live run 1)', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const impl = await implOf(w, t.a!);
      // The agent hands off in the middle of a turn that goes on afterwards.
      w.holding.add(impl);
      w.emitTurn(impl, 'busy-after-handoff', 'running');
      w.open.set(impl, 'busy-after-handoff');
      await settle();
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      await settle();
      expect((await taskOf(w, t.a!)).worktree?.cleanup).toBe('active');
      expect(w.closed).not.toContain(impl);
      await w.finishTurn(impl);
      await until(async () => (await taskOf(w, t.a!)).worktree?.cleanup === 'removed', 'removed after the turn');
      expect(w.closed).toContain(impl);
    });

    it('a worktree held by a process is left pending cleanup; task.retryCleanup finishes it', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.locked.add(path.toLowerCase());
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await taskOf(w, t.a!)).worktree?.cleanup === 'pending-cleanup', 'pending');
      expect(await statusOf(w, t.a!)).toBe('merged');
      const retry = () => w.run({ type: 'task.retryCleanup', requestId: rid(), instanceId: INSTANCE, taskId: t.a! });
      expect(await retry()).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true });
      w.git.locked.clear();
      expect(await retry()).toMatchObject({ ok: true });
      expect((await taskOf(w, t.a!)).worktree?.cleanup).toBe('removed');
      expect(await retry()).toMatchObject({ ok: false, code: 'invalid_transition' });
    });

    it('a merged and cleaned task\'s session is read-only with a clear reason; a session whose folder is gone too', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'delivered');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await taskOf(w, t.a!)).worktree?.cleanup === 'removed', 'cleaned');
      expect(await w.engine.sessionAccess(await implOf(w, t.a!))).toContain('merged');
      expect(await w.engine.sessionAccess(await implOf(w, t.b!))).toBeUndefined();
      expect(await w.engine.sessionAccess(ROOT)).toBeUndefined();
      w.git.folders.delete((await taskOf(w, t.b!)).worktree!.path.toLowerCase());
      expect(await w.engine.sessionAccess(await implOf(w, t.b!))).toContain('no longer exists');
    });

    it('workflow.complete waits for an active merge; workflow.cancel ends the tasks, keeps their work on their branches and cancels what was queued', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B'), item('c', 'C', ['a'])]);
      for (const id of [t.a!, t.b!, t.c!]) await give(w, id);
      await until(async () => (await delivered(w, t.b!)) === 1, 'delivered');
      // A's tests hang: the merge is active.
      w.commands.script = (spec) => (spec.purpose === 'test' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.state === 'testing', 'testing');
      const instance = await instanceOf(w);
      expect(await w.run({ type: 'workflow.complete', requestId: rid(), instanceId: INSTANCE, expectedRevision: instance.revision })).toMatchObject({ ok: false, code: 'invalid_transition' });
      expect(await w.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: instance.revision - 1 })).toMatchObject({ ok: false, code: 'stale_revision' });
      // A restart ends the hung test; the run is cancelled once its merge finished.
      w.commands.script = () => ({ exitCode: 0, outputTail: 'ok' });
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged after the restart');
      const bPath = (await taskOf(r, t.b!)).worktree!.path;
      r.git.write(bPath, 'b.txt', 'half done\n');
      const current = await instanceOf(r);
      expect(await r.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: current.revision })).toMatchObject({ ok: true });
      const ended: WorkflowInstance = await instanceOf(r);
      expect(ended).toMatchObject({ state: 'cancelled' });
      expect(ended.endedAt).toBeDefined();
      expect(ended.tasks.map((x) => x.status)).toEqual(['merged', 'cancelled', 'cancelled']);
      await until(async () => (await taskOf(r, t.b!)).worktree?.cleanup === 'removed', 'B removed');
      const b = ended.tasks.find((x) => x.id === t.b);
      expect(r.git.fileAt(r.git.tip(CWD, b!.worktree!.branch), 'b.txt')).toBe('half done\n');
      expect(await give(r, t.c!)).toMatchObject({ status: 'rejected' });
    });

    it('a crash while a cancelled run removes its worktrees: a restart finishes the removal, the work kept on the branch', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'delivered');
      w.git.write((await taskOf(w, t.a!)).worktree!.path, 'a.txt', 'wip\n');
      w.git.hang('removeWorktree');
      expect(await w.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: (await instanceOf(w)).revision })).toMatchObject({ ok: true });
      expect((await instanceOf(w)).state).toBe('cancelled');
      const r = await w.restart();
      await until(async () => (await instanceOf(r)).tasks.every((x) => x.worktree?.cleanup === 'removed'), 'removed');
      const a = await taskOf(r, t.a!);
      expect(r.git.fileAt(r.git.tip(CWD, a.worktree!.branch), 'a.txt')).toBe('wip\n');
    });

    it('restart while merging: the merge git made but nobody recorded is found, tested and merged once', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      w.git.hang('merge', 'after');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(() => w.git.calls.some((c) => c.op === 'merge'), 'merge called');
      expect((await attemptsOf(w, t.a!))[0]?.state).toBe('merging');
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged');
      expect(r.git.calls.filter((c) => c.op === 'merge').length).toBe(1);
      expect((await attemptsOf(r, t.a!))).toHaveLength(1);
    });

    it('restart while testing runs the tests again; restart after the fast-forward finds it done; dependents start once', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('c', 'C', ['a'])]);
      await give(w, t.a!);
      await give(w, t.c!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      w.commands.script = (spec) => (spec.purpose === 'test' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.state === 'testing', 'testing');
      w.commands.script = () => ({ exitCode: 0, outputTail: 'ok' });
      w.git.hang('advanceBranch', 'after');
      const r = await w.restart();
      await until(() => r.git.calls.some((c) => c.op === 'advanceBranch'), 'advanced');
      expect(r.commands.of('test')).toHaveLength(2);
      // The branch moved but the attempt still says advancing: the dependent has not started.
      expect((await attemptsOf(r, t.a!))[0]?.state).toBe('advancing');
      expect(await statusOf(r, t.c!)).toBe('pending');
      const r2 = await r.restart();
      await until(async () => (await statusOf(r2, t.a!)) === 'merged', 'merged');
      await until(async () => (await delivered(r2, t.c!)) === 1, 'C delivered');
      expect(r2.git.fileAt(r2.git.tip(CWD, 'main'), 'a.txt')).toBe('a\n');
    });

    it('restart during setup runs it again, keeping when it started; a cancel during setup kills it and writes nothing after', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'setup' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await until(() => w.commands.of('setup').length === 1, 'setup running');
      const startedAt = (await taskOf(w, t.a!)).setup?.startedAt;
      w.commands.script = () => ({ exitCode: 0, outputTail: 'ok' });
      const r = await w.restart();
      await until(async () => (await delivered(r, t.a!)) === 1, 'delivered after the restart');
      expect((await taskOf(r, t.a!)).setup).toMatchObject({ state: 'succeeded', startedAt });
      // B's setup hangs; the user cancels the run meanwhile.
      r.commands.script = (spec) => (spec.purpose === 'setup' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      await give(r, t.b!);
      await until(() => r.commands.of('setup').length === 3, 'B setup running');
      const current = await instanceOf(r);
      expect(await r.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: current.revision })).toMatchObject({ ok: true });
      await until(() => r.commands.killed.length === 1, 'killed');
      await settle();
      expect(await taskOf(r, t.b!)).toMatchObject({ status: 'cancelled', setup: { state: 'running' } });
    });

    it('a crash between writing a task list and its question, and between the user\'s decision and the tasks, is finished by a restart', async () => {
      const w = await begin(make, { confirm: true });
      crashOnce(w.repositories.escalations, 'upsert');
      await expect(createTasks(w, [item('a', 'A')], 'call-c')).rejects.toThrow('crash');
      expect((await instanceOf(w)).taskPlans[0]?.state).toBe('awaiting-confirmation');
      const r = await w.restart();
      const [question] = await openEscalations(r, 'confirmation');
      expect(question?.ref?.kind).toBe('taskPlan');
      crashOnce(r.repositories.instances, 'update');
      await respond(r, question!.id, 'approve').catch(() => undefined);
      expect((await instanceOf(r)).tasks).toHaveLength(0);
      const r2 = await r.restart();
      expect((await instanceOf(r2)).tasks.map((x) => x.title)).toEqual(['A']);
      expect((await instanceOf(r2)).taskPlans[0]?.state).toBe('created');
    });

    it('a crash after a merge was recorded and before cleanup and root\'s report: a restart finishes both, once', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      w.git.hang('removeWorktree');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'merged');
      await until(() => w.git.calls.some((c) => c.op === 'removeWorktree'), 'cleanup started');
      expect((await taskOf(w, t.a!)).worktree?.cleanup).toBe('active');
      const r = await r0(w);
      await until(async () => (await taskOf(r, t.a!)).worktree?.cleanup === 'removed', 'cleaned');
      await until(async () => ((await attemptsOf(r, t.a!))[0]?.integration?.cleanup) === 'removed', 'integration cleaned');
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.fromNodeId === MERGE)).toHaveLength(1);
    });

    it('restart while an agent resolves a conflict: the restart ended its turn, so the GUI decides from the worktree, without asking it again', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      await finish(w, t.a!, { 'src/app.txt': 'A\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      const resolver = await resolverSessionIdOf(hashOf, INSTANCE, t.b!, 0);
      w.holding.add(resolver);
      await finish(w, t.b!, { 'src/app.txt': 'B\n' });
      await until(() => w.open.has(resolver), 'resolver working');
      // While its turn runs nothing is decided, a replayed end of another turn included.
      w.emitTurn(resolver, 'old-turn', 'completed');
      await settle();
      expect((await attemptsOf(w, t.b!))[0]?.state).toBe('resolving');
      // It wrote the resolution, then the GUI went down (its runtime with it: the turn is cut off).
      const integ = await integrationRef(hashOf, CWD, INSTANCE, t.b!, 0);
      w.git.write(integ.path, 'src/app.txt', 'A+B\n');
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.b!)) === 'merged', 'B merged');
      expect(r.git.fileAt(r.git.tip(CWD, 'main'), 'src/app.txt')).toBe('A+B\n');
      // Its message crossed the dispatch boundary once, before the restart.
      expect((await r.store.get(await resolveOperationOf(hashOf, INSTANCE, t.b!, 0)))?.delivery.attempts).toHaveLength(1);
    });

    it('restart before the fast-forward: it is made once, from the recorded commits', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      w.git.hang('advanceBranch', 'before');
      const before = main(w);
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(() => w.git.calls.some((c) => c.op === 'advanceBranch'), 'advancing');
      expect(main(w)).toBe(before);
      expect((await attemptsOf(w, t.a!))[0]?.state).toBe('advancing');
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged');
      expect(r.commands.of('test')).toHaveLength(1);
      expect(r.git.fileAt(main(r), 'a.txt')).toBe('a\n');
    });

    it('a crash after failed tests were recorded and before the task was given back: a restart gives it back once', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'test' ? { exitCode: 1, outputTail: 'red' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      w.git.hang('removeWorktree');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.state === 'tests-failed', 'tests failed');
      await settle();
      expect((await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.fromNodeId === MERGE)).toHaveLength(0);
      const r = await w.restart();
      await until(async () => (await delivered(r, t.a!)) === 2, 'given back');
      const r2 = await r.restart();
      await settle();
      expect((await r2.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.fromNodeId === MERGE)).toHaveLength(1);
      expect((await attemptsOf(r2, t.a!))[0]?.integration?.cleanup).toBe('removed');
    });

    it('a resend of the merge handoff, before and after the merge, joins the queue once; a merge-failed decision is taken once', async () => {
      const w = await begin(make, {}, { setup: 'npm ci' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const impl = await implOf(w, t.a!);
      const call = { ruleId: 'to-merge', target: { kind: 'node' as const, nodeId: MERGE }, taskId: t.a!, content: 'merge it' };
      const first = await handoff(w, impl, call, { operationId: 'op-merge', sourceCallRef: 'call-merge' });
      expect(first).toMatchObject({ status: 'accepted', delivery: 'pending' });
      if (first.status !== 'accepted') return;
      expect(await handoff(w, impl, call, { operationId: 'op-merge', sourceCallRef: 'call-merge' })).toMatchObject({ status: 'duplicate', handoffId: first.handoffId, operationId: first.operationId });
      // Recorded like any handoff (R-04): to the merge node, counted, never delivered.
      expect((await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === MERGE)).toEqual([expect.objectContaining({ operationId: first.operationId, delivery: expect.objectContaining({ state: 'pending' }) as unknown })]);
      await until(async () => (await openEscalations(w, 'merge-failed')).length === 1, 'asked (no test command)');
      const r = await w.restart();
      expect(await handoff(r, impl, call, { operationId: 'op-merge', sourceCallRef: 'call-merge' })).toMatchObject({ status: 'duplicate', handoffId: first.handoffId });
      // Another content under the same call is refused.
      expect(await handoff(r, impl, { ...call, content: 'other' }, { operationId: 'op-merge', sourceCallRef: 'call-merge' })).toMatchObject({ status: 'rejected', rejection: { reason: 'resend-mismatch' } });
      expect(await attemptsOf(r, t.a!)).toHaveLength(1);
      const [question] = await openEscalations(r, 'merge-failed');
      await r.repositories.projects.save({ ...project(), revision: 0 }, 0);
      expect(await respond(r, question!.id, 'approve')).toMatchObject({ ok: true });
      expect(await respond(r, question!.id, 'approve')).toMatchObject({ ok: false });
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged');
      expect((await attemptsOf(r, t.a!)).map((m) => m.state)).toEqual(['failed', 'merged']);
      expect(await handoff(r, impl, call, { operationId: 'op-merge', sourceCallRef: 'call-merge' })).toMatchObject({ status: 'duplicate' });
      expect(await attemptsOf(r, t.a!)).toHaveLength(2);
    });

    it('r1 P1-1: the old merge call resent after the task was given back commits nothing and queues nothing', async () => {
      const w = await begin(make);
      let red = true;
      w.commands.script = (spec) => (spec.purpose === 'test' && red ? { exitCode: 1, outputTail: 'red' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const impl = await implOf(w, t.a!);
      const call = { ruleId: 'to-merge', target: { kind: 'node' as const, nodeId: MERGE }, taskId: t.a!, content: 'merge it' };
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.write(path, 'a.txt', 'first\n');
      await handoff(w, impl, call, { operationId: 'op-old', sourceCallRef: 'call-old' });
      await until(async () => (await delivered(w, t.a!)) === 2, 'given back');
      const branch = (await taskOf(w, t.a!)).worktree!.branch;
      const tip = w.git.tip(CWD, branch);
      // Unfinished rework in the worktree, then the old call again (a restart's resend).
      w.git.write(path, 'a.txt', 'half done\n');
      const r = await w.restart();
      expect(await handoff(r, impl, call, { operationId: 'op-old', sourceCallRef: 'call-old' })).toMatchObject({ status: 'duplicate' });
      await settle();
      expect(r.git.tip(CWD, branch)).toBe(tip);
      expect(await attemptsOf(r, t.a!)).toHaveLength(1);
      expect(await statusOf(r, t.a!)).toBe('running');
      // The real next handoff does go.
      red = false;
      r.git.write(path, 'a.txt', 'done\n');
      expect(await handoff(r, impl, call, { operationId: 'op-new', sourceCallRef: 'call-new' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged');
    });

    it('r1 P1-1: a crash after the merge handoff was accepted and before its task joined the queue: a restart queues it once', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      crashOnce(w.repositories.instances, 'update', (next) => (next as WorkflowInstance).tasks.some((x) => x.status === 'awaiting-merge'));
      await expect(finish(w, t.a!, { 'a.txt': 'a\n' })).rejects.toThrow('crash');
      expect(await attemptsOf(w, t.a!)).toHaveLength(0);
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged');
      expect(await attemptsOf(r, t.a!)).toHaveLength(1);
    });

    it('r1 P1-2: handing a task to the merge node frees its implementation node for the next task', async () => {
      const w = await begin(make, { concurrency: 1 });
      w.commands.script = (spec) => (spec.purpose === 'test' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered');
      await settle();
      expect(await delivered(w, t.b!)).toBe(0);
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      // A is being tested (its merge active): B gets the slot all the same.
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered while A is tested');
      expect((await attemptsOf(w, t.a!))[0]?.state).toBe('testing');
    });

    it('r1 P1-7: the merge node\'s receive limit holds; past it the task stops and root is asked', async () => {
      const template = pipelineTemplate();
      const merge = template.nodes.find((n) => n.id === MERGE)!;
      merge.inputRules = [{ id: 'done', condition: 'a finished task', acceptanceLimit: 1, waitForAllUpstream: false }];
      const w = await make(template);
      await w.repositories.projects.save(project(), null);
      await started(w);
      w.commands.script = (spec) => (spec.purpose === 'test' ? { exitCode: 1, outputTail: 'red' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await delivered(w, t.a!)) === 2, 'given back');
      expect(await finish(w, t.a!, { 'a.txt': 'b\n' })).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      expect(await attemptsOf(w, t.a!)).toHaveLength(1);
      expect(await taskOf(w, t.a!)).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded' });
      expect(await openEscalations(w, 'limit-exceeded')).toHaveLength(1);
    });

    it('r1 P1-3: an approved setup question cut off by a crash is carried out at the restart, not asked again', async () => {
      const w = await begin(make);
      let fail = true;
      w.commands.script = (spec) => (spec.purpose === 'setup' && fail ? { exitCode: 1, outputTail: 'boom' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1, 'asked');
      const [question] = await openEscalations(w, 'setup-failed');
      fail = false;
      crashOnce(w.repositories.instances, 'update');
      await respond(w, question!.id, 'approve').catch(() => undefined);
      expect(await statusOf(w, t.a!)).toBe('blocked');
      const r = await w.restart();
      await until(async () => (await delivered(r, t.a!)) === 1, 'set up and delivered after the restart');
      expect(await openEscalations(r, 'setup-failed')).toHaveLength(0);
    });

    it('r1 P1-3: an approved merge question cut off by a crash queues the merge at the restart', async () => {
      const w = await begin(make, {}, { setup: 'npm ci' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await openEscalations(w, 'merge-failed')).length === 1, 'asked');
      const [question] = await openEscalations(w, 'merge-failed');
      await w.repositories.projects.save({ ...project(), revision: 0 }, 0);
      crashOnce(w.repositories.instances, 'update');
      await respond(w, question!.id, 'approve').catch(() => undefined);
      expect(await attemptsOf(w, t.a!)).toHaveLength(1);
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'merged', 'merged after the restart');
      expect((await attemptsOf(r, t.a!)).map((m) => m.state)).toEqual(['failed', 'merged']);
    });

    it('r1 P1-3/P1-4: a declined setup question cut off by a crash gives the task up at the restart, its worktree removed and its work kept', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'setup' ? { exitCode: 1, outputTail: 'boom' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 1, 'asked');
      const [question] = await openEscalations(w, 'setup-failed');
      crashOnce(w.repositories.instances, 'update');
      await respond(w, question!.id, 'decline').catch(() => undefined);
      expect(await statusOf(w, t.a!)).toBe('blocked');
      const r = await w.restart();
      await until(async () => (await taskOf(r, t.a!)).worktree?.cleanup === 'removed', 'given up and removed');
      expect(await statusOf(r, t.a!)).toBe('failed');
    });

    it('r1 P1-4: a crash after a task was given up and before its worktree went: the restart removes it; task.retryCleanup can too', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'setup' ? { exitCode: 1, outputTail: 'boom' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await openEscalations(w, 'setup-failed')).length === 2, 'asked twice');
      const questions = await openEscalations(w, 'setup-failed');
      const pathA = (await taskOf(w, t.a!)).worktree!.path;
      w.git.write(pathA, 'notes.txt', 'kept\n');
      // The commit of A's work never returns (the GUI went down there).
      w.git.hang('commitAll');
      void respond(w, questions.find((q) => q.ref?.kind === 'task' && q.ref.taskId === t.a)!.id, 'decline');
      await until(async () => (await statusOf(w, t.a!)) === 'failed', 'A failed');
      expect((await taskOf(w, t.a!)).worktree?.cleanup).toBe('active');
      const r = await w.restart();
      await until(async () => (await taskOf(r, t.a!)).worktree?.cleanup === 'removed', 'A removed after the restart');
      const a = await taskOf(r, t.a!);
      expect(r.git.fileAt(r.git.tip(CWD, a.worktree!.branch), 'notes.txt')).toBe('kept\n');
      // B the same way, but finished with task.retryCleanup instead of a restart.
      r.git.hang('commitAll');
      void respond(r, questions.find((q) => q.ref?.kind === 'task' && q.ref.taskId === t.b)!.id, 'decline');
      await until(async () => (await statusOf(r, t.b!)) === 'failed', 'B failed');
      expect((await taskOf(r, t.b!)).worktree?.cleanup).toBe('active');
      expect(await r.run({ type: 'task.retryCleanup', requestId: rid(), instanceId: INSTANCE, taskId: t.b! })).toMatchObject({ ok: true });
      expect((await taskOf(r, t.b!)).worktree?.cleanup).toBe('removed');
    });

    it('G-11: root hands off the tasks of a list that waits for the user; they are held (nothing created, counted or sent) and start once it is approved, also across a restart', async () => {
      const w = await begin(make, { confirm: true });
      const asked = await createTasks(w, [item('a', 'A'), item('b', 'B', ['a'])], 'call-held');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const ids = { a: `${asked.taskPlanId}:a` as TaskId, b: `${asked.taskPlanId}:b` as TaskId };
      const ha = await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: ids.a, content: 'build A' }, { operationId: 'op-held-a', sourceCallRef: 'call-held-a' });
      expect(ha).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: ids.b, content: 'build B' });
      // A resend is the same operation; a node that is not root cannot use such an ID.
      expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: ids.a, content: 'build A' }, { operationId: 'op-held-a', sourceCallRef: 'call-held-a' })).toMatchObject({ status: 'duplicate' });
      const held = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === ids.a || h.taskId === ids.b);
      expect(held).toHaveLength(2);
      for (const h of held) expect(await w.repositories.sessions.get(h.target.sessionId!)).toBeUndefined();
      expect(w.git.calls.filter((c) => c.op === 'createWorktree')).toHaveLength(0);
      expect((await instanceOf(w)).tasks).toHaveLength(0);
      // A restart in between sends nothing either.
      const r = await w.restart();
      await settle();
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.delivery.state !== 'pending')).toHaveLength(0);
      const [question] = await openEscalations(r, 'confirmation');
      await respond(r, question!.id, 'approve');
      await until(async () => (await delivered(r, ids.a)) === 1, 'A delivered after the approval');
      // B waits for A to be merged, as any dependent does; its session is there, in its worktree.
      const bSession = await r.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId: ids.b });
      expect((await r.repositories.sessions.get(bSession!))?.cwd).toBe((await taskWorktreeRef(hashOf, CWD, INSTANCE, ids.b)).path);
      expect(await delivered(r, ids.b)).toBe(0);
      await finish(r, ids.a, { 'a.txt': 'a\n' });
      await until(async () => (await delivered(r, ids.b)) === 1, 'B delivered once A merged');
    });

    it('G-11: a declined list cancels what root handed off for it; so does ending the run before the decision', async () => {
      const w = await begin(make, { confirm: true });
      const asked = await createTasks(w, [item('a', 'A')], 'call-decline');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: `${asked.taskPlanId}:a` as TaskId, content: 'build A' });
      await respond(w, asked.escalationId, 'decline');
      const [cancelled] = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === `${asked.taskPlanId}:a`);
      expect(cancelled?.outcome).toMatchObject({ kind: 'cancelled', detail: 'the user declined the task list' });
      expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: `${asked.taskPlanId}:a` as TaskId, content: 'again' })).toMatchObject({ status: 'rejected', rejection: { reason: 'unknown-target' } });
      // Another list, never decided: the run ends.
      const second = await createTasks(w, [item('x', 'X')], 'call-undecided');
      if (second.status !== 'awaiting-confirmation') throw new Error('not asked');
      await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: `${second.taskPlanId}:x` as TaskId, content: 'build X' });
      expect(await w.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: (await instanceOf(w)).revision })).toMatchObject({ ok: true });
      await until(async () => (await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.taskId === `${second.taskPlanId}:x`)?.outcome !== undefined, 'cancelled with the run');
    });

    it('G-11: a crash after the approval and before the held handoffs were adopted is finished by the restart; the receive limit is counted then', async () => {
      const template = pipelineTemplate({ confirm: true });
      const impl = template.nodes.find((n) => n.id === IMPL)!;
      impl.inputRules = [{ id: 'work', condition: 'a task', acceptanceLimit: 1, waitForAllUpstream: false }];
      const w = await make(template);
      await w.repositories.projects.save(project(), null);
      await started(w);
      const asked = await createTasks(w, [item('a', 'A')], 'call-crash');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: 'first' });
      await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: 'second' });
      crashOnce(w.repositories.instances, 'update');
      await respond(w, asked.escalationId, 'approve').catch(() => undefined);
      const r = await w.restart();
      // Counted at the adoption, as T024 counts: the second is over the limit, the task stops and what is still
      // queued of it (the first too) is cancelled; root is asked. Nothing was delivered.
      await until(async () => (await openEscalations(r, 'limit-exceeded')).length === 1, 'the limit escalated after the restart');
      expect((await instanceOf(r)).taskPlans[0]?.state).toBe('created');
      expect(await taskOf(r, a)).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded' });
      const both = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a);
      expect(both.map((h) => [h.delivery.state, h.outcome?.kind])).toEqual([
        ['pending', 'cancelled'],
        ['pending', 'cancelled'],
      ]);
      expect(await delivered(r, a)).toBe(0);
    });

    it('r2 P1-1: held handoffs keep the rework rule: with reworkLimit 0, the second of three stops the task at the approval and nothing is sent', async () => {
      const w = await begin(make, { confirm: true, reworkLimit: 0 });
      const asked = await createTasks(w, [item('a', 'A')], 'call-rework');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      for (const n of [1, 2, 3]) await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: `try ${String(n)}` });
      // Their rework flags follow T024 at acceptance: the first is no rework, the next ones are.
      const sorted = async (x: World) => (await x.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a).sort((p, q) => (p.acceptedAt < q.acceptedAt ? -1 : 1));
      expect((await sorted(w)).map((h) => h.rework)).toEqual([false, true, true]);
      await respond(w, asked.escalationId, 'approve');
      await until(async () => (await openEscalations(w, 'limit-exceeded')).length === 1, 'the rework limit escalated');
      expect(await taskOf(w, a)).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 0 });
      expect((await sorted(w)).map((h) => [h.delivery.state, h.outcome?.kind])).toEqual([
        ['pending', 'cancelled'],
        ['pending', 'cancelled'],
        ['pending', 'cancelled'],
      ]);
      expect(await delivered(w, a)).toBe(0);
    });

    it('r2 P1-2: held handoffs of one root turn stay one fan-out: the waiting node gets nothing until both branches arrived', async () => {
      const base = fanTemplate();
      const template: WorkflowTemplate = {
        ...base,
        isolation: 'worktree',
        nodes: base.nodes.map((n) =>
          n.id === PLAN ? { ...n, outputRules: [...n.outputRules, { id: 'split', condition: 'split', payload: '', target: { kind: 'tasks' as const }, requiresUserConfirmation: true }] } : n,
        ),
      };
      const w = await make(template);
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      await started(w);
      const asked = await createTasks(w, [item('a', 'A')], 'call-fan');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      // In root's one turn: both branches.
      await handoff(w, ROOT, { ruleId: 'to-a', target: { kind: 'node', nodeId: RA }, taskId: a, content: 'review A please' });
      await handoff(w, ROOT, { ruleId: 'to-b', target: { kind: 'node', nodeId: RB }, taskId: a, content: 'review B please' });
      await w.finishTurn(ROOT);
      const rounds = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a).map((h) => h.round);
      expect(new Set(rounds).size).toBe(1);
      await respond(w, asked.escalationId, 'approve');
      const sent = async (node: NodeId) => (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a && h.toNodeId === node && h.delivery.state === 'sent').length;
      await until(async () => (await sent(RA)) === 1 && (await sent(RB)) === 1, 'both branches delivered');
      const ra = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: RA, taskId: a });
      const rb = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: RB, taskId: a });
      expect(await handoff(w, ra!, { ruleId: 'verdict', target: { kind: 'node', nodeId: JOIN }, taskId: a, content: 'A: fine' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      expect(await sent(JOIN)).toBe(0);
      expect((await instanceOf(w)).rounds).toEqual([expect.objectContaining({ nodeId: JOIN, expectedUpstream: [RA, RB], state: 'waiting' })]);
      await handoff(w, rb!, { ruleId: 'verdict', target: { kind: 'node', nodeId: JOIN }, taskId: a, content: 'B: fine' });
      await until(async () => (await sent(JOIN)) >= 1, 'the round delivered once complete');
      expect((await instanceOf(w)).rounds[0]?.state).toBe('ready');
    });

    it('r3 P1-1: a crash after the stop at a limit was written and before its handoffs were cancelled: the restart finishes the stop, nothing is sent', async () => {
      const w = await begin(make, { confirm: true, reworkLimit: 0 });
      const asked = await createTasks(w, [item('a', 'A')], 'call-stop');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      for (const n of [1, 2]) await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: `try ${String(n)}` });
      // The GUI goes down at the first cancellation: the stop itself is already written.
      hangOnce(w.store, 'recordOutcome');
      void respond(w, asked.escalationId, 'approve');
      await until(async () => (await instanceOf(w)).tasks.some((t) => t.id === a && t.status === 'blocked'), 'stopped');
      const r = await w.restart();
      await until(async () => (await openEscalations(r, 'limit-exceeded')).length === 1, 'root asked after the restart');
      expect(await taskOf(r, a)).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded' });
      const both = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a);
      expect(both.map((h) => [h.delivery.state, h.outcome?.kind])).toEqual([
        ['pending', 'cancelled'],
        ['pending', 'cancelled'],
      ]);
      expect(await delivered(r, a)).toBe(0);
    });

    it('r3 P1-1: a crash before the stop at a limit was written: the restart counts again and stops the task the same way', async () => {
      const w = await begin(make, { confirm: true, reworkLimit: 0 });
      const asked = await createTasks(w, [item('a', 'A')], 'call-stop-early');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      for (const n of [1, 2]) await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: `try ${String(n)}` });
      hangOnce(w.repositories.instances, 'update', (next) => (next as WorkflowInstance).tasks.some((t) => t.id === a && t.status === 'blocked'));
      void respond(w, asked.escalationId, 'approve');
      await until(async () => (await instanceOf(w)).tasks.some((t) => t.id === a), 'tasks created');
      await settle();
      expect(await statusOf(w, a)).toBe('pending');
      const r = await w.restart();
      await until(async () => (await openEscalations(r, 'limit-exceeded')).length === 1, 'stopped after the restart');
      expect(await taskOf(r, a)).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded' });
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a).every((h) => h.outcome?.kind === 'cancelled')).toBe(true);
      expect(await delivered(r, a)).toBe(0);
    });

    it('r3 P2: held handoffs cancelled at the approval add no rework, also when a restart rebuilds the count', async () => {
      const w = await begin(make, { confirm: true, reworkLimit: 0 });
      const asked = await createTasks(w, [item('a', 'A')], 'call-recount');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const a = `${asked.taskPlanId}:a` as TaskId;
      for (const n of [1, 2, 3]) await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId: a, content: `try ${String(n)}` });
      await respond(w, asked.escalationId, 'approve');
      await until(async () => (await openEscalations(w, 'limit-exceeded')).length === 1, 'stopped');
      expect((await taskOf(w, a)).reworkCount).toBe(0);
      const r = await w.restart();
      await settle();
      expect((await taskOf(r, a)).reworkCount).toBe(0);
    });

    it('r3 P2: a decline about a missing setup record cut off by a crash gives the task up at the restart', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => {
        if (spec.purpose === 'setup') w.git.write(spec.cwd, 'src/generated.txt', 'generated\n');
        return { exitCode: 0, outputTail: 'ok' };
      };
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.files.saved.delete(path.toLowerCase());
      expect(await finish(w, t.a!, { 'a.txt': 'a\n' })).toMatchObject({ status: 'rejected' });
      const [question] = await openEscalations(w, 'setup-failed');
      // The decline is saved; the GUI goes down before the task is given up.
      hangOnce(w.repositories.instances, 'update', (next) => (next as WorkflowInstance).tasks.some((x) => x.id === t.a && x.status === 'failed'));
      void respond(w, question!.id, 'decline');
      await until(async () => (await w.repositories.escalations.get(question!.id))?.state === 'declined', 'decline saved');
      expect(await statusOf(w, t.a!)).toBe('running');
      const r = await w.restart();
      await until(async () => (await statusOf(r, t.a!)) === 'failed', 'given up after the restart');
      // Without the record its work cannot be committed safely, so its worktree is kept rather than lost.
      expect((await taskOf(r, t.a!)).worktree?.cleanup).toBe('active');
      expect(await r.run({ type: 'task.retryCleanup', requestId: rid(), instanceId: INSTANCE, taskId: t.a! })).toMatchObject({ ok: false, code: 'invalid_transition' });
    });

    it('same-folder runs: create_tasks makes tasks without worktrees; the merge node completes a task and its dependent starts', async () => {
      const w = await begin(make, { isolation: 'same-folder' });
      const instance = await instanceOf(w);
      expect(instance.tasks).toHaveLength(1);
      const t = await made(w, [item('a', 'A'), item('b', 'B', ['a'])]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered');
      expect(await delivered(w, t.b!)).toBe(0);
      const impl = await w.repositories.sessions.get(await implOf(w, t.a!));
      expect(impl?.cwd).toBe(CWD);
      expect(await handoff(w, await implOf(w, t.a!), { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId: t.a! })).toMatchObject({ status: 'accepted' });
      expect(await taskOf(w, t.a!)).toMatchObject({ status: 'completed' });
      await until(async () => (await delivered(w, t.b!)) === 1, 'B delivered');
      expect(w.git.calls.filter((c) => c.op !== 'status' && c.op !== 'resolveBranch')).toEqual([]);
    });

    it('T043 G-6: the integration branch of a failed attempt is deleted with its worktree; the task’s branch and the target stay', async () => {
      const w = await begin(make);
      let red = true;
      w.commands.script = (spec) => (spec.purpose === 'test' && red ? { exitCode: 1, outputTail: 'red' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'A delivered');
      const before = main(w);
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.state === 'tests-failed', 'tests failed');
      const [first] = await attemptsOf(w, t.a!);
      expect(first?.integration).toMatchObject({ cleanup: 'removed' });
      expect(w.git.tip(CWD, first!.integration!.branch)).toBeUndefined();
      expect(w.git.tip(CWD, (await taskOf(w, t.a!)).worktree!.branch)).toBeDefined();
      expect(main(w)).toBe(before);
      // The next attempt gets its own branch and merges as before.
      red = false;
      await finish(w, t.a!, { 'a.txt': 'fixed\n' });
      await until(async () => (await statusOf(w, t.a!)) === 'merged', 'A merged');
      const [, second] = await attemptsOf(w, t.a!);
      expect(w.git.tip(CWD, second!.integration!.branch)).toBeUndefined();
      expect(second!.integration!.branch).not.toBe(first!.integration!.branch);
    });

    it('T043: at startup a worktree left pending-cleanup is tried again; one still held stays pending', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.locked.add(path.toLowerCase());
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await taskOf(w, t.a!)).worktree?.cleanup === 'pending-cleanup', 'pending');
      // Still held at the start: stays pending, was tried (retryCleanup), nothing thrown.
      const held = await w.restart();
      expect((await taskOf(held, t.a!)).worktree?.cleanup).toBe('pending-cleanup');
      expect(held.git.calls.filter((c) => c.op === 'retryCleanup')).toHaveLength(1);
      // task.retryCleanup says so while it is held, and the next start finishes it once it is free (branch deleted: merged).
      expect(await held.run({ type: 'task.retryCleanup', requestId: rid(), instanceId: INSTANCE, taskId: t.a! })).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true });
      held.git.locked.clear();
      const r = await held.restart();
      expect((await taskOf(r, t.a!)).worktree?.cleanup).toBe('removed');
      expect(r.git.tip(CWD, (await taskOf(r, t.a!)).worktree!.branch)).toBeUndefined();
      // Nothing left to retry on the next start.
      const tried = r.git.calls.filter((c) => c.op === 'retryCleanup').length;
      const again = await r.restart();
      expect(again.git.calls.filter((c) => c.op === 'retryCleanup')).toHaveLength(tried);
    });

    it('T043: a pending integration worktree of a failed attempt and a pending task worktree of an ended run are retried at startup', async () => {
      const w = await begin(make);
      w.commands.script = (spec) => (spec.purpose === 'test' ? { exitCode: 1, outputTail: 'red' } : { exitCode: 0, outputTail: 'ok' });
      const t = await made(w, [item('a', 'A'), item('b', 'B')]);
      await give(w, t.a!);
      await give(w, t.b!);
      await until(async () => (await delivered(w, t.a!)) === 1 && (await delivered(w, t.b!)) === 1, 'delivered');
      const integ = await integrationRef(hashOf, CWD, INSTANCE, t.a!, 0);
      w.git.locked.add(integ.path.toLowerCase());
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await attemptsOf(w, t.a!))[0]?.integration?.cleanup === 'pending-cleanup', 'integration pending');
      expect(w.git.tip(CWD, integ.branch)).toBeDefined(); // held: the branch is still there
      // B's worktree is held when the run is cancelled: its work is committed to its branch, the worktree stays pending.
      w.git.locked.add((await taskOf(w, t.b!)).worktree!.path.toLowerCase());
      expect(await w.run({ type: 'workflow.cancel', requestId: rid(), instanceId: INSTANCE, expectedRevision: (await instanceOf(w)).revision })).toMatchObject({ ok: true });
      await until(async () => (await taskOf(w, t.b!)).worktree?.cleanup === 'pending-cleanup', 'B pending');
      w.git.locked.clear();
      const r = await w.restart();
      expect((await attemptsOf(r, t.a!))[0]?.integration?.cleanup).toBe('removed');
      expect(r.git.tip(CWD, integ.branch)).toBeUndefined();
      expect((await taskOf(r, t.b!)).worktree?.cleanup).toBe('removed');
      expect(r.git.tip(CWD, (await taskOf(r, t.b!)).worktree!.branch)).toBeDefined(); // B's work stays on its branch
    });

    it('T043 r1 P1-3: a startup retry leaves a worktree alone while a session of it is given a message by recovery; it is cleaned when that turn ends', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const path = (await taskOf(w, t.a!)).worktree!.path;
      w.git.locked.add(path.toLowerCase());
      await finish(w, t.a!, { 'a.txt': 'a\n' });
      await until(async () => (await taskOf(w, t.a!)).worktree?.cleanup === 'pending-cleanup', 'pending');
      expect(await statusOf(w, t.a!)).toBe('merged');
      // A message accepted for the task's session and not sent before the app went down.
      const impl = await implOf(w, t.a!);
      const session = (await w.repositories.sessions.get(impl))!;
      const accepted = await w.service.delivery.accept({
        kind: 'user-message',
        operationId: 'user-message:t043-pending' as never,
        payloadHash: hashOf('one more thing'),
        payload: 'one more thing',
        proposalRevision: 0,
        target: { sessionId: impl, nativeSessionRef: (await w.service.nativeSessionOf(impl))! },
        at: '2026-11-01T00:00:00.000Z',
        context: { runtime: session.requestedModel.runtime, cwd: session.cwd, entry: { kind: 'new-turn' }, session: { model: session.requestedModel, readOnly: false } },
      });
      expect(accepted.status).toBe('accepted');
      // The restart sends it first (its turn runs); the retry of the pending cleanup must not cut that turn off.
      w.holding.add(impl);
      const retriesBefore = w.git.calls.filter((c) => c.op === 'retryCleanup').length;
      const r = await w.restart();
      await settle();
      expect((await r.store.get('user-message:t043-pending' as never))?.delivery.state).toBe('sent');
      expect(r.closed).not.toContain(impl);
      expect(r.git.calls.filter((c) => c.op === 'retryCleanup')).toHaveLength(retriesBefore);
      expect((await taskOf(r, t.a!)).worktree?.cleanup).toBe('pending-cleanup');
      // The turn ends: the cleanup that was put off is done.
      r.git.locked.clear();
      r.holding.delete(impl);
      await r.finishTurn(impl);
      await until(async () => (await taskOf(r, t.a!)).worktree?.cleanup === 'removed', 'removed after the turn');
      expect(r.closed).toContain(impl);
    });

    it('T043: a task still at work keeps its worktree: nothing is removed or retried at startup', async () => {
      const w = await begin(make);
      const t = await made(w, [item('a', 'A')]);
      await give(w, t.a!);
      await until(async () => (await delivered(w, t.a!)) === 1, 'delivered');
      const r = await w.restart();
      expect(r.git.calls.filter((c) => c.op === 'retryCleanup' || c.op === 'removeWorktree')).toEqual([]);
      expect((await taskOf(r, t.a!)).worktree?.cleanup).toBe('active');
    });
  });

/**
 * Makes one call of `method` never return (where `when` holds): the GUI went down there. Unlike a rejection, which
 * some steps catch and carry on from, nothing after it runs in this process.
 */
const hangOnce = <T extends object, K extends keyof T>(target: T, method: K, when: (...args: unknown[]) => boolean = () => true) => {
  const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let armed = true;
  (target as Record<K, unknown>)[method] = (...args: unknown[]) => {
    if (armed && when(...args)) {
      armed = false;
      return new Promise(() => undefined);
    }
    return original(...args);
  };
};

/** A restart: the previous process's hung git call stays hung (it died with it). */
const r0 = (w: World) => w.restart();


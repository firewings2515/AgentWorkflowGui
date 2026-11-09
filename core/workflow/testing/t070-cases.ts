// T070 (contracts 0.12): the template library through the session service, and the built-in templates run on fake
// runtimes (no model is called). Adding: only that template and its Agents, once, again after a delete, never over what is
// stored, announced with agent.updated / workflow.updated; the 0.11 call unchanged. Running: B, C and I in one folder, D
// through the task pipeline (tasks confirmed, two at once, a send-back, the merge node), each the plain way and with
// send-backs within the rework limit back to root (the trial's §4 point 1 cannot happen: one send-back is one rework).
// The other four go their plain way once. On the memory ports (core/workflow/t070.test.ts) and on SQLite
// (app/main/workflow-t070.test.ts).
import { describe, expect, it } from 'vitest';
import {
  AgentId,
  type AppEvent,
  BUILTIN_AGENT_IDS,
  BUILTIN_WORKFLOW_IDS,
  type BuiltinTemplateKey,
  type HandoffTarget,
  type NodeId,
  type SessionId,
  STARTER_AGENT_IDS,
  STARTER_WORKFLOW_ID,
  type TaskId,
  type TaskPlanItem,
  type WorkflowTemplate,
} from '../../../contracts';
import { project, until } from '../../pipeline/testing/t032-cases';
import { type BuiltinKey, builtinNodeId, builtinSet } from '../builtin-templates';
import { CWD, handoff, INSTANCE, instanceOf, rid, ROOT, settle, started, type World } from './harness';

export type MakeWorld = (workflow?: WorkflowTemplate) => Promise<World>;

const NOW = '2026-11-10T00:00:00.000Z';
const addOf = (template?: BuiltinTemplateKey) => ({ type: 'workflow.addStarter' as const, requestId: rid(), ...(template !== undefined && { template }) });
const updates = (w: World, from: number) =>
  w.events.slice(from).flatMap((e: AppEvent) => (e.type === 'agent.updated' ? [`agent:${e.agent.id}`] : e.type === 'workflow.updated' ? [`workflow:${e.workflow.id}`] : []));

/** A world whose run uses a built-in template, its Agents stored as the library adds them. */
const builtinWorld = async (make: MakeWorld, key: BuiltinKey) => {
  const set = builtinSet(key, [], NOW);
  const w = await make(set.workflow);
  for (const a of set.agents) await w.repositories.agents.save(a, null);
  return { w, workflow: set.workflow };
};

/** The rule `ruleId` of `role`'s node, as a handoff names it. */
const ruleOf = (workflow: WorkflowTemplate, key: BuiltinKey, role: string, ruleId: string): { ruleId: string; target: HandoffTarget } => {
  const rule = workflow.nodes.find((n) => n.id === builtinNodeId(key, role))?.outputRules.find((r) => r.id === ruleId);
  if (rule === undefined || rule.target.kind === 'tasks') throw new Error(`no handoff rule ${role}/${ruleId}`);
  return { ruleId, target: rule.target };
};

/** The session of a (node, task) of the run; the run's only task unless given. */
const nodeSession = async (w: World, nodeId: NodeId, taskId?: TaskId): Promise<SessionId> => {
  const task = taskId ?? (await instanceOf(w)).tasks[0]?.id;
  const id = await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId, ...(task !== undefined && { taskId: task }) });
  if (id === undefined) throw new Error(`no session for ${nodeId}`);
  return id;
};

const limitEscalations = async (w: World) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'limit-exceeded');

/** A run of a same-folder built-in template: `step(role, rule)` hands off from that role's session (root's for the root). */
const runOf = async (make: MakeWorld, key: BuiltinKey, options: { fanOut?: boolean } = {}) => {
  const { w, workflow } = await builtinWorld(make, key);
  // A fan-out is the handoffs of one turn of root: its first turn stays open until `fanOut` ends it.
  if (options.fanOut === true) w.holding.add(ROOT);
  const rootRole = workflow.nodes.find((n) => n.kind === 'agent' && n.isRoot)!.id;
  expect(await started(w, { workflowId: workflow.id })).toMatchObject({ ok: true });
  const step = async (role: string, ruleId: string) => {
    const caller = builtinNodeId(key, role) === rootRole ? ROOT : await nodeSession(w, builtinNodeId(key, role));
    return handoff(w, caller, ruleOf(workflow, key, role, ruleId));
  };
  /** Root fans out to two nodes in one turn (the join waits for both). */
  const fanOut = async (a: string, b: string) => {
    expect(await step('lead', a)).toMatchObject({ status: 'accepted' });
    expect(await step('lead', b)).toMatchObject({ status: 'accepted' });
    await w.finishTurn(ROOT);
    w.holding.delete(ROOT);
  };
  const reachedRoot = async (times: number) => {
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).at(-1)).toMatchObject({ toNodeId: rootRole, rework: false });
    expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'running', reworkCount: times, currentNodeId: rootRole });
    expect(await limitEscalations(w)).toEqual([]);
  };
  return { w, workflow, step, fanOut, reachedRoot };
};

const accepted = { status: 'accepted' };

export const t070LibraryCases = (backend: string, make: MakeWorld) =>
  describe(`T070 the template library through workflow.addStarter (${backend})`, () => {
    it('a key adds only that template and its own Agents, announced; a repeat adds and announces nothing', async () => {
      const w = await make();
      const before = { agents: (await w.repositories.agents.list()).map((a) => a.id), workflows: (await w.repositories.workflows.list()).map((x) => x.id) };
      const from = w.events.length;
      expect(await w.run(addOf('tdd'))).toMatchObject({ ok: true, revision: 0 });
      const agents = (await w.repositories.agents.list()).map((a) => a.id).filter((id) => !before.agents.includes(id));
      const workflows = (await w.repositories.workflows.list()).map((x) => x.id).filter((id) => !before.workflows.includes(id));
      expect(agents.sort()).toEqual(Object.values(BUILTIN_AGENT_IDS.tdd).sort());
      expect(workflows).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
      expect(updates(w, from).sort()).toEqual([...Object.values(BUILTIN_AGENT_IDS.tdd).map((id) => `agent:${id}`), `workflow:${BUILTIN_WORKFLOW_IDS.tdd}`].sort());
      const announced = w.events.slice(from).find((e) => e.type === 'workflow.updated');
      expect(announced?.type === 'workflow.updated' && announced.workflow).toEqual(await w.repositories.workflows.get(BUILTIN_WORKFLOW_IDS.tdd));
      const again = w.events.length;
      expect(await w.run(addOf('tdd'))).toMatchObject({ ok: true, revision: 0 });
      expect(updates(w, again)).toEqual([]);
      expect((await w.repositories.workflows.list()).filter((x) => x.id === BUILTIN_WORKFLOW_IDS.tdd)).toHaveLength(1);
    });

    it('r1 P2-1: an Agent stored under the template\'s ID is not announced: only what was written now, by its kind', async () => {
      const w = await make();
      const own = (await w.repositories.agents.list())[0]!;
      const twin = { ...own, id: AgentId.parse(BUILTIN_WORKFLOW_IDS.tdd), name: '名字和範本 ID 一樣的 Agent' };
      expect((await w.repositories.agents.save(twin, null)).status).toBe('saved');
      const from = w.events.length;
      expect(await w.run(addOf('tdd'))).toMatchObject({ ok: true, revision: 0 });
      const announced = updates(w, from);
      expect(announced).not.toContain(`agent:${BUILTIN_WORKFLOW_IDS.tdd}`);
      expect(announced.sort()).toEqual([...Object.values(BUILTIN_AGENT_IDS.tdd).map((id) => `agent:${id}`), `workflow:${BUILTIN_WORKFLOW_IDS.tdd}`].sort());
      expect(await w.repositories.agents.get(twin.id)).toMatchObject({ name: '名字和範本 ID 一樣的 Agent', revision: 0 });
    });

    it('deleted, it is added again through the command; the Agent kept is not announced and not overwritten', async () => {
      const w = await make();
      await w.run(addOf('safe-refactor'));
      const analyst = (await w.repositories.agents.get(BUILTIN_AGENT_IDS['safe-refactor'].analyst))!;
      await w.repositories.agents.save({ ...analyst, name: '重構・我的分析' }, 0);
      expect(await w.run({ type: 'workflow.delete', requestId: rid(), workflowId: BUILTIN_WORKFLOW_IDS['safe-refactor'], expectedRevision: 0 })).toMatchObject({ ok: true });
      const from = w.events.length;
      expect(await w.run(addOf('safe-refactor'))).toMatchObject({ ok: true, revision: 0 });
      expect(updates(w, from)).toEqual([`workflow:${BUILTIN_WORKFLOW_IDS['safe-refactor']}`]);
      expect(await w.repositories.agents.get(analyst.id)).toMatchObject({ name: '重構・我的分析', revision: 1 });
    });

    it('an edited template under its ID is kept, and its revision returned', async () => {
      const w = await make();
      await w.run(addOf('routing'));
      const saved = (await w.repositories.workflows.get(BUILTIN_WORKFLOW_IDS.routing))!;
      await w.repositories.workflows.save({ ...saved, name: '我的分流' }, 0);
      expect(await w.run(addOf('routing'))).toMatchObject({ ok: true, revision: 1 });
      expect(await w.repositories.workflows.get(BUILTIN_WORKFLOW_IDS.routing)).toMatchObject({ name: '我的分流' });
    });

    it('the 0.11 call (no template) is the starter set, as before, now announced', async () => {
      const w = await make();
      const from = w.events.length;
      expect(await w.run(addOf())).toMatchObject({ ok: true, revision: 0 });
      expect(await w.repositories.workflows.get(STARTER_WORKFLOW_ID)).toBeDefined();
      expect(await w.repositories.workflows.get(BUILTIN_WORKFLOW_IDS.tdd)).toBeUndefined();
      expect(updates(w, from).sort()).toEqual([...Object.values(STARTER_AGENT_IDS).map((id) => `agent:${id}`), `workflow:${STARTER_WORKFLOW_ID}`].sort());
      expect(await w.run(addOf('starter'))).toMatchObject({ ok: true, revision: 0 });
    });

    it('a template added from the library starts a run', async () => {
      const w = await make();
      await w.run(addOf('evaluator-optimizer'));
      expect(await started(w, { workflowId: BUILTIN_WORKFLOW_IDS['evaluator-optimizer'] })).toMatchObject({ ok: true });
      expect((await instanceOf(w)).template.id).toBe(BUILTIN_WORKFLOW_IDS['evaluator-optimizer']);
    });
  });

export const t070RunCases = (backend: string, make: MakeWorld) =>
  describe(`T070 the built-in templates on fake runtimes (${backend})`, () => {
    it.each([0, 1, 2])('B 評估者－優化者: sent back %i time(s), the judge\'s pass reaches root within the limit', async (times) => {
      const r = await runOf(make, 'evaluator-optimizer');
      expect(await r.step('lead', 'lead-writer')).toMatchObject(accepted);
      expect(await r.step('writer', 'writer-judge')).toMatchObject(accepted);
      for (let i = 0; i < times; i++) {
        expect(await r.step('judge', 'judge-rework')).toMatchObject(accepted);
        expect(await r.step('writer', 'writer-judge')).toMatchObject(accepted);
      }
      expect(await r.step('judge', 'judge-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(times);
    });

    it('B: a third send-back is stopped (limit-exceeded) and left to the user', async () => {
      const r = await runOf(make, 'evaluator-optimizer');
      await r.step('lead', 'lead-writer');
      await r.step('writer', 'writer-judge');
      for (let i = 0; i < 2; i++) {
        await r.step('judge', 'judge-rework');
        await r.step('writer', 'writer-judge');
      }
      expect(await r.step('judge', 'judge-rework')).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      expect((await instanceOf(r.w)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 2 });
    });

    it.each([0, 1, 2])('C TDD: sent back %i time(s) by the verifier, the pass reaches root within the limit', async (times) => {
      const r = await runOf(make, 'tdd');
      expect(await r.step('lead', 'lead-tester')).toMatchObject(accepted);
      expect(await r.step('tester', 'tester-builder')).toMatchObject(accepted);
      expect(await r.step('builder', 'builder-verifier')).toMatchObject(accepted);
      for (let i = 0; i < times; i++) {
        expect(await r.step('verifier', 'verifier-rework')).toMatchObject(accepted);
        expect(await r.step('builder', 'builder-verifier')).toMatchObject(accepted);
      }
      expect(await r.step('verifier', 'verifier-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(times);
      // The test writer was passed once only: a send-back never goes back to it.
      expect((await r.w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === builtinNodeId('tdd', 'tester'))).toHaveLength(1);
    });

    it.each([0, 1, 2])('I 交叉審查: both reviews join, then sent back %i time(s) by the verifier, the pass reaches root', async (times) => {
      const r = await runOf(make, 'cross-review', { fanOut: true });
      await r.fanOut('lead-revA', 'lead-revB');
      expect(await r.step('review-claude', 'revA-fixer')).toMatchObject(accepted);
      expect(await r.step('review-codex', 'revB-fixer')).toMatchObject(accepted);
      await settle();
      expect((await instanceOf(r.w)).rounds.map((x) => x.state)).toEqual(['ready']);
      expect(await r.step('fixer', 'fixer-verifier')).toMatchObject(accepted);
      for (let i = 0; i < times; i++) {
        expect(await r.step('verifier', 'verifier-rework')).toMatchObject(accepted);
        await settle();
        // The new round waits only for the verifier, which sent it: the fixer takes it at once.
        expect((await instanceOf(r.w)).rounds.at(-1)?.state).toBe('ready');
        expect(await r.step('fixer', 'fixer-verifier')).toMatchObject(accepted);
      }
      expect(await r.step('verifier', 'verifier-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(times);
    });

    it('E 平行審查: two reviews at once, the merger waits for both, then root', async () => {
      const r = await runOf(make, 'parallel-review', { fanOut: true });
      await r.fanOut('lead-correct', 'lead-robust');
      expect(await r.step('correctness', 'correct-merge')).toMatchObject(accepted);
      await settle();
      expect((await instanceOf(r.w)).rounds.map((x) => x.state)).toEqual(['waiting']);
      expect(await r.step('robustness', 'robust-merge')).toMatchObject(accepted);
      await settle();
      expect((await instanceOf(r.w)).rounds.map((x) => x.state)).toEqual(['ready']);
      expect(await r.step('merger', 'merger-root')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(0);
    });

    it('F 路由: root takes one path; the other node is never used', async () => {
      const r = await runOf(make, 'routing');
      expect(await r.step('lead', 'route-bug')).toMatchObject(accepted);
      expect(await r.step('fixer', 'fixer-review')).toMatchObject(accepted);
      expect(await r.step('reviewer', 'review-fixer')).toMatchObject(accepted);
      expect(await r.step('fixer', 'fixer-review')).toMatchObject(accepted);
      expect(await r.step('reviewer', 'review-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(1);
      expect((await r.w.repositories.handoffs.listByInstance(INSTANCE)).some((h) => h.toNodeId === builtinNodeId('routing', 'feature'))).toBe(false);
    });

    it('G 文件: one send-back by the checker, then root (the trial\'s only rework, now counted once)', async () => {
      const r = await runOf(make, 'docs-review');
      await r.step('lead', 'lead-writer');
      await r.step('writer', 'writer-checker');
      expect(await r.step('checker', 'checker-rework')).toMatchObject(accepted);
      await r.step('writer', 'writer-checker');
      expect(await r.step('checker', 'checker-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(1);
    });

    it('H 安全重構: analyse, refactor, verify, root', async () => {
      const r = await runOf(make, 'safe-refactor');
      await r.step('lead', 'lead-analyst');
      await r.step('analyst', 'analyst-refactorer');
      await r.step('refactorer', 'refactorer-verifier');
      expect(await r.step('verifier', 'verifier-pass')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await r.reachedRoot(0);
    });

    it('D 規格驅動: tasks confirmed by the user, two built at once, one sent back once, both merged by the merge node, root told', async () => {
      const key = 'spec-parallel';
      const { w, workflow } = await builtinWorld(make, key);
      // The merge node tests before the target branch moves: the project has its test command.
      await w.repositories.projects.save(project(), null);
      expect(await started(w, { workflowId: workflow.id })).toMatchObject({ ok: true });
      const builder = builtinNodeId(key, 'builder');
      const reviewer = builtinNodeId(key, 'reviewer');
      const item = (k: string, title: string): TaskPlanItem => ({ key: k, title, dependsOn: [], dependsOnExisting: [] });
      // O-07: the list waits for the user.
      const asked = await w.engine.createTasks({ ruleId: 'lead-tasks', tasks: [item('a', 'A'), item('b', 'B'), item('c', 'C')] }, { caller: ROOT, sourceCallRef: 'tasks-1' });
      if (asked.status !== 'awaiting-confirmation') throw new Error(`not asked: ${JSON.stringify(asked)}`);
      expect((await instanceOf(w)).tasks).toHaveLength(0);
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' })).toMatchObject({ ok: true });
      const tasks = (await instanceOf(w)).tasks;
      const [a, b, c] = tasks.map((t) => t.id) as [TaskId, TaskId, TaskId];
      const give = (taskId: TaskId) => handoff(w, ROOT, { ...ruleOf(workflow, key, 'lead', 'lead-builder'), taskId });
      const deliveredTo = async (nodeId: NodeId, taskId: TaskId) =>
        (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === taskId && h.toNodeId === nodeId && h.delivery.state === 'sent').length;
      const worktree = async (taskId: TaskId) => (await instanceOf(w)).tasks.find((t) => t.id === taskId)!.worktree!.path;
      const from = async (nodeId: NodeId, taskId: TaskId, role: string, ruleId: string) => handoff(w, await nodeSession(w, nodeId, taskId), { ...ruleOf(workflow, key, role, ruleId), taskId });
      const statusOf = async (taskId: TaskId) => (await instanceOf(w)).tasks.find((t) => t.id === taskId)?.status;

      for (const t of [a, b, c]) expect(await give(t)).toMatchObject(accepted);
      await until(async () => (await deliveredTo(builder, a)) === 1 && (await deliveredTo(builder, b)) === 1, 'two tasks at the builder');
      // Concurrency 2: the third waits for a slot.
      expect(await deliveredTo(builder, c)).toBe(0);

      // A: built, sent back once by the reviewer, built again, passed to the merge node.
      w.git.write(await worktree(a), 'feature-a.txt', 'a1\n');
      expect(await from(builder, a, 'builder', 'builder-reviewer')).toMatchObject(accepted);
      await until(async () => (await deliveredTo(reviewer, a)) === 1, 'A at the reviewer');
      await until(async () => (await deliveredTo(builder, c)) === 1, 'C takes the free slot');
      expect(await from(reviewer, a, 'reviewer', 'reviewer-rework')).toMatchObject(accepted);
      w.git.write(await worktree(a), 'feature-a.txt', 'a2\n');
      expect(await from(builder, a, 'builder', 'builder-reviewer')).toMatchObject(accepted);
      expect(await from(reviewer, a, 'reviewer', 'reviewer-merge')).toMatchObject(accepted);
      await until(async () => (await statusOf(a)) === 'merged', 'A merged');

      // B and C the plain way.
      for (const t of [b, c]) {
        w.git.write(await worktree(t), `feature-${t}.txt`, 'x\n');
        expect(await from(builder, t, 'builder', 'builder-reviewer')).toMatchObject(accepted);
        await until(async () => (await deliveredTo(reviewer, t)) === 1, 'at the reviewer');
        expect(await from(reviewer, t, 'reviewer', 'reviewer-merge')).toMatchObject(accepted);
        await until(async () => (await statusOf(t)) === 'merged', 'merged');
      }

      const run = await instanceOf(w);
      expect(run.tasks.map((t) => [t.status, t.reworkCount])).toEqual([['merged', 1], ['merged', 0], ['merged', 0]]);
      // The builder's work reached the target branch through the GUI's commits and the merge.
      expect(w.git.fileAt(w.git.tip(CWD, 'main'), 'feature-a.txt')).toBe('a2\n');
      expect(await limitEscalations(w)).toEqual([]);
      // The merge node tested each one before the branch moved (the project's test command); root is told of each merge.
      expect(run.mergeQueue.filter((m) => m.state === 'merged')).toHaveLength(3);
      expect(w.commands.of('test').map((spec) => spec.command)).toEqual(['npm test', 'npm test', 'npm test']);
      await settle();
      const toRoot = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === builtinNodeId(key, 'lead'));
      expect(toRoot.map((h) => [h.fromNodeId, h.taskId])).toEqual([[builtinNodeId(key, 'merge'), a], [builtinNodeId(key, 'merge'), b], [builtinNodeId(key, 'merge'), c]]);
    });
  });

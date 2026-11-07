// T064: one send-back is one rework. A task's rework count is how often it came back to one node (the most of any
// node), so a loop counts once, whatever nodes it passes; in the starter template the report to root at the end is no
// rework. On the harness (memory ports, fake adapters, real restarts): the starter set's own template, implement ⇄
// review, a waiting node, a restart, handoffs marked before T064, held handoffs and reports to root.
import { describe, expect, it } from 'vitest';
import { type Handoff, HandoffId, InstanceId, NodeId, OperationId, SessionId, TaskId } from '../../contracts';
import type { AcceptInput, HandoffMeta } from '../ports';
import { handoffCounts, isRework, nodeOf, receivedCount, reworkSoFar, taskProgress } from './graph';
import { starterSet } from './starter';
import { until } from '../pipeline/testing/t032-cases';
import { handoff, IMPL, INSTANCE, instanceOf, PLAN, REVIEW, rid, ROOT, sessionOf, settle, started, template, world, type World } from './testing/harness';
import { fanTemplate, JOIN, RA, RB } from './testing/t031-cases';

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const rework = { ruleId: 'rework', target: { kind: 'node' as const, nodeId: IMPL } };
const done = { ruleId: 'done', target: { kind: 'root' as const } };

/** The starter set itself (T063): its Agents and its template, nodes, rules and edges as a first start adds them. */
const STARTER_SET = starterSet([], '2026-11-07T00:00:00.000Z');
const STARTER_TEMPLATE = STARTER_SET.workflow;
const [SP, SI, SR] = STARTER_TEMPLATE.nodes.map((n) => n.id) as [NodeId, NodeId, NodeId];
const ruleTo = (from: NodeId, to: NodeId) => {
  const rule = STARTER_TEMPLATE.nodes.find((n) => n.id === from)?.outputRules.find((r) => r.target.kind === 'node' && r.target.nodeId === to);
  if (rule === undefined) throw new Error(`no rule ${from} → ${to}`);
  return { ruleId: rule.id, target: { kind: 'node' as const, nodeId: to } };
};
const sToImpl = ruleTo(SP, SI);
const sToReview = ruleTo(SI, SR);
const sToPlan = ruleTo(SR, SP);

/** A world with the starter set saved, as a first start leaves it. */
const starterWorld = async () => {
  const w = await world(STARTER_TEMPLATE);
  for (const a of STARTER_SET.agents) await w.repositories.agents.save(a, null);
  return w;
};

const flags = async (w: World) => (await w.repositories.handoffs.listByInstance(INSTANCE)).map((h) => [h.fromNodeId, h.toNodeId, h.rework]);
const limitEscalations = async (w: World) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'limit-exceeded');

/** plan → implement → review in the harness template. */
const firstLoop = async (w: World) => {
  await started(w);
  expect(await handoff(w, ROOT, toImpl)).toMatchObject({ status: 'accepted' });
  const impl = await sessionOf(w, IMPL);
  expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'accepted' });
  return { impl, review: await sessionOf(w, REVIEW) };
};

/** 規劃 → 實作 → 審查 in the starter template. */
const starterFirstLoop = async (w: World) => {
  expect(await started(w, { workflowId: STARTER_TEMPLATE.id })).toMatchObject({ ok: true });
  expect(await handoff(w, ROOT, sToImpl)).toMatchObject({ status: 'accepted' });
  const impl = await sessionOf(w, SI);
  expect(await handoff(w, impl, sToReview)).toMatchObject({ status: 'accepted' });
  return { impl, review: await sessionOf(w, SR) };
};

/** In the starter template: review sends the task back to plan and plan gives it to implement again; then implement hands it to review. */
const starterSendBack = async (w: World, impl: SessionId, review: SessionId) => {
  expect(await handoff(w, review, { ...sToPlan, content: 'needs work' })).toMatchObject({ status: 'accepted' });
  const again = await handoff(w, ROOT, sToImpl);
  if (again.status !== 'accepted') return again;
  expect(await handoff(w, impl, sToReview)).toMatchObject({ status: 'accepted' });
  return again;
};

describe('T064 the starter template: one send-back is one rework', () => {
  it('the starter set keeps a limit that allows two send-backs', () => {
    expect(STARTER_TEMPLATE.reworkLimit).toBe(2);
  });

  it.each([0, 1, 2])('sent back %i time(s), the passing review reaches root, within the limit', async (times) => {
    const w = await starterWorld();
    const { impl, review } = await starterFirstLoop(w);
    for (let i = 0; i < times; i++) expect(await starterSendBack(w, impl, review)).toMatchObject({ status: 'accepted' });
    expect((await instanceOf(w)).tasks[0]?.reworkCount).toBe(times);
    // The report to root: root received the task fewer times than implement, so it is no rework.
    const passed = await handoff(w, review, { ...sToPlan, content: 'approved' });
    expect(passed).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).at(-1)).toMatchObject({ toNodeId: SP, rework: false });
    expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'running', reworkCount: times, currentNodeId: SP });
    expect(await limitEscalations(w)).toEqual([]);
  });

  it('every handoff of two send-backs and a pass: only implement coming back counts', async () => {
    const w = await starterWorld();
    const { impl, review } = await starterFirstLoop(w);
    await starterSendBack(w, impl, review);
    await starterSendBack(w, impl, review);
    await handoff(w, review, { ...sToPlan, content: 'approved' });
    expect(await flags(w)).toEqual([
      [SP, SI, false],
      [SI, SR, false],
      [SR, SP, false],
      [SP, SI, true],
      [SI, SR, false],
      [SR, SP, false],
      [SP, SI, true],
      [SI, SR, false],
      [SR, SP, false],
    ]);
  });

  it('a third send-back is stopped when plan gives the task to implement again: escalated (limit-exceeded), the task blocked', async () => {
    const w = await starterWorld();
    const { impl, review } = await starterFirstLoop(w);
    await starterSendBack(w, impl, review);
    await starterSendBack(w, impl, review);
    // The send-back itself still reaches plan; giving the task to implement a fourth time is over the limit.
    const over = await starterSendBack(w, impl, review);
    expect(over).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).at(-1)).toMatchObject({ fromNodeId: SR, toNodeId: SP, rework: false });
    expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 2 });
    expect(await limitEscalations(w)).toEqual([expect.objectContaining({ fromSessionId: ROOT, detail: expect.stringContaining('rework limit of 2') as unknown })]);
  });
});

describe('T064 implement ⇄ review, then root', () => {
  it.each([0, 1, 2])('sent back to implement %i time(s), the verdict reaches root', async (times) => {
    const w = await world();
    const { impl, review } = await firstLoop(w);
    for (let i = 0; i < times; i++) {
      expect(await handoff(w, review, rework)).toMatchObject({ status: 'accepted' });
      expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'accepted' });
    }
    expect(await handoff(w, review, done)).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'running', reworkCount: times, currentNodeId: PLAN });
    // Each loop marks implement coming back; review coming back and the report to root add nothing.
    expect((await flags(w)).filter(([, , r]) => r)).toEqual(Array.from({ length: times }, () => [REVIEW, IMPL, true]));
  });

  it('a third send-back to implement is stopped', async () => {
    const w = await world();
    const { impl, review } = await firstLoop(w);
    for (let i = 0; i < 2; i++) {
      await handoff(w, review, rework);
      await handoff(w, impl, toReview);
    }
    expect(await handoff(w, review, rework)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 2 });
  });
});

describe('T064 a node that waits for all upstream', () => {
  it('a second fan-out is one rework: Review A coming back marks it, Review B and the second round of Verdict add nothing', async () => {
    const w = await world(fanTemplate());
    w.holding.add(ROOT);
    await started(w);
    const toA = { ruleId: 'to-a', target: { kind: 'node' as const, nodeId: RA } };
    const toB = { ruleId: 'to-b', target: { kind: 'node' as const, nodeId: RB } };
    const verdict = { ruleId: 'verdict', target: { kind: 'node' as const, nodeId: JOIN } };
    await handoff(w, ROOT, toA);
    await handoff(w, ROOT, toB);
    await w.finishTurn(ROOT);
    const ra = await sessionOf(w, RA);
    const rb = await sessionOf(w, RB);
    await handoff(w, ra, verdict);
    await handoff(w, rb, verdict);
    await settle();
    // Root fans out again in a later turn: the second loop.
    w.emitTurn(ROOT, 'root-2', 'running');
    await settle();
    await handoff(w, ROOT, toA);
    await handoff(w, ROOT, toB);
    w.emitTurn(ROOT, 'root-2', 'completed');
    await settle();
    await handoff(w, ra, verdict);
    await handoff(w, rb, verdict);
    await settle();
    expect((await instanceOf(w)).rounds.map((r) => [r.round, r.state])).toEqual([[1, 'ready'], [2, 'ready']]);
    // Expected (T064): the loop counts once, on the first handoff that came back to a node (Review A, sent
    // first). Review B came back as often, but that is the same loop, so it is not marked; nor is Verdict's
    // second round, whose two arrivals count as one receipt anyway (CR-4).
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).map((h) => [h.toNodeId, h.round, h.rework])).toEqual([
      [RA, 1, false],
      [RB, 1, false],
      [JOIN, 1, false],
      [JOIN, 1, false],
      [RA, 2, true],
      [RB, 2, false],
      [JOIN, 2, false],
      [JOIN, 2, false],
    ]);
    expect((await instanceOf(w)).tasks[0]?.reworkCount).toBe(1);
  });
});

describe('T064 restart and handoffs marked before T064', () => {
  it('a restart rebuilds the count of the new rule from the handoffs, and counting goes on from it', async () => {
    const w = await starterWorld();
    const { impl, review } = await starterFirstLoop(w);
    await starterSendBack(w, impl, review);
    await starterSendBack(w, impl, review);
    // A crash after acceptance, before the task record caught up.
    const instance = await instanceOf(w);
    await w.repositories.instances.update({ ...instance, revision: instance.revision + 1, tasks: instance.tasks.map((t) => ({ ...t, reworkCount: 0 })) }, instance.revision);
    const after = await w.restart();
    await settle();
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ reworkCount: 2, currentNodeId: SR });
    // Counting goes on from the store: a third send-back is stopped.
    expect(await starterSendBack(after, impl, review)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 2 });
  });

  /** Makes the engine mark and count handoffs as before T064: every return to a node that had the task is rework. */
  const asBeforeT064 = (w: World) => {
    const original = w.store.accept.bind(w.store);
    w.store.accept = async (input: AcceptInput) => {
      if (input.kind !== 'handoff' || input.handoff === undefined || input.counts === undefined) return original(input);
      const instance = await instanceOf(w);
      const meta = input.handoff;
      const handoffs = await w.repositories.handoffs.listByInstance(INSTANCE);
      const old = handoffs.some((h) => h.taskId === meta.taskId && h.toNodeId === meta.toNodeId);
      const { counts } = handoffCounts(instance, handoffs, meta.taskId, nodeOf(instance.template, meta.toNodeId)!, old);
      const marked: HandoffMeta = { ...meta, rework: old };
      return original({ ...input, counts, handoff: marked });
    };
    return () => {
      w.store.accept = original;
    };
  };

  /** A run sent back once before T064 (marked twice, the count at the limit of 2), then updated and restarted. */
  const sentBackBeforeT064 = async () => {
    const w = await starterWorld();
    const end = asBeforeT064(w);
    const { impl, review } = await starterFirstLoop(w);
    await starterSendBack(w, impl, review);
    end();
    expect(await flags(w)).toEqual([
      [SP, SI, false],
      [SI, SR, false],
      [SR, SP, false],
      [SP, SI, true],
      [SI, SR, true],
    ]);
    // The update: the stored marks are read as they are, and a restart rebuilds the count from them.
    const after = await w.restart();
    await settle();
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ status: 'running', reworkCount: 2 });
    return { after, impl, review };
  };

  it('a run sent back once before T064 (marked twice) reads as it was, and its passing review now reaches root', async () => {
    const { after, review } = await sentBackBeforeT064();
    // Before T064 this handoff was stopped (a third rework over the limit of 2).
    expect(await handoff(after, review, { ...sToPlan, content: 'approved' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ status: 'running', reworkCount: 2, currentNodeId: SP });
  });

  it('a run sent back once before T064 gets no sudden stop and no extra allowance: a second send-back goes and passes', async () => {
    const { after, impl, review } = await sentBackBeforeT064();
    // Implement's third receipt is not past the count of 2: no rework, the count stays.
    expect(await starterSendBack(after, impl, review)).toMatchObject({ status: 'accepted' });
    expect((await after.repositories.handoffs.listByInstance(INSTANCE)).slice(-3).map((h) => h.rework)).toEqual([false, false, false]);
    expect(await handoff(after, review, { ...sToPlan, content: 'approved' })).toMatchObject({ status: 'accepted' });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ status: 'running', reworkCount: 2 });
  });

  it('a run sent back once before T064 stops at the third send-back, as with the new count from the start', async () => {
    const { after, impl, review } = await sentBackBeforeT064();
    expect(await starterSendBack(after, impl, review)).toMatchObject({ status: 'accepted' });
    expect(await starterSendBack(after, impl, review)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'limit-exceeded', reworkCount: 2 });
  });
});

describe('T064 r1: held handoffs and reports to root', () => {
  it('P2-1 a task list the user approves later: the shown count follows the marks, live as after a restart', async () => {
    const w = await starterWorld();
    expect(await started(w, { workflowId: STARTER_TEMPLATE.id })).toMatchObject({ ok: true });
    const asked = await w.engine.createTasks({ ruleId: 'plan-tasks', tasks: [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }] }, { caller: ROOT, sourceCallRef: 'call-tasks' });
    if (asked.status !== 'awaiting-confirmation') throw new Error(`not asked: ${JSON.stringify(asked)}`);
    const a = TaskId.parse(`${asked.taskPlanId}:a`);
    // Root gives the task to implement twice while its list waits for the user: held, counted at the approval.
    for (const n of [1, 2]) expect(await handoff(w, ROOT, { ...sToImpl, taskId: a, content: `try ${String(n)}` })).toMatchObject({ status: 'accepted' });
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' });
    const taskA = async (x: World) => (await instanceOf(x)).tasks.find((t) => t.id === a);
    await until(async () => (await taskA(w))?.status === 'running', 'task A running');
    const marks = async (x: World) => (await x.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.taskId === a && h.rework).length;
    expect(await marks(w)).toBe(1);
    expect((await taskA(w))?.reworkCount).toBe(1);
    // One more loop: implement coming back a third time is the second rework. The store never counted the held
    // one, so its count of the key is 1; the task shows the marks, 2, as a restart rebuilds it.
    const node = async (nodeId: NodeId) => (await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId, taskId: a }))!;
    const impl = await node(SI);
    expect(await handoff(w, impl, { ...sToReview, taskId: a })).toMatchObject({ status: 'accepted' });
    const review = await node(SR);
    expect(await handoff(w, review, { ...sToPlan, taskId: a, content: 'needs work' })).toMatchObject({ status: 'accepted' });
    expect(await handoff(w, ROOT, { ...sToImpl, taskId: a, content: 'try 3' })).toMatchObject({ status: 'accepted' });
    expect(await marks(w)).toBe(2);
    expect((await taskA(w))?.reworkCount).toBe(2);
    const after = await w.restart();
    await settle();
    expect((await taskA(after))?.reworkCount).toBe(2);
  });

  it('P2-2 a report to root is rework when root already received the task more times than the count: no promise that it never is', async () => {
    const report = { id: 'done', condition: 'done', payload: '', target: { kind: 'root' as const }, requiresUserConfirmation: false };
    const w = await world(
      template(
        { reworkLimit: 0, edges: [{ source: PLAN, target: IMPL }, { source: PLAN, target: REVIEW }] },
        {
          plan: { outputRules: [{ ...report, id: 'to-impl', target: { kind: 'node', nodeId: IMPL } }, { ...report, id: 'to-review', target: { kind: 'node', nodeId: REVIEW } }] },
          impl: { outputRules: [report] },
          review: { outputRules: [report] },
        },
      ),
    );
    await started(w);
    await handoff(w, ROOT, toImpl);
    await handoff(w, ROOT, toReview);
    expect(await handoff(w, await sessionOf(w, IMPL), done)).toMatchObject({ status: 'accepted' });
    // Root's second receipt is more than the count of 0: rework, over the limit of 0.
    expect(await handoff(w, await sessionOf(w, REVIEW), done)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
  });
});

describe('T064 the rule on hand-made handoffs', () => {
  const TASK = TaskId.parse('run-1:task');
  let n = 0;
  const h = (to: NodeId, round: number, rework: boolean): Handoff =>
    ({
      id: HandoffId.parse(`handoff-${String(++n)}`),
      operationId: OperationId.parse(`op-${String(n)}`),
      sourceCallRef: `call-${String(n)}`,
      instanceId: InstanceId.parse('run-1'),
      taskId: TASK,
      fromNodeId: PLAN,
      toNodeId: to,
      fromSessionId: SessionId.parse('s'),
      ruleId: 'r',
      rework,
      payload: 'x',
      payloadHash: 'sha256:00',
      proposalRevision: 0,
      round,
      target: {},
      delivery: { state: 'pending', attempts: [] },
      acceptedAt: new Date(Date.UTC(2026, 10, 7, 0, 0, 0, n)).toISOString(),
    });

  /** Accepts each target in order, marking it by the rule: the marks always sum to the most returns of any node. */
  const walk = (targets: NodeId[]) => {
    const handoffs: Handoff[] = [];
    for (const to of targets) handoffs.push(h(to, 0, isRework(handoffs, TASK, to)));
    return handoffs;
  };

  it('the marks are the most returns of one node, for any order of handoffs', () => {
    const paths: NodeId[][] = [
      [IMPL, REVIEW, PLAN, IMPL, REVIEW, PLAN, IMPL, REVIEW, PLAN],
      [IMPL, REVIEW, IMPL, REVIEW, IMPL, REVIEW, PLAN],
      [IMPL, IMPL, IMPL, REVIEW, REVIEW, REVIEW, REVIEW, PLAN],
      [REVIEW, IMPL, PLAN, REVIEW, IMPL, IMPL],
    ];
    for (const path of paths) {
      const handoffs = walk(path);
      const most = Math.max(...[IMPL, REVIEW, PLAN].map((node) => Math.max(0, path.filter((p) => p === node).length - 1)));
      expect(taskProgress(handoffs, TASK).reworkCount).toBe(most);
      expect(reworkSoFar(handoffs, TASK)).toBe(most);
    }
  });

  it('a waiting node counts its earlier rounds, never another arrival of the round arriving; stored round 0 counts one by one', () => {
    const before = [h(JOIN, 1, false), h(JOIN, 1, false)];
    expect(receivedCount(before, TASK, JOIN, true)).toBe(1);
    // Round 1 again: no earlier round; round 2: one earlier round, not more than the count of 0.
    expect(isRework(before, TASK, JOIN, 1)).toBe(false);
    expect(isRework(before, TASK, JOIN, 2)).toBe(true);
    expect(isRework([...before, h(IMPL, 0, true)], TASK, JOIN, 2)).toBe(false);
    const legacy = [h(JOIN, 0, false), h(JOIN, 0, false)];
    expect(receivedCount(legacy, TASK, JOIN, true, 3)).toBe(2);
    expect(isRework([...legacy, h(IMPL, 0, true)], TASK, JOIN, 3)).toBe(true);
  });
});

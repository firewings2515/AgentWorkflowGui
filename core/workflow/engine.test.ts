// The workflow engine (T024) on fake adapters and memory ports: start, handoff checks and counting, rework,
// queueing until the target's turn ends, root escalations, report_to_root, and restart.
import { describe, expect, it } from 'vitest';
import { EscalationId, MessageId, OperationId, SessionId, TurnId } from '../../contracts';
import { permissionRequest } from '../sessions/testing/fake-adapter';
import {
  CWD,
  dispatches,
  handoff,
  IMPL,
  INSTANCE,
  instanceOf,
  PLAN,
  REVIEW,
  ROOT,
  rid,
  sessionOf,
  settle,
  started,
  startCommand,
  template,
  world,
  type World,
} from './testing/harness';
import { reworkKey } from './graph';

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const rework = { ruleId: 'rework', target: { kind: 'node' as const, nodeId: IMPL } };
const done = { ruleId: 'done', target: { kind: 'root' as const } };

const turn = (w: World, sessionId: SessionId, state: 'running' | 'completed', id = 'turn-x') => {
  const adapter = w.codex.get(sessionId) ?? w.claude;
  adapter.emit({
    type: 'turn.updated',
    turn: { id: TurnId.parse(id), sessionId, state, startedAt: '2026-10-29T01:00:00.000Z', ...(state !== 'running' && { endedAt: '2026-10-29T01:00:01.000Z' }) },
  });
  adapter.emit({ type: 'session.activity', sessionId, activity: state === 'running' ? 'running' : 'idle', at: '2026-10-29T01:00:00.000Z' });
};

const escalations = (w: World) => w.repositories.escalations.list();

describe('workflow.start (R-11, R-06)', () => {
  it('pins the revision, records consent, makes one task and the root session, and sends the first message as the user', async () => {
    const w = await world();
    const result = await started(w);
    expect(result).toMatchObject({ ok: true, created: [{ kind: 'instance' }, { kind: 'session', id: ROOT }, { kind: 'message' }] });
    const instance = await instanceOf(w);
    expect(instance).toMatchObject({ workflowRevision: 0, state: 'running', rootSessionId: ROOT, template: { id: 'wf-build', revision: 0, reworkLimit: 2 } });
    expect(instance.crossToolConsentAt).toBeDefined();
    expect(instance.tasks).toEqual([expect.objectContaining({ status: 'running', currentNodeId: PLAN, reworkCount: 0, dependsOn: [] })]);
    const root = await w.repositories.sessions.get(ROOT);
    expect(root).toMatchObject({ kind: 'workflow', workflow: { instanceId: INSTANCE, nodeId: PLAN }, cwd: CWD, requestedModel: { runtime: 'claude' } });
    expect(root?.kind === 'workflow' ? root.workflow.taskId : 'ordinary').toBeUndefined();
    expect(await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: PLAN })).toBe(ROOT);
    // Through the delivery service, once, as the user's message.
    expect(w.claude.dispatched).toHaveLength(1);
    expect(w.claude.dispatched[0]).toMatchObject({ text: 'Plan a login page.', origin: { kind: 'user' } });
    expect((await w.store.get(OperationId.parse(`user-message:${INSTANCE}:first`)))?.delivery.state).toBe('sent');
    // Root is told its rules and the rework limit at start (R-05).
    expect(w.claude.started[0]?.instructions).toContain('Planner instructions.');
    expect(w.claude.started[0]?.instructions).toContain('ruleId `to-impl`');
    expect(w.claude.started[0]?.instructions).toContain('at most 2 for this task');
    expect(w.claude.started[0]?.cwd).toBe(CWD);
  });

  it('a repeat of the same start finishes nothing twice; another start under the same ID is refused', async () => {
    const w = await world();
    const first = startCommand();
    await w.run(first);
    await settle();
    expect(await w.run({ ...first, requestId: rid() })).toMatchObject({ ok: true });
    await settle();
    expect(w.claude.dispatched).toHaveLength(1);
    expect(await w.run({ ...first, requestId: rid(), title: 'Something else' })).toMatchObject({ ok: false, code: 'already_exists' });
  });

  it('refuses a changed template, a mixed-tool workflow without consent, and an unresolvable folder, creating nothing', async () => {
    const w = await world();
    expect(await w.run(startCommand({ workflowRevision: 3 }))).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(await w.run(startCommand({ crossToolConsent: false }))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await w.run(startCommand({ cwd: 'Z:\\nowhere' }))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await w.repositories.instances.list()).toEqual([]);
    expect(await w.repositories.sessions.list()).toEqual([]);
  });

  it('a one-tool workflow starts without the cross-tool consent', async () => {
    const one = template({}, { impl: { model: { runtime: 'claude', model: 'haiku' } } });
    const w = await world(one);
    expect(await started(w, { crossToolConsent: false })).toMatchObject({ ok: true });
    expect((await instanceOf(w)).crossToolConsentAt).toBeUndefined();
  });
});

describe('handoff (R-04 steps 1-7)', () => {
  it('runs the template flow: plan → implement → review (sent back once) → implement → review → root, counting rework twice', async () => {
    const w = await world();
    await started(w);
    // No implement session before the first handoff to it (R-06).
    expect(await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId: (await instanceOf(w)).tasks[0]!.id })).toBeUndefined();

    const a = await handoff(w, ROOT, toImpl);
    expect(a).toMatchObject({ status: 'accepted', delivery: 'sent' });
    const impl = await sessionOf(w, IMPL);
    expect(await w.repositories.sessions.get(impl)).toMatchObject({ kind: 'workflow', parentId: ROOT, cwd: CWD, requestedModel: { runtime: 'codex' } });
    const b = await handoff(w, impl, toReview);
    const review = await sessionOf(w, REVIEW);
    // Review is read-only: no writable root, a read-only runtime session.
    expect(await w.repositories.sessions.get(review)).toMatchObject({ folderScope: { writableRoots: [] } });
    expect(w.claude.started.find((s) => s.sessionId === review)).toMatchObject({ readOnly: true });
    const c = await handoff(w, review, rework);
    const d = await handoff(w, impl, toReview);
    const e = await handoff(w, review, done);
    for (const r of [b, c, d, e]) expect(r).toMatchObject({ status: 'accepted', delivery: 'sent' });

    const handoffs = await w.repositories.handoffs.listByInstance(INSTANCE);
    expect(handoffs.map((h) => [h.fromNodeId, h.toNodeId, h.rework])).toEqual([
      [PLAN, IMPL, false],
      [IMPL, REVIEW, false],
      [REVIEW, IMPL, true],
      [IMPL, REVIEW, true],
      [REVIEW, PLAN, false],
    ]);
    // Rework goes back to the same session: one implement session, created once.
    expect(handoffs[0]?.target.sessionId).toBe(handoffs[2]?.target.sessionId);
    expect(w.codex.size).toBe(1);
    expect(w.codex.get(impl)?.started).toHaveLength(1);
    expect(handoffs[4]?.target.sessionId).toBe(ROOT);
    const instance = await instanceOf(w);
    expect(instance.tasks[0]).toMatchObject({ reworkCount: 2, currentNodeId: PLAN, status: 'running' });
    // Each payload went through the delivery service once, marked as a handoff, never as the user (R-03).
    const sent = dispatches(w).filter((d) => d.origin?.kind === 'handoff');
    expect(sent).toHaveLength(5);
    expect(sent.every((d) => d.entry.kind === 'new-turn')).toBe(true);
    expect(w.events.some((e) => e.type === 'handoff.updated')).toBe(true);
    expect(w.events.filter((e) => e.type === 'instance.updated').at(-1)).toMatchObject({ instance: { tasks: [{ reworkCount: 2 }] } });
  });

  it('a third return over the rework limit is not handed off: root gets a limit escalation and the task is blocked', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    await handoff(w, impl, toReview);
    const review = await sessionOf(w, REVIEW);
    await handoff(w, review, rework);
    await handoff(w, impl, toReview);
    const before = dispatches(w).length;
    const over = await handoff(w, review, rework);
    expect(over).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect(dispatches(w)).toHaveLength(before);
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(4);
    const [escalation] = await escalations(w);
    expect(escalation).toMatchObject({ kind: 'limit-exceeded', rootSessionId: ROOT, instanceId: INSTANCE, fromSessionId: review, state: 'open', ref: { kind: 'task' } });
    expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
    // Asking again reuses the open escalation.
    expect(await handoff(w, review, rework)).toMatchObject({ status: 'escalated', escalationId: escalation?.id });
    expect(await escalations(w)).toHaveLength(1);
    // The user sees it on root; the limit still holds.
    expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation!.id, decision: 'approve' })).toMatchObject({ ok: true });
    expect((await w.repositories.escalations.get(escalation!.id))).toMatchObject({ state: 'resolved', resolvedBy: 'user' });
    expect(await handoff(w, review, rework)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
  });

  it('enforces a node receive limit (the smallest of its input rules) for the task', async () => {
    const w = await world(
      template({ reworkLimit: 5 }, { review: { inputRules: [{ id: 'change', condition: 'a change', acceptanceLimit: 3, waitForAllUpstream: false }, { id: 'other', condition: 'x', acceptanceLimit: 1, waitForAllUpstream: false }] } }),
    );
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'accepted' });
    const review = await sessionOf(w, REVIEW);
    await handoff(w, review, rework);
    expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await escalations(w))[0]?.detail).toContain('receive limit of 1');
  });

  it('refuses an unconnected target, a rule the node lacks (escalated to root), another task, and ordinary sessions', async () => {
    const w = await world();
    await started(w);
    expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: REVIEW } })).toMatchObject({ status: 'rejected', rejection: { reason: 'not-connected' } });
    expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: 'nowhere' as never } })).toMatchObject({ status: 'rejected', rejection: { reason: 'unknown-target' } });
    const noRule = await handoff(w, ROOT, { ruleId: 'made-up', target: { kind: 'node', nodeId: IMPL } });
    expect(noRule).toMatchObject({ status: 'rejected', rejection: { reason: 'no-matching-rule' } });
    await handoff(w, ROOT, { ruleId: 'made-up-2', target: { kind: 'node', nodeId: IMPL } });
    const open = await escalations(w);
    expect(open).toEqual([expect.objectContaining({ kind: 'no-rule-matched', rootSessionId: ROOT, state: 'open' })]);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    expect(await handoff(w, impl, { ...toReview, taskId: 'other-task' as never })).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    // Nothing of the refused calls was accepted or counted.
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(1);

    await w.repositories.sessions.create({ ...(await w.repositories.sessions.get(ROOT))!, id: SessionId.parse('plain'), kind: 'ordinary' } as never);
    expect(await handoff(w, SessionId.parse('plain'), toImpl)).toMatchObject({ status: 'rejected', rejection: { reason: 'not-in-workflow' } });
    expect(await w.engine.createTasks({ tasks: [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }] }, { caller: ROOT })).toMatchObject({ status: 'rejected', rejection: { reason: 'unsupported' } });
    expect(await w.engine.createTasks({ tasks: [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }] }, { caller: SessionId.parse('plain') })).toMatchObject({
      status: 'rejected',
      rejection: { reason: 'not-in-workflow' },
    });
  });

  it('a resend with the same operationId or the same source call is a duplicate, counted and sent once; a changed one is refused', async () => {
    const w = await world();
    await started(w);
    const first = await handoff(w, ROOT, { ...toImpl, content: 'the plan' }, { operationId: 'op-a', sourceCallRef: 'call-a' });
    expect(first).toMatchObject({ status: 'accepted', operationId: 'op-a' });
    // retryOf of the same operation, and the same call again after a restart (new operationId, same source call).
    expect(await handoff(w, ROOT, { ...toImpl, content: 'the plan' }, { operationId: 'op-a', sourceCallRef: 'call-b' })).toMatchObject({ status: 'duplicate', operationId: 'op-a' });
    expect(await handoff(w, ROOT, { ...toImpl, content: 'the plan' }, { operationId: 'op-z', sourceCallRef: 'call-a' })).toMatchObject({ status: 'duplicate', operationId: 'op-a' });
    expect(await handoff(w, ROOT, { ...toImpl, content: 'another plan' }, { operationId: 'op-a', sourceCallRef: 'call-c' })).toMatchObject({ status: 'rejected', rejection: { reason: 'resend-mismatch' } });
    const impl = await sessionOf(w, IMPL);
    expect(await handoff(w, impl, toReview, { operationId: 'op-a', sourceCallRef: 'call-d' })).toMatchObject({ status: 'rejected', rejection: { reason: 'not-owner' } });
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(1);
    expect(dispatches(w).filter((d) => d.origin?.kind === 'handoff')).toHaveLength(1);
    expect((await instanceOf(w)).tasks[0]?.currentNodeId).toBe(IMPL);
  });

  it('a formal handoff waits for the target turn to end (SP-05), then goes as a new turn; the next one waits for that turn', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    await handoff(w, impl, toReview);
    const review = await sessionOf(w, REVIEW);
    // Implement is busy in its own turn when review sends the task back.
    turn(w, impl, 'running', 'turn-impl');
    await settle();
    const before = w.codex.get(impl)!.dispatched.length;
    const queued = await handoff(w, review, rework);
    expect(queued).toMatchObject({ status: 'accepted', delivery: 'pending' });
    expect(w.codex.get(impl)!.dispatched).toHaveLength(before);
    turn(w, impl, 'completed', 'turn-impl');
    await settle();
    expect(w.codex.get(impl)!.dispatched).toHaveLength(before + 1);
    expect(w.codex.get(impl)!.dispatched.at(-1)).toMatchObject({ entry: { kind: 'new-turn' }, origin: { kind: 'handoff', fromSessionId: review } });
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).at(-1)?.delivery.state).toBe('sent');
  });

  it('a session that wakes on its own (a background sub-agent finished) gets the same counting, limits and queueing (R-05)', async () => {
    const w = await world(template({ reworkLimit: 1 }));
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    await handoff(w, impl, toReview);
    const review = await sessionOf(w, REVIEW);
    await handoff(w, review, rework);
    // Review wakes with no input from anyone, and its turn calls handoff again.
    turn(w, review, 'running', 'turn-wake');
    await settle();
    expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.rework)).toHaveLength(1);
  });

  it('a rule that asks the user first escalates; only the user approval accepts and delivers it, a decline drops it', async () => {
    const confirmFirst = template({}, { plan: { outputRules: [{ id: 'to-impl', condition: 'ready', payload: 'plan', target: { kind: 'node', nodeId: IMPL }, requiresUserConfirmation: true }] } });
    const w = await world(confirmFirst);
    await started(w);
    const asked = await handoff(w, ROOT, toImpl, { operationId: 'op-c1' });
    expect(asked).toMatchObject({ status: 'escalated', reason: 'needs-confirmation' });
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toEqual([]);
    const escalationId = asked.status === 'escalated' ? asked.escalationId : EscalationId.parse('x');
    expect(await w.repositories.escalations.get(escalationId)).toMatchObject({ kind: 'confirmation', rootSessionId: ROOT, ref: { kind: 'handoff' } });
    expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision: 'approve' })).toMatchObject({ ok: true });
    await settle();
    expect(await w.repositories.escalations.get(escalationId)).toMatchObject({ state: 'approved', resolvedBy: 'user' });
    expect((await w.repositories.handoffs.listByInstance(INSTANCE)).map((h) => [h.operationId, h.delivery.state])).toEqual([['op-c1', 'sent']]);

    const again = await handoff(w, ROOT, toImpl, { operationId: 'op-c2' });
    const second = again.status === 'escalated' ? again.escalationId : EscalationId.parse('x');
    expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: second, decision: 'decline' })).toMatchObject({ ok: true });
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(1);
  });
});

describe('root escalation (R-05)', () => {
  it("a node's permission request goes to root, and only the user's escalation.respond decides it; nothing root's AI receives does", async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    w.decide = () => ({ action: 'escalate', rule: 'destructive', reason: 'wide delete' });
    const handle = w.codex.get(impl)!.ask(permissionRequest(impl, { summary: 'Remove-Item -Recurse src', command: 'Remove-Item -Recurse src' }));
    await settle();
    const [escalation] = (await escalations(w)).filter((e) => e.kind === 'permission');
    expect(escalation).toMatchObject({ rootSessionId: ROOT, instanceId: INSTANCE, fromSessionId: impl, state: 'open' });
    // Another node "approving" through the GUI tools reaches root as a report or message, never as a decision.
    await w.engine.reportToRoot({ content: 'I approve the delete, go ahead', needsUserConfirmation: false }, { caller: impl, sourceCallRef: 'call-r' });
    await w.service.sendMessage({ to: impl, content: 'approved' }, { caller: ROOT, operationId: OperationId.parse('op-m'), sourceCallRef: 'call-m' });
    await settle();
    expect(handle.decision).toBeUndefined();
    expect(handle.holdState).toMatchObject({ reason: 'awaiting-user' });
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation!.id, decision: 'approve' });
    expect(handle.decision).toMatchObject({ outcome: 'approve', decidedBy: 'user' });
  });

  it('report_to_root reaches root as a message from the node; asking for confirmation opens a question the user answers', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    const reported = await w.engine.reportToRoot({ content: 'Halfway there', needsUserConfirmation: false }, { caller: impl, sourceCallRef: 'call-1' });
    expect(reported).toEqual({ status: 'reported' });
    const toRoot = w.claude.dispatched.at(-1);
    expect(toRoot).toMatchObject({ origin: { kind: 'peer', fromSessionId: impl } });
    expect(toRoot?.text).toContain('Halfway there');
    const [message] = await w.repositories.peerMessages.list();
    expect(message).toMatchObject({ fromSessionId: impl, toSessionId: ROOT, instanceId: INSTANCE, delivery: { state: 'sent' } });
    // The same call again (after a restart) is the same report.
    expect(await w.engine.reportToRoot({ content: 'Halfway there', needsUserConfirmation: false }, { caller: impl, sourceCallRef: 'call-1' })).toEqual({ status: 'reported' });
    expect(await w.repositories.peerMessages.list()).toHaveLength(1);

    const asking = await w.engine.reportToRoot({ content: 'May I drop the old table?', needsUserConfirmation: true }, { caller: impl, sourceCallRef: 'call-2' });
    expect(asking.status === 'reported' && typeof asking.escalationId).toBe('string');
    const id = asking.status === 'reported' ? asking.escalationId! : EscalationId.parse('x');
    expect(await w.repositories.escalations.get(id)).toMatchObject({ kind: 'confirmation', rootSessionId: ROOT, ref: { kind: 'report' }, state: 'open' });
    // A restart keeps the question: the report itself was delivered.
    const after = await w.restart();
    expect(await after.repositories.escalations.get(id)).toMatchObject({ state: 'open' });
    expect(await after.run({ type: 'escalation.respond', requestId: rid(), escalationId: id, decision: 'decline' })).toMatchObject({ ok: true });
    expect(await after.repositories.escalations.get(id)).toMatchObject({ state: 'declined', resolvedBy: 'user' });
  });

  it('a handoff whose delivery stayed unknown is escalated to root with its handoff, and never resent on its own', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    w.claude.dispatchModes = ['lost'];
    const r = await handoff(w, impl, toReview);
    expect(r).toMatchObject({ status: 'accepted', delivery: 'unknown' });
    await settle();
    const unknown = (await escalations(w)).find((e) => e.kind === 'delivery-unknown');
    expect(unknown).toMatchObject({ rootSessionId: ROOT, instanceId: INSTANCE, ref: { kind: 'handoff', handoffId: r.status === 'accepted' ? r.handoffId : '' } });
    const after = await w.restart();
    expect(after.claude.dispatched).toHaveLength(0);
  });
});

describe('cross-tool consent inside the run (R-11)', () => {
  it('send_message between nodes of the run needs no confirmation; to a session outside it still does', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    const inside = await w.service.sendMessage({ to: ROOT, content: 'question' }, { caller: impl, operationId: OperationId.parse('op-in'), sourceCallRef: 'call-in' });
    expect(inside).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect((await w.repositories.peerMessages.list()).find((m) => m.operationId === 'op-in')).toMatchObject({ instanceId: INSTANCE });
    await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('outsider'), kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD });
    await settle();
    const outside = await w.service.sendMessage({ to: SessionId.parse('outsider'), content: 'hi' }, { caller: impl, operationId: OperationId.parse('op-out'), sourceCallRef: 'call-out' });
    expect(outside).toMatchObject({ status: 'awaiting-confirmation' });
  });
});

describe('restart', () => {
  it('a handoff accepted while its target was busy is sent once after a restart, and the task is rebuilt from the handoffs', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    await handoff(w, impl, toReview);
    const review = await sessionOf(w, REVIEW);
    turn(w, impl, 'running', 'turn-busy');
    await settle();
    expect(await handoff(w, review, rework)).toMatchObject({ delivery: 'pending' });
    // A crash after acceptance, before the task record caught up.
    const instance = await instanceOf(w);
    await w.repositories.instances.update({ ...instance, revision: instance.revision + 1, tasks: instance.tasks.map((t) => ({ ...t, reworkCount: 0, currentNodeId: REVIEW })) }, instance.revision);
    const after = await w.restart();
    await settle();
    const adapter = after.codex.get(impl);
    expect(adapter?.dispatched).toHaveLength(1);
    expect(adapter?.dispatched[0]).toMatchObject({ origin: { kind: 'handoff', fromSessionId: review } });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ reworkCount: 1, currentNodeId: IMPL });
    // Counting continues from the store after the restart: the next return is the second rework.
    const record = await after.store.get((await after.repositories.handoffs.listByInstance(INSTANCE)).at(-1)!.operationId);
    expect(record?.kind === 'handoff' && record.handoff?.rework).toBe(true);
    expect(await handoff(after, impl, toReview)).toMatchObject({ status: 'accepted' });
    expect((await instanceOf(after)).tasks[0]).toMatchObject({ reworkCount: 2, currentNodeId: REVIEW });
    expect(reworkKey(INSTANCE, (await instanceOf(after)).tasks[0]!.id)).toBe(JSON.stringify(['rework', INSTANCE, `${INSTANCE}:task`]));
  });

  it('a handoff waiting for confirmation does not survive a restart: its escalation is closed by the system', async () => {
    const confirmFirst = template({}, { plan: { outputRules: [{ id: 'to-impl', condition: 'ready', payload: 'plan', target: { kind: 'node', nodeId: IMPL }, requiresUserConfirmation: true }] } });
    const w = await world(confirmFirst);
    await started(w);
    const asked = await handoff(w, ROOT, toImpl);
    const id = asked.status === 'escalated' ? asked.escalationId : EscalationId.parse('x');
    const after = await w.restart();
    expect(await after.repositories.escalations.get(id)).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
    expect(await after.run({ type: 'escalation.respond', requestId: rid(), escalationId: id, decision: 'approve' })).toMatchObject({ ok: false });
  });

  it('a first message whose delivery stayed unknown is not sent again after a restart (CR-2)', async () => {
    const w = await world();
    w.claude.dispatchModes = ['reject'];
    await started(w);
    const after = await w.restart();
    expect(after.claude.dispatched).toHaveLength(0);
    expect((await after.store.get(OperationId.parse(`user-message:${MessageId.parse(`${INSTANCE}:first`)}`)))?.delivery.state).toBe('unknown');
  });
});

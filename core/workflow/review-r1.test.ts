// T024 review r1: each reviewer reproduction as a regression test (fake adapters whose dispatches start
// turns, memory ports, real restarts through the harness).
import { describe, expect, it } from 'vitest';
import { EscalationId, OperationId, SessionId, type WorkflowInstance } from '../../contracts';
import type { InstanceRepository, NodeSessionKey } from '../ports';
import { CWD, dispatches, handoff, IMPL, INSTANCE, instanceOf, REVIEW, ROOT, rid, sessionOf, settle, started, startCommand, template, world, type World } from './testing/harness';

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const rework = { ruleId: 'rework', target: { kind: 'node' as const, nodeId: IMPL } };
const done = { ruleId: 'done', target: { kind: 'root' as const } };

/** plan → implement → review, with every turn already ended. */
const toReviewOnce = async (w: World) => {
  await started(w);
  await handoff(w, ROOT, toImpl);
  const impl = await sessionOf(w, IMPL);
  await handoff(w, impl, toReview);
  await settle();
  return { impl, review: await sessionOf(w, REVIEW) };
};

/** Implement busy in a turn of its own, then two handoffs to it from review and root (in that order). */
const twoQueued = async (w: World) => {
  const { impl, review } = await toReviewOnce(w);
  w.holding.add(impl);
  w.emitTurn(impl, 'busy-1', 'running');
  await settle();
  const first = await handoff(w, review, rework, { operationId: 'op-first' });
  const second = await handoff(w, ROOT, toImpl, { operationId: 'op-second' });
  expect(first).toMatchObject({ status: 'accepted', delivery: 'pending' });
  expect(second).toMatchObject({ status: 'accepted', delivery: 'pending' });
  return { impl, review };
};

const handoffOps = (w: World, sessionId: SessionId) =>
  (w.codex.get(sessionId)?.dispatched ?? []).filter((d) => d.origin?.kind === 'handoff').map((d) => (d.origin?.kind === 'handoff' ? d.origin.handoffId : ''));

describe('T024 review r1', () => {
  it('r1-P1-1 a task blocked at a limit hands off nowhere, root included, and stays blocked', async () => {
    const w = await world(template({ reworkLimit: 1 }));
    const { impl, review } = await toReviewOnce(w);
    await handoff(w, review, rework);
    expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    const before = dispatches(w).length;
    const toRoot = await handoff(w, review, done);
    expect(toRoot).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect(dispatches(w)).toHaveLength(before);
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(3);
    expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
    // The user seeing the escalation does not unblock it: there is no command for that yet.
    const id = toRoot.status === 'escalated' ? toRoot.escalationId : EscalationId.parse('x');
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: id, decision: 'approve' });
    expect(await handoff(w, review, done)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
  });

  it('r1-P1-2 after a restart two handoffs queued for one target go one per turn, oldest first', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await twoQueued(w);
    const after = await w.restart();
    await settle();
    expect(after.codex.get(impl)?.dispatched.map((d) => d.origin)).toEqual([expect.objectContaining({ kind: 'handoff', fromSessionId: review })]);
    // Its turn runs (held): the second waits for it to end.
    expect(after.open.has(impl)).toBe(true);
    await after.finishTurn(impl);
    expect(after.codex.get(impl)?.dispatched.map((d) => (d.origin?.kind === 'handoff' ? d.origin.fromSessionId : ''))).toEqual([review, ROOT]);
  });

  it('r1-P1-2 a user retry of an unknown handoff waits for the target turn like any handoff', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await toReviewOnce(w);
    w.codex.get(impl)!.dispatchModes = ['lost'];
    const lost = await handoff(w, review, rework);
    expect(lost).toMatchObject({ status: 'accepted', delivery: 'unknown' });
    await settle();
    const escalation = (await w.repositories.escalations.list({ state: 'open' })).find((e) => e.kind === 'delivery-unknown');
    w.holding.add(impl);
    w.emitTurn(impl, 'busy-2', 'running');
    await settle();
    const before = w.codex.get(impl)!.dispatched.length;
    expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
    await settle();
    expect(w.codex.get(impl)!.dispatched).toHaveLength(before);
    w.emitTurn(impl, 'busy-2', 'completed');
    await settle();
    expect(w.codex.get(impl)!.dispatched).toHaveLength(before + 1);
    expect(w.codex.get(impl)!.dispatched.at(-1)).toMatchObject({ entry: { kind: 'new-turn' }, origin: { kind: 'handoff', fromSessionId: review } });
  });

  it('r1-P1-3 a replayed completion of an old turn does not let the next handoff in while the new turn runs', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await twoQueued(w);
    w.emitTurn(impl, 'busy-1', 'completed');
    await settle();
    expect(handoffOps(w, impl)).toHaveLength(2); // plan's, then review's
    // The old turn's end arrives again (with idle) while the turn review's handoff started still runs.
    w.emitTurn(impl, 'busy-1', 'completed');
    await settle();
    expect(handoffOps(w, impl)).toHaveLength(2);
    await w.finishTurn(impl);
    expect(handoffOps(w, impl)).toHaveLength(3);
    expect(w.codex.get(impl)!.dispatched.at(-1)).toMatchObject({ origin: { kind: 'handoff', fromSessionId: ROOT } });
    expect(review).toBeDefined();
  });

  it('r1-P1-3 an idle without the turn completion does not let a new handoff overtake the queued one', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await toReviewOnce(w);
    w.emitTurn(impl, 'busy-3', 'running');
    await settle();
    await handoff(w, review, rework, { operationId: 'op-old' });
    // Only idle arrives; the turn's completion is lost.
    w.codex.get(impl)!.emit({ type: 'session.activity', sessionId: impl, activity: 'idle', at: '2026-10-29T01:00:00.000Z' });
    await settle();
    const late = await handoff(w, ROOT, toImpl, { operationId: 'op-new' });
    expect(late).toMatchObject({ status: 'accepted', delivery: 'pending' });
    expect(handoffOps(w, impl)).toHaveLength(1);
    w.emitTurn(impl, 'busy-3', 'completed');
    await settle();
    expect(w.codex.get(impl)!.dispatched.slice(-2).map((d) => (d.origin?.kind === 'handoff' ? d.origin.fromSessionId : ''))).toEqual([review, ROOT]);
  });

  it('r1-P1-3 a replayed old turn end before the new turn reported its start does not end the wait', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await twoQueued(w);
    // The runtime reports nothing of the turn the next handoff starts (yet).
    w.silent.add(impl);
    w.emitTurn(impl, 'busy-1', 'completed');
    await settle();
    expect(handoffOps(w, impl)).toHaveLength(2);
    w.emitTurn(impl, 'busy-1', 'completed');
    await settle();
    expect(handoffOps(w, impl)).toHaveLength(2);
    // A turn never recorded ends late: not the dispatched one, so still nothing (r2-P1-2).
    w.emitTurn(impl, 'late-turn', 'completed');
    await settle();
    expect(handoffOps(w, impl)).toHaveLength(2);
    // The turn the dispatch started ends (its start was never reported): the next one goes.
    await w.finishTurn(impl);
    expect(handoffOps(w, impl)).toHaveLength(3);
    expect(review).toBeDefined();
  });

  it('r1-P1-3 a handoff left pending (its resume failed) is sent before a newer one to the same session', async () => {
    const w = await world(template({ reworkLimit: 5 }));
    const { impl, review } = await toReviewOnce(w);
    // Review's runtime is gone and its resume fails once: the handoff stays pending.
    w.claude.emit({ type: 'runtime.exited', runtime: 'claude', sessionIds: [review], expected: false, code: 1, signal: null, at: '2026-10-29T01:00:00.000Z' });
    await settle();
    const failing = Promise.reject(new Error('resume failed'));
    failing.catch(() => undefined);
    w.claude.resumeGate = failing;
    expect(await handoff(w, impl, { ...toReview, content: 'old' }, { operationId: 'op-old' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
    w.claude.resumeGate = undefined;
    const toReviewSession = () => w.claude.dispatched.filter((d) => d.origin?.kind === 'handoff' && d.origin.fromSessionId === impl).map((d) => d.text.split('\n\n').at(-1));
    await handoff(w, impl, { ...toReview, content: 'new' }, { operationId: 'op-new' });
    await settle();
    expect(toReviewSession().slice(-2)).toEqual(['old', 'new']);
  });

  it('r1-P1-4 a start cut off before its instance was stored accepts only the same start again', async () => {
    const w = await world();
    const create = w.repositories.instances.create.bind(w.repositories.instances);
    let fail = true;
    const instances: InstanceRepository = w.repositories.instances;
    instances.create = (instance: WorkflowInstance) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('crash'));
      }
      return create(instance);
    };
    const original = startCommand();
    await expect(w.run(original)).rejects.toThrow('crash');
    const after = await w.restart();
    for (const changed of [{ cwd: 'E:\\work\\other' }, { firstMessage: 'Something else.' }]) {
      expect(await after.run({ ...original, requestId: rid(), ...changed })).toMatchObject({ ok: false, code: 'already_exists' });
    }
    // Consent is first stored with the instance; this mixed-tool workflow is refused without it anyway.
    expect(await after.run({ ...original, requestId: rid(), crossToolConsent: false })).toMatchObject({ ok: false });
    expect(await after.repositories.instances.list()).toEqual([]);
    expect(after.claude.dispatched).toHaveLength(0);
    expect(await after.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
    await settle();
    expect(after.claude.dispatched.map((d) => d.text)).toEqual(['Plan a login page.']);
    expect(after.claude.started[0]?.cwd).toBe(CWD);
  });

  it('r1-P1-4 a start cut off after its instance was stored compares the first message, folder and consent too', async () => {
    const w = await world();
    const bind = w.repositories.instances.bindNodeSession.bind(w.repositories.instances);
    let fail = true;
    const instances: InstanceRepository = w.repositories.instances;
    instances.bindNodeSession = (key: NodeSessionKey, sessionId: SessionId) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('crash'));
      }
      return bind(key, sessionId);
    };
    const original = startCommand();
    await expect(w.run(original)).rejects.toThrow('crash');
    expect(await instanceOf(w)).toBeDefined();
    const after = await w.restart();
    for (const changed of [{ cwd: 'E:\\work\\other' }, { firstMessage: 'Something else.' }, { crossToolConsent: false }]) {
      expect(await after.run({ ...original, requestId: rid(), ...changed })).toMatchObject({ ok: false, code: 'already_exists' });
    }
    expect(await after.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
    await settle();
    expect(after.claude.dispatched.map((d) => d.text)).toEqual(['Plan a login page.']);
  });

  it('r1-P1-5 a retry of a handoff waiting for confirmation must be the same handoff from the same session', async () => {
    const confirmReview = template({}, { impl: { outputRules: [{ id: 'to-review', condition: 'done', payload: 'change', target: { kind: 'node', nodeId: REVIEW }, requiresUserConfirmation: true }] } });
    const w = await world(confirmReview);
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    const asked = await handoff(w, impl, { ...toReview, content: 'X' }, { operationId: 'op-a', sourceCallRef: 'call-a' });
    expect(asked).toMatchObject({ status: 'escalated', reason: 'needs-confirmation' });
    expect(await handoff(w, impl, { ...toReview, content: 'Y' }, { operationId: 'op-a', sourceCallRef: 'call-b' })).toMatchObject({ status: 'rejected', rejection: { reason: 'resend-mismatch' } });
    expect(await handoff(w, ROOT, { ...toImpl, content: 'X' }, { operationId: 'op-a', sourceCallRef: 'call-c' })).toMatchObject({ status: 'rejected', rejection: { reason: 'not-owner' } });
    expect(await handoff(w, impl, { ...toReview, content: 'X' }, { operationId: 'op-a', sourceCallRef: 'call-d' })).toEqual(asked);
    const id = asked.status === 'escalated' ? asked.escalationId : EscalationId.parse('x');
    await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: id, decision: 'approve' });
    await settle();
    const review = await sessionOf(w, REVIEW);
    const sent = w.claude.dispatched.filter((d) => d.origin?.kind === 'handoff' && d.nativeSessionRef === w.claude.started.find((s) => s.sessionId === review)?.preallocatedRef);
    expect(sent.map((d) => d.text.endsWith('\n\nX'))).toEqual([true]);
  });

  it('r1-P1-6 a workflow session asking to message a session outside its run asks the user on the run root', async () => {
    const w = await world();
    await started(w);
    await handoff(w, ROOT, toImpl);
    const impl = await sessionOf(w, IMPL);
    await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('outsider'), kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD });
    await settle();
    const asked = await w.service.sendMessage({ to: SessionId.parse('outsider'), content: 'hi' }, { caller: impl, operationId: OperationId.parse('op-out'), sourceCallRef: 'call-out' });
    const id = asked.status === 'awaiting-confirmation' ? asked.escalationId : EscalationId.parse('x');
    expect(await w.repositories.escalations.get(id)).toMatchObject({ kind: 'confirmation', rootSessionId: ROOT, instanceId: INSTANCE, fromSessionId: impl });
    // An ordinary session keeps its own question.
    await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('codex-plain'), kind: 'ordinary', agentId: 'agent-builder' as never, model: { runtime: 'codex', model: 'gpt-6-luna' }, cwd: CWD });
    await settle();
    const plain = await w.service.sendMessage({ to: SessionId.parse('outsider'), content: 'hi' }, { caller: SessionId.parse('codex-plain'), operationId: OperationId.parse('op-plain'), sourceCallRef: 'call-plain' });
    const plainId = plain.status === 'awaiting-confirmation' ? plain.escalationId : EscalationId.parse('x');
    const question = await w.repositories.escalations.get(plainId);
    expect(question).toMatchObject({ rootSessionId: 'codex-plain' });
    expect(question?.instanceId).toBeUndefined();
  });

  it('r1-P1-7 a report accepted before its question was written gets the question back, after a restart or on the same call', async () => {
    for (const how of ['restart', 'resend'] as const) {
      const w = await world();
      await started(w);
      await handoff(w, ROOT, toImpl);
      const impl = await sessionOf(w, IMPL);
      const upsert = w.repositories.escalations.upsert.bind(w.repositories.escalations);
      let fail = true;
      w.repositories.escalations.upsert = (e) => {
        if (fail && e.id.startsWith('wf-report:')) {
          fail = false;
          return Promise.reject(new Error('crash'));
        }
        return upsert(e);
      };
      await expect(w.engine.reportToRoot({ content: 'May I drop the table?', needsUserConfirmation: true }, { caller: impl, sourceCallRef: 'call-q' })).rejects.toThrow('crash');
      const reports = async (x: World) => (await x.repositories.escalations.list()).filter((e) => e.ref?.kind === 'report');
      expect(await reports(w)).toEqual([]);
      const x = how === 'restart' ? await w.restart() : w;
      if (how === 'restart') expect(await reports(x)).toEqual([expect.objectContaining({ state: 'open', rootSessionId: ROOT, fromSessionId: impl })]);
      const again = await x.engine.reportToRoot({ content: 'May I drop the table?', needsUserConfirmation: true }, { caller: impl, sourceCallRef: 'call-q' });
      const [question] = await reports(x);
      expect(again).toEqual({ status: 'reported', escalationId: question?.id });
      expect(await reports(x)).toHaveLength(1);
      expect(await x.repositories.peerMessages.list()).toHaveLength(1);
    }
  });

  it('r1-P1-7 root asking the user twice with the same call, across a restart, opens one question', async () => {
    const w = await world();
    await started(w);
    const first = await w.engine.reportToRoot({ content: 'Shall we ship?', needsUserConfirmation: true }, { caller: ROOT, sourceCallRef: 'call-root' });
    const after = await w.restart();
    const again = await after.engine.reportToRoot({ content: 'Shall we ship?', needsUserConfirmation: true }, { caller: ROOT, sourceCallRef: 'call-root' });
    expect(again).toEqual(first);
    expect((await after.repositories.escalations.list()).filter((e) => e.ref?.kind === 'report')).toHaveLength(1);
  });

  it('r1-P2-1 a node session whose provision was stored without any handoff is not started by a restart', async () => {
    const w = await world();
    await started(w);
    const accept = w.service.delivery.accept.bind(w.service.delivery);
    let fail = true;
    w.service.delivery.accept = (input) => {
      if (fail && input.kind === 'handoff') {
        fail = false;
        return Promise.reject(new Error('crash'));
      }
      return accept(input);
    };
    await expect(handoff(w, ROOT, toImpl)).rejects.toThrow('crash');
    const impl = await sessionOf(w, IMPL);
    expect(await w.repositories.handoffs.listByInstance(INSTANCE)).toEqual([]);
    const after = await w.restart();
    await settle();
    expect(after.codex.get(impl)?.started ?? []).toEqual([]);
    // The first handoff to it starts it then.
    expect(await handoff(after, ROOT, toImpl)).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect(after.codex.get(impl)?.started).toHaveLength(1);
  });

  it('r1-P2-3 the same handoff call resent after a real restart is the same operation, counted once', async () => {
    const w = await world();
    await started(w);
    expect(await handoff(w, ROOT, { ...toImpl, content: 'the plan' }, { operationId: 'op-a', sourceCallRef: 'call-a' })).toMatchObject({ status: 'accepted' });
    const after = await w.restart();
    expect(await handoff(after, ROOT, { ...toImpl, content: 'the plan' }, { operationId: 'op-z', sourceCallRef: 'call-a' })).toMatchObject({ status: 'duplicate', operationId: 'op-a' });
    expect(await after.repositories.handoffs.listByInstance(INSTANCE)).toHaveLength(1);
    expect(dispatches(after).filter((d) => d.origin?.kind === 'handoff')).toHaveLength(0);
  });
});

// T040 (G-11 B, C-31): once the user approved a task list, root is told which task IDs were made, as a `system-notice`
// through the delivery service. On the memory ports (core/pipeline/t040.test.ts) and on SQLite (app/main): the notice
// is made once whatever repeats it — a crash after the approval and before its acceptance, a restart, two recoveries
// at once — and never for a declined list or one that needed no approval.
import { describe, expect, it } from 'vitest';
import type { Escalation, OperationId, TaskPlanItem, WorkflowTemplate } from '../../../contracts';
import { crashOnce } from '../../workflow/testing/r2-cases';
import { instanceOf, rid, settle, started, type World } from '../../workflow/testing/harness';
import { planNoticeOperationOf } from '../pipeline';
import { createTasks, pipelineTemplate, project } from './t032-cases';

const item = (key: string, title: string, dependsOn: string[] = []): TaskPlanItem => ({ key, title, dependsOn, dependsOnExisting: [] });
const respond = (w: World, escalationId: Escalation['id'], decision: 'approve' | 'decline') => w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision });

const begin = async (make: (workflow?: WorkflowTemplate) => Promise<World>, confirm: boolean) => {
  const w = await make(pipelineTemplate({ confirm }));
  await w.repositories.projects.save(project(), null);
  expect(await started(w)).toMatchObject({ ok: true });
  return w;
};

/** Every dispatch of the notice to root, over all the worlds a run went through (a restart has its own adapters). */
const notices = (worlds: World[], operationId: OperationId) => {
  const adapters = new Set(worlds.flatMap((w) => [w.claude, ...w.codex.values()]));
  return [...adapters].flatMap((a) => a.dispatched).filter((d) => d.origin?.kind === 'system' && d.text.includes(operationId.slice('notice-tasks-'.length)));
};

export const t040NoticeCases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`G-11 (B): root is told the task IDs of an approved list (${backend})`, () => {
    it('after the approval: one system notice to root listing every task ID made, delivered once', async () => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A'), item('b', 'B', ['a'])], 'call-notice');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      expect(await w.store.get(op)).toBeUndefined();
      expect(await respond(w, asked.escalationId, 'approve')).toMatchObject({ ok: true });
      await settle();
      const plan = (await instanceOf(w)).taskPlans[0]!;
      expect(plan.state).toBe('created');
      const record = await w.store.get(op);
      expect(record).toMatchObject({ kind: 'system-notice', delivery: { state: 'sent' }, context: { origin: { kind: 'system' } } });
      expect(record?.target.sessionId).toBe((await instanceOf(w)).rootSessionId);
      const sent = notices([w], op);
      expect(sent).toHaveLength(1);
      for (const c of plan.created) expect(sent[0]!.text).toContain(c.taskId);
      // The same answer again changes nothing.
      expect(await respond(w, asked.escalationId, 'approve')).toMatchObject({ ok: false });
      await settle();
      expect(notices([w], op)).toHaveLength(1);
    });

    it('no notice for a declined list, nor for one that needed no approval (create_tasks answered with the IDs)', async () => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], 'call-declined');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      await respond(w, asked.escalationId, 'decline');
      await settle();
      expect(await w.store.get(planNoticeOperationOf(asked.taskPlanId))).toBeUndefined();

      const free = await begin(make, false);
      const made = await createTasks(free, [item('x', 'X')], 'call-free');
      expect(made).toMatchObject({ status: 'created' });
      const plan = (await instanceOf(free)).taskPlans[0]!;
      await settle();
      expect(await free.store.get(planNoticeOperationOf(plan.id))).toBeUndefined();
      // A restart does not make one either.
      const again = await free.restart();
      await settle();
      expect(await again.store.get(planNoticeOperationOf(plan.id))).toBeUndefined();
    });

    it('a crash after the approval and before the notice was accepted: the restart makes it, once', async () => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], 'call-crash-notice');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      crashOnce(w.store, 'accept', (input) => (input as { kind?: string }).kind === 'system-notice');
      await respond(w, asked.escalationId, 'approve').catch(() => undefined);
      await settle();
      // The decision and the tasks are stored; the notice is not.
      expect((await instanceOf(w)).taskPlans[0]?.state).toBe('created');
      expect(await w.store.get(op)).toBeUndefined();
      expect(notices([w], op)).toHaveLength(0);

      const r = await w.restart();
      await settle();
      expect(await r.store.get(op)).toMatchObject({ kind: 'system-notice', delivery: { state: 'sent' } });
      expect(notices([w, r], op)).toHaveLength(1);

      // Two paths at once (two recoveries, as a second restart's would race the first's): still one record, one dispatch.
      await Promise.all([r.engine.recover(), r.engine.recover()]);
      await settle();
      const again = await r.restart();
      await settle();
      expect(notices([w, r, again], op)).toHaveLength(1);
      expect((await again.store.listByState('sent')).filter((x) => x.operationId === op)).toHaveLength(1);
    });

    it('two recoveries at once while the notice was never made: one record, one dispatch', async () => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], 'call-race-notice');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      crashOnce(w.store, 'accept', (input) => (input as { kind?: string }).kind === 'system-notice');
      await respond(w, asked.escalationId, 'approve').catch(() => undefined);
      await settle();
      expect(await w.store.get(op)).toBeUndefined();
      // Both paths that make up for it run together: the approval's own retry would be the same call.
      await Promise.all([w.engine.recover(), w.engine.recover()]);
      await settle();
      expect(notices([w], op)).toHaveLength(1);
      expect(await w.store.get(op)).toMatchObject({ delivery: { state: 'sent' } });
    });

    it('a notice whose delivery stays unknown is escalated to the user (delivery-unknown), never resent by itself', async () => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], 'call-unknown-notice');
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      // Lost on the way: the runtime may or may not have it, and its history does not say (CR-2).
      w.claude.dispatchModes.push('lost');
      await respond(w, asked.escalationId, 'approve');
      await settle();
      expect(await w.store.get(op)).toMatchObject({ delivery: { state: 'unknown' } });
      const open = (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');
      expect(open).toMatchObject([{ ref: { kind: 'peerMessage', peerMessageId: `peer-${op}` } }]);
      const r = await w.restart();
      await settle();
      expect(notices([w, r], op)).toHaveLength(1);
      expect(await r.store.get(op)).toMatchObject({ delivery: { state: 'unknown' } });
    });

    it.each(['wait', 'cancel', 'retry'] as const)('the escalation of an unknown notice, resolved with %s, makes or changes no peer message', async (decision) => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], `call-resolve-${decision}`);
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      w.claude.dispatchModes.push('lost');
      await respond(w, asked.escalationId, 'approve');
      await settle();
      const before = await w.repositories.peerMessages.list();
      const [escalation] = (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');
      if (escalation === undefined) throw new Error('no escalation');
      expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation.id, decision, acceptDuplicateRisk: decision === 'retry' })).toMatchObject({ ok: true });
      await settle();
      expect(await w.repositories.peerMessages.list()).toEqual(before);
      expect(await w.repositories.peerMessages.get(`peer-${op}` as never)).toBeUndefined();
      const record = await w.store.get(op);
      expect(record?.kind).toBe('system-notice');
      if (decision === 'retry') expect(notices([w], op)).toHaveLength(2);
      else expect(notices([w], op)).toHaveLength(1);
    });

    // r1 P1-5: the user's retry enters root the way the first try did: into its running turn, else as a new turn.
    it.each([
      ['still runs', 'insert'],
      ['has ended', 'new-turn'],
    ] as const)('a retried notice while root %s goes in as %s, as the first try did', async (rootState, expected) => {
      const w = await begin(make, true);
      const asked = await createTasks(w, [item('a', 'A')], `call-retry-${expected}`);
      if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
      const op = planNoticeOperationOf(asked.taskPlanId);
      const root = (await instanceOf(w)).rootSessionId;
      w.emitTurn(root, 'turn-busy', 'running');
      await settle();
      w.claude.dispatchModes.push('lost');
      await respond(w, asked.escalationId, 'approve');
      await settle();
      expect(notices([w], op).map((d) => d.entry.kind)).toEqual(['insert']);
      if (rootState === 'has ended') {
        w.emitTurn(root, 'turn-busy', 'completed');
        await settle();
      }
      const [escalation] = (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');
      if (escalation === undefined) throw new Error('no escalation');
      expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
      await settle();
      expect(notices([w], op).map((d) => d.entry.kind)).toEqual(['insert', expected]);
      expect(await w.store.get(op)).toMatchObject({ delivery: { state: 'sent' } });
    });
  });

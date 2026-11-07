// T065 cases (trial feedback #3, trial D): a notice to root inserted into root's running turn, right after the user approved
// root's task list. Its dispatch waited for its ack inside the run's queue while root's handoffs waited for that queue,
// and the runtime takes an inserted payload in only after the turn's tool calls return: the ack never came in time,
// the reconcile right after found nothing (the transcript had no record yet), and the notice stayed unknown. Here: the
// run's queue is not held for an ack; an insert that timed out is reconciled after its turn; the GUI's own notices never
// hold the end of a run, which closes them; handoffs and reports still do. With the fake runtimes, on the memory ports
// (core/workflow/t065.test.ts) and on SQLite (app/main/workflow-t065.test.ts).
import { describe, expect, it } from 'vitest';
import { type Escalation, MessageId, type SessionId, type WorkflowTemplate } from '../../../contracts';
import { planNoticeOperationOf } from '../../pipeline';
import { createTasks, pipelineTemplate, project } from '../../pipeline/testing/t032-cases';
import type { DispatchRequest, DispatchResult } from '../../ports';
import { LATE_RECONCILE_DELAYS_MS, LATE_RECONCILE_LIMIT_MS } from '../../sessions/late-checks';
import { FakeAdapter } from '../../sessions/testing/fake-adapter';
import { advanceClock, handoff, IMPL, instanceOf, rid, ROOT, sessionOf, settle, started, type World } from './harness';

const TIMEOUT: DispatchResult = { state: 'unknown', reason: 'timeout', written: true, detail: 'no reply frame echoed the uuid within the deadline' };
const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };

/** Every insert into a session goes to `answer` instead of the fake runtime; the rest as before. Returns what it saw. */
const inserts = (w: World, answer: (request: DispatchRequest) => Promise<DispatchResult>): DispatchRequest[] => {
  const seen: DispatchRequest[] = [];
  const original = w.claude.dispatchOnce.bind(w.claude);
  w.claude.dispatchOnce = (request) => {
    if (request.entry.kind !== 'insert') return original(request);
    seen.push(request);
    return answer(request);
  };
  return seen;
};

/** What the runtime does once the turn takes an inserted payload in: it is in the transcript from then on. */
const store = (w: World, request: DispatchRequest) => w.claude.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });

/**
 * The main process's `sleep` on a virtual time the test moves (r1 P2-5): each wait ends when the time reaches its end,
 * in order, and the harness clock (the service's `now`) moves with it, so the reconciles' points in time can be told.
 */
const sleeps = (w: World) => {
  const asked: number[] = [];
  let t = 0;
  const waiting: { at: number; resolve: () => void }[] = [];
  (w.service as unknown as { options: { sleep?: (ms: number) => Promise<void> } }).options.sleep = (ms) => {
    asked.push(ms);
    return new Promise<void>((resolve) => waiting.push({ at: t + ms, resolve }));
  };
  const reconciledAt: number[] = [];
  const reconcile = w.claude.reconcile.bind(w.claude);
  w.claude.reconcile = (request) => {
    reconciledAt.push(t);
    return reconcile(request);
  };
  return {
    asked,
    /** The virtual time of each reconcile of the Claude runtime, in order. */
    reconciledAt,
    now: () => t,
    /** Moves the virtual time on by `ms`, ending each wait due on the way in order. */
    elapse: async (ms: number) => {
      const to = t + ms;
      for (;;) {
        const next = waiting.filter((x) => x.at <= to).sort((x, y) => x.at - y.at)[0];
        if (next === undefined) break;
        waiting.splice(waiting.indexOf(next), 1);
        advanceClock(next.at - t);
        t = next.at;
        next.resolve();
        await settle();
      }
      advanceClock(to - t);
      t = to;
      await settle();
    },
  };
};

const LAST = LATE_RECONCILE_DELAYS_MS.at(-1)!;

const unknownEscalations = async (w: World): Promise<Escalation[]> => (await w.repositories.escalations.list()).filter((e) => e.kind === 'delivery-unknown');
const reconcilesOf = (w: World, request: DispatchRequest) => w.claude.reconciled.filter((r) => r.clientMessageId === request.attempt.clientMessageId).length;

/** A pipeline run whose root is in its first turn (held), with a task list waiting for the user. */
const awaitingList = async (make: Make, confirm = true) => {
  const w = await make(pipelineTemplate({ confirm }));
  await w.repositories.projects.save(project(), null);
  w.holding.add(ROOT);
  expect(await started(w)).toMatchObject({ ok: true });
  await settle();
  const asked = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], `call-${String(Math.random())}`);
  if (asked.status !== 'awaiting-confirmation') throw new Error(`not asked: ${asked.status}`);
  return { w, asked, notice: planNoticeOperationOf(asked.taskPlanId) };
};

const approve = async (w: World, escalationId: Escalation['id']) => {
  expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision: 'approve' })).toMatchObject({ ok: true });
  await settle();
};

const end = async (w: World, type: 'workflow.complete' | 'workflow.cancel') => {
  const instance = await instanceOf(w);
  return w.run({ type, requestId: rid(), instanceId: instance.id, expectedRevision: instance.revision });
};

export type Make = (workflow: WorkflowTemplate) => Promise<World>;

export const t065Cases = (backend: string, make: Make) => {
  /** A run with impl working on task a, root in a turn of its own. */
  const working = async () => {
    const w = await make(pipelineTemplate());
    await w.repositories.projects.save(project(), null);
    w.holding.add(ROOT);
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    const created = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-report-tasks');
    if (created.status !== 'created') throw new Error(created.status);
    expect(await handoff(w, ROOT, { ...toImpl, taskId: created.tasks[0]!.taskId, content: 'build a' })).toMatchObject({ status: 'accepted' });
    await settle();
    const impl = await sessionOf(w, IMPL);
    return { w, impl, taskId: created.tasks[0]!.taskId };
  };
  const report = (w: World, impl: SessionId, content: string, call = `call-${content}`) => w.engine.reportToRoot({ content, needsUserConfirmation: false }, { caller: impl, sourceCallRef: call });
  const reportOf = async (w: World, content: string) => (await w.repositories.peerMessages.list()).find((p) => p.text.includes(content));

  describe(`T065 (${backend}): the notice of an approved task list, inserted into root's running turn`, () => {
    it('repro D: while its dispatch waits for the ack, the user\'s approval and root\'s handoff both go on; it is sent once', async () => {
      const { w, asked, notice } = await awaitingList(make);
      let ack: (result: DispatchResult) => void = () => undefined;
      const seen = inserts(w, () => new Promise((resolve) => (ack = resolve)));
      let approved = false;
      void w.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' }).then(() => (approved = true));
      await settle();
      let handed: unknown;
      void handoff(w, ROOT, { ...toImpl, taskId: `${asked.taskPlanId}:a` as never, content: 'build a' }).then((result) => (handed = result));
      for (let i = 0; i < 10; i++) await settle();
      // Before T065 both waited for the notice's ack, which needed the handoff's result first: a 60 s standstill.
      expect(approved).toBe(true);
      expect(handed).toMatchObject({ status: 'accepted' });
      expect(seen).toHaveLength(1);
      expect(w.service.beingConfirmed(notice)).toBe(true);
      // The handoff returned, the runtime takes the notice in and acks it.
      store(w, seen[0]!);
      ack({ state: 'sent', nativeRef: { sessionRef: seen[0]!.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' } });
      await settle();
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(await unknownEscalations(w)).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('its ack timed out in the running turn: no reconcile and no question before the turn ends; found then, it is sent', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      expect(seen).toHaveLength(1);
      expect((await w.store.get(notice))?.delivery.state).toBe('unknown');
      // Before T065: reconciled right away (not-found) and escalated.
      expect(reconcilesOf(w, seen[0]!)).toBe(0);
      expect(await unknownEscalations(w)).toEqual([]);
      expect(w.service.beingConfirmed(notice)).toBe(true);
      // The turn took it in and stored it, then ended.
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(reconcilesOf(w, seen[0]!)).toBe(1);
      expect(await unknownEscalations(w)).toEqual([]);
      expect(w.service.beingConfirmed(notice)).toBe(false);
      expect(seen).toHaveLength(1);
    });

    it('after the turn it is looked for again at each delay; stored a little later, it is found and nothing is asked', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      // The limit, counted from the dispatch.
      expect(clock.asked).toHaveLength(1);
      expect(clock.asked[0]).toBeGreaterThan(LATE_RECONCILE_LIMIT_MS - 1_000);
      await w.finishTurn(ROOT);
      expect(reconcilesOf(w, seen[0]!)).toBe(1);
      await clock.elapse(LATE_RECONCILE_DELAYS_MS[1]!);
      expect(reconcilesOf(w, seen[0]!)).toBe(2);
      // The runtime wrote it only now (the next turn took it in).
      store(w, seen[0]!);
      await clock.elapse(LATE_RECONCILE_DELAYS_MS[2]! - LATE_RECONCILE_DELAYS_MS[1]!);
      expect(reconcilesOf(w, seen[0]!)).toBe(3);
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(await unknownEscalations(w)).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('not found at any look after the turn: only then unknown, one question, worded as the GUI\'s own notice', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      await w.finishTurn(ROOT);
      let previous = 0;
      for (const at of LATE_RECONCILE_DELAYS_MS.filter((d) => d > 0)) {
        expect(await unknownEscalations(w)).toEqual([]);
        await clock.elapse(at - previous);
        previous = at;
      }
      expect(reconcilesOf(w, seen[0]!)).toBe(LATE_RECONCILE_DELAYS_MS.length);
      const escalations = await unknownEscalations(w);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatchObject({ state: 'open', rootSessionId: ROOT, title: 'Notice to root: delivery outcome unknown' });
      expect(escalations[0]?.detail).toContain("the GUI's own notice to root");
      expect(escalations[0]?.detail).toContain('does not affect any task');
      expect(escalations[0]?.detail).toContain('reason: not-found');
      expect((await w.store.get(notice))?.delivery.state).toBe('unknown');
      expect(w.service.beingConfirmed(notice)).toBe(false);
      // Another turn end looks no more, and nothing was sent again.
      w.emitTurn(ROOT, 'turn-later', 'running');
      w.emitTurn(ROOT, 'turn-later', 'completed');
      await settle();
      expect(reconcilesOf(w, seen[0]!)).toBe(LATE_RECONCILE_DELAYS_MS.length);
      expect(seen).toHaveLength(1);
    });

    it('a turn that runs past the limit: asked then; its end finds the notice, and the system closes that question', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      await clock.elapse(LATE_RECONCILE_LIMIT_MS);
      const [question] = await unknownEscalations(w);
      expect(question).toMatchObject({ state: 'open' });
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(await w.repositories.escalations.get(question!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
      expect(seen).toHaveLength(1);
    });

    it('the user\'s own message inserted into the running turn is reconciled after the turn as well', async () => {
      const w = await make(pipelineTemplate());
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      const root = await w.repositories.sessions.get(ROOT);
      const messageId = MessageId.parse('m-t065-insert');
      expect(await w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId, expectedRevision: root!.revision, text: 'one more thing', attachments: [] })).toMatchObject({
        ok: false,
        code: 'unknown_outcome',
      });
      expect(reconcilesOf(w, seen[0]!)).toBe(0);
      expect(await unknownEscalations(w)).toEqual([]);
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get(`user-message:${messageId}` as never))?.delivery.state).toBe('sent');
      expect((await w.repositories.sessions.get(ROOT))?.activity).not.toBe('reconciling');
      expect(await unknownEscalations(w)).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('the runtime exiting before the turn ended counts as its end (the transcript is final)', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      store(w, seen[0]!);
      w.claude.emit({ type: 'runtime.exited', runtime: 'claude', sessionIds: [ROOT], expected: false, code: 1, signal: null, at: '2026-10-29T01:00:00.000Z' });
      await settle();
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(await unknownEscalations(w)).toEqual([]);
    });

    it('a restart before the turn ended: recovery reconciles it (found: sent; not found: one question)', async () => {
      for (const found of [true, false]) {
        const { w, asked, notice } = await awaitingList(make);
        const seen = inserts(w, () => Promise.resolve(TIMEOUT));
        await approve(w, asked.escalationId);
        expect(await unknownEscalations(w)).toEqual([]);
        // The runtime of the next start reads the same transcript: what the last one stored is on it.
        // eslint-disable-next-line @typescript-eslint/unbound-method -- put back on the prototype, and called with this below
        const original = FakeAdapter.prototype.reconcile;
        const request = seen[0]!;
        FakeAdapter.prototype.reconcile = function (this: FakeAdapter, r) {
          if (found) this.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
          return original.call(this, r);
        };
        try {
          const r = await w.restart();
          await settle();
          expect((await r.store.get(notice))?.delivery.state).toBe(found ? 'sent' : 'unknown');
          expect(await unknownEscalations(r)).toHaveLength(found ? 0 : 1);
          expect(r.claude.dispatched.filter((d) => d.text === request.text)).toEqual([]);
        } finally {
          FakeAdapter.prototype.reconcile = original;
        }
      }
    });
  });

  describe(`T065 (${backend}): ending a run`, () => {
    it.each(['workflow.complete', 'workflow.cancel'] as const)('%s with the notice unknown and asked about: allowed; the system closes it and keeps the record', async (type) => {
      const { w, asked, notice } = await awaitingList(make);
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      await w.finishTurn(ROOT);
      await clock.elapse(LAST);
      const [question] = await unknownEscalations(w);
      expect(question).toMatchObject({ state: 'open' });
      expect(await end(w, type)).toMatchObject({ ok: true });
      await settle();
      expect(await w.repositories.escalations.get(question!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
      const record = await w.store.get(notice);
      expect(record?.outcome).toMatchObject({ kind: 'cancelled' });
      expect(record?.outcome?.detail).toContain(type === 'workflow.complete' ? 'completed' : 'cancelled');
      expect(w.logs.some((l) => l.includes('left unconfirmed were closed with the run'))).toBe(true);
      // Root counts as idle again (the supervisor kept it open for this in trial D).
      expect((await w.service.idleFacts(ROOT))?.deliveries).toEqual({ pending: 0, unknown: 0 });
      // A restart asks nothing about it again.
      const r = await w.restart();
      await settle();
      expect((await unknownEscalations(r)).filter((e) => e.state === 'open')).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('a notice still being confirmed when the run ends: the end goes on, and nothing asks about the notice later', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      await approve(w, asked.escalationId);
      expect(w.service.beingConfirmed(notice)).toBe(true);
      expect(await end(w, 'workflow.complete')).toMatchObject({ ok: true });
      await settle();
      expect((await w.store.get(notice))?.outcome).toMatchObject({ kind: 'cancelled' });
      await w.finishTurn(ROOT);
      await clock.elapse(LAST);
      expect(await unknownEscalations(w)).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('a notice not dispatched yet when the run ends is never sent', async () => {
      const { w, asked, notice } = await awaitingList(make);
      // Root's queue is held (a user message waits for its ack), so the notice waits behind it.
      let ack: (result: DispatchResult) => void = () => undefined;
      const seen = inserts(w, () => new Promise((resolve) => (ack = resolve)));
      const root = await w.repositories.sessions.get(ROOT);
      void w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse('m-hold'), expectedRevision: root!.revision, text: 'hold', attachments: [] });
      await settle();
      await approve(w, asked.escalationId);
      expect((await w.store.get(notice))?.delivery.state).toBe('pending');
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      ack(TIMEOUT);
      await settle();
      expect(seen.filter((s) => s.text.includes('Notice from the GUI'))).toEqual([]);
      expect((await w.store.get(notice))?.outcome).toMatchObject({ kind: 'cancelled' });
      expect((await w.service.idleFacts(ROOT))?.deliveries.pending).toBe(0);
    });

    it('an unknown handoff still holds complete and cancel (D-12)', async () => {
      const { w, asked } = await awaitingList(make);
      await approve(w, asked.escalationId);
      w.onNewCodex = (adapter) => adapter.dispatchModes.push('lost');
      expect(await handoff(w, ROOT, { ...toImpl, taskId: `${asked.taskPlanId}:a` as never, content: 'build a' })).toMatchObject({ status: 'accepted' });
      await settle();
      expect((await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).map((h) => h.delivery.state)).toContain('unknown');
      for (const type of ['workflow.complete', 'workflow.cancel'] as const) {
        expect(await end(w, type)).toMatchObject({ ok: false, code: 'invalid_transition', message: 'A delivery of this run has an unknown outcome; decide it first' });
      }
    });
  });

  describe(`T065 (${backend}): reports to root go outside the run's queue`, () => {

    it('while a report waits for its ack, root\'s own handoff is not held by it', async () => {
      const { w, impl, taskId } = await working();
      let ack: (result: DispatchResult) => void = () => undefined;
      const seen = inserts(w, () => new Promise((resolve) => (ack = resolve)));
      let reported: unknown;
      void report(w, impl, 'progress').then((r) => (reported = r));
      await settle();
      expect(seen).toHaveLength(1);
      let handed: unknown;
      void handoff(w, ROOT, { ...toImpl, taskId, content: 'more for a' }).then((r) => (handed = r));
      for (let i = 0; i < 10; i++) await settle();
      expect(handed).toBeDefined();
      // The reporting call itself still waits for its dispatch (outside the run's queue).
      expect(reported).toBeUndefined();
      store(w, seen[0]!);
      ack(TIMEOUT);
      await w.finishTurn(ROOT);
      expect(reported).toMatchObject({ status: 'reported' });
      expect((await reportOf(w, 'progress'))?.delivery.state).toBe('sent');
    });

    it('two reports in a row from one node reach root in their order, each once, neither in place of the other', async () => {
      const { w, impl } = await working();
      const acks: ((result: DispatchResult) => void)[] = [];
      const seen = inserts(w, (request) => {
        store(w, request);
        return new Promise((resolve) => acks.push(resolve));
      });
      const first = report(w, impl, 'first report');
      const second = report(w, impl, 'second report');
      await settle();
      // Root's queue sends one at a time, in the order the run's queue accepted them.
      expect(seen.map((s) => s.text.includes('first report'))).toEqual([true]);
      acks[0]!({ state: 'sent', nativeRef: { sessionRef: seen[0]!.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'ack' } });
      await settle();
      expect(seen.map((s) => (s.text.includes('first report') ? 1 : s.text.includes('second report') ? 2 : 0))).toEqual([1, 2]);
      acks[1]!({ state: 'sent', nativeRef: { sessionRef: seen[1]!.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'ack' } });
      expect(await first).toMatchObject({ status: 'reported' });
      expect(await second).toMatchObject({ status: 'reported' });
      const a = await reportOf(w, 'first report');
      const b = await reportOf(w, 'second report');
      expect(a?.id).not.toBe(b?.id);
      expect([a?.delivery.state, b?.delivery.state]).toEqual(['sent', 'sent']);
      expect(seen).toHaveLength(2);
    });

    it('the run ends while a report is on its way: refused as being confirmed (retryable) until it is known, then allowed', async () => {
      const { w, impl } = await working();
      let ack: (result: DispatchResult) => void = () => undefined;
      const seen = inserts(w, () => new Promise((resolve) => (ack = resolve)));
      const sending = report(w, impl, 'late report');
      await settle();
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true, message: 'A delivery of this run is still being confirmed; try again in a moment' });
      // Timed out in root's turn: still being confirmed, not yet a question.
      ack(TIMEOUT);
      await settle();
      expect(await sending).toMatchObject({ status: 'reported' });
      expect(await end(w, 'workflow.complete')).toMatchObject({ ok: false, retryable: true, message: 'A delivery of this run is still being confirmed; try again in a moment' });
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await reportOf(w, 'late report'))?.delivery.state).toBe('sent');
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      expect((await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
      expect(seen).toHaveLength(1);
    });

    it('a report not found after root\'s turn still holds the end of the run (D-12)', async () => {
      const { w, impl } = await working();
      const clock = sleeps(w);
      inserts(w, () => Promise.resolve(TIMEOUT));
      expect(await report(w, impl, 'lost report')).toMatchObject({ status: 'reported' });
      await w.finishTurn(ROOT);
      await clock.elapse(LAST);
      expect(await unknownEscalations(w)).toHaveLength(1);
      for (const type of ['workflow.complete', 'workflow.cancel'] as const) {
        expect(await end(w, type)).toMatchObject({ ok: false, code: 'invalid_transition', message: 'A delivery of this run has an unknown outcome; decide it first' });
      }
    });

    it('a report still queued for root when the run ends is never sent, and holds nothing', async () => {
      const { w, impl } = await working();
      let ack: (result: DispatchResult) => void = () => undefined;
      const seen = inserts(w, () => new Promise((resolve) => (ack = resolve)));
      // Root's queue is held by a message of the user's waiting for its ack; the report waits behind it.
      const root = await w.repositories.sessions.get(ROOT);
      void w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse('m-hold-2'), expectedRevision: root!.revision, text: 'hold', attachments: [] });
      await settle();
      const sending = report(w, impl, 'queued report');
      await settle();
      expect((await reportOf(w, 'queued report'))?.delivery.state).toBe('pending');
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      ack({ state: 'sent', nativeRef: { sessionRef: seen[0]!.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'ack' } });
      expect(await sending).toMatchObject({ status: 'reported' });
      await settle();
      expect(seen.filter((s) => s.text.includes('queued report'))).toEqual([]);
      const queued = await reportOf(w, 'queued report');
      // Read from the store: the memory peer-message view of the harness does not carry the outcome.
      const stored = await w.store.get(queued!.operationId);
      expect(stored?.outcome).toMatchObject({ kind: 'cancelled', detail: 'the run was cancelled' });
      expect(stored?.delivery.state).toBe('pending');
      expect((await w.service.idleFacts(ROOT))?.deliveries).toEqual({ pending: 0, unknown: 0 });
      expect((await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
    });
  });
  describe(`T065 r1 (${backend}): what the first review found`, () => {
    const NOTICE_TEXT = 'Notice from the GUI';
    /** Root's queue held by a message of the user's whose insert never answers: what comes for root waits behind it. */
    const holdRoot = async (w: World, id: string) => {
      const root = await w.repositories.sessions.get(ROOT);
      void w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse(id), expectedRevision: root!.revision, text: `hold ${id}`, attachments: [] });
      await settle();
    };
    /** Root's runtime closed, and its next resume held: a delivery to root waits in its target's preparation. */
    const closedRootHeld = async (w: World) => {
      await w.finishTurn(ROOT);
      await w.service.closeWorkflowRuntime(ROOT);
      let release: () => void = () => undefined;
      w.claude.resumeGate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        w.claude.resumeGate = undefined;
        release();
      };
    };
    const noticesSent = (w: World) => w.claude.dispatched.filter((d) => d.text.includes(NOTICE_TEXT));

    it('P1-1: a notice cancelled with its run while still pending is not sent by the next start', async () => {
      const { w, asked, notice } = await awaitingList(make);
      inserts(w, () => new Promise(() => undefined));
      await holdRoot(w, 'm-r1-hold-notice');
      await approve(w, asked.escalationId);
      expect((await w.store.get(notice))?.delivery.state).toBe('pending');
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      expect((await w.store.get(notice))?.outcome).toMatchObject({ kind: 'cancelled' });
      const r = await w.restart();
      await settle();
      expect(noticesSent(r)).toEqual([]);
      expect(await r.store.get(notice)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
    });

    it('P1-1: a report cancelled with its run while still queued is not sent by the next start', async () => {
      const { w, impl } = await working();
      inserts(w, () => new Promise(() => undefined));
      await holdRoot(w, 'm-r1-hold-report');
      void report(w, impl, 'report before restart');
      await settle();
      const queued = await reportOf(w, 'report before restart');
      expect(queued?.delivery.state).toBe('pending');
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      const r = await w.restart();
      await settle();
      expect(r.claude.dispatched.filter((d) => d.text.includes('report before restart'))).toEqual([]);
      expect(await r.store.get(queued!.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
    });

    it('P1-2: a notice whose run is cancelled while its target is being prepared is not claimed or sent afterwards', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const release = await closedRootHeld(w);
      await approve(w, asked.escalationId);
      // The notice is in its preparation (root resumes first): not claimed yet.
      expect((await w.store.get(notice))?.delivery.attempts).toEqual([]);
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      await settle();
      release();
      await settle();
      expect(noticesSent(w)).toEqual([]);
      expect(await w.store.get(notice)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it('P1-2: a report whose run completes while root is being prepared is not sent after the end', async () => {
      const { w, impl } = await working();
      const release = await closedRootHeld(w);
      let reported: unknown;
      void report(w, impl, 'report during prepare').then((r) => (reported = r));
      await settle();
      const record = await reportOf(w, 'report during prepare');
      expect(record?.delivery.attempts).toEqual([]);
      expect(await end(w, 'workflow.complete')).toMatchObject({ ok: true });
      await settle();
      release();
      await settle();
      expect(reported).toMatchObject({ status: 'reported' });
      expect(w.claude.dispatched.filter((d) => d.text.includes('report during prepare'))).toEqual([]);
      expect(await w.store.get(record!.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it("P1-3: root's runtime exits before the insert times out: reconciled at once, asked once, then no longer being confirmed", async () => {
      const { w, impl } = await working();
      const clock = sleeps(w);
      let ack: (result: DispatchResult) => void = () => undefined;
      inserts(w, () => new Promise((resolve) => (ack = resolve)));
      const sending = report(w, impl, 'report before exit');
      await settle();
      w.claude.emit({ type: 'runtime.exited', runtime: 'claude', sessionIds: [ROOT], expected: false, code: 1, signal: null, at: '2026-10-29T01:00:00.000Z' });
      await settle();
      ack(TIMEOUT);
      expect(await sending).toMatchObject({ status: 'reported' });
      await settle();
      const operationId = (await reportOf(w, 'report before exit'))!.operationId;
      // No end of the turn comes any more: the reconcile started at once.
      expect(clock.reconciledAt).toEqual([0]);
      await clock.elapse(LAST);
      expect(clock.reconciledAt).toHaveLength(LATE_RECONCILE_DELAYS_MS.length);
      expect(await unknownEscalations(w)).toHaveLength(1);
      expect(w.service.beingConfirmed(operationId)).toBe(false);
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: false, message: 'A delivery of this run has an unknown outcome; decide it first' });
    });

    it("P1-3: escalated at the limit, it is no longer being confirmed; the turn's later end still closes the question", async () => {
      const { w, impl } = await working();
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      expect(await report(w, impl, 'report past the limit')).toMatchObject({ status: 'reported' });
      const operationId = (await reportOf(w, 'report past the limit'))!.operationId;
      expect(w.service.beingConfirmed(operationId)).toBe(true);
      await clock.elapse(LATE_RECONCILE_LIMIT_MS);
      const [question] = await unknownEscalations(w);
      expect(question).toMatchObject({ state: 'open' });
      expect(w.service.beingConfirmed(operationId)).toBe(false);
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: false, message: 'A delivery of this run has an unknown outcome; decide it first' });
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get(operationId))?.delivery.state).toBe('sent');
      expect(await w.repositories.escalations.get(question!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      expect(seen).toHaveLength(1);
    });

    it("P2-4: a user message found sent after its turn is not shown twice when the runtime's late echo comes", async () => {
      const w = await make(pipelineTemplate());
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      const root = await w.repositories.sessions.get(ROOT);
      const text = 'say it once';
      await w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse('m-r1-echo'), expectedRevision: root!.revision, text, attachments: [] });
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get('user-message:m-r1-echo' as never))?.delivery.state).toBe('sent');
      // The runtime's own record of the prompt, under the attempt's clientMessageId.
      w.claude.emit({
        type: 'message.completed',
        message: { id: MessageId.parse(seen[0]!.attempt.clientMessageId), sessionId: ROOT, role: 'user', origin: { kind: 'user' }, text, attachments: [], createdAt: '2026-10-29T01:00:05.000Z' },
      });
      await settle();
      expect((await w.repositories.conversations.get(ROOT)).messages.filter((m) => m.text === text).map((m) => m.id)).toEqual(['m-r1-echo']);
    });

    it('P2-5: after the turn the reconciles fall at 0, 2, 5 and 10 s from its end; the limit counts from the dispatch', async () => {
      const { w, asked } = await awaitingList(make);
      const clock = sleeps(w);
      // The ack is waited for 90 s before the dispatch times out.
      const seen = inserts(w, () => {
        advanceClock(90_000);
        return Promise.resolve(TIMEOUT);
      });
      await approve(w, asked.escalationId);
      expect(clock.asked).toHaveLength(1);
      expect(clock.asked[0]).toBeLessThanOrEqual(LATE_RECONCILE_LIMIT_MS - 90_000);
      expect(clock.asked[0]).toBeGreaterThan(LATE_RECONCILE_LIMIT_MS - 91_000);
      await clock.elapse(1_000);
      const ended = clock.now();
      await w.finishTurn(ROOT);
      await clock.elapse(LAST + 1_000);
      const offsets = clock.reconciledAt.map((t) => t - ended);
      expect(offsets).toHaveLength(LATE_RECONCILE_DELAYS_MS.length);
      for (const [i, at] of LATE_RECONCILE_DELAYS_MS.entries()) {
        expect(offsets[i]).toBeGreaterThanOrEqual(at - 50);
        expect(offsets[i]).toBeLessThanOrEqual(at);
      }
      expect(seen).toHaveLength(1);
    });
  });
  describe(`T065 r2 (${backend}): what the second review found`, () => {
    /**
     * Holds every dispatch right after its target's preparation, the last wait before the store's claim (Astra r2: the
     * cancel lands after every read the dispatch made). Released by the test.
     */
    const pauseBeforeClaim = (w: World) => {
      const service = w.service as unknown as { prepareTarget: (record: unknown) => Promise<void> };
      const prepare = service.prepareTarget.bind(w.service);
      let release: () => void = () => undefined;
      let paused = 0;
      service.prepareTarget = async (record) => {
        await prepare(record);
        paused++;
        await new Promise<void>((resolve) => (release = resolve));
      };
      return { paused: () => paused, release: () => release() };
    };

    it('P1: a notice whose run is cancelled after its last read before the claim is not claimed or sent', async () => {
      const { w, asked, notice } = await awaitingList(make);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      const gate = pauseBeforeClaim(w);
      await approve(w, asked.escalationId);
      expect(gate.paused()).toBe(1);
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      // The cancel answered with the notice's outcome already written.
      expect((await w.store.get(notice))?.outcome).toMatchObject({ kind: 'cancelled' });
      gate.release();
      await settle();
      expect(seen).toEqual([]);
      expect(await w.store.get(notice)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it('P1: a report whose run completes after its last read before the claim is not claimed or sent', async () => {
      const { w, impl } = await working();
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      const gate = pauseBeforeClaim(w);
      let reported: unknown;
      void report(w, impl, 'report at the claim').then((r) => (reported = r));
      await settle();
      expect(gate.paused()).toBe(1);
      expect(await end(w, 'workflow.complete')).toMatchObject({ ok: true });
      gate.release();
      await settle();
      expect(reported).toMatchObject({ status: 'reported' });
      expect(seen).toEqual([]);
      const record = await reportOf(w, 'report at the claim');
      expect(await w.store.get(record!.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it('P2: the limit\'s question written after the turn\'s end found the payload sent is not left open', async () => {
      const { w, impl } = await working();
      const clock = sleeps(w);
      const seen = inserts(w, () => Promise.resolve(TIMEOUT));
      expect(await report(w, impl, 'report at the limit and the end')).toMatchObject({ status: 'reported' });
      const operationId = (await reportOf(w, 'report at the limit and the end'))!.operationId;
      // The escalations queue is held, as Astra did: the limit's question waits in it.
      let open: () => void = () => undefined;
      void (w.service as unknown as { serial: (key: string, fn: () => Promise<void>) => Promise<void> }).serial('escalations', () => new Promise<void>((resolve) => (open = resolve)));
      await clock.elapse(LATE_RECONCILE_LIMIT_MS);
      expect(await unknownEscalations(w)).toEqual([]);
      // Meanwhile the turn ends and the runtime has stored the payload: found sent.
      store(w, seen[0]!);
      await w.finishTurn(ROOT);
      expect((await w.store.get(operationId))?.delivery.state).toBe('sent');
      open();
      await settle();
      expect((await unknownEscalations(w)).filter((e) => e.state === 'open')).toEqual([]);
      expect(await end(w, 'workflow.cancel')).toMatchObject({ ok: true });
      expect(seen).toHaveLength(1);
    });
  });
};

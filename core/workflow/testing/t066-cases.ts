// T066 cases (T065 Astra r4): nothing goes to root or to a node at the moment a run ends. A `send_message` of the run to
// its root is accepted in the run's queue (so the end's closing step lists it, and none is accepted after the end); root's
// own `report_to_root` after the end is refused as a node's is; the run's handoffs not claimed yet are closed with root's
// reports in the end's one closing step, before the end is committed. On the memory ports (core/workflow/t066.test.ts)
// and on SQLite (app/main/workflow-t066.test.ts).
import { describe, expect, it } from 'vitest';
import { OperationId, type SessionId, type WorkflowTemplate } from '../../../contracts';
import { createTasks, pipelineTemplate, project } from '../../pipeline/testing/t032-cases';
import type { DispatchRequest, DispatchResult } from '../../ports';
import { handoff, IMPL, instanceOf, REVIEW, rid, ROOT, sessionOf, settle, started, template, type World } from './harness';

export type Make = (workflow: WorkflowTemplate) => Promise<World>;

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const RUN_ENDED = { status: 'rejected', rejection: { reason: 'invalid-input', detail: 'this workflow run has ended' } };
const REPORT_BEING_SENT = 'A report to root is being sent; end the run once it has gone';
const HANDOFF_BEING_SENT = 'A handoff of this run is being sent; end the run once it has gone';

const end = async (w: World, type: 'workflow.complete' | 'workflow.cancel' = 'workflow.complete') => {
  const instance = await instanceOf(w);
  return w.run({ type, requestId: rid(), instanceId: instance.id, expectedRevision: instance.revision });
};
const tryEnd = (w: World, type: 'workflow.complete' | 'workflow.cancel' = 'workflow.complete') =>
  end(w, type).catch((error: unknown) => ({ ok: false as const, thrown: String(error) }));

/** A gate the test opens: `wait()` is pending until `open()`. */
const gate = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { wait: () => opened, open: () => release() };
};

/** Holds every dispatch right after its target's preparation, the last wait before the store's claim. */
const holdBeforeClaim = (w: World) => {
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
/** Holds the first `endUnclaimed` of the store: the end has listed what it closes, its closing step not run yet. */
const holdClosingStep = (w: World) => {
  const original = w.store.endUnclaimed.bind(w.store);
  let release: () => void = () => undefined;
  let paused = 0;
  w.store.endUnclaimed = async (ids, outcome) => {
    if (paused++ === 0) await new Promise<void>((resolve) => (release = resolve));
    return original(ids, outcome);
  };
  return { paused: () => paused, release: () => release() };
};
/** Holds what follows the end's commit (`afterEnd` settles the held handoffs first), so it cannot close anything late. */
const holdAfterEnd = (w: World) => {
  const engine = w.engine as unknown as { settleHeldNow: (id: unknown, task?: unknown) => Promise<void> };
  const original = engine.settleHeldNow.bind(w.engine);
  let release: () => void = () => undefined;
  let paused = 0;
  engine.settleHeldNow = async (id, task) => {
    if ((await instanceOf(w)).state !== 'running' && paused++ === 0) await new Promise<void>((resolve) => (release = resolve));
    return original(id, task);
  };
  return { paused: () => paused, release: () => release() };
};
/** Every dispatch records the run's state at that moment and the payload's text; `hold` keeps a dispatch until opened. */
const watch = (w: World, hold?: (request: DispatchRequest) => Promise<void> | undefined) => {
  const seen: { state: string; text: string }[] = [];
  w.dispatchGate = async (request) => {
    seen.push({ state: (await instanceOf(w)).state, text: request.text });
    await hold?.(request);
  };
  return { seen, of: (text: string) => seen.filter((s) => s.text.includes(text)).map((s) => s.state) };
};
/** Every insert into root goes to the test: it records the run's state and waits for `ack`. */
const insertsHeld = (w: World) => {
  const states: string[] = [];
  const seen: DispatchRequest[] = [];
  const acks: ((result: DispatchResult) => void)[] = [];
  const original = w.claude.dispatchOnce.bind(w.claude);
  w.claude.dispatchOnce = async (request) => {
    if (request.entry.kind !== 'insert') return original(request);
    seen.push(request);
    states.push((await instanceOf(w)).state);
    return new Promise<DispatchResult>((resolve) => acks.push(resolve));
  };
  /** The runtime takes it in: in the transcript, and its ack names it. */
  const ack = (i: number) => {
    const request = seen[i]!;
    w.claude.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
    acks[i]!({ state: 'sent', nativeRef: { sessionRef: request.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' } });
  };
  return { seen, states, ack };
};

export const t066Cases = (backend: string, make: Make) => {
  /** A run with impl working on task a (its first turn over), root in a turn of its own. */
  const working = async () => {
    const w = await make(pipelineTemplate());
    await w.repositories.projects.save(project(), null);
    w.holding.add(ROOT);
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    const created = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t066-tasks');
    if (created.status !== 'created') throw new Error(created.status);
    const taskId = created.tasks[0]!.taskId;
    expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'build a' })).toMatchObject({ status: 'accepted' });
    await settle();
    return { w, impl: await sessionOf(w, IMPL), taskId };
  };
  let messages = 0;
  /** impl's `send_message` to root; `op` names the operation (a resend repeats it). */
  const message = (w: World, from: SessionId, content: string, op = `op-t066-${String(++messages)}`) =>
    w.service.sendMessage({ to: ROOT, content }, { caller: from, operationId: OperationId.parse(op), sourceCallRef: `call-${op}` });

  describe(`T066 (${backend}): send_message of a run to its root`, () => {
    it('r4 P1: sent after the end listed root\'s reports, it waits for the run\'s queue and is refused once the end is committed', async () => {
      const { w, impl } = await working();
      const runtime = watch(w);
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      expect(step.paused()).toBe(1);
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void message(w, impl, 'late question', 'op-late').then((r) => (sent = r));
      await settle();
      const after = holdAfterEnd(w);
      step.release();
      await settle();
      claim.release();
      await settle();
      after.release();
      await settle();
      expect(answer).toMatchObject({ ok: true });
      expect(sent).toEqual(RUN_ENDED);
      expect(await w.store.get(OperationId.parse('op-late'))).toBeUndefined();
      expect(runtime.of('late question')).toEqual([]);
    });

    it.each(['workflow.complete', 'workflow.cancel'] as const)('claimed before the closing step, %s is refused as being sent; once it is sent the run ends', async (type) => {
      const { w, impl } = await working();
      const root = insertsHeld(w);
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void message(w, impl, 'question in the end', 'op-in-end').then((r) => (sent = r));
      await settle();
      expect(claim.paused()).toBe(1);
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w, type).then((r) => (answer = r));
      await settle();
      claim.release();
      await settle();
      expect(root.seen).toHaveLength(1);
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true, message: REPORT_BEING_SENT });
      expect(await w.store.get(OperationId.parse('op-in-end'))).toMatchObject({ delivery: { state: 'unknown' } });
      expect((await instanceOf(w)).state).toBe('running');
      root.ack(0);
      await settle();
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await end(w, type)).toMatchObject({ ok: true });
      await settle();
      const record = await w.store.get(OperationId.parse('op-in-end'));
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
      expect(root.states).toEqual(['running']);
    });

    it('closed by the end before its claim: never claimed or sent; a resend is told the run has ended and sends nothing', async () => {
      const { w, impl } = await working();
      const root = insertsHeld(w);
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void message(w, impl, 'question closed', 'op-closed').then((r) => (sent = r));
      await settle();
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: true });
      claim.release();
      await settle();
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'pending' });
      expect(await w.store.get(OperationId.parse('op-closed'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled', detail: 'the run was completed' } });
      // The same call again (its operation): not accepted again, not sent.
      expect(await message(w, impl, 'question closed', 'op-closed')).toEqual(RUN_ENDED);
      await settle();
      expect(root.seen).toEqual([]);
      expect(await w.store.get(OperationId.parse('op-closed'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it('after the end: a new one is refused with a reason; a resend of one sent before the end is a duplicate, sent once', async () => {
      const { w, impl } = await working();
      const root = insertsHeld(w);
      let first: unknown;
      void message(w, impl, 'question before', 'op-before').then((r) => (first = r));
      await settle();
      root.ack(0);
      await settle();
      expect(first).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect(await message(w, impl, 'question after', 'op-after')).toEqual(RUN_ENDED);
      expect(await w.store.get(OperationId.parse('op-after'))).toBeUndefined();
      expect(await message(w, impl, 'question before', 'op-before')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
      await settle();
      expect(root.seen).toHaveLength(1);
      expect(root.states).toEqual(['running']);
    });

    it('restart: a run committed as ended with a message to root not closed (older code, a crash) sends nothing; it is closed first', async () => {
      const { w, impl } = await working();
      insertsHeld(w);
      holdBeforeClaim(w);
      void message(w, impl, 'question of an old end', 'op-old-end');
      await settle();
      const instance = await instanceOf(w);
      const endedAt = '2026-10-29T02:00:00.000Z' as never;
      const committed = { ...instance, revision: instance.revision + 1, state: 'completed' as const, endedAt, tasks: instance.tasks.map((t) => ({ ...t, status: 'completed' as const, completedAt: endedAt })) };
      expect((await w.repositories.instances.update(committed, instance.revision)).status).toBe('saved');
      expect((await w.store.get(OperationId.parse('op-old-end')))?.outcome).toBeUndefined();
      const r = await w.restart();
      await settle();
      expect(r.claude.dispatched.filter((d) => d.text.includes('question of an old end'))).toEqual([]);
      expect(await r.store.get(OperationId.parse('op-old-end'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });
  });

  describe(`T066 (${backend}): the order of the queues (op → run → session)`, () => {
    it('root hands off in the run\'s queue while a node sends to root: both finish, neither waits for the other', async () => {
      const { w, impl, taskId } = await working();
      const held = gate();
      const runtime = watch(w, (request) => (request.text.includes('second') ? held.wait() : undefined));
      let handed: unknown;
      void handoff(w, ROOT, { ...toImpl, taskId, content: 'second' }).then((r) => (handed = r));
      await settle();
      // The handoff's dispatch holds the run's queue: the message waits for it, accepting nothing yet.
      expect(runtime.of('second')).toEqual(['running']);
      let sent: unknown;
      void message(w, impl, 'question while handing off', 'op-while').then((r) => (sent = r));
      await settle();
      expect(sent).toBeUndefined();
      expect(await w.store.get(OperationId.parse('op-while'))).toBeUndefined();
      held.open();
      await settle();
      expect(handed).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(sent).toMatchObject({ status: 'accepted' });
      expect((await w.store.get(OperationId.parse('op-while')))?.delivery.state).not.toBe('pending');
    });

    it('a message on its way to root holds root\'s queue: root\'s handoff and a second message still go on in the run\'s queue', async () => {
      const { w, impl, taskId } = await working();
      const root = insertsHeld(w);
      let first: unknown;
      void message(w, impl, 'first question', 'op-first').then((r) => (first = r));
      await settle();
      expect(root.seen).toHaveLength(1);
      // Root's queue waits for the first one's ack; the run's queue is free.
      let second: unknown;
      void message(w, impl, 'second question', 'op-second').then((r) => (second = r));
      await settle();
      expect(await w.store.get(OperationId.parse('op-second'))).toMatchObject({ delivery: { state: 'pending' } });
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'more work' })).toMatchObject({ status: 'accepted' });
      root.ack(0);
      await settle();
      expect(root.seen).toHaveLength(2);
      root.ack(1);
      await settle();
      expect(first).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(second).toMatchObject({ status: 'accepted', delivery: 'sent' });
    });
  });

  describe(`T066 r1 (${backend}): only a message to root waits for the run's queue`, () => {
    it("Astra r1 P1: root's message to another node goes while the run's queue waits for root's queue (held by an insert's ack)", async () => {
      // plan (root) → impl → review → root: review's handoff to root waits for root's queue in the run's queue.
      const w = await make(template());
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL } })).toMatchObject({ status: 'accepted' });
      await settle();
      const impl = await sessionOf(w, IMPL);
      expect(await handoff(w, impl, { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW } })).toMatchObject({ status: 'accepted' });
      await settle();
      const review = await sessionOf(w, REVIEW);
      // 1. impl's message into root's running turn: its ack is held, and root's queue with it.
      const root = insertsHeld(w);
      let first: unknown;
      void message(w, impl, 'question held', 'op-r1-held').then((r) => (first = r));
      await settle();
      expect(root.seen).toHaveLength(1);
      // 2. review hands off to root: in the run's queue. Root's queue no longer waits for the ack (T067, the ack waits in
      //    root's send lane), so it finds root's turn running and the handoff waits for its end, answered at once.
      let handed: unknown;
      void handoff(w, review, { ruleId: 'done', target: { kind: 'root' } }).then((r) => (handed = r));
      await settle();
      expect(handed).toMatchObject({ status: 'accepted', delivery: 'pending' });
      // 3. root, in that same running turn, sends to impl: it does not wait for the run's queue, so it returns (and root
      //    can go on to take the first message in).
      let aux: unknown;
      void w.service.sendMessage({ to: impl, content: 'note for impl' }, { caller: ROOT, operationId: OperationId.parse('op-r1-aux'), sourceCallRef: 'call-op-r1-aux' }).then((r) => (aux = r));
      await settle();
      expect(aux).toMatchObject({ status: 'accepted' });
      expect(first).toBeUndefined();
      root.ack(0);
      await settle();
      expect(first).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(handed).toMatchObject({ status: 'accepted' });
    });
  });

  describe(`T066 r1 (${backend}): the former wait cycle (r1 P2) waits for no timeout any more (T067)`, () => {
    it("X's insert waits for its ack in X's send lane: root's handoff to X and X's send_message(root) both return before that ack; every part is right", async () => {
      const { w, impl, taskId } = await working();
      // impl (X) in a turn of its own.
      w.holding.add(impl);
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      // Every insert into X waits for the test: its ack comes only once X's tool call has returned, as Claude's does.
      const codex = w.codex.get(impl)!;
      const original = codex.dispatchOnce.bind(codex);
      const held: { request: DispatchRequest; end: (result: DispatchResult) => void }[] = [];
      codex.dispatchOnce = (request) => (request.entry.kind === 'insert' ? new Promise<DispatchResult>((end) => held.push({ request, end })) : original(request));
      // 1. Root's message into X's running turn: its ack waits in X's send lane, not in X's queue.
      let note: unknown;
      void w.service.sendMessage({ to: impl, content: 'note for impl' }, { caller: ROOT, operationId: OperationId.parse('op-cycle-note'), sourceCallRef: 'call-cycle-note' }).then((r) => (note = r));
      await settle();
      expect(held).toHaveLength(1);
      // 2. Root hands X more work: in the run's queue, it finds X's turn running in X's queue and waits for that turn's end.
      let handed: unknown;
      void handoff(w, ROOT, { ...toImpl, taskId, content: 'third part' }).then((r) => (handed = r));
      await settle();
      expect(handed).toMatchObject({ status: 'accepted', delivery: 'pending' });
      // 3. X, in that turn, sends to root: the run's queue is free, so it goes and X's tool call returns.
      let spoke: unknown;
      void message(w, impl, 'question from the cycle', 'op-cycle-root').then((r) => (spoke = r));
      await settle();
      expect(spoke).toMatchObject({ status: 'accepted', delivery: 'sent' });
      // Only root's call still waits: for the ack of the note, which X's runtime gives once that tool call returned.
      expect(note).toBeUndefined();
      expect(w.service.beingConfirmed(OperationId.parse('op-cycle-note'))).toBe(true);

      // X's turn takes the note in: its ack, not its timeout.
      const request = held[0]!.request;
      codex.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
      held[0]!.end({ state: 'sent', nativeRef: { sessionRef: request.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' } });
      await settle();
      expect(note).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(w.service.beingConfirmed(OperationId.parse('op-cycle-note'))).toBe(false);

      // X's turn ends: the queued handoff goes once.
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      expect((await w.store.get(OperationId.parse('op-cycle-note')))?.delivery.state).toBe('sent');
      expect((await w.repositories.escalations.list()).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
      expect(held).toHaveLength(1);
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
      const third = (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).find((h) => h.payload.includes('third part'));
      expect(third?.delivery.state).toBe('sent');
      // X's message reached root once, and is sent.
      expect(dispatchedText(w, 'question from the cycle')).toHaveLength(1);
      expect((await w.store.get(OperationId.parse('op-cycle-root')))?.delivery.state).toBe('sent');
      // The run ends as usual.
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect((await instanceOf(w)).state).toBe('completed');
      expect((await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
    });
  });

  describe(`T066 (${backend}): root's report_to_root after the end`, () => {
    it.each([false, true])('refused with a reason (asks the user: %s); no question is opened', async (needsUserConfirmation) => {
      const { w } = await working();
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      const before = (await w.repositories.escalations.list()).length;
      expect(await w.engine.reportToRoot({ content: 'new question after end', needsUserConfirmation }, { caller: ROOT, sourceCallRef: `call-root-late-${String(needsUserConfirmation)}` })).toEqual(RUN_ENDED);
      expect((await w.repositories.escalations.list()).length).toBe(before);
    });

    it('the same call again after the end finds the question it opened before', async () => {
      const { w } = await working();
      const asked = await w.engine.reportToRoot({ content: 'question before end', needsUserConfirmation: true }, { caller: ROOT, sourceCallRef: 'call-root-before' });
      expect(asked.status).toBe('reported');
      expect(asked.status === 'reported' ? asked.escalationId : undefined).toBeDefined();
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      const again = await w.engine.reportToRoot({ content: 'question before end', needsUserConfirmation: true }, { caller: ROOT, sourceCallRef: 'call-root-before' });
      expect(again).toEqual(asked);
    });
  });

  describe(`T066 (${backend}): a handoff queued for a node when the run ends`, () => {
    /** impl's turn runs; root hands it a second task part, which waits for that turn (queued, SP-05). */
    const queued = async () => {
      const { w, impl, taskId } = await working();
      w.holding.add(impl);
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'third part' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      const third = (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).find((h) => h.delivery.state === 'pending')!;
      return { w, impl, third };
    };
    /** impl's turn ends: the queued handoff passes the gate and waits right before its claim. */
    const pastTheGate = async (w: World, impl: SessionId) => {
      const claim = holdBeforeClaim(w);
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      expect(claim.paused()).toBe(1);
      return claim;
    };

    it('the closing step first: the end goes; the handoff is closed, never claimed or sent', async () => {
      const { w, impl, third } = await queued();
      const runtime = watch(w);
      const claim = await pastTheGate(w, impl);
      const step = holdClosingStep(w);
      const after = holdAfterEnd(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: true });
      claim.release();
      await settle();
      after.release();
      await settle();
      expect(runtime.of('third part')).toEqual([]);
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled', detail: 'the run was completed' } });
    });

    it.each(['workflow.complete', 'workflow.cancel'] as const)('claimed before the closing step, %s is refused as being sent (nothing written); once it is sent the run ends', async (type) => {
      const { w, impl, third } = await queued();
      const ack = gate();
      const runtime = watch(w, (request) => (request.text.includes('third part') ? ack.wait() : undefined));
      const claim = await pastTheGate(w, impl);
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w, type).then((r) => (answer = r));
      await settle();
      claim.release();
      await settle();
      expect(runtime.of('third part')).toEqual(['running']);
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true, message: HANDOFF_BEING_SENT });
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'unknown' } });
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      expect((await instanceOf(w)).state).toBe('running');
      ack.open();
      await settle();
      expect(await end(w, type)).toMatchObject({ ok: true });
      await settle();
      const record = await w.store.get(third.operationId);
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
      expect(runtime.of('third part')).toEqual(['running']);
    });

    it('closed with root\'s reports in one step: a report claimed meanwhile refuses the end and the handoff is not closed', async () => {
      const { w, impl, third } = await queued();
      const root = insertsHeld(w);
      const claim = holdBeforeClaim(w);
      void w.engine.reportToRoot({ content: 'report meanwhile', needsUserConfirmation: false }, { caller: impl, sourceCallRef: 'call-report-meanwhile' });
      await settle();
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      claim.release();
      await settle();
      expect(root.seen).toHaveLength(1);
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: false, message: REPORT_BEING_SENT });
      // Nothing of the set was written: the queued handoff is still open and waits for impl's turn.
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      root.ack(0);
      await settle();
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
    });

    it('restart: a run committed as ended with a queued handoff not closed (older code, a crash): closed, nothing sent', async () => {
      const { w, third } = await queued();
      const instance = await instanceOf(w);
      const endedAt = '2026-10-29T02:00:00.000Z' as never;
      const committed = { ...instance, revision: instance.revision + 1, state: 'completed' as const, endedAt, tasks: instance.tasks.map((t) => ({ ...t, status: 'completed' as const, completedAt: endedAt })) };
      expect((await w.repositories.instances.update(committed, instance.revision)).status).toBe('saved');
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      const r = await w.restart();
      await settle();
      expect(dispatchedText(r, 'third part')).toEqual([]);
      expect(await r.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it('closed, but the end\'s commit failed: logged by operation, the run still runs; after a restart nothing is sent and the run ends', async () => {
      const { w, third } = await queued();
      const repo = w.repositories.instances;
      const update = repo.update.bind(repo);
      let failed = false;
      repo.update = (next, expected) => {
        if (!failed && (next.state === 'completed' || next.state === 'cancelled')) {
          failed = true;
          return Promise.reject(new Error('disk I/O error'));
        }
        return update(next, expected);
      };
      expect(await tryEnd(w)).toMatchObject({ ok: false });
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
      expect((await instanceOf(w)).state).toBe('running');
      expect(w.logs.find((l) => l.includes('stay closed'))).toContain(third.operationId);
      const r = await w.restart();
      await settle();
      expect((await instanceOf(r)).state).toBe('running');
      expect(dispatchedText(r, 'third part')).toEqual([]);
      expect(await end(r)).toMatchObject({ ok: true });
      expect(await r.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });
  });
};

const dispatchedText = (w: World, text: string) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)].filter((d) => d.text.includes(text));

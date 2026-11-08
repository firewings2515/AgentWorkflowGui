// T068 cases (T066 report §6 items 1 and 2). 1: a `send_message` between two sessions of a run (a node to a node, root to a
// node) is accepted in the run's queue, so the end's closing step lists it with the run's handoffs and reports, and none is
// accepted once the end is committed; a restart's recovery sends none of an ended run. Messages of no run are untouched.
// 2: a task stopped at a limit (`cancelQueued`), a task given up, held handoffs and a declined round cancel a handoff only
// while it is not claimed (`endUnclaimed`), so one sent meanwhile is never recorded as cancelled. On the memory ports
// (core/workflow/t068.test.ts) and on SQLite (app/main/workflow-t068.test.ts).
import { describe, expect, it } from 'vitest';
import { type Escalation, OperationId, type OperationOutcome, SessionId, type TaskId, type WorkflowTemplate } from '../../../contracts';
import { createTasks, pipelineTemplate, project } from '../../pipeline/testing/t032-cases';
import type { DispatchRequest, DispatchResult } from '../../ports';
import { CWD, handoff, IMPL, INSTANCE, instanceOf, REVIEW, rid, ROOT, sessionOf, settle, started, template, type World } from './harness';

export type Make = (workflow: WorkflowTemplate) => Promise<World>;

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const rework = { ruleId: 'rework', target: { kind: 'node' as const, nodeId: IMPL } };
const RUN_ENDED = { status: 'rejected', rejection: { reason: 'invalid-input', detail: 'this workflow run has ended' } };
const MESSAGE_BEING_SENT = 'A message of this run is being sent; end the run once it has gone';
const LIMIT = 'the task stopped at a handoff limit';
const GIVEN_UP = 'the task was given up';

const end = async (w: World, type: 'workflow.complete' | 'workflow.cancel' = 'workflow.complete') => {
  const instance = await instanceOf(w);
  return w.run({ type, requestId: rid(), instanceId: instance.id, expectedRevision: instance.revision });
};

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
  let holding = true;
  service.prepareTarget = async (record) => {
    await prepare(record);
    if (!holding) return;
    paused++;
    await new Promise<void>((resolve) => (release = resolve));
  };
  /** `release` lets the last one held go; `stop` lets it go and holds no later one. */
  return { paused: () => paused, release: () => release(), stop: () => ((holding = false), release()) };
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
/**
 * Holds the first write of an outcome with this detail, whichever way the store is asked (`recordOutcome` as before T068,
 * `endUnclaimed` since): the cancel has listed the handoff, its write not made yet.
 */
const holdCancelWrite = (w: World, detail: string) => {
  let release: () => void = () => undefined;
  let paused = 0;
  const store = w.store as unknown as Record<'recordOutcome' | 'endUnclaimed', (a: unknown, outcome: OperationOutcome) => Promise<unknown>>;
  for (const method of ['recordOutcome', 'endUnclaimed'] as const) {
    const original = store[method].bind(w.store);
    store[method] = async (a, outcome) => {
      if (outcome.detail === detail && paused++ === 0) await new Promise<void>((resolve) => (release = resolve));
      return original(a, outcome);
    };
  }
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
const dispatchedText = (w: World, text: string) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)].filter((d) => d.text.includes(text));
const handoffWith = async (w: World, text: string) => (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).find((h) => h.payload.includes(text));
const openOf = async (w: World, kind: Escalation['kind']) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === kind);
const op = (id: string) => OperationId.parse(id);

export const t068Cases = (backend: string, make: Make) => {
  /** plan (root, Claude, in a turn of its own) → impl (Codex) → review (Claude): impl and review exist, both idle. */
  const nodes = async (reworkLimit = 5) => {
    const w = await make(template({ reworkLimit }));
    w.holding.add(ROOT);
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    expect(await handoff(w, ROOT, toImpl)).toMatchObject({ status: 'accepted' });
    await settle();
    const impl = await sessionOf(w, IMPL);
    expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'accepted' });
    await settle();
    return { w, impl, review: await sessionOf(w, REVIEW) };
  };
  /** A `send_message` tool call of `from`; `id` names its operation (a resend repeats it). */
  const send = (w: World, from: SessionId, to: SessionId, content: string, id: string) =>
    w.service.sendMessage({ to, content }, { caller: from, operationId: op(id), sourceCallRef: `call-${id}` });
  /** Who sends to whom in the run: a node to a node, root to a node. */
  const pairs = [
    ['a node to a node (review → impl)', (s: { impl: SessionId; review: SessionId }) => ({ from: s.review, to: s.impl })],
    ['root to a node (root → review)', (s: { impl: SessionId; review: SessionId }) => ({ from: ROOT, to: s.review })],
  ] as const;

  describe(`T068 (${backend}): a message between two sessions of a run when the run ends`, () => {
    it.each(pairs)('%s, waiting in the target\'s send lane at the end: closed with the run, never claimed or sent; a resend is told; a restart sends nothing', async (_, who) => {
      const s = await nodes();
      const { w } = s;
      const { from, to } = who(s);
      const runtime = watch(w);
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void send(w, from, to, 'note in the lane', 'op-lane').then((r) => (sent = r));
      await settle();
      expect(claim.paused()).toBe(1);
      const after = holdAfterEnd(w);
      expect(await end(w)).toMatchObject({ ok: true });
      claim.release();
      await settle();
      after.release();
      await settle();
      expect(runtime.of('note in the lane')).toEqual([]);
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'pending' });
      expect(await w.store.get(op('op-lane'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled', detail: 'the run was completed' } });
      // The same call again: not accepted again, not sent.
      expect(await send(w, from, to, 'note in the lane', 'op-lane')).toEqual(RUN_ENDED);
      await settle();
      expect(runtime.of('note in the lane')).toEqual([]);
      const r = await w.restart();
      await settle();
      expect(dispatchedText(r, 'note in the lane')).toEqual([]);
      expect(await r.store.get(op('op-lane'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });

    it.each(pairs)('%s, sent after the end listed what it closes: waits for the run\'s queue and is refused once the end is committed', async (_, who) => {
      const s = await nodes();
      const { w } = s;
      const { from, to } = who(s);
      const runtime = watch(w);
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      expect(step.paused()).toBe(1);
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void send(w, from, to, 'late note', 'op-late').then((r) => (sent = r));
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
      expect(await w.store.get(op('op-late'))).toBeUndefined();
      expect(runtime.of('late note')).toEqual([]);
    });

    it.each(['workflow.complete', 'workflow.cancel'] as const)('claimed before the closing step, %s is refused as being sent (nothing written); once it is sent the run ends', async (type) => {
      const { w, impl, review } = await nodes();
      const ack = gate();
      const runtime = watch(w, (request) => (request.text.includes('note in flight') ? ack.wait() : undefined));
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void send(w, review, impl, 'note in flight', 'op-flight').then((r) => (sent = r));
      await settle();
      expect(claim.paused()).toBe(1);
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w, type).then((r) => (answer = r));
      await settle();
      claim.release();
      await settle();
      expect(runtime.of('note in flight')).toEqual(['running']);
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: false, code: 'invalid_transition', retryable: true, message: MESSAGE_BEING_SENT });
      expect(await w.store.get(op('op-flight'))).toMatchObject({ delivery: { state: 'unknown' } });
      expect((await w.store.get(op('op-flight')))?.outcome).toBeUndefined();
      expect((await instanceOf(w)).state).toBe('running');
      ack.open();
      await settle();
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await end(w, type)).toMatchObject({ ok: true });
      await settle();
      const record = await w.store.get(op('op-flight'));
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
      expect(runtime.of('note in flight')).toEqual(['running']);
    });

    it("closed with the run's handoffs in one step: a message claimed meanwhile refuses the end and the queued handoff is not closed", async () => {
      const { w, impl, review } = await nodes();
      // impl runs a turn; root's next handoff to it waits for that turn (queued, SP-05).
      w.holding.add(impl);
      expect(await handoff(w, ROOT, { ...toImpl, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      expect(await handoff(w, ROOT, { ...toImpl, content: 'third part' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      const third = (await handoffWith(w, 'third part'))!;
      const ack = gate();
      watch(w, (request) => (request.text.includes('note meanwhile') ? ack.wait() : undefined));
      const claim = holdBeforeClaim(w);
      void send(w, ROOT, review, 'note meanwhile', 'op-meanwhile');
      await settle();
      const step = holdClosingStep(w);
      let answer: unknown;
      void end(w).then((r) => (answer = r));
      await settle();
      claim.release();
      await settle();
      step.release();
      await settle();
      expect(answer).toMatchObject({ ok: false, message: MESSAGE_BEING_SENT });
      // Nothing of the set was written: the queued handoff is still open.
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      ack.open();
      await settle();
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
      expect((await w.store.get(op('op-meanwhile')))?.outcome).toBeUndefined();
    });

    it.each(pairs)('%s after the end: a new one is refused with a reason; a resend of one sent before the end is a duplicate, sent once', async (_, who) => {
      const s = await nodes();
      const { w } = s;
      const { from, to } = who(s);
      expect(await send(w, from, to, 'note before', 'op-before')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect(await send(w, from, to, 'note after', 'op-after')).toEqual(RUN_ENDED);
      expect(await w.store.get(op('op-after'))).toBeUndefined();
      expect(await send(w, from, to, 'note before', 'op-before')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
      await settle();
      expect(dispatchedText(w, 'note before')).toHaveLength(1);
      expect(dispatchedText(w, 'note after')).toEqual([]);
    });

    it('restart: a run committed as ended with a message between its nodes not closed (older code, a crash) sends nothing; it is closed first', async () => {
      const { w, impl, review } = await nodes();
      holdBeforeClaim(w);
      void send(w, review, impl, 'note of an old end', 'op-old-end');
      await settle();
      const instance = await instanceOf(w);
      const endedAt = '2026-10-29T02:00:00.000Z' as never;
      const committed = { ...instance, revision: instance.revision + 1, state: 'completed' as const, endedAt, tasks: instance.tasks.map((t) => ({ ...t, status: 'completed' as const, completedAt: endedAt })) };
      expect((await w.repositories.instances.update(committed, instance.revision)).status).toBe('saved');
      expect(await w.store.get(op('op-old-end'))).toMatchObject({ delivery: { state: 'pending' } });
      expect((await w.store.get(op('op-old-end')))?.outcome).toBeUndefined();
      const r = await w.restart();
      await settle();
      expect(dispatchedText(r, 'note of an old end')).toEqual([]);
      expect(await r.store.get(op('op-old-end'))).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: { kind: 'cancelled' } });
    });
  });

  describe(`T068 (${backend}): messages of no run are not touched by its end`, () => {
    const PLAIN = SessionId.parse('plain-claude');
    const withPlain = async () => {
      const s = await nodes();
      expect(await s.w.run({ type: 'session.create', requestId: rid(), sessionId: PLAIN, kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      return s;
    };

    it('no instanceId (an ordinary session to a node of the run): one waiting in the lane at the end is not closed and goes; after the end a new one goes', async () => {
      const { w, review } = await withPlain();
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void send(w, PLAIN, review, 'plain note', 'op-plain').then((r) => (sent = r));
      await settle();
      expect(claim.paused()).toBe(1);
      expect((await w.store.get(op('op-plain'))) as unknown).toMatchObject({ delivery: { state: 'pending' } });
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      claim.stop();
      await settle();
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect((await w.store.get(op('op-plain')))?.outcome).toBeUndefined();
      // And from the node of the ended run to the ordinary session (no instanceId either way).
      expect(await send(w, review, PLAIN, 'node to plain', 'op-node-plain')).toMatchObject({ status: 'accepted' });
      expect(await send(w, PLAIN, review, 'plain after', 'op-plain-after')).toMatchObject({ status: 'accepted' });
      await settle();
      expect(dispatchedText(w, 'plain note')).toHaveLength(1);
      expect(dispatchedText(w, 'node to plain')).toHaveLength(1);
      expect(dispatchedText(w, 'plain after')).toHaveLength(1);
    });

    it('needing the user\'s confirmation (cross-tool, outside the run\'s consent): asked before the end, approved after it, it goes', async () => {
      const { w, impl } = await withPlain();
      const asked = await send(w, PLAIN, impl, 'plain to codex', 'op-confirm');
      expect(asked).toMatchObject({ status: 'awaiting-confirmation' });
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      const escalationId = (asked as { escalationId: Escalation['id'] }).escalationId;
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision: 'approve' })).toMatchObject({ ok: true });
      await settle();
      expect(dispatchedText(w, 'plain to codex')).toHaveLength(1);
      const record = await w.store.get(op('op-confirm'));
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
    });

    it('another group (a session of another run to a node of this one): one waiting in the lane at the end is not closed and goes; after the end a new one goes', async () => {
      const { w, review } = await nodes();
      const ROOT2 = SessionId.parse('root-2');
      expect(await started(w, { instanceId: 'run-2' as never, rootSessionId: ROOT2, firstMessage: 'Plan another page.' })).toMatchObject({ ok: true });
      await settle();
      const claim = holdBeforeClaim(w);
      let sent: unknown;
      void send(w, ROOT2, review, 'other group note', 'op-group').then((r) => (sent = r));
      await settle();
      expect(claim.paused()).toBe(1);
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      claim.stop();
      await settle();
      expect(sent).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect((await w.store.get(op('op-group')))?.outcome).toBeUndefined();
      // A message of no run: it carries no run, so no end lists it.
      const group = await w.store.get(op('op-group'));
      expect(group?.kind).toBe('peer-message');
      expect(group?.kind === 'peer-message' ? group.peer?.instanceId : 'none').toBeUndefined();
      expect(await send(w, ROOT2, review, 'other group after', 'op-group-after')).toMatchObject({ status: 'accepted' });
      await settle();
      expect(dispatchedText(w, 'other group note')).toHaveLength(1);
      expect(dispatchedText(w, 'other group after')).toHaveLength(1);
    });
  });

  describe(`T068 (${backend}): no wait cycle through the run's queue`, () => {
    it("Y's insert waits for its ack in Y's send lane: root's handoff to Y queues at once and Y's send_message to another node returns before that ack", async () => {
      const { w, impl, review } = await nodes();
      // impl (Y) in a turn of its own.
      w.holding.add(impl);
      expect(await handoff(w, ROOT, { ...toImpl, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      // Every insert into Y waits for the test: its ack comes only once Y's tool call has returned, as Claude's does.
      const codex = w.codex.get(impl)!;
      const original = codex.dispatchOnce.bind(codex);
      const held: { request: DispatchRequest; end: (result: DispatchResult) => void }[] = [];
      codex.dispatchOnce = (request) => (request.entry.kind === 'insert' ? new Promise<DispatchResult>((done) => held.push({ request, end: done })) : original(request));
      // 1. Root's message into Y's running turn (through the run's queue since T068): its ack waits in Y's send lane.
      let note: unknown;
      void send(w, ROOT, impl, 'note for impl', 'op-cycle-note').then((r) => (note = r));
      await settle();
      expect(held).toHaveLength(1);
      // 2. Root hands Y more work: in the run's queue it finds Y's turn running and waits for that turn's end.
      let handed: unknown;
      void handoff(w, ROOT, { ...toImpl, content: 'third part' }).then((r) => (handed = r));
      await settle();
      expect(handed).toMatchObject({ status: 'accepted', delivery: 'pending' });
      // 3. Y, in that turn, sends to review: through the run's queue and review's queue, and returns, before the ack.
      let spoke: unknown;
      void send(w, impl, review, 'note for review', 'op-cycle-review').then((r) => (spoke = r));
      await settle();
      expect(spoke).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(note).toBeUndefined();

      // Y's turn takes the note in: its ack, not a timeout.
      const request = held[0]!.request;
      codex.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
      held[0]!.end({ state: 'sent', nativeRef: { sessionRef: request.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' } });
      await settle();
      expect(note).toMatchObject({ status: 'accepted', delivery: 'sent' });
      // Y's turn ends: the queued handoff goes once; the run ends as usual.
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
      expect(dispatchedText(w, 'note for review')).toHaveLength(1);
      expect(await end(w)).toMatchObject({ ok: true });
      expect((await openOf(w, 'delivery-unknown'))).toEqual([]);
    });
  });

  describe(`T068 (${backend}): a task stopped at a limit cancels only what is not claimed`, () => {
    /** impl is busy; review sends the task back (queued); impl's turn ends and that handoff waits right before its claim. */
    const pastTheGate = async () => {
      const { w, impl, review } = await nodes(1);
      w.holding.add(impl);
      w.emitTurn(impl, 'busy-1', 'running');
      await settle();
      expect(await handoff(w, review, { ...rework, content: 'queued rework' }, { operationId: 'op-queued' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      const claim = holdBeforeClaim(w);
      w.emitTurn(impl, 'busy-1', 'completed');
      await settle();
      expect(claim.paused()).toBe(1);
      return { w, impl, claim };
    };

    it('sent between the listing and the cancel\'s write: it stays sent, never recorded as cancelled, and is not counted', async () => {
      const { w, claim } = await pastTheGate();
      const write = holdCancelWrite(w, LIMIT);
      // Root sends the task back once more: a second loop, over the limit (as T024 r2-P1-1).
      let limited: unknown;
      void handoff(w, ROOT, toImpl).then((r) => (limited = r));
      await settle();
      expect(write.paused()).toBe(1);
      claim.release();
      await settle();
      expect((await w.store.get(op('op-queued')))?.delivery.state).toBe('sent');
      write.release();
      await settle();
      expect(limited).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      const record = await w.store.get(op('op-queued'));
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
      expect(dispatchedText(w, 'queued rework')).toHaveLength(1);
      const [limit] = await openOf(w, 'limit-exceeded');
      expect(limit?.detail).not.toContain('were cancelled');
    });

    it('claimed and on its way at the cancel\'s write: left to its delivery (unknown, no outcome), then sent', async () => {
      const { w, claim } = await pastTheGate();
      const ack = gate();
      watch(w, (request) => (request.text.includes('queued rework') ? ack.wait() : undefined));
      const write = holdCancelWrite(w, LIMIT);
      let limited: unknown;
      void handoff(w, ROOT, toImpl).then((r) => (limited = r));
      await settle();
      claim.release();
      await settle();
      expect((await w.store.get(op('op-queued')))?.delivery.state).toBe('unknown');
      write.release();
      await settle();
      expect(limited).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      expect((await w.store.get(op('op-queued')))?.outcome).toBeUndefined();
      expect(w.logs.some((l) => l.includes('is on its way; it is not cancelled'))).toBe(true);
      ack.open();
      await settle();
      const record = await w.store.get(op('op-queued'));
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
    });
  });

  describe(`T068 (${backend}): a task given up cancels only what is not claimed`, () => {
    /** A run with impl working on task a in a turn of its own; root's third part of the task waits for that turn. */
    const queued = async () => {
      const w = await make(pipelineTemplate());
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const created = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t068-tasks');
      if (created.status !== 'created') throw new Error(created.status);
      const taskId = created.tasks[0]!.taskId;
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'build a' })).toMatchObject({ status: 'accepted' });
      await settle();
      const impl = await sessionOf(w, IMPL);
      w.holding.add(impl);
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'third part' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      return { w, impl, taskId, third: (await handoffWith(w, 'third part'))! };
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
    /** The pipeline gives the task up (as the user declining its setup or merge question does, in the run's queue). */
    const giveUp = (w: World, taskId: TaskId) => {
      const engine = w.engine as unknown as { pipeline: { giveUp(instanceId: unknown, taskId: TaskId): Promise<void> }; inRunQueue<T>(id: unknown, fn: () => Promise<T>): Promise<T> };
      return engine.inRunQueue(INSTANCE, () => engine.pipeline.giveUp(INSTANCE, taskId));
    };

    it('sent between the listing and the cancel\'s write: it stays sent, never recorded as cancelled', async () => {
      const { w, impl, taskId, third } = await queued();
      const claim = await pastTheGate(w, impl);
      const write = holdCancelWrite(w, GIVEN_UP);
      let given = false;
      void giveUp(w, taskId).then(() => (given = true));
      await settle();
      expect(write.paused()).toBe(1);
      claim.release();
      await settle();
      expect((await w.store.get(third.operationId))?.delivery.state).toBe('sent');
      write.release();
      await settle();
      expect(given).toBe(true);
      expect((await instanceOf(w)).tasks.find((t) => t.id === taskId)?.status).toBe('failed');
      const record = await w.store.get(third.operationId);
      expect(record?.delivery.state).toBe('sent');
      expect(record?.outcome).toBeUndefined();
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
    });

    it('claimed at the write and left unknown; the user retries it: it waits, never sent, and the end of the run closes it (the known residue)', async () => {
      const { w, impl, taskId, third } = await queued();
      const claim = await pastTheGate(w, impl);
      // Its dispatch comes back unknown (written, no ack): on its way when the cancel is written.
      w.codex.get(impl)!.dispatchModes.push('lost');
      const write = holdCancelWrite(w, GIVEN_UP);
      let given = false;
      void giveUp(w, taskId).then(() => (given = true));
      await settle();
      claim.release();
      await settle();
      expect((await w.store.get(third.operationId))?.delivery.state).toBe('unknown');
      write.release();
      await settle();
      expect(given).toBe(true);
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      expect(w.logs.some((l) => l.includes('is on its way; it is not cancelled'))).toBe(true);
      // The user retries it: pending again, but the gate lets nothing of a task given up go.
      const [unknown] = (await openOf(w, 'delivery-unknown')).filter((e) => e.ref?.kind === 'handoff');
      expect(unknown).toBeDefined();
      const dispatched = dispatchedText(w, 'third part').length;
      expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
      await settle();
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' } });
      expect((await w.store.get(third.operationId))?.outcome).toBeUndefined();
      expect(dispatchedText(w, 'third part')).toHaveLength(dispatched);
      // The end of the run closes it; nothing is sent, after a restart either.
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      expect(await w.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled', detail: 'the run was completed' } });
      const r = await w.restart();
      await settle();
      expect(dispatchedText(r, 'third part')).toHaveLength(0);
      expect(await r.store.get(third.operationId)).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
    });
  });
};


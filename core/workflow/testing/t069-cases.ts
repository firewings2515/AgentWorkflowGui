// T069 cases. L2: a `send_message` or `report_to_root` tool call waits for its dispatch's ack only until its deadline
// (`inRunWaitMs`), then is answered as it stands (`pending` in the lane, `unknown` on its way) while the dispatch goes on;
// a resend is a duplicate, never a second dispatch, and a delivery still being confirmed holds the end of its run (D-12).
// L6: every tool call that waits for its run's queue (`send_message` to root, `report_to_root`, `handoff`, `create_tasks`)
// waits for it only until the same deadline, then is told the run is busy with nothing of it recorded (as T068 r2 did for
// a node's message). On the memory ports (core/workflow/t069.test.ts) and on SQLite (app/main/workflow-t069.test.ts).
import { describe, expect, it } from 'vitest';
import { OperationId, SessionId, type WorkflowTemplate } from '../../../contracts';
import { createTasks, pipelineTemplate, project } from '../../pipeline/testing/t032-cases';
import type { DispatchRequest, DispatchResult } from '../../ports';
import type { FakeAdapter } from '../../sessions/testing/fake-adapter';
import { IN_RUN_WAIT_MS } from '../../sessions/service';
import { peerIdOf } from '../ids';
import { CWD, handoff, IMPL, INSTANCE, instanceOf, REVIEW, rid, ROOT, sessionOf, settle, started, template, type World } from './harness';

export type Make = (workflow: WorkflowTemplate) => Promise<World>;

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const BUSY = { status: 'rejected', rejection: { reason: 'busy', detail: 'this workflow run is busy; nothing was recorded; call again in a moment' } };
const MESSAGE_BUSY = { status: 'rejected', rejection: { reason: 'busy', detail: 'this workflow run is busy; send the message again in a moment' } };
const PLAIN = SessionId.parse('plain-claude');
const op = (id: string) => OperationId.parse(id);

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

/**
 * The service's `sleep`: a tool call's deadline (`IN_RUN_WAIT_MS`) passes only when the test says so; nothing else ever
 * ends. Each call asks for one, in order; `pass(i)` lets the i-th pass, `passAll` every one asked so far.
 */
const timeControl = (w: World) => {
  const options = (w.service as unknown as { options: { sleep?: (ms: number) => Promise<void> } }).options;
  const limits: (() => void)[] = [];
  options.sleep = (ms) => (ms === IN_RUN_WAIT_MS ? new Promise<void>((resolve) => limits.push(resolve)) : new Promise<void>(() => undefined));
  return { asked: () => limits.length, pass: (i: number) => limits[i]?.(), passAll: () => limits.forEach((pass) => pass()) };
};

/**
 * Every insert (a payload joining a running turn) into these adapters waits for the test: `ack` ends it sent (as the
 * runtime's ack once the target's own tool call returned), `timeout` ends it unknown (no ack within the dispatch's
 * timeout, T065). Anything else goes at once.
 */
const holdInserts = (...adapters: FakeAdapter[]) => {
  const held: { text: string; request: DispatchRequest; adapter: FakeAdapter; end: (result: DispatchResult) => void }[] = [];
  for (const adapter of adapters) {
    const original = adapter.dispatchOnce.bind(adapter);
    adapter.dispatchOnce = (request) =>
      request.entry.kind === 'insert'
        ? new Promise<DispatchResult>((done) => {
            // The runtime has it now; its ack is what waits.
            adapter.dispatched.push(request);
            held.push({ text: request.text, request, adapter, end: done });
          })
        : original(request);
  }
  const take = (text: string) => {
    const i = held.findIndex((h) => h.text.includes(text));
    if (i < 0) throw new Error(`no insert held with "${text}"`);
    return held.splice(i, 1)[0]!;
  };
  return {
    held: () => held.map((h) => h.text),
    ack: (text: string) => {
      const { request, adapter, end: done } = take(text);
      adapter.history.set(request.attempt.clientMessageId, { ref: request.nativeSessionRef, text: request.text });
      done({ state: 'sent', nativeRef: { sessionRef: request.nativeSessionRef }, evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' } });
    },
    timeout: (text: string) => take(text).end({ state: 'unknown', reason: 'timeout', written: true, detail: 'no ack within the timeout' }),
  };
};

const dispatchedText = (w: World, text: string) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)].filter((d) => d.text.includes(text));
const openOf = async (w: World, kind: string) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === kind);
const peersWith = async (w: World, text: string) => (await w.repositories.peerMessages.list()).filter((m) => m.text.includes(text));
const handoffsWith = async (w: World, text: string) => (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.payload.includes(text));
/** What the store, the repositories and the runtimes hold, to show a given-up call wrote nothing. */
const snapshot = async (w: World) => ({
  handoffs: (await w.repositories.handoffs.listByInstance(INSTANCE)).length,
  peers: (await w.repositories.peerMessages.list()).length,
  escalations: (await w.repositories.escalations.list({})).length,
  pending: (await w.store.listByState('pending')).length,
  unknown: (await w.store.listByState('unknown')).length,
  sent: (await w.store.listByState('sent')).length,
  plans: (await instanceOf(w)).taskPlans.length,
  tasks: (await instanceOf(w)).tasks.length,
  dispatched: [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)].length,
});

export const t069Cases = (backend: string, make: Make) => {
  /** plan (root, Claude, in a turn of its own) → impl (Codex) → review (Claude): impl and review exist, both idle. */
  const nodes = async () => {
    const w = await make(template());
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
  /** As `nodes`, with impl and review each running a turn of its own (root runs one from the start): payloads join them. */
  const running = async () => {
    const s = await nodes();
    const { w, impl } = s;
    w.holding.add(impl);
    w.holding.add(s.review);
    expect(await handoff(w, ROOT, { ...toImpl, content: 'keep impl busy' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
    await settle();
    expect(await handoff(w, impl, { ...toReview, content: 'keep review busy' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
    await settle();
    return s;
  };
  /** A `send_message` tool call of `from`; `id` names its operation (a resend repeats it). */
  const send = (w: World, from: SessionId, to: SessionId, content: string, id: string) =>
    w.service.sendMessage({ to, content }, { caller: from, operationId: op(id), sourceCallRef: `call-${id}-${String(Math.random())}` });
  const report = (w: World, from: SessionId, content: string, call: string, needsUserConfirmation = false) => w.engine.reportToRoot({ content, needsUserConfirmation }, { caller: from, sourceCallRef: call });
  /** Calls `fn` and keeps what it answers, so the test sees whether it has returned yet. */
  const call = <T>(fn: () => Promise<T>) => {
    const box: { result?: T; error?: unknown } = {};
    void fn().then(
      (r) => (box.result = r),
      (e: unknown) => (box.error = e),
    );
    return box;
  };

  describe(`T069 (${backend}) L2: a call waits for its dispatch's ack only until its deadline`, () => {
    it('two nodes send to each other while both run (each ack waits for the other\'s call): both answer at the deadline, then each goes once and the run ends', async () => {
      const { w, impl, review } = await running();
      const time = timeControl(w);
      const inserts = holdInserts(w.codex.get(impl)!, w.claude);
      const toReviewCall = call(() => send(w, impl, review, 'impl to review', 'op-ir'));
      const toImplCall = call(() => send(w, review, impl, 'review to impl', 'op-ri'));
      await settle();
      expect(inserts.held()).toHaveLength(2);
      expect(toReviewCall.result).toBeUndefined();
      expect(toImplCall.result).toBeUndefined();
      time.passAll();
      await settle();
      // Both answered while neither ack has come: handed over, being confirmed.
      expect(toReviewCall.result).toEqual({ status: 'accepted', peerMessageId: peerIdOf(op('op-ir')), operationId: op('op-ir'), delivery: 'unknown' });
      expect(toImplCall.result).toEqual({ status: 'accepted', peerMessageId: peerIdOf(op('op-ri')), operationId: op('op-ri'), delivery: 'unknown' });
      expect(inserts.held()).toHaveLength(2);
      // Their calls returned, so each runtime takes the other's message in.
      inserts.ack('impl to review');
      inserts.ack('review to impl');
      await settle();
      for (const id of ['op-ir', 'op-ri']) expect((await w.store.get(op(id)))?.delivery).toMatchObject({ state: 'sent', attempts: [{ state: 'sent' }] });
      expect(dispatchedText(w, 'impl to review')).toHaveLength(1);
      expect(dispatchedText(w, 'review to impl')).toHaveLength(1);
      // What the dispatch ended with is announced after the call answered.
      const last = w.events.filter((e) => e.type === 'peerMessage.updated' && e.message.operationId === op('op-ir')).at(-1);
      expect(last).toMatchObject({ message: { delivery: { state: 'sent' } } });
      expect(await end(w)).toMatchObject({ ok: true });
      expect(await openOf(w, 'delivery-unknown')).toEqual([]);
    });

    it('two ordinary sessions send to each other while both run: both answer at the deadline, then each goes once', async () => {
      // No workflow run at all: two ordinary Claude sessions, each running a turn of its own.
      const w = await make(template());
      const PLAIN_2 = SessionId.parse('plain-claude-2');
      for (const sessionId of [PLAIN, PLAIN_2]) {
        expect(await w.run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD })).toMatchObject({ ok: true });
        await settle();
        expect(await w.repositories.sessions.get(sessionId)).toMatchObject({ kind: 'ordinary' });
        w.holding.add(sessionId);
      }
      // Each is idle: a message to it starts a turn there, which stays running.
      expect(await send(w, PLAIN_2, PLAIN, 'wake one', 'op-wake-1')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      expect(await send(w, PLAIN, PLAIN_2, 'wake two', 'op-wake-2')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      await settle();
      const time = timeControl(w);
      const inserts = holdInserts(w.claude);
      const oneToTwo = call(() => send(w, PLAIN, PLAIN_2, 'one to two', 'op-12'));
      const twoToOne = call(() => send(w, PLAIN_2, PLAIN, 'two to one', 'op-21'));
      await settle();
      // Both join the other's running turn, so each ack waits for the other's call.
      expect(inserts.held()).toHaveLength(2);
      expect(oneToTwo.result).toBeUndefined();
      expect(twoToOne.result).toBeUndefined();
      time.passAll();
      await settle();
      expect(oneToTwo.result).toEqual({ status: 'accepted', peerMessageId: peerIdOf(op('op-12')), operationId: op('op-12'), delivery: 'unknown' });
      expect(twoToOne.result).toEqual({ status: 'accepted', peerMessageId: peerIdOf(op('op-21')), operationId: op('op-21'), delivery: 'unknown' });
      expect(inserts.held()).toHaveLength(2);
      inserts.ack('one to two');
      inserts.ack('two to one');
      await settle();
      for (const id of ['op-12', 'op-21']) {
        const record = await w.store.get(op(id));
        expect(record?.delivery).toMatchObject({ state: 'sent', attempts: [{ state: 'sent' }] });
        // Messages of no run.
        expect(record?.kind === 'peer-message' ? record.peer?.instanceId : 'not a message').toBeUndefined();
      }
      expect(dispatchedText(w, 'one to two')).toHaveLength(1);
      expect(dispatchedText(w, 'two to one')).toHaveLength(1);
      expect(await openOf(w, 'delivery-unknown')).toEqual([]);
    });

    it("root's send_message to a node against that node's report_to_root: both answer at the deadline, then each goes once and the run ends", async () => {
      const { w, impl } = await running();
      const time = timeControl(w);
      const inserts = holdInserts(w.codex.get(impl)!, w.claude);
      const rootCall = call(() => send(w, ROOT, impl, 'root to impl', 'op-root-impl'));
      const reportCall = call(() => report(w, impl, 'impl reports', 'call-impl-report'));
      await settle();
      expect(inserts.held()).toHaveLength(2);
      expect(rootCall.result).toBeUndefined();
      expect(reportCall.result).toBeUndefined();
      time.passAll();
      await settle();
      expect(rootCall.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
      expect(reportCall.result).toEqual({ status: 'reported' });
      inserts.ack('root to impl');
      inserts.ack('impl reports');
      await settle();
      expect((await w.store.get(op('op-root-impl')))?.delivery.state).toBe('sent');
      const [reported] = await peersWith(w, 'impl reports');
      expect(reported?.delivery.state).toBe('sent');
      expect(dispatchedText(w, 'root to impl')).toHaveLength(1);
      expect(dispatchedText(w, 'impl reports')).toHaveLength(1);
      expect(await end(w)).toMatchObject({ ok: true });
      expect(await openOf(w, 'delivery-unknown')).toEqual([]);
    });

    it('a target that takes it at once: the answer is as before (sent), the deadline never needed', async () => {
      const { w, impl, review } = await nodes();
      expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: PLAIN, kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      const time = timeControl(w);
      expect(await send(w, review, impl, 'node to node', 'op-now-1')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await send(w, impl, ROOT, 'node to root', 'op-now-2')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await send(w, PLAIN, review, 'ordinary to node', 'op-now-3')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await report(w, review, 'a quick report', 'call-now-4')).toEqual({ status: 'reported' });
      // Each asked for its deadline, and none waited for it (the test never let it pass).
      expect(time.asked()).toBe(4);
      await settle();
      expect((await peersWith(w, 'a quick report'))[0]?.delivery.state).toBe('sent');
    });

    describe('a resend of one answered while being confirmed', () => {
      it('on its way (unknown): duplicate at once, never dispatched again', async () => {
        const { w, impl, review } = await running();
        const time = timeControl(w);
        const inserts = holdInserts(w.codex.get(impl)!);
        const first = call(() => send(w, review, impl, 'note', 'op-re-1'));
        await settle();
        time.passAll();
        await settle();
        expect(first.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
        expect(await send(w, review, impl, 'note', 'op-re-1')).toMatchObject({ status: 'duplicate', delivery: 'unknown' });
        inserts.ack('note');
        await settle();
        expect(await send(w, review, impl, 'note', 'op-re-1')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
        expect(dispatchedText(w, 'note')).toHaveLength(1);
        expect((await w.store.get(op('op-re-1')))?.delivery.attempts).toHaveLength(1);
      });

      it('still pending in the lane behind another: duplicate, its lane not entered again, dispatched once', async () => {
        const { w, impl, review } = await running();
        const time = timeControl(w);
        const inserts = holdInserts(w.codex.get(impl)!);
        const ahead = call(() => send(w, review, impl, 'ahead', 'op-ahead'));
        const behind = call(() => send(w, ROOT, impl, 'behind', 'op-behind'));
        await settle();
        expect(inserts.held()).toEqual([expect.stringContaining('ahead')]);
        time.passAll();
        await settle();
        expect(ahead.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
        expect(behind.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
        // The resend waits for the dispatch the first call entered (its own deadline), never a second one.
        const resend = call(() => send(w, ROOT, impl, 'behind', 'op-behind'));
        await settle();
        expect(resend.result).toBeUndefined();
        time.passAll();
        await settle();
        expect(resend.result).toMatchObject({ status: 'duplicate', delivery: 'pending' });
        inserts.ack('ahead');
        await settle();
        inserts.ack('behind');
        await settle();
        expect(inserts.held()).toEqual([]);
        expect(dispatchedText(w, 'behind')).toHaveLength(1);
        expect((await w.store.get(op('op-behind')))?.delivery).toMatchObject({ state: 'sent', attempts: [{ state: 'sent' }] });
        expect(await send(w, ROOT, impl, 'behind', 'op-behind')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
      });

      it('a resend waits for its own dispatch only, never for messages entered after it', async () => {
        const { w, impl, review } = await running();
        const time = timeControl(w);
        const inserts = holdInserts(w.codex.get(impl)!);
        const ahead = call(() => send(w, review, impl, 'ahead', 'op-ahead'));
        const behind = call(() => send(w, ROOT, impl, 'behind', 'op-behind'));
        const later = call(() => send(w, review, impl, 'later one', 'op-later'));
        await settle();
        time.passAll();
        await settle();
        expect(behind.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
        expect(later.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
        expect(ahead.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
        // Its deadline never passes here: it answers once the dispatch the first call entered is over.
        const resend = call(() => send(w, ROOT, impl, 'behind', 'op-behind'));
        await settle();
        inserts.ack('ahead');
        await settle();
        inserts.ack('behind');
        await settle();
        // The later message is still held: a second entry of the resend behind it would not have answered yet.
        expect(inserts.held()).toEqual([expect.stringContaining('later one')]);
        expect(resend.result).toMatchObject({ status: 'duplicate', delivery: 'sent' });
        inserts.ack('later one');
        await settle();
        expect(dispatchedText(w, 'behind')).toHaveLength(1);
      });

      it('its dispatch threw after the call answered: logged without its content, nothing left unhandled, and a resend is not stuck on it', async () => {
        const { w, impl, review } = await running();
        const time = timeControl(w);
        const service = w.service as unknown as { dispatchPending: (id: OperationId, options: unknown) => Promise<unknown> };
        const original = service.dispatchPending.bind(w.service);
        const failing = gate();
        let failed = 0;
        service.dispatchPending = async (id, options) => {
          if (id === op('op-throw') && failed++ === 0) {
            await failing.wait();
            throw new Error('the store failed');
          }
          return original(id, options);
        };
        const first = call(() => send(w, review, impl, 'secret words', 'op-throw'));
        await settle();
        time.passAll();
        await settle();
        expect(first.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
        failing.open();
        await settle();
        const logged = w.logs.filter((l) => l.includes('op-throw'));
        expect(logged).toHaveLength(1);
        expect(logged[0]).not.toContain('secret words');
        // The failed dispatch is over: a resend enters a new one (the target takes it at once) and is answered.
        expect(await send(w, review, impl, 'secret words', 'op-throw')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
        expect(dispatchedText(w, 'secret words')).toHaveLength(1);
      });

      it('its dispatch threw before the deadline: the call is told (an error), and a resend is not stuck on it', async () => {
        const { w, impl, review } = await nodes();
        timeControl(w);
        const service = w.service as unknown as { dispatchPending: (id: OperationId, options: unknown) => Promise<unknown> };
        const original = service.dispatchPending.bind(w.service);
        let failed = 0;
        service.dispatchPending = (id, options) => (id === op('op-throw-2') && failed++ === 0 ? Promise.reject(new Error('the store failed')) : original(id, options));
        await expect(send(w, review, impl, 'words', 'op-throw-2')).rejects.toThrow('the store failed');
        expect(await send(w, review, impl, 'words', 'op-throw-2')).toMatchObject({ status: 'duplicate', delivery: 'sent' });
        expect(dispatchedText(w, 'words')).toHaveLength(1);
      });
    });

    it.each(['workflow.complete', 'workflow.cancel'] as const)('%s while one is being confirmed: refused as retryable with nothing written; once its result is in, the run ends', async (type) => {
      const { w, impl, review } = await running();
      const time = timeControl(w);
      const inserts = holdInserts(w.codex.get(impl)!);
      const sent = call(() => send(w, review, impl, 'in flight', 'op-flight'));
      await settle();
      time.passAll();
      await settle();
      expect(sent.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
      const before = await instanceOf(w);
      expect(await end(w, type)).toMatchObject({ ok: false, retryable: true, message: 'A delivery of this run is still being confirmed; try again in a moment' });
      expect(await instanceOf(w)).toEqual(before);
      expect((await w.store.get(op('op-flight')))?.outcome).toBeUndefined();
      inserts.ack('in flight');
      await settle();
      expect(await end(w, type)).toMatchObject({ ok: true });
      expect((await w.store.get(op('op-flight')))?.delivery.state).toBe('sent');
    });

    it('its dispatch then times out (no ack within the dispatch timeout): unknown, reconciled late as before, never dispatched again, and it holds the end', async () => {
      const { w, impl, review } = await running();
      const time = timeControl(w);
      const inserts = holdInserts(w.codex.get(impl)!);
      const sent = call(() => send(w, review, impl, 'slow note', 'op-slow'));
      await settle();
      time.passAll();
      await settle();
      expect(sent.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
      inserts.timeout('slow note');
      await settle();
      expect((await w.store.get(op('op-slow')))?.delivery.state).toBe('unknown');
      expect(await end(w)).toMatchObject({ ok: false, retryable: true });
      expect(await send(w, review, impl, 'slow note', 'op-slow')).toMatchObject({ status: 'duplicate', delivery: 'unknown' });
      expect(dispatchedText(w, 'slow note')).toHaveLength(1);
      expect((await w.store.get(op('op-slow')))?.delivery.attempts).toHaveLength(1);
    });

    it('known behaviour: one answered pending (in the lane behind a message of no run) is closed with the run when it ends, and never sent', async () => {
      const { w, review } = await running();
      expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: PLAIN, kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      const time = timeControl(w);
      const inserts = holdInserts(w.claude);
      const ahead = call(() => send(w, PLAIN, review, 'plain ahead', 'op-plain-ahead'));
      const ofRun = call(() => send(w, ROOT, review, 'root behind', 'op-root-behind'));
      await settle();
      expect(inserts.held()).toEqual([expect.stringContaining('plain ahead')]);
      time.passAll();
      await settle();
      expect(ofRun.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
      expect(ahead.result).toMatchObject({ status: 'accepted', delivery: 'unknown' });
      // The run's message is not claimed: the end closes it (T068), the one of no run on its way does not hold it.
      expect(await end(w)).toMatchObject({ ok: true });
      inserts.ack('plain ahead');
      await settle();
      expect(await w.store.get(op('op-root-behind'))).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled', detail: 'the run was completed' } });
      expect(dispatchedText(w, 'root behind')).toEqual([]);
      expect(inserts.held()).toEqual([]);
      expect((await w.store.get(op('op-plain-ahead')))?.delivery.state).toBe('sent');
    });
  });

  describe(`T069 (${backend}) L6: a tool call waits for its run's queue only until its deadline`, () => {
    /**
     * The cycle of T068 r1 (L6), for Y = impl: Y runs a turn and an insert into it waits for its ack (which waits for Y's
     * tool calls); a cleanup's exclusive() holds Y's queue and waits for Y's lane; root's handoff to Y holds the run's queue
     * and waits for Y's queue. Y's next tool call waits for the run's queue.
     */
    const cycle = async () => {
      const { w, impl, review } = await running();
      const time = timeControl(w);
      const inserts = holdInserts(w.codex.get(impl)!);
      const first = call(() => send(w, review, impl, 'first note', 'op-first'));
      await settle();
      expect(inserts.held()).toHaveLength(1);
      let cleaned = false;
      void w.service.exclusive([impl], () => {
        cleaned = true;
        return Promise.resolve();
      });
      await settle();
      const handed = call(() => handoff(w, ROOT, { ...toImpl, content: 'third part' }));
      await settle();
      expect(handed.result).toBeUndefined();
      return { w, impl, review, time, inserts, first, handed, cleaned: () => cleaned };
    };
    const tools: readonly (readonly [string, (w: World, impl: SessionId) => Promise<unknown>, unknown])[] = [
      ['report_to_root', (w: World, impl: SessionId) => report(w, impl, 'Y reports', 'call-y-report'), BUSY],
      ['send_message to root', (w: World, impl: SessionId) => send(w, impl, ROOT, 'Y to root', 'op-y-root'), MESSAGE_BUSY],
      ['handoff', (w: World, impl: SessionId) => handoff(w, impl, { ...toReview, content: 'Y hands on' }, { operationId: 'op-y-handoff' }), BUSY],
    ] as const;

    it.each(tools)("Y's %s is told the run is busy at its deadline, before the ack; once the ack comes all goes on and the given-up step writes nothing", async (_, tool, busy) => {
      const { w, impl, time, inserts, first, handed, cleaned } = await cycle();
      const k = time.asked();
      const y = call(() => tool(w, impl));
      await settle();
      expect(y.result).toBeUndefined();
      const before = await snapshot(w);
      time.pass(k);
      await settle();
      expect(y.result).toEqual(busy);
      expect(first.result).toBeUndefined();
      expect(inserts.held()).toHaveLength(1);
      // Y's call returned, so its runtime takes the insert in: the cleanup, root's handoff and the first note go on.
      inserts.ack('first note');
      await settle();
      expect(first.result).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(cleaned()).toBe(true);
      expect(handed.result).toMatchObject({ status: 'accepted', delivery: 'pending' });
      // The run's queue is free again: the given-up step has had its turn and wrote nothing (root's handoff is the one more).
      await settle();
      const after = await snapshot(w);
      const pick = (s: typeof before) => ({ handoffs: s.handoffs, peers: s.peers, escalations: s.escalations, plans: s.plans, tasks: s.tasks });
      expect(pick(after)).toEqual(pick(before));
      expect(await peersWith(w, 'Y reports')).toEqual([]);
      expect(await w.store.get(op('op-y-root'))).toBeUndefined();
      expect(await handoffsWith(w, 'Y hands on')).toEqual([]);
      expect(dispatchedText(w, 'Y ')).toEqual([]);
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
      expect(await end(w)).toMatchObject({ ok: true });
      expect(await openOf(w, 'delivery-unknown')).toEqual([]);
    });

    /** The run's queue held by a step the test ends (a long one: a handoff making a worktree, say). */
    const holdRunQueue = (w: World) => {
      const engine = w.engine as unknown as { inRunQueue<T>(id: unknown, fn: () => Promise<T>): Promise<T> };
      const held = gate();
      void engine.inRunQueue(INSTANCE, () => held.wait());
      return held;
    };
    const rootTools: readonly (readonly [string, (w: World, review: SessionId) => Promise<unknown>, unknown])[] = [
      ['handoff', (w: World) => handoff(w, ROOT, { ...toImpl, content: 'root hands on' }, { operationId: 'op-root-handoff' }), BUSY],
      ['report_to_root asking the user', (w: World) => report(w, ROOT, 'root asks', 'call-root-asks', true), BUSY],
      ['send_message to a node', (w: World, review: SessionId) => send(w, ROOT, review, 'root note', 'op-root-note'), MESSAGE_BUSY],
    ] as const;

    it.each(rootTools)("root's %s while the run's queue is held: busy at its deadline; run later, its step writes nothing", async (_, tool, busy) => {
      const { w, review } = await nodes();
      const time = timeControl(w);
      const queue = holdRunQueue(w);
      await settle();
      const before = await snapshot(w);
      const k = time.asked();
      const answer = call(() => tool(w, review));
      await settle();
      expect(answer.result).toBeUndefined();
      time.pass(k);
      await settle();
      expect(answer.result).toEqual(busy);
      queue.open();
      await settle();
      expect(await snapshot(w)).toEqual(before);
      expect(await openOf(w, 'confirmation')).toEqual([]);
    });

    it("root's create_tasks while the run's queue is held: busy at its deadline; run later, nothing is planned", async () => {
      const w = await make(pipelineTemplate());
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const time = timeControl(w);
      const queue = holdRunQueue(w);
      await settle();
      const before = await snapshot(w);
      const answer = call(() => createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t069-tasks'));
      await settle();
      expect(answer.result).toBeUndefined();
      time.passAll();
      await settle();
      expect(answer.result).toEqual(BUSY);
      queue.open();
      await settle();
      expect(await snapshot(w)).toEqual(before);
      // Called again with the queue free, it plans as ever.
      expect(await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t069-tasks-2')).toMatchObject({ status: 'created' });
    });

    it('a free run queue: each tool goes at once, its deadline never needed', async () => {
      const { w, impl, review } = await nodes();
      const time = timeControl(w);
      expect(await report(w, impl, 'free report', 'call-free-r')).toEqual({ status: 'reported' });
      expect(await report(w, ROOT, 'free root report', 'call-free-rr')).toEqual({ status: 'reported' });
      expect(await send(w, review, ROOT, 'free to root', 'op-free-root')).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(await handoff(w, review, { ruleId: 'rework', target: { kind: 'node', nodeId: IMPL }, content: 'free rework' })).toMatchObject({ status: 'accepted' });
      expect(time.asked()).toBe(4);
      await settle();
      expect(dispatchedText(w, 'free rework')).toHaveLength(1);
    });
  });
};

// T067 cases (T066 Astra r1 P2): a dispatch to a session no longer waits for its ack in that session's queue. Each
// session has a send lane: every dispatch to it goes there, one at a time in the order it was entered (C-07, CR-2), and
// one that may join the running turn (a user message, a peer message, a report or notice) waits for its ack there,
// outside the session's queue; a handoff or transfer (a new turn only) still waits for the lane in the queue. The echo of
// a user message waits only for what follows its ack. On the memory ports (core/workflow/t067.test.ts) and on SQLite
// (app/main/workflow-t067.test.ts).
import { describe, expect, it } from 'vitest';
import { MessageId, OperationId, type SessionId, type WorkflowTemplate } from '../../../contracts';
import { planNoticeOperationOf } from '../../pipeline';
import { createTasks, pipelineTemplate, project } from '../../pipeline/testing/t032-cases';
import type { DispatchRequest, DispatchResult } from '../../ports';
import type { FakeAdapter } from '../../sessions/testing/fake-adapter';
import { handoff, IMPL, instanceOf, REVIEW, rid, ROOT, sessionOf, settle, started, template, type World } from './harness';

export type Make = (workflow: WorkflowTemplate) => Promise<World>;

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const TIMEOUT: DispatchResult = { state: 'unknown', reason: 'timeout', written: true, detail: 'no reply frame echoed the uuid within the deadline' };

/** A gate the test opens: `wait()` is pending until `open()`. */
const gate = () => {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { wait: () => opened, open: () => release() };
};

interface Held {
  request: DispatchRequest;
  end: (result: DispatchResult) => void;
}
/** Every insert into the adapter's sessions waits for the test (its ack comes only once the turn's tool call returned). */
const holdInserts = (adapter: FakeAdapter): Held[] => {
  const held: Held[] = [];
  const original = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = (request) => (request.entry.kind === 'insert' ? new Promise<DispatchResult>((end) => held.push({ request, end })) : original(request));
  return held;
};
/** The runtime takes a held insert in: in its transcript, and its ack (naming `turnRef` when given). */
const ack = (adapter: FakeAdapter, held: Held, turnRef?: string) => {
  adapter.history.set(held.request.attempt.clientMessageId, { ref: held.request.nativeSessionRef, text: held.request.text });
  held.end({
    state: 'sent',
    nativeRef: { sessionRef: held.request.nativeSessionRef, ...(turnRef !== undefined && { turnRef }) },
    evidence: { kind: 'live-ack', at: '2026-10-29T00:00:00.000Z', detail: 'status frame' },
  });
};

const internals = (w: World) => w.service as unknown as { queues: Map<string, unknown>; serial: (key: string, fn: () => Promise<unknown>) => Promise<unknown> };
/** Whether the session's send lane has a dispatch in it. */
const laneBusy = (w: World, sessionId: SessionId) => internals(w).queues.has(`send:${sessionId}`);
/** Holds the session's queue until the gate opens. */
const holdQueue = (w: World, sessionId: SessionId) => {
  const held = gate();
  void internals(w).serial(`session:${sessionId}`, () => held.wait());
  return held;
};

let said = 0;
/** Whether an event of the session is applied now (its queue is free): an agent message, stored once applied. */
const applied = async (w: World, adapter: FakeAdapter, sessionId: SessionId) => {
  const id = MessageId.parse(`t067-said-${String(++said)}`);
  adapter.emit({ type: 'message.completed', message: { id, sessionId, role: 'assistant', origin: { kind: 'agent' }, text: `said ${String(said)}`, attachments: [], createdAt: '2026-10-29T01:00:00.000Z' } });
  await settle();
  return (await w.repositories.conversations.get(sessionId)).messages.some((m) => m.id === id);
};

let messages = 0;
/** The user's message to a session (`session.send`), with its message ID. */
const userSend = async (w: World, sessionId: SessionId, text: string) => {
  const session = await w.repositories.sessions.get(sessionId);
  const messageId = MessageId.parse(`t067-msg-${String(++messages)}`);
  const sent = w.run({ type: 'session.send', requestId: rid(), sessionId, messageId, expectedRevision: session!.revision, text, attachments: [] });
  return { messageId, sent };
};
const userMessagesOf = async (w: World, sessionId: SessionId, text: string) => (await w.repositories.conversations.get(sessionId)).messages.filter((m) => m.role === 'user' && m.text === text);

const dispatchedText = (w: World, text: string) => [...w.claude.dispatched, ...[...w.codex.values()].flatMap((a) => a.dispatched)].filter((d) => d.text.includes(text));
const end = async (w: World) => {
  const instance = await instanceOf(w);
  return w.run({ type: 'workflow.complete', requestId: rid(), instanceId: instance.id, expectedRevision: instance.revision });
};

export const t067Cases = (backend: string, make: Make) => {
  /** A pipeline run: impl works on task a (its first turn over), root in a turn of its own. */
  const working = async () => {
    const w = await make(pipelineTemplate());
    await w.repositories.projects.save(project(), null);
    w.holding.add(ROOT);
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    const created = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], `call-t067-tasks-${String(Math.random())}`);
    if (created.status !== 'created') throw new Error(created.status);
    const taskId = created.tasks[0]!.taskId;
    expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'build a' })).toMatchObject({ status: 'accepted' });
    await settle();
    return { w, impl: await sessionOf(w, IMPL), taskId };
  };
  /** As `working`, with impl (Codex) in a turn of its own now and every insert into it held. */
  const implRunning = async () => {
    const { w, impl, taskId } = await working();
    w.holding.add(impl);
    expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'second' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
    await settle();
    const codex = w.codex.get(impl)!;
    return { w, impl, taskId, codex, held: holdInserts(codex) };
  };
  let ops = 0;
  const peer = (w: World, from: SessionId, to: SessionId, content: string, op = `op-t067-${String(++ops)}`) =>
    w.service.sendMessage({ to, content }, { caller: from, operationId: OperationId.parse(op), sourceCallRef: `call-${op}` });
  const report = (w: World, from: SessionId, content: string) => w.engine.reportToRoot({ content, needsUserConfirmation: false }, { caller: from, sourceCallRef: `call-report-${content}` });

  describe(`T067 (${backend}): the wait cycle of T066 r1 P2 (draft repro) ends before any timeout`, () => {
    it.each(['send_message', 'report_to_root'] as const)(
      "X's queue no longer waits for an insert's ack: root's handoff to X and X's %s to root both return before that ack",
      async (tool) => {
        // plan (root) → impl → review → impl: impl (X) in its rework turn.
        const w = await make(template());
        w.holding.add(ROOT);
        expect(await started(w)).toMatchObject({ ok: true });
        await settle();
        expect(await handoff(w, ROOT, toImpl)).toMatchObject({ status: 'accepted' });
        await settle();
        const impl = await sessionOf(w, IMPL);
        expect(await handoff(w, impl, { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW } })).toMatchObject({ status: 'accepted' });
        await settle();
        const review = await sessionOf(w, REVIEW);
        w.holding.add(impl);
        expect(await handoff(w, review, { ruleId: 'rework', target: { kind: 'node', nodeId: IMPL } })).toMatchObject({ status: 'accepted' });
        await settle();
        const codex = w.codex.get(impl)!;
        const held = holdInserts(codex);
        // 1. Root's message into X's running turn: its ack is held.
        let note: unknown;
        void peer(w, ROOT, impl, 'note', 'op-t067-note').then((r) => (note = r));
        await settle();
        expect(held).toHaveLength(1);
        // 2. Root hands X more work: in the run's queue, it finds X's turn running and waits for its end.
        let handed: unknown;
        void handoff(w, ROOT, toImpl).then((r) => (handed = r));
        await settle();
        expect(handed).toMatchObject({ status: 'accepted', delivery: 'pending' });
        // 3. X, in its running turn, speaks to root: the run's queue is free, so it returns.
        let spoke: unknown;
        const call =
          tool === 'send_message'
            ? peer(w, impl, ROOT, 'to root', 'op-t067-to-root')
            : w.engine.reportToRoot({ content: 'to root', needsUserConfirmation: false }, { caller: impl, sourceCallRef: 'call-t067-report' });
        void call.then((r) => (spoke = r));
        await settle();
        expect(spoke).toMatchObject(tool === 'send_message' ? { status: 'accepted', delivery: 'sent' } : { status: 'reported' });
        expect(note).toBeUndefined();
        // X's tool call returned: its runtime takes the note in and acks it.
        ack(codex, held[0]!);
        await settle();
        expect(note).toMatchObject({ status: 'accepted', delivery: 'sent' });
        expect(dispatchedText(w, 'to root')).toHaveLength(1);
        // X's turn ends: the handoff goes once.
        w.holding.delete(impl);
        await w.finishTurn(impl);
        await settle();
        const handoffs = (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).filter((h) => h.target.sessionId === impl);
        expect(handoffs.map((h) => h.delivery.state)).toEqual(['sent', 'sent', 'sent']);
        expect(held).toHaveLength(1);
        expect((await w.repositories.escalations.list()).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
      },
    );
  });

  describe(`T067 (${backend}): the order of dispatches to one session (C-07, CR-2), each kind`, () => {
    it('peer messages: the second is not dispatched while the first waits for its ack; the session\'s queue is free meanwhile', async () => {
      const { w, impl, codex, held } = await implRunning();
      let first: unknown;
      let second: unknown;
      void peer(w, ROOT, impl, 'peer one').then((r) => (first = r));
      await settle();
      void peer(w, ROOT, impl, 'peer two').then((r) => (second = r));
      await settle();
      expect(held.map((h) => h.request.text)).toEqual([expect.stringContaining('peer one')]);
      expect(await applied(w, codex, impl)).toBe(true);
      expect({ first, second }).toEqual({ first: undefined, second: undefined });
      ack(codex, held[0]!);
      await settle();
      expect(first).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(held.map((h) => h.request.text)).toEqual([expect.stringContaining('peer one'), expect.stringContaining('peer two')]);
      ack(codex, held[1]!);
      await settle();
      expect(second).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(held).toHaveLength(2);
    });

    it('user messages: the second is not dispatched while the first waits for its ack; the session\'s queue is free meanwhile', async () => {
      const { w, impl, codex, held } = await implRunning();
      const one = await userSend(w, impl, 'user one');
      let firstDone: unknown;
      void one.sent.then((r) => (firstDone = r));
      await settle();
      const two = await userSend(w, impl, 'user two');
      let secondDone: unknown;
      void two.sent.then((r) => (secondDone = r));
      await settle();
      expect(held.map((h) => h.request.text)).toEqual(['user one']);
      expect(await applied(w, codex, impl)).toBe(true);
      // Both are stored as the user's messages already; neither command has its answer yet.
      expect((await userMessagesOf(w, impl, 'user two')).length).toBe(1);
      expect({ firstDone, secondDone }).toEqual({ firstDone: undefined, secondDone: undefined });
      ack(codex, held[0]!);
      await settle();
      expect(firstDone).toMatchObject({ ok: true });
      expect(held.map((h) => h.request.text)).toEqual(['user one', 'user two']);
      ack(codex, held[1]!);
      await settle();
      expect(secondDone).toMatchObject({ ok: true });
      for (const text of ['user one', 'user two']) expect(await userMessagesOf(w, impl, text)).toHaveLength(1);
    });

    it('reports to root: the second is not dispatched while the first waits for its ack; root\'s queue is free meanwhile', async () => {
      const { w, impl } = await working();
      const held = holdInserts(w.claude);
      let first: unknown;
      let second: unknown;
      void report(w, impl, 'report one').then((r) => (first = r));
      await settle();
      void report(w, impl, 'report two').then((r) => (second = r));
      await settle();
      expect(held.map((h) => h.request.text)).toEqual([expect.stringContaining('report one')]);
      expect(await applied(w, w.claude, ROOT)).toBe(true);
      expect({ first, second }).toEqual({ first: undefined, second: undefined });
      ack(w.claude, held[0]!);
      await settle();
      expect(first).toMatchObject({ status: 'reported' });
      expect(held).toHaveLength(2);
      expect(held[1]!.request.text).toContain('report two');
      ack(w.claude, held[1]!);
      await settle();
      expect(second).toMatchObject({ status: 'reported' });
    });

    it("root's notice, then the user's message to root: the message is not dispatched while the notice waits for its ack", async () => {
      const w = await make(pipelineTemplate({ confirm: true }));
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const asked = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t067-notice');
      if (asked.status !== 'awaiting-confirmation') throw new Error(asked.status);
      const held = holdInserts(w.claude);
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' })).toMatchObject({ ok: true });
      await settle();
      const notice = planNoticeOperationOf(asked.taskPlanId);
      expect(held).toHaveLength(1);
      expect((await w.store.get(notice))?.delivery.attempts.at(-1)?.clientMessageId).toBe(held[0]!.request.attempt.clientMessageId);
      const message = await userSend(w, ROOT, 'after the notice');
      let done: unknown;
      void message.sent.then((r) => (done = r));
      await settle();
      expect(held).toHaveLength(1);
      expect(await applied(w, w.claude, ROOT)).toBe(true);
      ack(w.claude, held[0]!);
      await settle();
      expect((await w.store.get(notice))?.delivery.state).toBe('sent');
      expect(held.map((h) => h.request.text)).toEqual([expect.any(String), 'after the notice']);
      ack(w.claude, held[1]!);
      await settle();
      expect(done).toMatchObject({ ok: true });
    });

    it('a handoff whose gate opens while an insert waits for its ack: dispatched only after that ack, once', async () => {
      const { w, impl, taskId, codex, held } = await implRunning();
      // A handoff queued for impl's turn end, then a message into that turn, its ack held.
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'third part' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      let note: unknown;
      void peer(w, ROOT, impl, 'note before the end').then((r) => (note = r));
      await settle();
      expect(held).toHaveLength(1);
      // The turn ends meanwhile: the handoff's gate opens, and it waits for the lane.
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      expect(dispatchedText(w, 'third part')).toHaveLength(0);
      // The insert's ack (it joined the turn before its end): then the handoff goes.
      ack(codex, held[0]!);
      await settle();
      expect(note).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
      const third = (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).find((h) => h.payload.includes('third part'));
      expect(third?.delivery.state).toBe('sent');
    });

    it('a handoff behind an insert whose ack names a new turn: it waits for that turn, never sent into it, and goes once it ends', async () => {
      const { w, impl, taskId, codex, held } = await implRunning();
      expect(await handoff(w, ROOT, { ...toImpl, taskId, content: 'third part' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      void peer(w, ROOT, impl, 'note that starts a turn');
      await settle();
      w.holding.delete(impl);
      await w.finishTurn(impl);
      await settle();
      // The runtime took the note in after the turn's end: it started a new turn, named by the ack.
      ack(codex, held[0]!, 'turn-t067-new');
      await settle();
      expect(dispatchedText(w, 'third part')).toHaveLength(0);
      const third = async () => (await w.repositories.handoffs.listByInstance((await instanceOf(w)).id)).find((h) => h.payload.includes('third part'));
      expect((await third())?.delivery).toMatchObject({ state: 'pending', attempts: [] });
      expect((await w.repositories.escalations.list()).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
      // That turn is reported and ends: the handoff goes once.
      w.emitTurn(impl, 'turn-t067-new', 'running');
      await settle();
      w.emitTurn(impl, 'turn-t067-new', 'completed');
      await settle();
      expect(dispatchedText(w, 'third part')).toHaveLength(1);
      expect((await third())?.delivery.state).toBe('sent');
    });
  });

  describe(`T067 (${backend}): the echo of a user message dispatched outside its session's queue`, () => {
    it('Claude: echoed on the frame of its ack, before the ack is answered: kept once; a user message that is not its echo is applied at once', async () => {
      await working().then(async ({ w }) => {
        const held = holdInserts(w.claude);
        const message = await userSend(w, ROOT, 'to root, echoed');
        let done: unknown;
        void message.sent.then((r) => (done = r));
        await settle();
        expect(held).toHaveLength(1);
        // Another user message of root's turn (not this one's echo) while the ack is held: applied now, not at the ack.
        w.claude.emit({
          type: 'message.completed',
          message: { id: MessageId.parse('t067-other-user'), sessionId: ROOT, role: 'user', origin: { kind: 'user' }, text: 'another prompt', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' },
        });
        await settle();
        expect(await userMessagesOf(w, ROOT, 'another prompt')).toHaveLength(1);
        // The ack's frame: its echo first (under the attempt's clientMessageId), then the ack, as the adapter does.
        const request = held[0]!.request;
        w.claude.emit({
          type: 'message.completed',
          message: { id: MessageId.parse(request.attempt.clientMessageId), sessionId: ROOT, role: 'user', origin: { kind: 'user' }, text: request.text, attachments: [], createdAt: '2026-10-29T01:00:00.000Z' },
        });
        ack(w.claude, held[0]!);
        await settle();
        expect(done).toMatchObject({ ok: true });
        expect(await userMessagesOf(w, ROOT, 'to root, echoed')).toHaveLength(1);
      });
    });

    it('Codex: its echo (an item of the turn) before the answer to its request: kept once; another user message is applied at once', async () => {
      const { w, impl, codex, held } = await implRunning();
      const message = await userSend(w, impl, 'to impl, echoed');
      let done: unknown;
      void message.sent.then((r) => (done = r));
      await settle();
      expect(held).toHaveLength(1);
      codex.emit({
        type: 'message.completed',
        message: { id: MessageId.parse('t067-item-other'), sessionId: impl, role: 'user', origin: { kind: 'user' }, text: 'another prompt', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' },
      });
      await settle();
      expect(await userMessagesOf(w, impl, 'another prompt')).toHaveLength(1);
      const turnRef = 'turn-t067-steered';
      codex.emit({
        type: 'message.completed',
        message: { id: MessageId.parse('t067-item-echo'), sessionId: impl, turnId: turnRef as never, role: 'user', origin: { kind: 'user' }, text: 'to impl, echoed', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' },
      });
      ack(codex, held[0]!, turnRef);
      await settle();
      expect(done).toMatchObject({ ok: true });
      expect(await userMessagesOf(w, impl, 'to impl, echoed')).toHaveLength(1);
    });
  });

  describe(`T067 (${backend}): a dispatch in the send lane never waits for a session's queue`, () => {
    it('a sent user message (its echo expected, its question closed): the lane finishes while the session\'s queue is held', async () => {
      const { w } = await working();
      const held = holdInserts(w.claude);
      const message = await userSend(w, ROOT, 'sent while root\'s queue is held');
      await settle();
      expect(held).toHaveLength(1);
      const queue = holdQueue(w, ROOT);
      ack(w.claude, held[0]!);
      await settle();
      expect(laneBusy(w, ROOT)).toBe(false);
      expect((await w.store.get(OperationId.parse(`user-message:${message.messageId}`)))?.delivery.state).toBe('sent');
      queue.open();
      await settle();
      expect(await message.sent).toMatchObject({ ok: true });
    });

    it('an insert that timed out (left to the reconcile after its turn): the lane finishes while the session\'s queue is held', async () => {
      const { w, impl, held } = await implRunning();
      void peer(w, ROOT, impl, 'times out', 'op-t067-timeout');
      await settle();
      expect(held).toHaveLength(1);
      const queue = holdQueue(w, impl);
      held[0]!.end(TIMEOUT);
      await settle();
      expect(laneBusy(w, impl)).toBe(false);
      expect((await w.store.get(OperationId.parse('op-t067-timeout')))?.delivery.state).toBe('unknown');
      expect(w.service.beingConfirmed(OperationId.parse('op-t067-timeout'))).toBe(true);
      queue.open();
      await settle();
    });

    it('a notice whose run ended while it was on its way (closed after its dispatch): the lane finishes while root\'s queue is held', async () => {
      const w = await make(pipelineTemplate({ confirm: true }));
      await w.repositories.projects.save(project(), null);
      w.holding.add(ROOT);
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      const asked = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-t067-closing');
      if (asked.status !== 'awaiting-confirmation') throw new Error(asked.status);
      const held = holdInserts(w.claude);
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' })).toMatchObject({ ok: true });
      await settle();
      const notice = planNoticeOperationOf(asked.taskPlanId);
      expect(held).toHaveLength(1);
      expect(await end(w)).toMatchObject({ ok: true });
      await settle();
      const queue = holdQueue(w, ROOT);
      held[0]!.end(TIMEOUT);
      await settle();
      expect(laneBusy(w, ROOT)).toBe(false);
      expect((await w.store.get(notice))?.outcome?.kind).toBe('cancelled');
      expect(w.service.beingConfirmed(notice)).toBe(false);
      expect((await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown')).toEqual([]);
      queue.open();
      await settle();
    });

    it("`exclusive` holds the sessions' send lanes too: what it runs waits for a dispatch on its way", async () => {
      const { w, impl, codex, held } = await implRunning();
      void peer(w, ROOT, impl, 'on its way');
      await settle();
      expect(held).toHaveLength(1);
      let ran = false;
      const done = w.service.exclusive([impl], () => {
        ran = true;
        return Promise.resolve();
      });
      await settle();
      expect(ran).toBe(false);
      ack(codex, held[0]!);
      await done;
      expect(ran).toBe(true);
    });
  });
};

// T039 crash matrix (V-15, V-16, V-28): the GUI dies at each of the task card's points and starts again on the same
// storage. A crash here is what the live run does with taskkill: the old world is never shut down and its runtimes
// stay stuck on the await they were at (their process is gone with the GUI); `restart()` builds a new service, engine
// and supervisor on the same repositories and delivery store, then runs the start-up recovery. Each point checks what
// the card asks after a restart:
//   - an unknown delivery is only reconciled, never sent again on its own; the user's retry is a new attempt;
//   - an approval that was waiting for the user is not replayed (withdrawn, and its escalation cannot approve);
//   - a late result of the old attempt (the old process "answering" after the retry) changes nothing;
//   - the old opening's turn does not run on into the new one;
//   - what was left running is recorded as ended (the Job, or the start-up cleanup, ended the processes: backend test);
//   - no unexpected `pending-cleanup`.
// The same cases run on memory storage (crash-memory.test.ts) and on the real SQLite repositories (crash-sqlite.test.ts).
import { describe, expect, it } from 'vitest';
import { type Escalation, type ItemId, type NativeTaskId, type Runtime, type SessionId, type TaskId, TurnId, type WorkflowTemplate } from '../../contracts';
import { createTasks, MERGE, pipelineTemplate, project, until } from '../../core/pipeline/testing/t032-cases';
import { permissionRequest } from '../../core/sessions/testing/fake-adapter';
import { CWD as SUP_CWD } from '../../core/sessions/testing/harness';
import {
  adapterOf,
  AT,
  closesOf,
  created,
  exchange,
  gate,
  IDLE_MS,
  isOpen,
  resumedOf,
  rid as supRid,
  send,
  settle as supSettle,
  type HoldingAdapter,
  type SupWorld,
  type SupWorldOptions,
} from '../../core/supervisor/testing/harness';
import {
  CWD,
  dispatches,
  handoff,
  IMPL,
  INSTANCE,
  instanceOf,
  rid,
  ROOT,
  settle,
  sessionOf,
  started,
  template,
  type World,
} from '../../core/workflow/testing/harness';

export type MakeSup = (o?: SupWorldOptions) => Promise<SupWorld>;
export type MakeFlow = (workflow?: WorkflowTemplate) => Promise<World>;

const RUNTIMES: readonly Runtime[] = ['codex', 'claude'];


const openEscalations = async (w: { repositories: SupWorld['repositories'] }, kind?: Escalation['kind']) =>
  (await w.repositories.escalations.list({ state: 'open' })).filter((e) => kind === undefined || e.kind === kind);

/** The adapter's next dispatches wait for the returned gate before the runtime gets them (the GUI dies in between). */
const holdDispatch = (adapter: HoldingAdapter) => {
  const late = gate();
  const dispatch = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = async (request) => {
    await late.promise;
    return dispatch(request);
  };
  return late;
};

/** A restart of the supervisor world: a new service and supervisor on the same storage, recovered. */
const restartSup = async (w: SupWorld): Promise<SupWorld> => {
  const r = w.restart();
  await r.service.start();
  await supSettle();
  return r;
};

/** No worktree of the run is left waiting for a cleanup nobody asked for. */
const noPendingCleanup = async (w: World) => {
  const instance = await w.repositories.instances.get(INSTANCE);
  if (instance === undefined) return;
  expect(instance.tasks.filter((t) => t.worktree?.cleanup === 'pending-cleanup')).toEqual([]);
  expect(instance.mergeQueue.filter((m) => m.integration?.cleanup === 'pending-cleanup')).toEqual([]);
};

export const crashCases = (name: string, makeSup: MakeSup, makeFlow: MakeFlow) => {
  describe(`T039 crash matrix: ordinary sessions (${name})`, () => {
    for (const runtime of RUNTIMES) {
      it(`P1 ${runtime}: unknown committed, the runtime never got it: the restart only reconciles and never sends it again; the old attempt's late ack changes nothing`, async () => {
        const w = await makeSup();
        const a = await created(w, runtime);
        const late = holdDispatch(adapterOf(w, runtime, a));
        void send(w, a, 'the work');
        await supSettle();
        const [before] = (await w.store.listByState('unknown')).filter((r) => r.kind === 'user-message');
        expect(before?.delivery.attempts).toHaveLength(1);
        expect(sentTexts(w, runtime, a)).toEqual([]);

        const r = await restartSup(w);
        const after = (await r.store.get(before!.operationId))!;
        expect(after.delivery).toMatchObject({ state: 'unknown' });
        expect(after.delivery.attempts).toHaveLength(1);
        expect(after.outcome).toBeUndefined();
        // Reconciled (read only), never sent again, the session not resumed for it.
        expect(adapterOf(r, runtime, a).reconciled.map((x) => x.clientMessageId)).toEqual([before!.delivery.attempts[0]!.clientMessageId]);
        expect(sentTexts(r, runtime, a)).toEqual([]);
        expect(resumedOf(r, runtime, a)).toEqual([]);
        // A user's own message has no escalation in contracts (G-1): the session shows it is reconciling. The message
        // itself is stored once.
        expect((await r.repositories.sessions.get(a))?.activity).toBe('reconciling');
        expect((await r.repositories.conversations.get(a)).messages.filter((m) => m.role === 'user')).toHaveLength(1);
        // Sending the same message ID again does not send it again either.
        const message = (await r.repositories.conversations.get(a)).messages.find((m) => m.role === 'user')!;
        const session = (await r.repositories.sessions.get(a))!;
        expect(
          await r.run({ type: 'session.send', requestId: supRid(), sessionId: a, messageId: message.id, expectedRevision: session.revision, text: 'the work', attachments: [] }),
        ).toMatchObject({ ok: false });
        expect(sentTexts(r, runtime, a)).toEqual([]);

        // The user's next message is a new operation: it resumes the session once and is sent once.
        expect((await send(r, a, 'next')).ok).toBe(true);
        await supSettle();
        expect(sentTexts(r, runtime, a)).toEqual(['next']);
        expect(resumedOf(r, runtime, a)).toHaveLength(1);
        const kept = (await r.store.get(before!.operationId))!;
        expect(kept.delivery.state).toBe('unknown');

        // The old process's ack of that same attempt comes late (it cannot, once the process is gone; the store is the
        // last guard): it is that attempt's own evidence, so at most it settles it; nothing is sent again, no attempt added.
        late.open();
        await supSettle();
        expect((await r.store.get(before!.operationId))!.delivery.attempts.map((x) => x.attemptId)).toEqual(kept.delivery.attempts.map((x) => x.attemptId));
        expect(sentTexts(r, runtime, a)).toEqual(['next']);
      });

      it(`P2 ${runtime}: an approval held for the user mid-turn: the restart withdraws it, its escalation approves nothing, and the runtime asking again is asked of the user again`, async () => {
        const w = await makeSup();
        w.decide = () => ({ action: 'escalate', rule: 'write-outside-scope', reason: 'outside the folder' });
        const a = await created(w, runtime);
        expect((await send(w, a, 'write the marker')).ok).toBe(true);
        const old = adapterOf(w, runtime, a);
        const turn = TurnId.parse(old.lastTurn!);
        old.emit({ type: 'turn.updated', turn: { id: turn, sessionId: a, state: 'running', startedAt: AT } });
        const request = permissionRequest(a, { id: 'perm-p2' as never, summary: 'Set-Content outside', command: 'Set-Content E:\\outside\\marker.txt x', paths: ['E:\\outside\\marker.txt'], turnId: turn });
        const asked = old.ask(request);
        await supSettle();
        old.emit({ type: 'permission.updated', request: asked.request });
        await supSettle();
        expect(asked.holdState).toMatchObject({ reason: 'awaiting-user' });
        const [held] = await openEscalations(w, 'permission');
        expect(held).toBeDefined();

        const r = await restartSup(w);
        const conversation = await r.repositories.conversations.get(a);
        expect(conversation.permissionRequests.find((p) => p.id === 'perm-p2')).toMatchObject({ state: 'withdrawn' });
        expect(conversation.turns.find((t) => t.id === turn)).toMatchObject({ state: 'interrupted' });
        expect(await openEscalations(r, 'permission')).toEqual([]);
        // The old approval is not replayed: approving the old escalation now is refused, and nothing reached the runtime.
        expect(await r.run({ type: 'escalation.respond', requestId: supRid(), escalationId: held!.id, decision: 'approve' })).toMatchObject({ ok: false });
        expect(asked.decision).toBeUndefined();

        // The next message resumes it once; the runtime asks the same thing again: a new hold, decided by nobody yet.
        expect((await send(r, a, 'go on')).ok).toBe(true);
        await supSettle();
        expect(resumedOf(r, runtime, a)).toHaveLength(1);
        const again = adapterOf(r, runtime, a).ask({ ...request, turnId: TurnId.parse(adapterOf(r, runtime, a).lastTurn!) });
        await supSettle();
        expect(again.decision).toBeUndefined();
        expect(again.holdState).toMatchObject({ reason: 'awaiting-user' });
        const [asking] = await openEscalations(r, 'permission');
        expect(await r.run({ type: 'escalation.respond', requestId: supRid(), escalationId: asking!.id, decision: 'decline' })).toMatchObject({ ok: true });
        expect(again.decision).toMatchObject({ outcome: 'decline', decidedBy: 'user' });
      });

      it(`P5 ${runtime}: the supervisor closing an idle session: after the restart it is closed, resumes once in its folder, and the old turn does not run on`, async () => {
        const w = await makeSup();
        const a = await created(w, runtime);
        await exchange(w, runtime, a, 'before');
        const old = adapterOf(w, runtime, a);
        const oldTurn = TurnId.parse(old.lastTurn!);
        w.clock.advance(IDLE_MS);
        old.closeGate = new Promise<void>(() => undefined);
        void w.supervisor.tick();
        await supSettle();
        expect(closesOf(w, runtime, a)).toHaveLength(1);

        const r = await restartSup(w);
        expect((await r.repositories.sessions.get(a))?.activity).toBe('closed');
        expect(await r.store.listByState('pending')).toEqual([]);
        expect((await r.store.listByState('unknown')).filter((x) => x.kind !== 'provision')).toEqual([]);
        expect((await send(r, a, 'after')).ok).toBe(true);
        await supSettle();
        expect(resumedOf(r, runtime, a).map((o) => o.cwd)).toEqual([SUP_CWD]);
        expect(sentTexts(r, runtime, a)).toEqual(['after']);
        // The new opening's runtime replays the old turn as running: it stays ended, and the session's turn boundary
        // follows the new turn only.
        const fresh = adapterOf(r, runtime, a);
        fresh.emit({ type: 'turn.updated', turn: { id: oldTurn, sessionId: a, state: 'running', startedAt: AT } });
        const newTurn = TurnId.parse(fresh.lastTurn!);
        fresh.emit({ type: 'turn.updated', turn: { id: newTurn, sessionId: a, state: 'running', startedAt: AT } });
        fresh.emit({ type: 'turn.updated', turn: { id: newTurn, sessionId: a, state: 'completed', startedAt: AT, endedAt: AT } });
        await supSettle();
        expect((await r.repositories.conversations.get(a)).turns.find((t) => t.id === oldTurn)?.state).toBe('completed');
        expect(await r.service.mainTurnRunning(a)).toBe(false);
        expect(isOpen(r, a)).toBe(true);
      });

      it(`P6 ${runtime}: a command running (V-28): the restart records the command, its turn and the sub-agent as ended; the session is not busy`, async () => {
        const w = await makeSup();
        const a = await created(w, runtime);
        expect((await send(w, a, 'run a long command')).ok).toBe(true);
        const old = adapterOf(w, runtime, a);
        const turn = TurnId.parse(old.lastTurn!);
        old.emit({ type: 'turn.updated', turn: { id: turn, sessionId: a, state: 'running', startedAt: AT } });
        old.emit({
          type: 'item.updated',
          item: { id: 'cmd-p6' as ItemId, sessionId: a, turnId: turn, kind: 'command', command: 'Start-Sleep -Seconds 240', cwd: SUP_CWD, state: 'running', output: '', outputTruncated: false, startedAt: AT },
        });
        old.emit({
          type: 'nativeTask.updated',
          task: { id: 'nt-p6' as NativeTaskId, sessionId: a, runtime, parentRef: 'parent', nativeRef: 'child', label: 'helper', state: 'running', background: true, startedAt: AT },
        });
        w.owned.set(a, 2);
        await supSettle();

        // The Job ended the processes with the GUI (backend test: the next start's cleanup records them ended).
        w.owned.delete(a);
        const r = await restartSup(w);
        const conversation = await r.repositories.conversations.get(a);
        expect(conversation.turns.find((t) => t.id === turn)).toMatchObject({ state: 'interrupted' });
        expect(conversation.items.find((i) => i.id === 'cmd-p6')).toMatchObject({ state: 'interrupted' });
        expect(conversation.items.find((i) => i.id === 'cmd-p6')?.endedAt).toBeDefined();
        expect(conversation.nativeTasks.find((t) => t.id === 'nt-p6')).toMatchObject({ state: 'stopped' });
        expect(conversation.nativeTasks.find((t) => t.id === 'nt-p6')?.endedAt).toBeDefined();
        expect(await r.service.mainTurnRunning(a)).toBe(false);
        expect((await r.service.idleFacts(a))?.items.every((i) => i.endedAt !== undefined)).toBe(true);
        // What the user sent was sent once, before the crash; nothing is sent again.
        expect(sentTexts(r, runtime, a)).toEqual([]);
        expect(await r.store.listByState('pending')).toEqual([]);
      });
    }
  });

  describe(`T039 crash matrix: workflow handoff and merge queue (${name})`, () => {
    it('P3: mid-handoff, after its target was made and the unknown committed: counted once, never sent again or made again; the retry sends it once', async () => {
      const w = await makeFlow(template());
      expect(await started(w)).toMatchObject({ ok: true });
      const late = gate();
      w.dispatchGate = () => late.promise;
      void handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'build the page' });
      await settle();
      const impl = await sessionOf(w, IMPL);
      const [record] = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(record?.delivery.state).toBe('unknown');
      expect(w.codex.get(impl)?.started).toHaveLength(1);
      expect(dispatches(w).filter((d) => d.text.includes('build the page'))).toEqual([]);

      const r = await w.restart();
      await settle();
      const handoffs = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.delivery.state).toBe('unknown');
      expect(handoffs[0]!.delivery.attempts).toHaveLength(1);
      // Not made again, not sent again, not resumed to look.
      expect(r.codex.get(impl)?.started ?? []).toEqual([]);
      expect(r.codex.get(impl)?.resumed ?? []).toEqual([]);
      expect(dispatches(r)).toEqual([]);
      const [unknown] = await openEscalations(r, 'delivery-unknown');
      expect(unknown).toBeDefined();

      expect(await r.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
      await settle();
      expect(dispatches(r).filter((d) => d.text.includes('build the page'))).toHaveLength(1);
      const sent = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.delivery).toMatchObject({ state: 'sent' });
      expect(sent[0]!.delivery.attempts).toHaveLength(2);
      // The old process's late ack changes nothing.
      late.open();
      await settle();
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL)).toEqual(sent);
      await noPendingCleanup(r);
    });

    it('P3: the old attempt’s late ack while the user’s retry is still on its way settles nothing of the retry', async () => {
      const w = await makeFlow(template());
      expect(await started(w)).toMatchObject({ ok: true });
      const late = gate();
      w.dispatchGate = () => late.promise;
      void handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'build the page' });
      await settle();
      const r = await w.restart();
      await settle();
      const [unknown] = await openEscalations(r, 'delivery-unknown');
      // The retry's dispatch has not been answered yet either.
      const retryHeld = gate();
      r.dispatchGate = () => retryHeld.promise;
      void r.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'retry', acceptDuplicateRisk: true });
      await settle();
      const [inFlight] = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(inFlight!.delivery.state).toBe('unknown');
      expect(inFlight!.delivery.attempts).toHaveLength(2);
      late.open();
      await settle();
      // The first attempt's ack names another attempt than the one under way: nothing of the record changes.
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL)).toEqual([inFlight]);
      retryHeld.open();
      await settle();
      const [done] = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(done!.delivery.state).toBe('sent');
      expect(done!.delivery.attempts.at(-1)).toMatchObject({ state: 'sent', attemptId: inFlight!.delivery.attempts[1]!.attemptId });
      expect(done!.delivery.attempts[0]).toMatchObject({ state: 'unknown', resolution: { decision: 'retry' } });
      expect(dispatches(r).filter((d) => d.text.includes('build the page'))).toHaveLength(1);
    });

    it('P3: mid-handoff, while its target was being made: the target is not made again on its own; the handoff waits, then goes once', async () => {
      const w = await makeFlow(template());
      expect(await started(w)).toMatchObject({ ok: true });
      w.onNewCodex = (adapter) => adapter.startModes.push('held');
      void handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'build the page' });
      await settle();
      const impl = await sessionOf(w, IMPL);
      expect(w.codex.get(impl)?.started).toHaveLength(1);

      const r = await w.restart();
      await settle();
      expect(r.codex.get(impl)?.started ?? []).toEqual([]);
      expect(dispatches(r)).toEqual([]);
      const handoffs = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.delivery.state).toBe('pending');
      const [unknown] = await openEscalations(r, 'delivery-unknown');
      expect(unknown?.ref).toMatchObject({ kind: 'provision' });

      expect(await r.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
      await until(async () => (await r.repositories.handoffs.listByInstance(INSTANCE)).some((h) => h.toNodeId === IMPL && h.delivery.state === 'sent'), 'the handoff sent');
      expect(r.codex.get(impl)?.started).toHaveLength(1);
      expect(dispatches(r).filter((d) => d.text.includes('build the page'))).toHaveLength(1);
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL)).toHaveLength(1);
    });

    it('P4: the merge queue testing in its integration worktree: the restart tests again once (the old run died with the GUI), merges once, cleans up both worktrees', async () => {
      const w = await makeFlow(pipelineTemplate());
      await w.repositories.projects.save(project(), null);
      expect(await started(w)).toMatchObject({ ok: true });
      const made = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }]);
      if (made.status !== 'created') throw new Error('no task');
      const taskId: TaskId = made.tasks[0]!.taskId;
      expect(await handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId, content: 'build A' })).toMatchObject({ status: 'accepted' });
      await until(async () => (await w.repositories.handoffs.listByInstance(INSTANCE)).some((h) => h.toNodeId === IMPL && h.delivery.state === 'sent'), 'A delivered');
      w.commands.script = (spec) => (spec.purpose === 'test' ? 'hang' : { exitCode: 0, outputTail: 'ok' });
      const task = (await instanceOf(w)).tasks.find((t) => t.id === taskId)!;
      w.git.write(task.worktree!.path, 'a.txt', 'a\n');
      const implSession = (await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId }))!;
      expect(await handoff(w, implSession, { ruleId: 'to-merge', target: { kind: 'node', nodeId: MERGE }, taskId })).toMatchObject({ status: 'accepted' });
      await until(async () => (await instanceOf(w)).mergeQueue[0]?.state === 'testing', 'testing');
      const base = w.git.tip(CWD, 'main');

      // The GUI dies with the test running; the test process went with it.
      w.commands.script = () => ({ exitCode: 0, outputTail: 'ok' });
      const r = await w.restart();
      await until(async () => (await instanceOf(r)).tasks.find((t) => t.id === taskId)?.status === 'merged', 'merged');
      expect(r.commands.of('test')).toHaveLength(2);
      expect(r.git.calls.filter((c) => c.op === 'merge')).toHaveLength(1);
      expect((await instanceOf(r)).mergeQueue).toHaveLength(1);
      expect(r.git.tip(CWD, 'main')).not.toBe(base);
      expect(r.git.fileAt(r.git.tip(CWD, 'main'), 'a.txt')).toBe('a\n');
      expect((await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === MERGE)).toHaveLength(1);
      await until(async () => {
        const instance = await instanceOf(r);
        return instance.tasks.every((t) => t.worktree?.cleanup === 'removed') && instance.mergeQueue.every((m) => m.integration?.cleanup === 'removed');
      }, 'both worktrees removed');
      await noPendingCleanup(r);
    });
  });
};

/** The texts dispatched to the session in this world, across its adapters (none when it never had one). */
const sentTexts = (w: SupWorld, runtime: Runtime, sessionId: SessionId): string[] => {
  const adapters = w.all.get(sessionId) ?? [runtime === 'claude' ? w.claude : w.codex.get(sessionId)].filter((x) => x !== undefined);
  return adapters.flatMap((x) => x.dispatched.map((d) => d.text));
};

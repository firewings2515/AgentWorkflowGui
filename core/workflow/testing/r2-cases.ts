// T024 review r2: each reviewer reproduction as a regression test, run on the memory ports here and on
// the SQLite repositories and delivery store in app/main (the two backends the reviewer used).
import { describe, expect, it } from 'vitest';
import { type Command, SessionId, type WorkflowTemplate } from '../../../contracts';
import { CWD, handoff, IMPL, INSTANCE, instanceOf, REVIEW, ROOT, rid, sessionOf, settle, started, startCommand, template, type World } from './harness';

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
const toReview = { ruleId: 'to-review', target: { kind: 'node' as const, nodeId: REVIEW } };
const rework = { ruleId: 'rework', target: { kind: 'node' as const, nodeId: IMPL } };

const toReviewOnce = async (w: World) => {
  await started(w);
  await handoff(w, ROOT, toImpl);
  const impl = await sessionOf(w, IMPL);
  await handoff(w, impl, toReview);
  await settle();
  return { impl, review: await sessionOf(w, REVIEW) };
};

/** Handoff payloads a session's runtime received, by the content after the frame. */
const received = (w: World, sessionId: SessionId) => {
  const adapter = w.codex.get(sessionId) ?? w.claude;
  const refs = new Set([...adapter.started.filter((o) => o.sessionId === sessionId).map((o) => o.preallocatedRef), ...adapter.resumed.filter((o) => o.sessionId === sessionId).map((o) => o.nativeSessionRef)]);
  return adapter.dispatched.filter((d) => w.codex.has(sessionId) || refs.has(d.nativeSessionRef)).map((d) => d.text.split('\n\n').at(-1));
};

/** Makes `method` of `target` reject once with "crash" when `when` holds, as a GUI killed at that point. */
export const crashOnce = <T extends object, K extends keyof T>(target: T, method: K, when: (...args: unknown[]) => boolean = () => true) => {
  const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let armed = true;
  (target as Record<K, unknown>)[method] = (...args: unknown[]) => {
    if (armed && when(...args)) {
      armed = false;
      return Promise.reject(new Error('crash'));
    }
    return original(...args);
  };
};

export const r2Cases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`T024 review r2 (${backend})`, () => {
    it('r2-P1-1 a handoff queued before its task stopped at a limit is cancelled, not sent when the turn ends, nor after a restart', async () => {
      const w = await make(template({ reworkLimit: 1 }));
      const { impl, review } = await toReviewOnce(w);
      // Implement is busy; review sends the task back (queued), then implement's own handoff goes over the limit.
      w.holding.add(impl);
      w.emitTurn(impl, 'busy-1', 'running');
      await settle();
      const queued = await handoff(w, review, { ...rework, content: 'queued' }, { operationId: 'op-queued' });
      expect(queued).toMatchObject({ status: 'accepted', delivery: 'pending' });
      expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
      const stored = (await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.operationId === 'op-queued');
      expect(stored).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
      const limit = (await w.repositories.escalations.list({ state: 'open' })).find((e) => e.kind === 'limit-exceeded');
      expect(limit?.detail).toContain('1 queued handoff(s) of the task were cancelled');
      const before = received(w, impl).length;
      w.emitTurn(impl, 'busy-1', 'completed');
      await settle();
      expect(received(w, impl)).toHaveLength(before);
      // A resend of it is answered as blocked, not as a duplicate that goes on.
      expect(await handoff(w, review, { ...rework, content: 'queued' }, { operationId: 'op-queued', sourceCallRef: 'call-again' })).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      const after = await w.restart();
      await settle();
      expect(received(after, impl)).toHaveLength(0);
    });

    it('r2-P1-1 a queued handoff whose cancel could not be written is still not sent once its task is blocked', async () => {
      const w = await make(template({ reworkLimit: 1 }));
      const { impl, review } = await toReviewOnce(w);
      w.holding.add(impl);
      w.emitTurn(impl, 'busy-1', 'running');
      await settle();
      await handoff(w, review, { ...rework, content: 'queued' }, { operationId: 'op-queued' });
      crashOnce(w.store, 'recordOutcome');
      expect(await handoff(w, impl, toReview)).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
      expect((await w.repositories.handoffs.listByInstance(INSTANCE)).find((h) => h.operationId === 'op-queued')?.outcome).toBeUndefined();
      const before = received(w, impl).length;
      w.emitTurn(impl, 'busy-1', 'completed');
      await settle();
      expect(received(w, impl)).toHaveLength(before);
    });

    it('r2-P1-2 a late end of a turn never recorded does not release the next handoff; the end of the turn the dispatch started does', async () => {
      const w = await make(template({ reworkLimit: 5 }));
      const { impl, review } = await toReviewOnce(w);
      // A goes, but its turn reports nothing yet.
      w.silent.add(impl);
      await handoff(w, review, { ...rework, content: 'A' });
      await settle();
      expect(received(w, impl).at(-1)).toBe('A');
      const b = await handoff(w, ROOT, { ...toImpl, content: 'B' });
      expect(b).toMatchObject({ status: 'accepted', delivery: 'pending' });
      // The end of an earlier turn X that the GUI never recorded arrives late.
      w.emitTurn(impl, 'turn-x-never-recorded', 'completed');
      await settle();
      expect(received(w, impl).at(-1)).toBe('A');
      w.silent.delete(impl);
      await w.finishTurn(impl);
      expect(received(w, impl).at(-1)).toBe('B');
    });

    it('r2-P1-3 a running that arrives after the same turn completed does not reopen it, so handoffs still go', async () => {
      const w = await make(template({ reworkLimit: 5 }));
      const { impl, review } = await toReviewOnce(w);
      w.emitTurn(impl, 'turn-late', 'completed');
      w.emitTurn(impl, 'turn-late', 'running');
      await settle();
      expect((await w.repositories.conversations.get(impl)).turns.find((t) => t.id === 'turn-late')?.state).toBe('completed');
      await handoff(w, review, { ...rework, content: 'one' });
      await handoff(w, ROOT, { ...toImpl, content: 'two' });
      await settle();
      expect(received(w, impl).slice(-2)).toEqual(['one', 'two']);
    });

    it('r2-P1-3 an ordinary session keeps a turn that ended as ended, and its turns still run and end as before', async () => {
      const w = await make();
      const plain = SessionId.parse('plain-claude');
      await w.run({ type: 'session.create', requestId: rid(), sessionId: plain, kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD });
      await settle();
      w.emitTurn(plain, 't-1', 'running');
      await settle();
      expect((await w.repositories.conversations.get(plain)).turns.map((t) => [t.id, t.state])).toEqual([['t-1', 'running']]);
      w.emitTurn(plain, 't-1', 'completed');
      w.emitTurn(plain, 't-1', 'running');
      w.emitTurn(plain, 't-2', 'running');
      await settle();
      expect((await w.repositories.conversations.get(plain)).turns.map((t) => [t.id, t.state])).toEqual([
        ['t-1', 'completed'],
        ['t-2', 'running'],
      ]);
      // The late running is not pushed either: the views agree with the store.
      expect(w.events.filter((e) => e.type === 'turn.updated' && e.turn.id === 't-1').map((e) => (e.type === 'turn.updated' ? e.turn.state : ''))).toEqual(['running', 'completed']);
    });

    it('r2-P1-4 a start cut off after its root session, before the first message was written, refuses another first message', async () => {
      const w = await make();
      crashOnce(w.service, 'recordUserMessage');
      const original = startCommand();
      await expect(w.run(original)).rejects.toThrow('crash');
      expect(await w.repositories.sessions.get(ROOT)).toBeDefined();
      // Retried at once, and after a restart (which writes the stored first message into root).
      expect(await w.run({ ...original, requestId: rid(), firstMessage: 'Something else.' })).toMatchObject({ ok: false, code: 'already_exists', mayHaveSideEffects: false });
      const after = await w.restart();
      expect(await after.run({ ...original, requestId: rid(), firstMessage: 'Something else.' })).toMatchObject({ ok: false, code: 'already_exists', mayHaveSideEffects: false });
      expect(after.claude.dispatched).toHaveLength(0);
      expect(await after.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
      await settle();
      expect(after.claude.dispatched.map((d) => d.text)).toEqual(['Plan a login page.']);
    });

    it('r2-P1-4 a start cut off before its instance refuses a newer template whose root has another tool and write access', async () => {
      const w = await make();
      crashOnce(w.repositories.instances, 'create');
      const original = startCommand();
      await expect(w.run(original)).rejects.toThrow('crash');
      // The template moves on: root is now Codex and read-only.
      const newer = template({ revision: 1 }, { plan: { model: { runtime: 'codex', model: 'gpt-6-luna' }, writePolicy: 'read-only' } });
      expect(await w.repositories.workflows.save(newer, 0)).toMatchObject({ status: 'saved' });
      expect(await w.run({ ...original, requestId: rid(), workflowRevision: 1 })).toMatchObject({ ok: false, code: 'already_exists' });
      const after = await w.restart();
      expect(await after.run({ ...original, requestId: rid(), workflowRevision: 1 })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(await after.repositories.instances.list()).toEqual([]);
      const root = await after.repositories.sessions.get(ROOT);
      expect(root).toMatchObject({ requestedModel: { runtime: 'claude' } });
      expect(root?.folderScope.writableRoots.length).toBe(1);
      expect(after.codex.size).toBe(0);
      expect(after.claude.dispatched).toHaveLength(0);
    });

    it('r2-P2 a start cut off before its instance refuses another root session before creating any', async () => {
      const w = await make();
      crashOnce(w.repositories.instances, 'create');
      const original = startCommand();
      await expect(w.run(original)).rejects.toThrow('crash');
      const after = await w.restart();
      const other: Command = { ...original, requestId: rid(), rootSessionId: SessionId.parse('root-other') };
      expect(await after.run(other)).toMatchObject({ ok: false, code: 'already_exists', mayHaveSideEffects: false });
      expect((await after.repositories.sessions.list()).map((s) => s.id)).toEqual([ROOT]);
      expect(await after.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
    });

    it('r2-P1-5 a report accepted but not delivered goes on when the same call is resent, and root receives its text', async () => {
      const w = await make();
      await started(w);
      await handoff(w, ROOT, toImpl);
      const impl = await sessionOf(w, IMPL);
      const before = received(w, ROOT).length;
      crashOnce(w.repositories.escalations, 'upsert', (e) => (e as { id: string }).id.startsWith('wf-report:'));
      const input = { content: 'May I drop the old table?', needsUserConfirmation: true };
      await expect(w.engine.reportToRoot(input, { caller: impl, sourceCallRef: 'call-r' })).rejects.toThrow('crash');
      expect(received(w, ROOT)).toHaveLength(before);
      const again = await w.engine.reportToRoot(input, { caller: impl, sourceCallRef: 'call-r' });
      expect(again).toMatchObject({ status: 'reported', escalationId: expect.any(String) as string });
      expect(received(w, ROOT).at(-1)).toBe('May I drop the old table?');
      expect((await w.repositories.peerMessages.list()).map((m) => m.delivery.state)).toEqual(['sent']);
    });

    it('r2-P1-5 a report left pending goes on when the root turn ends, without a resend or a restart', async () => {
      const w = await make();
      await started(w);
      await handoff(w, ROOT, toImpl);
      const impl = await sessionOf(w, IMPL);
      crashOnce(w.repositories.escalations, 'upsert', (e) => (e as { id: string }).id.startsWith('wf-report:'));
      await expect(w.engine.reportToRoot({ content: 'Progress: half done', needsUserConfirmation: true }, { caller: impl, sourceCallRef: 'call-p' })).rejects.toThrow('crash');
      expect(received(w, ROOT).at(-1)).not.toBe('Progress: half done');
      w.emitTurn(ROOT, 'root-turn', 'running');
      w.emitTurn(ROOT, 'root-turn', 'completed');
      await settle();
      expect(received(w, ROOT).at(-1)).toBe('Progress: half done');
    });
  });

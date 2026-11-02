// T046 (F-1, F-2, G-1): a runtime stores nothing of a session before its first payload (Claude writes the transcript
// with the first message, Codex the rollout with the first turn), so such a session cannot be resumed. Each of the
// card's three ways back to a closed session — a normal exit and start, the idle supervisor's close, a crash at the
// dispatch fault point — is run with both of its paths:
//   - nothing was handed over for certain (no attempt ever crossed the dispatch boundary, or only attempts the user
//     chose to send again): Claude opens it again under its own session ID and nothing is lost; Codex cannot (its
//     thread ID is the runtime's, C-08), so the session shows `error` and the sender is told why;
//   - it cannot be told (an attempt still undecided, or one the user cancelled): nothing is opened again and nothing is
//     sent again; the unknown message has its escalation (G-1) and the session shows `error`.
// The runtimes' disk (`RuntimeDisk`) is kept across restarts, as the real one is; the same cases run on memory storage
// and on the real SQLite repositories (t046-memory.test.ts, t046-sqlite.test.ts).
import { describe, expect, it } from 'vitest';
import type { Escalation, Runtime, SessionId } from '../../contracts';
import { RuntimeDisk } from '../../core/sessions/testing/fake-adapter';
import { CWD as SUP_CWD } from '../../core/sessions/testing/harness';
import {
  activityOf,
  adapterOf,
  adaptersOf,
  created,
  exchange,
  gate,
  IDLE_MS,
  idleFor,
  isOpen,
  resumedOf,
  rid as supRid,
  send,
  settle as supSettle,
  textsOf,
  type HoldingAdapter,
  type SupWorld,
  type SupWorldOptions,
} from '../../core/supervisor/testing/harness';
import { dispatches, handoff, IMPL, INSTANCE, rid, ROOT, sessionOf, settle, started, template, type World } from '../../core/workflow/testing/harness';
import type { WorkflowTemplate } from '../../contracts';

export type MakeSup = (o?: SupWorldOptions) => Promise<SupWorld>;
export type MakeFlow = (workflow?: WorkflowTemplate) => Promise<World>;

const RUNTIMES: readonly Runtime[] = ['claude', 'codex'];

const openEscalations = async (w: { repositories: SupWorld['repositories'] }, kind?: Escalation['kind']) =>
  (await w.repositories.escalations.list({ state: 'open' })).filter((e) => kind === undefined || e.kind === kind);

/** A world whose runtimes resume only what they stored. */
const withDisk = async (make: MakeSup): Promise<SupWorld> => {
  const w = await make();
  w.disk = new RuntimeDisk();
  return w;
};

/** A crash: a new service and supervisor on the same storage and disk, recovered; the old one is never shut down. */
const crash = async (w: SupWorld): Promise<SupWorld> => {
  const r = w.restart();
  await r.service.start();
  await supSettle();
  return r;
};

/** A normal exit (R-14), then a start on the same storage and disk. */
const exitAndStart = async (w: SupWorld): Promise<SupWorld> => {
  await w.service.shutdown();
  return crash(w);
};

/** Every session start of the session across its adapters (the provision, and an opening again). */
const startsOf = (w: SupWorld, runtime: Runtime, sessionId: SessionId) => adaptersOf(w, runtime, sessionId).flatMap((a) => a.started);

/** The adapter's next dispatches wait for the returned gate before the runtime gets them (the dispatch fault point). */
const holdDispatch = (adapter: HoldingAdapter) => {
  const late = gate();
  const dispatch = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = async (request) => {
    await late.promise;
    return dispatch(request);
  };
  return late;
};

/** The native session the session was created as (Claude: the ID chosen before the create call). */
const nativeOf = async (w: SupWorld, sessionId: SessionId) => (await w.store.get(`provision:${sessionId}` as never))?.target.nativeSessionRef;

/** After a resume that found nothing stored: Claude opened it again under its own ID, Codex shows `error`. */
const expectOpenedAgainOrError = async (r: SupWorld, runtime: Runtime, a: SessionId, ref: string | undefined, result: Awaited<ReturnType<typeof send>>, text: string) => {
  expect(resumedOf(r, runtime, a).length).toBeGreaterThanOrEqual(1);
  if (runtime === 'claude') {
    expect(result).toMatchObject({ ok: true });
    // The same session ID (`sessionId`, not `resume`), once.
    expect(startsOf(r, runtime, a).map((s) => s.preallocatedRef)).toEqual([ref]);
    expect(textsOf(r, runtime, a)).toEqual([text]);
    expect(isOpen(r, a)).toBe(true);
    expect(r.logs).toContain(`[sessions] ${a} had nothing stored and nothing was handed to it unasked: opened again under its own ID (nothing)`);
    return;
  }
  // Codex picks its thread IDs itself: the thread cannot be made again under the same ID, so nothing is opened.
  expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
  expect(result.ok ? '' : result.message).toMatch(/cannot confirm that nothing of it is stored/);
  expect(startsOf(r, runtime, a)).toEqual([]);
  expect(textsOf(r, runtime, a)).toEqual([]);
  expect(await activityOf(r, a)).toBe('error');
  expect(r.logs).toContain(`[sessions] ${a} cannot be resumed and is not opened again`);
};

/** After a resume that found nothing stored, with an attempt to it undecided: nothing opened, nothing sent. */
const expectNotOpened = async (r: SupWorld, runtime: Runtime, a: SessionId, result: Awaited<ReturnType<typeof send>>) => {
  expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
  expect(result.ok ? '' : result.message).toMatch(/An earlier message may have reached this session/);
  expect(startsOf(r, runtime, a)).toEqual([]);
  expect(textsOf(r, runtime, a)).toEqual([]);
  expect(isOpen(r, a)).toBe(false);
  expect(await activityOf(r, a)).toBe('error');
};

/** The unknown user message has its escalation (G-1): at the session itself, pointing at the message. */
const messageEscalation = async (r: SupWorld, a: SessionId) => {
  const [e] = await openEscalations(r, 'delivery-unknown');
  expect(e).toMatchObject({ rootSessionId: a, fromSessionId: a, ref: { kind: 'message' } });
  const [record] = (await r.store.listByState('unknown')).filter((x) => x.kind === 'user-message');
  expect(e!.ref).toEqual({ kind: 'message', operationId: record!.operationId, messageId: record!.operationId.slice('user-message:'.length) });
  return e!;
};

/** The user retries the unknown message; Claude opens the session again and sends it once more, Codex cannot. */
const retryAfter = async (r: SupWorld, runtime: Runtime, a: SessionId, ref: string | undefined, escalation: Escalation, text: string) => {
  const result = await r.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true });
  await supSettle();
  const [record] = (await r.store.listByTarget(a)).filter((x) => x.kind === 'user-message' && x.payload === text);
  if (runtime === 'claude') {
    expect(result).toMatchObject({ ok: true });
    expect(startsOf(r, runtime, a).map((s) => s.preallocatedRef)).toEqual([ref]);
    expect(textsOf(r, runtime, a)).toEqual([text]);
    expect(record!.delivery).toMatchObject({ state: 'sent' });
    expect(record!.delivery.attempts).toHaveLength(2);
    expect(await activityOf(r, a)).toBe('idle');
    // Opened again on the user's retry: every crossing to it is one the user chose to send again.
    expect(r.logs).toContain(`[sessions] ${a} had nothing stored and nothing was handed to it unasked: opened again under its own ID (retried)`);
    return;
  }
  // F-2: said plainly, never left waiting unseen.
  expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
  expect(result.ok ? '' : result.message).toMatch(/^The retry is saved, but it cannot be sent: /);
  expect(record!.delivery.state).toBe('pending');
  expect(record!.delivery.attempts).toHaveLength(1);
  expect(textsOf(r, runtime, a)).toEqual([]);
  expect(await activityOf(r, a)).toBe('error');
};

export const noHistoryCases = (name: string, makeSup: MakeSup, makeFlow: MakeFlow) => {
  describe(`T046 a session its runtime stored nothing of (${name})`, () => {
    for (const runtime of RUNTIMES) {
      it(`${runtime} normal exit, nothing handed over: the first message after the start ${runtime === 'claude' ? 'opens it again under its own ID' : 'is refused plainly and the session shows error'}`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        const ref = await nativeOf(w, a);
        expect(w.disk!.stored.size).toBe(0);
        const r = await exitAndStart(w);
        const result = await send(r, a, 'first');
        await supSettle();
        await expectOpenedAgainOrError(r, runtime, a, ref, result, 'first');
      });

      it(`${runtime} normal exit, a message unknown: nothing is opened or sent again; its escalation decides, and a retry ${runtime === 'claude' ? 'opens it again and sends once' : 'is refused plainly'}`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        const ref = await nativeOf(w, a);
        // No ack and nothing stored: unknown, escalated.
        adapterOf(w, runtime, a).dispatchModes.push('lost');
        expect(await send(w, a, 'lost one')).toMatchObject({ ok: false, code: 'unknown_outcome' });
        await supSettle();
        await messageEscalation(w, a);
        expect(await activityOf(w, a)).toBe('reconciling');
        const r = await exitAndStart(w);
        const escalation = await messageEscalation(r, a);
        const result = await send(r, a, 'next');
        await supSettle();
        await expectNotOpened(r, runtime, a, result);
        await retryAfter(r, runtime, a, ref, escalation, 'lost one');
      });

      it(`${runtime} idle close, nothing handed over: the next message ${runtime === 'claude' ? 'opens it again under its own ID' : 'is refused plainly and the session shows error'}`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        const ref = await nativeOf(w, a);
        await idleFor(w, IDLE_MS);
        expect(isOpen(w, a)).toBe(false);
        expect(await activityOf(w, a)).toBe('closed');
        const resumedBefore = resumedOf(w, runtime, a).length;
        const startsBefore = startsOf(w, runtime, a).length;
        const result = await send(w, a, 'after the close');
        await supSettle();
        expect(resumedOf(w, runtime, a).length).toBe(resumedBefore + 1);
        if (runtime === 'claude') {
          expect(result).toMatchObject({ ok: true });
          expect(startsOf(w, runtime, a).slice(startsBefore).map((s) => s.preallocatedRef)).toEqual([ref]);
          expect(textsOf(w, runtime, a)).toEqual(['after the close']);
          expect(isOpen(w, a)).toBe(true);
        } else {
          expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
          expect(startsOf(w, runtime, a)).toHaveLength(startsBefore);
          expect(textsOf(w, runtime, a)).toEqual([]);
          expect(await activityOf(w, a)).toBe('error');
        }
      });

      it(`${runtime} idle close after the user cancelled an unknown message: it cannot be told, so nothing is opened or sent again`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        adapterOf(w, runtime, a).dispatchModes.push('lost');
        await send(w, a, 'lost one');
        await supSettle();
        const escalation = await messageEscalation(w, a);
        expect(await w.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: escalation.id, decision: 'cancel', acceptDuplicateRisk: false })).toMatchObject({ ok: true });
        await supSettle();
        // Decided: the session no longer shows it is reconciling, so the supervisor can close it.
        expect(await activityOf(w, a)).toBe('idle');
        await idleFor(w, IDLE_MS);
        expect(isOpen(w, a)).toBe(false);
        const startsBefore = startsOf(w, runtime, a).length;
        const textsBefore = textsOf(w, runtime, a).length;
        const result = await send(w, a, 'next');
        await supSettle();
        expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
        expect(startsOf(w, runtime, a)).toHaveLength(startsBefore);
        expect(textsOf(w, runtime, a)).toHaveLength(textsBefore);
        expect(isOpen(w, a)).toBe(false);
        expect(await activityOf(w, a)).toBe('error');
      });

      it(`${runtime} crash, nothing handed over: the first message after the restart ${runtime === 'claude' ? 'opens it again under its own ID' : 'is refused plainly and the session shows error'}`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        const ref = await nativeOf(w, a);
        const r = await crash(w);
        expect(await openEscalations(r)).toEqual([]);
        const result = await send(r, a, 'first');
        await supSettle();
        await expectOpenedAgainOrError(r, runtime, a, ref, result, 'first');
      });

      it(`${runtime} crash at the dispatch fault point (unknown committed, the runtime never got it): reconciled only and escalated (G-1); nothing opened or sent again; a retry ${runtime === 'claude' ? 'opens it again and sends once' : 'is refused plainly'}`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, runtime);
        const ref = await nativeOf(w, a);
        holdDispatch(adapterOf(w, runtime, a));
        void send(w, a, 'the work');
        await supSettle();
        expect((await w.store.listByState('unknown')).filter((x) => x.kind === 'user-message')).toHaveLength(1);
        const r = await crash(w);
        // Only reconciled, never resumed or sent for it; the user decides.
        expect(resumedOf(r, runtime, a)).toEqual([]);
        expect(textsOf(r, runtime, a)).toEqual([]);
        const escalation = await messageEscalation(r, a);
        expect(escalation.title).toBe('Message delivery outcome unknown');
        expect(await activityOf(r, a)).toBe('reconciling');
        const result = await send(r, a, 'next');
        await supSettle();
        await expectNotOpened(r, runtime, a, result);
        // The escalation is still the user's to answer.
        expect((await openEscalations(r, 'delivery-unknown')).map((e) => e.id)).toEqual([escalation.id]);
        await retryAfter(r, runtime, a, ref, escalation, 'the work');
        // The refused message was told not sent: no later start sends it unseen, even once the session can resume.
        const [refused] = (await r.store.listByTarget(a)).filter((x) => x.kind === 'user-message' && x.payload === 'next');
        expect(refused!.outcome).toMatchObject({ kind: 'cancelled' });
        // The same message sent again under its own ID is told it will not go (r2 P2), not "saved, try again".
        const messageId = refused!.operationId.slice('user-message:'.length);
        const resent = await r.run({ type: 'session.send', requestId: supRid(), sessionId: a, messageId: messageId as never, expectedRevision: (await r.repositories.sessions.get(a))!.revision, text: 'next', attachments: [] });
        expect(resent).toMatchObject({ ok: false, code: 'invalid_transition', retryable: false });
        expect(resent.ok ? '' : resent.message).toMatch(/^This message was not sent and will not be: /);
        expect(textsOf(r, runtime, a).filter((t) => t === 'next')).toEqual([]);
        const again = await crash(r);
        expect(textsOf(again, runtime, a)).toEqual([]);
        expect((await again.store.get(refused!.operationId))!.delivery).toMatchObject({ state: 'pending', attempts: [] });
      });
    }

    it('r1 P1-3: a message the user cancelled does not leave the session reconciling after a restart', async () => {
      const w = await withDisk(makeSup);
      const a = await created(w, 'claude');
      adapterOf(w, 'claude', a).dispatchModes.push('lost');
      await send(w, a, 'lost one');
      await supSettle();
      const escalation = await messageEscalation(w, a);
      expect(await w.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: escalation.id, decision: 'cancel', acceptDuplicateRisk: false })).toMatchObject({ ok: true });
      await supSettle();
      expect(await activityOf(w, a)).toBe('idle');
      // The restart reconciles the cancelled attempt again: still not found, and still decided.
      const r = await crash(w);
      expect(await openEscalations(r)).toEqual([]);
      expect(await activityOf(r, a)).toBe('closed');
      expect((await r.service.idleFacts(a))?.activity).not.toBe('reconciling');
    });

    for (const how of ['the runtime cannot be asked', 'the opening again fails'] as const) {
      it(`r1 P1-2: claude, a retry whose session could not be opened now (${how}) is said plainly, stays saved, and goes once at the next start`, async () => {
        const w = await withDisk(makeSup);
        const a = await created(w, 'claude');
        const ref = await nativeOf(w, a);
        holdDispatch(adapterOf(w, 'claude', a));
        void send(w, a, 'the work');
        await supSettle();
        const r = await crash(w);
        const escalation = await messageEscalation(r, a);
        if (how === 'the runtime cannot be asked') r.claude.reconcileProvision = () => Promise.reject(new Error('claude is not usable now'));
        else r.claude.startModes.push('fail');
        const result = await r.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true });
        await supSettle();
        expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
        expect(result.ok ? '' : result.message).toMatch(/^The retry is saved, but its session could not be resumed now\. It is tried again when the app starts next/);
        const [record] = (await r.store.listByTarget(a)).filter((x) => x.kind === 'user-message');
        expect(record!.delivery).toMatchObject({ state: 'pending' });
        expect(record!.delivery.attempts).toHaveLength(1);
        expect(textsOf(r, 'claude', a)).toEqual([]);
        // The next start sends what the user chose to retry, once, in the session opened again under its own ID.
        const next = await crash(r);
        expect(startsOf(next, 'claude', a).map((s) => s.preallocatedRef)).toEqual([ref]);
        expect(textsOf(next, 'claude', a)).toEqual(['the work']);
        expect((await next.store.get(record!.operationId))!.delivery).toMatchObject({ state: 'sent' });
      });
    }

    /**
     * r3 P1: two deliveries to one session at once. The first one's resume is refused and its session's `error` is being
     * written (held here) when the second begins; the first must still be told its own reason, whatever the second does.
     */
    const holdErrorWrite = (r: SupWorld) => {
      const held = gate();
      const sessions = r.repositories.sessions as unknown as { update: (record: { activity: string }, revision: number) => Promise<unknown> };
      const update = sessions.update.bind(sessions);
      let armed = true;
      sessions.update = async (record, revision) => {
        if (armed && record.activity === 'error') {
          armed = false;
          await held.promise;
        }
        return update(record, revision);
      };
      return held;
    };
    const twoUnknown = async () => {
      const w = await withDisk(makeSup);
      const a = await created(w, 'claude');
      adapterOf(w, 'claude', a).dispatchModes.push('lost', 'lost');
      await send(w, a, 'first');
      await send(w, a, 'second');
      await supSettle();
      const r = await crash(w);
      const open = await openEscalations(r, 'delivery-unknown');
      const of = async (text: string) => {
        const [record] = (await r.store.listByTarget(a)).filter((x) => x.kind === 'user-message' && x.payload === text);
        return { record: record!, escalation: open.find((e) => e.ref?.kind === 'message' && e.ref.operationId === record!.operationId)! };
      };
      return { r, a, first: await of('first'), second: await of('second') };
    };

    it("r3 P1: two retries at once: the first, refused while the second is undecided, is told its own reason, not ok", async () => {
      const { r, a, first, second } = await twoUnknown();
      const held = holdErrorWrite(r);
      const retry = (id: Escalation['id']) => r.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: id, decision: 'retry', acceptDuplicateRisk: true });
      const one = retry(first.escalation.id);
      await supSettle();
      const two = retry(second.escalation.id);
      await supSettle();
      held.open();
      const [r1, r2] = await Promise.all([one, two]);
      await supSettle();
      expect(r1).toMatchObject({ ok: false, code: 'runtime_unavailable' });
      expect(r1.ok ? '' : r1.message).toMatch(/^The retry is saved, but it cannot be sent: An earlier message may have reached this session/);
      // The second goes once: by then every attempt to the session is one the user retried.
      expect(r2).toMatchObject({ ok: true });
      expect(textsOf(r, 'claude', a)).toEqual(['second']);
      expect((await r.store.get(first.record.operationId))!.delivery).toMatchObject({ state: 'pending', attempts: [{ resolution: { decision: 'retry' } }] });
    });

    it('r3 P1: a send and a retry at once: the refused send is told why and never sent later; the retry goes once', async () => {
      const { r, a, first } = await twoUnknown();
      const held = holdErrorWrite(r);
      const sent = send(r, a, 'third');
      await supSettle();
      const retried = r.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: first.escalation.id, decision: 'retry', acceptDuplicateRisk: true });
      await supSettle();
      held.open();
      const [s, t] = await Promise.all([sent, retried]);
      await supSettle();
      expect(s).toMatchObject({ ok: false, code: 'invalid_transition' });
      expect(s.ok ? '' : s.message).toMatch(/^An earlier message may have reached this session/);
      const [third] = (await r.store.listByTarget(a)).filter((x) => x.kind === 'user-message' && x.payload === 'third');
      expect(third!.outcome).toMatchObject({ kind: 'cancelled' });
      expect(t).toMatchObject({ ok: false, code: 'runtime_unavailable' });
      expect(textsOf(r, 'claude', a)).toEqual([]);
      // Nothing of the refused send goes at a later start either.
      const next = await crash(r);
      expect(textsOf(next, 'claude', a)).not.toContain('third');
    });

    it('r3 P2: a message the user cancelled, sent again under its own ID, is told it will not go; the session does not wait on it', async () => {
      const w = await withDisk(makeSup);
      const a = await created(w, 'claude');
      adapterOf(w, 'claude', a).dispatchModes.push('lost');
      await send(w, a, 'lost one');
      await supSettle();
      const escalation = await messageEscalation(w, a);
      expect(await w.run({ type: 'delivery.resolve', requestId: supRid(), escalationId: escalation.id, decision: 'cancel', acceptDuplicateRisk: false })).toMatchObject({ ok: true });
      await supSettle();
      const [record] = (await w.store.listByTarget(a)).filter((x) => x.kind === 'user-message');
      const textsBefore = textsOf(w, 'claude', a).length;
      const again = await w.run({
        type: 'session.send',
        requestId: supRid(),
        sessionId: a,
        messageId: record!.operationId.slice('user-message:'.length) as never,
        expectedRevision: (await w.repositories.sessions.get(a))!.revision,
        text: 'lost one',
        attachments: [],
      });
      expect(again).toMatchObject({ ok: false, code: 'invalid_transition', retryable: false });
      expect(again.ok ? '' : again.message).toBe('This message was cancelled and will not be sent');
      expect(await activityOf(w, a)).toBe('idle');
      expect(await openEscalations(w)).toEqual([]);
      expect(textsOf(w, 'claude', a)).toHaveLength(textsBefore);
    });

    it('claude: a session that had a message sent is never opened again, even when its transcript cannot be found', async () => {
      const w = await withDisk(makeSup);
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a, 'before');
      const ref = await nativeOf(w, a);
      // The transcript is not found any more (moved, unreadable): not finding it is no proof (CR-2).
      w.disk!.stored.delete(ref!);
      const r = await crash(w);
      const result = await send(r, a, 'after');
      await supSettle();
      expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable', retryable: true });
      expect(startsOf(r, 'claude', a)).toEqual([]);
      expect(textsOf(r, 'claude', a)).toEqual([]);
      expect(r.logs).toContain(`[sessions] resuming ${a} failed (claude)`);
    });

    it('claude: nothing handed over, but the runtime has the session stored: a resume that failed otherwise is not answered by opening it again', async () => {
      const w = await withDisk(makeSup);
      const a = await created(w, 'claude');
      const ref = await nativeOf(w, a);
      w.disk!.stored.add(ref!);
      const r = await crash(w);
      r.claude.onResume = () => {
        throw new Error('claude.exe did not start');
      };
      const result = await send(r, a, 'first');
      await supSettle();
      expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable', retryable: true });
      expect(r.claude.provisionLookups).toEqual([{ cwd: SUP_CWD, preallocatedRef: ref }]);
      expect(startsOf(r, 'claude', a)).toEqual([]);
      expect(textsOf(r, 'claude', a)).toEqual([]);
    });
  });

  describe(`T046 F-2: a handoff the user retried to a session its runtime stored nothing of (${name})`, () => {
    for (const runtime of RUNTIMES) {
      it(`${runtime} Implement: the restart only reconciles; the user's retry ${runtime === 'claude' ? 'opens it again under its own ID and sends it once (attempt 2)' : 'is refused plainly, the session shows error, and nothing waits unseen'}`, async () => {
        const w = await makeFlow(template({}, { impl: { model: runtime === 'claude' ? { runtime: 'claude', model: 'haiku' } : { runtime: 'codex', model: 'gpt-6-luna' } } }));
        w.disk = new RuntimeDisk();
        expect(await started(w)).toMatchObject({ ok: true });
        const late = gate();
        w.dispatchGate = (request) => (request.text.includes('build the page') ? late.promise : undefined);
        void handoff(w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'build the page' });
        await settle();
        const impl = await sessionOf(w, IMPL);
        const ref = (await w.store.get(`provision:${impl}` as never))?.target.nativeSessionRef;
        expect(ref).toBeDefined();
        expect(w.disk.stored.has(ref!)).toBe(false);

        const r = await w.restart();
        await settle();
        const [unknown] = await openEscalations(r, 'delivery-unknown');
        expect(unknown?.ref).toMatchObject({ kind: 'handoff' });
        const result = await r.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'retry', acceptDuplicateRisk: true });
        await settle();
        const [record] = (await r.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === IMPL);
        const sentToImpl = dispatches(r).filter((d) => d.text.includes('build the page'));
        if (runtime === 'claude') {
          expect(result).toMatchObject({ ok: true });
          expect(r.claude.started.filter((s) => s.sessionId === impl).map((s) => s.preallocatedRef)).toEqual([ref]);
          expect(sentToImpl).toHaveLength(1);
          expect(record!.delivery).toMatchObject({ state: 'sent' });
          expect(record!.delivery.attempts).toHaveLength(2);
        } else {
          expect(result).toMatchObject({ ok: false, code: 'runtime_unavailable' });
          expect(result.ok ? '' : result.message).toMatch(/^The retry is saved, but it cannot be sent: /);
          expect(r.codex.get(impl)?.started ?? []).toEqual([]);
          expect(sentToImpl).toEqual([]);
          expect(record!.delivery.state).toBe('pending');
          expect(record!.delivery.attempts).toHaveLength(1);
          expect((await r.repositories.sessions.get(impl))?.activity).toBe('error');
          expect(r.logs).toContain(`[sessions] resuming ${impl} failed (codex)`);
          expect(r.logs).toContain(`[sessions] ${impl} cannot be resumed and is not opened again`);
        }
        late.open();
        await settle();
      });
    }
  });
};

// T023 acceptance in core: fake adapters and memory ports (the proposals projected from the delivery store).
import { describe, expect, it } from 'vitest';
import { MessageId, SessionId, TransferId } from '../../../contracts';
import { NOTE_REQUEST } from '../frame';
import { noteOperationOf, payloadOperationOf, targetSessionOf } from '../ids';
import { CLAUDE, CODEX, cancel, confirm, dispatches, prepare, proposal, rid, settle, source, starts, work, type World } from './harness';

const T = TransferId.parse('tr-1');
const target = targetSessionOf(T);

/** What reached the target tool's runtime: sessions created and payloads delivered. */
const toTarget = (w: World) => ({
  created: starts(w).filter((s) => s.sessionId === target).length,
  delivered: dispatches(w).filter((d) => w.refs.get(d.nativeSessionRef) === target),
});

const ready = async (w: World, sourceId: SessionId) => {
  const prepared = await prepare(w, sourceId, T);
  expect(prepared).toMatchObject({ ok: true, created: [{ kind: 'transfer', id: T }] });
  const p = await proposal(w, T);
  expect(p.state).toBe('awaiting-confirmation');
  return p;
};

export const commandCases = (backend: string, make: () => Promise<World>) =>
  describe(`T023 transfer commands (${backend})`, () => {
    describe('transfer.prepare', () => {
      it('builds the fixed frame from the source history at its turn boundary, calling no model and touching no target', async () => {
        const w = await make();
        const s = await source(w);
        const before = dispatches(w).length;
        const p = await ready(w, s);
        expect(p.content.noteSource).toBe('gui-digest');
        expect(p.content.goal).toBe('Implement add() and subtract() in calc.js.');
        expect(p.content.note).toContain('User: Implement add()');
        expect(p.content.note).toContain('$ node test.js → exit 1');
        expect(p.content.note).toContain('Changed: calc.js (update)');
        expect(p.content.note).toContain('Agent: add() is done');
        expect(p.content.diff).toContain('+export const add = (a, b) => a + b;');
        expect(p.content.testOutput).toContain('subtract: FAIL');
        expect(p.target).toEqual(CODEX);
        // No model call for the digest; nothing of the target exists (CR-5).
        expect(dispatches(w)).toHaveLength(before);
        expect(toTarget(w)).toEqual({ created: 0, delivered: [] });
        expect(w.codex.size).toBe(0);
        expect(await w.repositories.sessions.get(target)).toBeUndefined();
        expect(await w.store.get(payloadOperationOf(T))).toBeUndefined();
        expect(p.provision).toBeUndefined();
      });

      it('waits as a draft while the source turn runs, and finishes when that turn ends', async () => {
        const w = await make();
        const s = await source(w);
        const turn = await work(w, s, { keepRunning: true });
        expect(await prepare(w, s, T)).toMatchObject({ ok: true });
        expect((await proposal(w, T)).state).toBe('draft');
        w.emitTurn(s, turn, 'completed');
        await settle();
        expect((await proposal(w, T)).state).toBe('awaiting-confirmation');
      });

      it("asks the source agent for its note through the delivery service, and takes the reply of that turn", async () => {
        const w = await make();
        const s = await source(w);
        w.notes.set(s, 'Goal: calc. Done: add. Not done: subtract.');
        expect(await prepare(w, s, T, { noteSource: 'agent' })).toMatchObject({ ok: true });
        const request = await w.store.get(noteOperationOf(T));
        expect(request).toMatchObject({ kind: 'transfer', delivery: { state: 'sent' }, context: { origin: { kind: 'transfer', fromSessionId: s, transferId: T } } });
        expect(dispatches(w).at(-1)).toMatchObject({ text: NOTE_REQUEST, origin: { kind: 'transfer', fromSessionId: s, transferId: T } });
        const p = await proposal(w, T);
        expect(p.state).toBe('awaiting-confirmation');
        expect(p.content).toMatchObject({ noteSource: 'agent', note: 'Goal: calc. Done: add. Not done: subtract.' });
        expect(toTarget(w).created).toBe(0);
      });

      it('refuses another tool that is the same, a workflow-less unknown source, and a second proposal under way', async () => {
        const w = await make();
        const s = await source(w);
        expect(await prepare(w, s, T, { target: { ...CLAUDE, model: 'sonnet' } })).toMatchObject({ ok: false, code: 'invalid_request' });
        expect(await prepare(w, SessionId.parse('nobody'), T)).toMatchObject({ ok: false, code: 'not_found' });
        await ready(w, s);
        expect(await prepare(w, s, TransferId.parse('tr-2'))).toMatchObject({ ok: false, code: 'invalid_transition' });
        // The same request again is the same proposal; a different one under its ID is not.
        expect(await prepare(w, s, T)).toMatchObject({ ok: true });
        expect(await prepare(w, s, T, { noteSource: 'agent' })).toMatchObject({ ok: false, code: 'already_exists' });
      });
    });

    describe('transfer.confirm', () => {
      it('creates the new session derived from the source, then delivers the frame once', async () => {
        const w = await make();
        const s = await source(w);
        const p = await ready(w, s);
        const result = await confirm(w, T);
        expect(result).toMatchObject({ ok: true, created: [{ kind: 'session', id: target }] });
        const created = await w.repositories.sessions.get(target);
        expect(created).toMatchObject({ kind: 'ordinary', derivedFromSessionId: s, requestedModel: CODEX, cwd: (await w.repositories.sessions.get(s))!.cwd });
        const after = await proposal(w, T);
        expect(after).toMatchObject({ state: 'approved', approvedRevision: p.revision + 1, createdSessionId: target, provision: { state: 'sent' }, delivery: { state: 'sent' } });
        const { created: made, delivered } = toTarget(w);
        expect(made).toBe(1);
        expect(delivered).toHaveLength(1);
        expect(delivered[0]!.origin).toEqual({ kind: 'transfer', fromSessionId: s, transferId: T });
        // The runtime's echo is stored in the new session as a message from the transfer, not from the user (G-1).
        const shown = (await w.repositories.conversations.get(target)).messages.filter((m) => m.role === 'user');
        expect(shown).toMatchObject([{ role: 'user', origin: { kind: 'transfer', fromSessionId: s, transferId: T }, text: delivered[0]!.text }]);
        expect(delivered[0]!.text).toContain('## Goal\n```text\nImplement add() and subtract() in calc.js.\n```');
        expect(delivered[0]!.text).toContain(`claude session (${s})`);
        // The same confirmation again does nothing twice.
        expect(await confirm(w, T, p.revision)).toMatchObject({ ok: true });
        expect(toTarget(w).created).toBe(1);
        expect(toTarget(w).delivered).toHaveLength(1);
        expect(w.logs).toEqual([]);
        // Every step was pushed: the renderer's last view of the proposal is the stored one.
        const pushed = w.events.filter((e) => e.type === 'transfer.updated').at(-1);
        expect(pushed).toMatchObject({ proposal: await proposal(w, T) });
      });

      it('a source that changed makes the proposal stale; nothing is created', async () => {
        const w = await make();
        const s = await source(w);
        const p = await ready(w, s);
        await work(w, s, { reply: 'one more thing' });
        expect((await proposal(w, T)).state).toBe('stale');
        expect(await confirm(w, T, p.revision)).toMatchObject({ ok: false, code: 'stale_revision' });
        expect(toTarget(w)).toEqual({ created: 0, delivered: [] });
        expect(await w.repositories.sessions.get(target)).toBeUndefined();
      });
    });

    describe('a chain of transfers', () => {
      it('the session a transfer created is transferred back with that goal, its frame named and not repeated', async () => {
        const w = await make();
        const s = await source(w);
        await ready(w, s);
        expect(await confirm(w, T)).toMatchObject({ ok: true });
        // The user asks the new session for one more step first (as in the live run): the goal stays the transfer's.
        const next = await w.repositories.sessions.get(target);
        expect(
          await w.run({ type: 'session.send', requestId: rid(), sessionId: target, messageId: MessageId.parse('m-step'), expectedRevision: next!.revision, text: 'Now do subtract() only.', attachments: [] }),
        ).toMatchObject({ ok: true });
        const back = TransferId.parse('tr-back');
        expect(await prepare(w, target, back, { target: CLAUDE })).toMatchObject({ ok: true });
        const p = await proposal(w, back);
        expect(p).toMatchObject({ state: 'awaiting-confirmation', sourceSessionId: target, content: { goal: 'Implement add() and subtract() in calc.js.' } });
        expect(p.content.note).toContain(`(Work transferred in from session ${s}, transfer ${T})`);
        expect(p.content.note).not.toContain('## Goal');
        expect(p.content.note).toContain('User: Now do subtract() only.');
        expect(await confirm(w, back)).toMatchObject({ ok: true });
        expect((await w.repositories.sessions.get(targetSessionOf(back)))?.derivedFromSessionId).toBe(target);
      });
    });

    describe('transfer.cancel', () => {
      it('before the confirmation: nothing is ever created or sent', async () => {
        const w = await make();
        const s = await source(w);
        const p = await ready(w, s);
        expect(await cancel(w, T)).toMatchObject({ ok: true });
        expect((await proposal(w, T)).state).toBe('cancelled');
        expect(await confirm(w, T, p.revision)).toMatchObject({ ok: false });
        const after = await w.restart();
        expect(toTarget(after)).toEqual({ created: 0, delivered: [] });
      });
    });
  });

// T023 in core: outcomes that stay unknown (CR-2), cancels in every state, failures, restarts between any two
// steps, and the MCP token. Fake adapters and memory ports.
import { describe, expect, it } from 'vitest';
import { EscalationId, MessageId, TransferId, TurnId } from '../../../contracts';
import type { RuntimeAdapter } from '../../ports';
import { noteOperationOf, payloadOperationOf, targetSessionOf } from '../ids';
import { cancel, confirm, dispatches, prepare, proposal, rid, settle, source, starts, work, type World } from './harness';

const T = TransferId.parse('tr-1');
const target = targetSessionOf(T);
const payloadOp = payloadOperationOf(T);
const provisionOp = `provision:${target}`;

const created = (worlds: World[]) => worlds.flatMap(starts).filter((s) => s.sessionId === target).length;
const delivered = (worlds: World[]) => worlds.flatMap((w) => dispatches(w).filter((d) => w.refs.get(d.nativeSessionRef) === target));

/** The process dies inside the first matching call: it never returns and applies nothing. */
const die = <T extends object>(object: T, method: keyof T, when: (...args: never[]) => boolean = () => true) => {
  const original = (object[method] as (...args: unknown[]) => unknown).bind(object);
  let armed = true;
  (object as Record<keyof T, unknown>)[method] = (...args: never[]) => {
    if (armed && when(...args)) {
      armed = false;
      return new Promise(() => undefined);
    }
    return original(...args);
  };
};

const ready = async (w: World) => {
  const s = await source(w);
  expect(await prepare(w, s, T)).toMatchObject({ ok: true });
  expect((await proposal(w, T)).state).toBe('awaiting-confirmation');
  return s;
};

const openEscalations = async (w: World) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');

const resolve = async (w: World, escalationId: EscalationId, decision: 'wait' | 'cancel' | 'retry') =>
  w.run({ type: 'delivery.resolve', requestId: rid(), escalationId, decision, acceptDuplicateRisk: decision === 'retry' });

export const lifecycleCases = (backend: string, make: () => Promise<World>) =>
  describe(`T023 transfer lifecycle (${backend})`, () => {
    describe('an outcome that stays unknown (CR-2)', () => {
      it('a lost create response is not created again: escalated at the source, and only the user retries it', async () => {
        const w = await make();
        const s = await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) adapter.startModes = ['lost'];
        };
        expect(await confirm(w, T)).toMatchObject({ ok: false, code: 'unknown_outcome', mayHaveSideEffects: true });
        const [escalation] = await openEscalations(w);
        expect(escalation).toMatchObject({ rootSessionId: s, fromSessionId: target, ref: { kind: 'provision', operationId: provisionOp, blocked: [payloadOp] } });
        expect(await proposal(w, T)).toMatchObject({ state: 'approved', provision: { state: 'unknown' }, delivery: { state: 'pending' } });
        // A restart only reconciles; a resent confirmation does not create it either.
        w.configure = () => undefined;
        const after = await w.restart();
        expect(await confirm(after, T, (await proposal(after, T)).revision - 1)).toMatchObject({ ok: false, code: 'unknown_outcome' });
        expect(created([w, after])).toBe(1);
        expect(delivered([w, after])).toHaveLength(0);
        // The user decides to retry (accepting a possible duplicate): created, then the content goes once.
        expect(await resolve(after, escalation!.id, 'retry')).toMatchObject({ ok: true });
        await settle();
        expect(created([w, after])).toBe(2);
        expect(delivered([w, after])).toHaveLength(1);
        expect(await proposal(after, T)).toMatchObject({ state: 'approved', createdSessionId: target, delivery: { state: 'sent' } });
      });

      it("the user cancelling a creation whose outcome is unknown fails the transfer; nothing is sent, the work stays in the source", async () => {
        const w = await make();
        const s = await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) adapter.startModes = ['lost'];
        };
        await confirm(w, T);
        const [escalation] = await openEscalations(w);
        expect(await resolve(w, escalation!.id, 'cancel')).toMatchObject({ ok: true });
        await settle();
        expect(await proposal(w, T)).toMatchObject({ state: 'failed', failure: { message: expect.stringContaining('cancelled') as unknown } });
        expect((await w.store.get(payloadOp))?.outcome?.kind).toBe('failed');
        const after = await w.restart();
        expect(delivered([w, after])).toHaveLength(0);
        // The source is untouched and can be transferred again.
        expect(await prepare(after, s, TransferId.parse('tr-2'))).toMatchObject({ ok: true });
      });

      it('a payload delivery without evidence is escalated at the source, never resent on its own, and reconciled as sent when it shows up', async () => {
        const w = await make();
        const s = await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) adapter.dispatchModes = ['lost'];
        };
        expect(await confirm(w, T)).toMatchObject({ ok: false, code: 'unknown_outcome' });
        const [escalation] = await openEscalations(w);
        expect(escalation).toMatchObject({ rootSessionId: s, fromSessionId: target, title: 'Transfer delivery outcome unknown', ref: { kind: 'transfer', transferId: T } });
        expect(await proposal(w, T)).toMatchObject({ state: 'approved', createdSessionId: target, delivery: { state: 'unknown' } });
        w.configure = () => undefined;
        const after = await w.restart();
        expect(delivered([w, after])).toHaveLength(1);
        expect((await proposal(after, T)).delivery?.state).toBe('unknown');
        // The user retries: a second attempt, the old one kept.
        expect(await resolve(after, escalation!.id, 'retry')).toMatchObject({ ok: true });
        await settle();
        expect(delivered([w, after])).toHaveLength(2);
        expect((await proposal(after, T)).delivery).toMatchObject({ state: 'sent', attempts: [{ state: 'unknown', resolution: { decision: 'retry' } }, { state: 'sent' }] });
      });

      it('a cancel of a payload whose outcome is unknown records the user cancel, closes the question, and a later retry sends nothing', async () => {
        const w = await make();
        await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) adapter.dispatchModes = ['lost'];
        };
        await confirm(w, T);
        const [escalation] = await openEscalations(w);
        expect(await cancel(w, T)).toMatchObject({ ok: true });
        expect(await proposal(w, T)).toMatchObject({ state: 'cancelled', delivery: { state: 'unknown', attempts: [{ resolution: { decision: 'cancel', decidedBy: 'user' } }] } });
        expect(await w.repositories.escalations.get(escalation!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'user' });
        expect(await resolve(w, escalation!.id, 'retry')).toMatchObject({ ok: false });
        const after = await w.restart();
        expect(delivered([w, after])).toHaveLength(1);
      });
    });

    describe('transfer.cancel in every state', () => {
      it('a draft whose source turn still runs: the note request is never sent', async () => {
        const w = await make();
        const s = await source(w);
        const turn = await work(w, s, { keepRunning: true });
        await prepare(w, s, T, { noteSource: 'agent' });
        expect((await proposal(w, T)).state).toBe('draft');
        expect(await cancel(w, T)).toMatchObject({ ok: true });
        w.emitTurn(s, turn, 'completed');
        await settle();
        const after = await w.restart();
        expect([...dispatches(w), ...dispatches(after)].filter((d) => d.text.includes('handoff note'))).toHaveLength(0);
        expect(await after.store.get(noteOperationOf(T))).toBeUndefined();
        expect((await proposal(after, T)).state).toBe('cancelled');
      });

      it('while the target is being created: its session is recorded, but the content is not sent', async () => {
        const w = await make();
        await ready(w);
        let codex: RuntimeAdapter | undefined;
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) {
            adapter.startModes = ['held'];
            codex = adapter;
          }
        };
        const confirming = confirm(w, T);
        await settle();
        expect(codex).toBeDefined();
        const cancelling = cancel(w, T);
        await settle();
        w.codex.get(target)!.release();
        expect(await confirming).toMatchObject({ ok: false, code: 'invalid_transition' });
        expect(await cancelling).toMatchObject({ ok: true });
        expect(await proposal(w, T)).toMatchObject({ state: 'cancelled', createdSessionId: target, provision: { state: 'sent' }, delivery: { state: 'pending' } });
        const after = await w.restart();
        expect(created([w, after])).toBe(1);
        expect(delivered([w, after])).toHaveLength(0);
      });

      it('after the content was delivered: refused, the new session keeps it', async () => {
        const w = await make();
        await ready(w);
        await confirm(w, T);
        expect(await cancel(w, T)).toMatchObject({ ok: false, code: 'invalid_transition' });
        expect((await proposal(w, T)).state).toBe('approved');
      });

      it('after a restart that cut off the confirmation: the accepted payload never goes, nor the creation', async () => {
        const w = await make();
        await ready(w);
        die(w.store, 'claim', (input: { operationId: string }) => input.operationId === provisionOp);
        void confirm(w, T);
        await settle();
        expect(await w.store.get(payloadOp)).toMatchObject({ delivery: { state: 'pending' } });
        const after = await w.restart({ recover: false });
        // The session service's own recovery leaves a transfer's deliveries alone.
        expect(created([w, after])).toBe(0);
        expect(await cancel(after, T)).toMatchObject({ ok: true });
        await after.transfers.recover();
        await settle();
        expect(created([w, after])).toBe(0);
        expect(delivered([w, after])).toHaveLength(0);
        expect(await proposal(after, T)).toMatchObject({ state: 'cancelled', delivery: { state: 'pending' } });
        expect((await after.store.get(payloadOp))?.outcome?.kind).toBe('cancelled');
      });
    });

    describe('a restart between any two steps after the confirmation', () => {
      const steps: [string, (w: World) => void][] = [
        ['after the approval, before the target is recorded', (w) => die(w.store, 'accept', (input: { kind: string }) => input.kind === 'provision')],
        ['after the target is recorded, before the payload is', (w) => die(w.store, 'accept', (input: { kind: string }) => input.kind === 'transfer')],
        ['after both, before the creation is claimed', (w) => die(w.store, 'claim', (input: { operationId: string }) => input.operationId === provisionOp)],
        ['after the creation, before the payload is claimed', (w) => die(w.store, 'claim', (input: { operationId: string }) => input.operationId === payloadOp)],
      ];
      for (const [name, crash] of steps)
        it(`${name}: one session, created once, the content sent once`, async () => {
          const w = await make();
          const s = await ready(w);
          crash(w);
          void confirm(w, T);
          await settle();
          // The source went on meanwhile: once the payload exists the proposal is never made stale (T022 r2).
          await work(w, s, { reply: 'still here' });
          const after = await w.restart();
          expect(created([w, after])).toBe(1);
          expect(delivered([w, after])).toHaveLength(1);
          expect(await proposal(after, T)).toMatchObject({ state: 'approved', createdSessionId: target, delivery: { state: 'sent' } });
          expect((await after.repositories.sessions.list()).filter((x) => x.derivedFromSessionId === s)).toHaveLength(1);
        });

      it('inside the create call: unknown, escalated, never created again', async () => {
        const w = await make();
        const s = await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) die(adapter, 'startSession');
        };
        void confirm(w, T);
        await settle();
        const after = await w.restart();
        expect(created([w, after])).toBe(0);
        expect(delivered([w, after])).toHaveLength(0);
        expect(await proposal(after, T)).toMatchObject({ state: 'approved', provision: { state: 'unknown' } });
        expect(await openEscalations(after)).toMatchObject([{ rootSessionId: s, ref: { kind: 'provision', blocked: [payloadOp] } }]);
      });

      it('inside the payload dispatch: unknown, reconciled read-only, never resent', async () => {
        const w = await make();
        await ready(w);
        w.configure = (adapter, sessionId) => {
          if (sessionId === target) die(adapter, 'dispatchOnce');
        };
        void confirm(w, T);
        await settle();
        const after = await w.restart();
        expect(delivered([w, after])).toHaveLength(0);
        expect((await proposal(after, T)).delivery?.state).toBe('unknown');
        expect(await openEscalations(after)).toMatchObject([{ ref: { kind: 'transfer', transferId: T } }]);
      });

      it("a draft whose note request was cut off: sent once after the restart, then finished with the agent's note", async () => {
        const w = await make();
        const s = await source(w);
        w.notes.set(s, 'the note');
        die(w.store, 'claim', (input: { operationId: string }) => input.operationId === noteOperationOf(T));
        void prepare(w, s, T, { noteSource: 'agent' });
        await settle();
        const after = await w.restart();
        expect([...dispatches(w), ...dispatches(after)].filter((d) => d.text.includes('handoff note'))).toHaveLength(1);
        expect(await proposal(after, T)).toMatchObject({ state: 'awaiting-confirmation', content: { note: 'the note', noteSource: 'agent' } });
      });
    });

    describe('failure stays in the source session', () => {
      it('the target tool gone before anything was created fails the transfer; the source is untouched and can try again', async () => {
        const w = await make();
        const s = await ready(w);
        w.available.delete('codex');
        expect(await confirm(w, T)).toMatchObject({ ok: false, code: 'runtime_unavailable' });
        expect((await proposal(w, T)).state).toBe('awaiting-confirmation');
        // Confirmed, cut off, and the tool is gone after the restart.
        w.available.add('codex');
        die(w.store, 'accept', (input: { kind: string }) => input.kind === 'provision');
        void confirm(w, T);
        await settle();
        w.available.delete('codex');
        const before = { session: await w.repositories.sessions.get(s), conversation: await w.repositories.conversations.get(s) };
        const after = await w.restart();
        expect(await proposal(after, T)).toMatchObject({ state: 'failed', failure: { message: 'codex is not available on this computer' } });
        expect(created([w, after])).toBe(0);
        expect((await after.repositories.conversations.get(s)).messages).toEqual(before.conversation.messages);
        expect((await after.repositories.sessions.get(s))?.requestedModel).toEqual(before.session?.requestedModel);
        after.available.add('codex');
        expect(await prepare(after, s, TransferId.parse('tr-2'))).toMatchObject({ ok: true });
        expect(await confirm(after, TransferId.parse('tr-2'))).toMatchObject({ ok: true });
      });

      it('a delivered transfer leaves the source session as it was', async () => {
        const w = await make();
        const s = await ready(w);
        const before = { session: await w.repositories.sessions.get(s), conversation: await w.repositories.conversations.get(s), dispatched: dispatches(w).filter((d) => w.refs.get(d.nativeSessionRef) === s).length };
        expect(await confirm(w, T)).toMatchObject({ ok: true });
        expect(await w.repositories.conversations.get(s)).toEqual(before.conversation);
        expect((await w.repositories.sessions.get(s))?.revision).toBe(before.session?.revision);
        expect(dispatches(w).filter((d) => w.refs.get(d.nativeSessionRef) === s)).toHaveLength(before.dispatched);
      });
    });

    describe('one confirmation only', () => {
      it('two confirmations at once create and send once', async () => {
        const w = await make();
        await ready(w);
        const revision = (await proposal(w, T)).revision;
        const results = await Promise.all([confirm(w, T, revision), confirm(w, T, revision)]);
        expect(results.every((r) => r.ok)).toBe(true);
        expect(created([w])).toBe(1);
        expect(delivered([w])).toHaveLength(1);
      });

      it('a confirmation of a revision before the current one is stale', async () => {
        const w = await make();
        await ready(w);
        const revision = (await proposal(w, T)).revision;
        expect(await confirm(w, T, revision - 1)).toMatchObject({ ok: false, code: 'stale_revision' });
        expect(created([w])).toBe(0);
      });

      it('the source running a turn at the confirmation makes it stale', async () => {
        const w = await make();
        const s = await ready(w);
        await work(w, s, { keepRunning: true });
        expect(await confirm(w, T)).toMatchObject({ ok: false, code: 'stale_revision' });
        expect((await proposal(w, T)).state).toBe('stale');
        expect(created([w])).toBe(0);
      });
    });

    describe('what leaves the GUI', () => {
      it('an MCP token quoted in the source history never reaches the proposal, the payload or the store', async () => {
        const w = await make();
        const s = await source(w);
        const token = w.claude.started.find((o) => o.sessionId === s)?.mcp?.token;
        expect(token).toBeDefined();
        const read = w.claude.readHistory.bind(w.claude) as RuntimeAdapter['readHistory'];
        (w.claude as RuntimeAdapter).readHistory = async (request) => {
          const history = await read(request);
          const at = '2026-10-30T02:00:00.000Z';
          return {
            ...history,
            entries: [
              ...history.entries,
              { kind: 'message', message: { id: MessageId.parse('leak'), sessionId: s, turnId: TurnId.parse('t-leak'), role: 'assistant', origin: { kind: 'agent' }, text: `The env has Bearer ${token!}`, attachments: [], createdAt: at } },
            ],
          };
        };
        await prepare(w, s, T);
        await confirm(w, T);
        const p = await proposal(w, T);
        expect(p.content.note).toContain('[redacted]');
        const texts = [JSON.stringify(p), JSON.stringify(await w.store.get(payloadOp)), ...delivered([w]).map((d) => d.text), JSON.stringify(w.events), ...w.logs];
        for (const text of texts) expect(text).not.toContain(token!);
      });

      it("the runtime's history unreadable: the GUI's own record, said so", async () => {
        const w = await make();
        const s = await source(w);
        w.historyFails.add('claude');
        await prepare(w, s, T);
        const p = await proposal(w, T);
        expect(p.content.note).toContain('Agent: add() is done');
        expect(p.content.note).toContain("this is the GUI's own record");
      });
    });
  });

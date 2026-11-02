// T040 (C-31, G-11 B): the delivery service takes `system-notice`, the GUI's own words to a session, only with the
// `system` origin; the origin rules of every other kind are as before. On the memory store (core/delivery/t040.test.ts)
// and the SQLite store (app/main/delivery-t040.test.ts), with a restart that finds a notice still pending.
import { describe, expect, it } from 'vitest';
import type { MessageOrigin } from '../../../contracts';
import type { AcceptInput, DeliveryStore, PayloadContext } from '../../ports';
import { DeliveryService } from '../service';
import { FakeHistory, FakeRuntime } from './fake-runtime';
import { at, hashOf, op, payloadInput, uuid } from './fixtures';

const make = (store: DeliveryStore, history = new FakeHistory()) => {
  const codex = new FakeRuntime('codex', history);
  const claude = new FakeRuntime('claude', history);
  const service = new DeliveryService({ store, runtimes: { codex, claude }, now: () => at(40), uuid, hashPayload: hashOf, onEscalation: () => undefined });
  return { service, codex, history };
};

/** The context without its origin. */
const bare = (context: PayloadContext): PayloadContext => {
  const copy = { ...context };
  delete copy.origin;
  return copy;
};

const notice = (origin: MessageOrigin | undefined, name = 'notice-1'): AcceptInput => {
  const base = payloadInput({ kind: 'system-notice', operationId: op(name), sourceCallRef: name, payload: 'The user approved your list.', payloadHash: hashOf('The user approved your list.') });
  return { ...base, counts: [], context: { ...bare(base.context), ...(origin !== undefined && { origin }) } };
};

export const t040DeliveryCases = (backend: string, open: () => { store: DeliveryStore; reopen: () => DeliveryStore }) =>
  describe(`system-notice in the delivery service (C-31) (${backend})`, () => {
    it('is accepted with the system origin and dispatched as from the system, once; a resend is the same operation', async () => {
      const { store } = open();
      const g = make(store);
      expect(await g.service.accept(notice({ kind: 'system' }))).toMatchObject({ status: 'accepted' });
      expect(await g.service.accept(notice({ kind: 'system' }))).toMatchObject({ status: 'duplicate' });
      expect(await g.service.dispatch(op('notice-1'))).toMatchObject({ status: 'sent' });
      expect(await g.service.dispatch(op('notice-1'))).not.toMatchObject({ status: 'sent', fresh: true });
      expect(g.codex.dispatched).toHaveLength(1);
      expect(g.codex.dispatched[0]).toMatchObject({ text: 'The user approved your list.', origin: { kind: 'system' } });
      expect(await store.get(op('notice-1'))).toMatchObject({ kind: 'system-notice', delivery: { state: 'sent' }, context: { origin: { kind: 'system' } } });
    });

    it.each<[string, MessageOrigin | undefined]>([
      ['no origin', undefined],
      ['the user', { kind: 'user' }],
      ['an agent', { kind: 'agent' }],
      ['a peer', { kind: 'peer', fromSessionId: 's-x' as never, peerMessageId: 'p-x' as never }],
    ])('with %s as its origin it is invalid, and nothing is stored or sent', async (_name, origin) => {
      const { store } = open();
      const g = make(store);
      expect(await g.service.accept(notice(origin, 'notice-bad'))).toMatchObject({ status: 'invalid' });
      expect(await store.get(op('notice-bad'))).toBeUndefined();
      expect(g.codex.dispatched).toHaveLength(0);
    });

    it('the other kinds keep their origin rules', async () => {
      const { store } = open();
      const g = make(store);
      // A handoff names its origin; a peer message is never the user's; a user message may name none.
      const handoff = payloadInput({ operationId: op('h-1'), sourceCallRef: 'h-1' });
      expect(await g.service.accept({ ...handoff, context: bare(handoff.context) })).toMatchObject({ status: 'invalid' });
      expect(await g.service.accept(handoff)).toMatchObject({ status: 'accepted' });
      const user = payloadInput({ kind: 'user-message', operationId: op('u-1'), sourceCallRef: 'u-1', counts: [] });
      expect(await g.service.accept(user)).toMatchObject({ status: 'accepted' });
      const peer = payloadInput({ kind: 'peer-message', operationId: op('p-1'), sourceCallRef: 'p-1', counts: [] });
      expect(await g.service.accept({ ...peer, context: { ...peer.context, origin: { kind: 'user' } } })).toMatchObject({ status: 'invalid' });
    });

    it('a notice still pending at a restart is sent once by the recovery, as from the system', async () => {
      const opened = open();
      const g = make(opened.store);
      expect(await g.service.accept(notice({ kind: 'system' }, 'notice-pending'))).toMatchObject({ status: 'accepted' });
      const again = make(opened.reopen(), g.history);
      await again.service.recover();
      await make(opened.reopen(), g.history).service.recover();
      const sent = [...g.codex.dispatched, ...again.codex.dispatched];
      expect(sent.filter((d) => d.text === 'The user approved your list.')).toHaveLength(1);
      expect(again.codex.dispatched[0]).toMatchObject({ origin: { kind: 'system' } });
    });
  });

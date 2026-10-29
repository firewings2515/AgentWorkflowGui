// Contracts 0.5 (T020) in the delivery service and the in-memory store that T022's SQLite store follows:
// several receive counts in one acceptance (C-12), the handoff and peer facts stored with the delivery,
// the sender and the origin (C-08, C-01), outcomes and the lookup by tool-call identity.
import { describe, expect, it } from 'vitest';
import { type MessageOrigin, OperationId, PeerMessageId, SessionId } from '../../contracts';
import { COUNT_KEY, OP, contextWithoutOrigin, gui, handoffMeta, op, payloadInput } from './testing/fixtures';
import { MemoryDeliveryStore } from './testing/memory-store';

const REWORK = 'instance-1/task-1/rework';
const peer = { peerMessageId: PeerMessageId.parse('peer-1'), fromSessionId: SessionId.parse('session-a'), toSessionId: SessionId.parse('session-target') };
const peerOrigin: MessageOrigin = { kind: 'peer', fromSessionId: peer.fromSessionId, peerMessageId: peer.peerMessageId };

describe('C-12: every count is checked first and all advance together', () => {
  it('counts the receipt and the rework of one handoff at once', async () => {
    const store = new MemoryDeliveryStore();
    const counts = [{ key: COUNT_KEY, limit: 3 }, { key: REWORK, limit: 1 }];
    expect(await store.accept(payloadInput({ counts }))).toMatchObject({ status: 'accepted', counts: [{ key: COUNT_KEY, count: 1 }, { key: REWORK, count: 1 }] });
    // The rework limit is reached: nothing is written, the receipt count does not move either.
    expect(await store.accept(payloadInput({ operationId: op('op-2'), counts }))).toEqual({ status: 'limit-exceeded', key: REWORK, count: 1, limit: 1 });
    expect(await store.get(op('op-2'))).toBeUndefined();
    expect(store.admissions(COUNT_KEY)).toBe(1);
    // A resend counts nothing; one with other count keys is a conflict.
    expect((await store.accept(payloadInput({ counts }))).status).toBe('duplicate');
    expect((await store.accept(payloadInput({ counts: [{ key: COUNT_KEY, limit: 3 }] }))).status).toBe('conflict');
  });
});

describe('C-12, C-09: the facts of a handoff and of a peer message are stored with it', () => {
  it('refuses a handoff without its facts and a peer message without its own', async () => {
    const g = gui();
    expect(await g.service.accept(payloadInput({ handoff: undefined }))).toMatchObject({ status: 'invalid' });
    expect(await g.service.accept(payloadInput({ kind: 'peer-message', operationId: op('op-p') }))).toMatchObject({ status: 'invalid' });
    expect(await g.store.get(OP)).toBeUndefined();
  });

  it('reads the facts back, and a resend that changes them is a conflict', async () => {
    const g = gui();
    await g.service.accept(payloadInput());
    expect((await g.store.get(OP))?.kind === 'handoff' && (await g.store.get(OP))).toMatchObject({ handoff: handoffMeta() });
    expect((await g.service.accept(payloadInput({ handoff: { ...handoffMeta(), ruleId: 'other-rule' } }))).status).toBe('conflict');
    expect((await g.service.accept(payloadInput({ kind: 'peer-message', operationId: op('op-p'), peer, counts: undefined, context: { ...payloadInput().context, origin: peerOrigin } }))).status).toBe('accepted');
    expect(await g.store.get(op('op-p'))).toMatchObject({ peer });
  });

  it('copies the facts from plain data only: a getter or a Proxy is refused, not read', async () => {
    const g = gui();
    let read = 0;
    const withGetter = { ...handoffMeta() } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'ruleId', { enumerable: true, get: () => (read++, 'x') });
    expect((await g.service.accept(payloadInput({ handoff: withGetter as never }))).status).toBe('invalid');
    const upstream = new Proxy(['node-a'], {});
    expect((await g.service.accept(payloadInput({ handoff: { ...handoffMeta(), expectedUpstream: upstream as never } }))).status).toBe('accepted');
    const extra = { ...peer, mcp: { token: 'secret' } };
    expect((await g.service.accept(payloadInput({ kind: 'peer-message', operationId: op('op-p'), peer: extra, counts: undefined }))).status).toBe('invalid');
    expect(read).toBe(0);
  });
});

describe('T020 r1: review counterexamples', () => {
  it('r1-P1-3 a Proxy cannot answer another length for counts: the limit still holds', async () => {
    const g = gui();
    const limited = [{ key: COUNT_KEY, limit: 1 }];
    expect((await g.service.accept(payloadInput({ counts: limited }))).status).toBe('accepted');
    const lying = new Proxy([{ key: COUNT_KEY, limit: 1 }], { get: (target, key, receiver) => (key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown)) });
    expect(await g.service.accept(payloadInput({ operationId: op('op-2'), counts: lying }))).toMatchObject({ status: 'limit-exceeded', key: COUNT_KEY });
    expect(await g.store.get(op('op-2'))).toBeUndefined();
  });

  it('r1-P1-4 a handoff or peer message without an origin is refused; none is ever from the user', async () => {
    const g = gui();
    const noOrigin = contextWithoutOrigin();
    expect(await g.service.accept(payloadInput({ context: noOrigin }))).toMatchObject({ status: 'invalid' });
    expect(await g.service.accept(payloadInput({ kind: 'peer-message', operationId: op('op-p'), peer, counts: undefined, context: noOrigin }))).toMatchObject({ status: 'invalid' });
    expect(await g.service.accept(payloadInput({ context: { ...noOrigin, origin: { kind: 'user' } } }))).toMatchObject({ status: 'invalid' });
    expect(await g.service.accept(payloadInput({ kind: 'transfer', operationId: op('op-t'), counts: undefined, context: { ...noOrigin, origin: { kind: 'user' } } }))).toMatchObject({ status: 'invalid' });
  });

  it('r1-P1-4 a recovered transfer stored without an origin reaches the runtime as not the user’s', async () => {
    const g = gui();
    expect((await g.service.accept(payloadInput({ kind: 'transfer', counts: undefined, context: contextWithoutOrigin() }))).status).toBe('accepted');
    const next = g.restart();
    await next.service.recover();
    expect(next.codex.dispatched[0]?.origin).toEqual({ kind: 'system' });
  });
});

describe('C-01, C-08: origin and sender', () => {
  it('dispatches a recovered payload with the origin stored at acceptance', async () => {
    const g = gui();
    const origin: MessageOrigin = { kind: 'peer', fromSessionId: peer.fromSessionId, peerMessageId: peer.peerMessageId };
    const accepted = await g.service.accept(payloadInput({ kind: 'peer-message', peer, counts: undefined, context: { ...payloadInput().context, origin } }));
    expect(accepted.status).toBe('accepted');
    expect((await g.service.dispatch(OP)).status).toBe('sent');
    expect(g.codex.dispatched[0]?.origin).toEqual(origin);
  });

  it('refuses an origin that is not a message origin', async () => {
    const g = gui();
    const outcome = await g.service.accept(payloadInput({ context: { ...payloadInput().context, origin: { kind: 'user', extra: 1 } as never } }));
    expect(outcome.status).toBe('invalid');
  });

  it('stores the sender as part of what a resend must repeat', async () => {
    const store = new MemoryDeliveryStore();
    const sender = SessionId.parse('session-implement');
    await store.accept(payloadInput({ sender }));
    expect(await store.get(OP)).toMatchObject({ sender });
    expect((await store.accept(payloadInput({ sender: SessionId.parse('session-other') }))).status).toBe('conflict');
  });
});

describe('outcomes and lookup by tool-call identity', () => {
  it('records an outcome once and finds an operation by its source call', async () => {
    const store = new MemoryDeliveryStore();
    await store.accept(payloadInput());
    const outcome = { kind: 'cancelled' as const, detail: 'the user cancelled', at: '2026-10-29T10:00:00Z' };
    expect(await store.recordOutcome(OP, outcome)).toBe('recorded');
    expect(await store.recordOutcome(OP, outcome)).toBe('recorded');
    expect(await store.recordOutcome(OP, { ...outcome, kind: 'failed' })).toBe('stale');
    expect(await store.recordOutcome(OperationId.parse('missing'), outcome)).toBe('stale');
    expect(await store.get(OP)).toMatchObject({ outcome, delivery: { state: 'pending' } });
    expect((await store.findBySourceCallRef('call-1'))?.operationId).toBe(OP);
    expect(await store.findBySourceCallRef('call-other')).toBeUndefined();
  });
});

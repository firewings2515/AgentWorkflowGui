// T065 r2: a delivery that ended apart from delivery (`recordOutcome`: its workflow run ended, it was cancelled) is never
// claimed. The store checks the outcome in the claim's own atomic step, so an outcome written before the claim always
// wins, whatever its caller read before; a claim that came first stands (the run ended after it left). No pause point is
// needed to show it. On the memory store (core/delivery/t065.test.ts) and the SQLite store (app/main/workflow-t065.test.ts).
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, type MessageOrigin } from '../../../contracts';
import type { AcceptInput, DeliveryStore, PayloadContext } from '../../ports';
import { DeliveryService } from '../service';
import { FakeHistory, FakeRuntime } from './fake-runtime';
import { at, hashOf, op, payloadInput, THREAD, uuid } from './fixtures';

const make = (store: DeliveryStore) => {
  const history = new FakeHistory();
  const codex = new FakeRuntime('codex', history);
  const claude = new FakeRuntime('claude', history);
  const service = new DeliveryService({ store, runtimes: { codex, claude }, now: () => at(40), uuid, hashPayload: hashOf, onEscalation: () => undefined });
  return { service, codex };
};

const withoutOrigin = (context: PayloadContext): PayloadContext => {
  const copy = { ...context };
  delete copy.origin;
  return copy;
};

const SYSTEM: MessageOrigin = { kind: 'system' };
const inputs = (name: string): Record<'handoff' | 'system-notice', AcceptInput> => {
  const handoff = payloadInput({ operationId: op(`${name}-handoff`) });
  const base = payloadInput({ kind: 'system-notice', operationId: op(`${name}-notice`), sourceCallRef: `${name}-notice`, payload: 'Notice', payloadHash: hashOf('Notice') });
  return { handoff, 'system-notice': { ...base, counts: [], context: { ...withoutOrigin(base.context), origin: SYSTEM } } };
};

const claimOf = (input: AcceptInput, n: number) => ({
  operationId: input.operationId,
  expectedProposalRevision: input.proposalRevision,
  expectedNativeSessionRef: THREAD,
  attemptId: AttemptId.parse(`attempt-t065-${String(n)}`),
  clientMessageId: ClientMessageId.parse(`9a7c1e52-0d3b-4f6e-8a21-${String(n).padStart(12, '0')}`),
  at: at(41),
});
const CANCELLED = { kind: 'cancelled' as const, detail: 'the run was cancelled', at: at(42) };

let claims = 650;

export const t065ClaimCases = (backend: string, open: () => DeliveryStore) =>
  describe(`T065 r2 (${backend}): a delivery with an outcome is never claimed`, () => {
    it.each(['handoff', 'system-notice'] as const)('%s: an outcome written first makes the claim answer ended; nothing changes', async (kind) => {
      const store = open();
      const input = inputs(`ended-${kind}`)[kind];
      expect((await store.accept(input)).status).toBe('accepted');
      expect(await store.recordOutcome(input.operationId, CANCELLED)).toBe('recorded');
      expect(await store.claim(claimOf(input, ++claims))).toEqual({ status: 'ended' });
      expect(await store.get(input.operationId)).toMatchObject({ delivery: { state: 'pending', attempts: [] }, outcome: CANCELLED });
    });

    it('a claim that came first stands, and the outcome written after it is kept beside the attempt', async () => {
      const store = open();
      const input = inputs('claimed-first')['system-notice'];
      expect((await store.accept(input)).status).toBe('accepted');
      expect(await store.claim(claimOf(input, ++claims))).toMatchObject({ status: 'claimed' });
      expect(await store.recordOutcome(input.operationId, CANCELLED)).toBe('recorded');
      expect(await store.get(input.operationId)).toMatchObject({ delivery: { state: 'unknown' }, outcome: CANCELLED });
    });

    it('the delivery service never reaches the runtime for it: not dispatched, reason ended', async () => {
      const store = open();
      const { service, codex } = make(store);
      const input = inputs('service')['system-notice'];
      expect((await service.accept(input)).status).toBe('accepted');
      expect(await store.recordOutcome(input.operationId, CANCELLED)).toBe('recorded');
      expect(await service.dispatch(input.operationId, { origin: SYSTEM })).toMatchObject({ status: 'not-dispatched', reason: 'ended' });
      expect(codex.dispatched).toEqual([]);
    });
  });

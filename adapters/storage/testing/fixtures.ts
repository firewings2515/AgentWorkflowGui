// Test inputs for the delivery store: a handoff to a bound Codex thread and a provision for a new
// Claude session, plus claim inputs with fresh attempt and client message IDs.
import { createHash, randomUUID } from 'node:crypto';
import { AttemptId, ClientMessageId, OperationId, type PayloadHash, SessionId } from '../../../contracts';
import type { AcceptInput, ClaimInput, PayloadKind } from '../../../core/ports';
import { canonicalJson } from '../delivery-store';

export type PayloadInput = Extract<AcceptInput, { kind: PayloadKind }>;
export type ProvisionInput = Extract<AcceptInput, { kind: 'provision' }>;
/** Overrides where `undefined` removes the field. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

const defined = <T extends object>(value: Record<string, unknown>): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export const hashOf = (text: string): PayloadHash => `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const op = (id: string): OperationId => OperationId.parse(id);
export const at = (second = 0): string => new Date(Date.UTC(2026, 9, 26, 1, 0, second)).toISOString();

export const THREAD = 'thread-A';
export const COUNT_KEY = 'instance-1/task-1/node-review';

export const payloadInput = (overrides: Overrides<PayloadInput> = {}): PayloadInput =>
  defined({
    kind: 'handoff',
    operationId: op('op-1'),
    sourceCallRef: 'call-1',
    payloadHash: hashOf('payload'),
    payload: 'payload',
    proposalRevision: 1,
    target: { sessionId: SessionId.parse('session-target'), nativeSessionRef: THREAD },
    at: at(),
    context: {
      runtime: 'codex',
      cwd: 'E:/work',
      entry: { kind: 'new-turn' },
      session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false },
    },
    count: { key: COUNT_KEY, limit: 3 },
    ...overrides,
  });

export const provisionInput = (overrides: Partial<ProvisionInput> = {}): ProvisionInput => {
  const operationId = overrides.operationId ?? op('provision-1');
  const spec: ProvisionInput['spec'] = {
    runtime: 'claude',
    sessionId: SessionId.parse('session-new'),
    cwd: 'E:/work',
    model: { runtime: 'claude', model: 'claude-sonnet-5-5' },
    readOnly: true,
    preallocatedRef: '6f1c2a40-5b7e-4d89-9a3c-2e8f0b1d4c55',
  };
  return {
    kind: 'provision',
    operationId,
    payloadHash: hashOf(canonicalJson(spec)),
    proposalRevision: 1,
    target: {
      sessionId: spec.sessionId,
      provision: { operationId, bindingKey: COUNT_KEY, state: 'pending', preallocated: true, nativeSessionRef: spec.preallocatedRef },
    },
    at: at(),
    spec,
    ...overrides,
  };
};

export const claimInput = (operationId: OperationId, overrides: Overrides<ClaimInput> = {}): ClaimInput =>
  defined({
    operationId,
    expectedProposalRevision: 1,
    expectedNativeSessionRef: THREAD,
    attemptId: AttemptId.parse(`attempt-${randomUUID()}`),
    clientMessageId: ClientMessageId.parse(randomUUID()),
    at: at(10),
    ...overrides,
  });

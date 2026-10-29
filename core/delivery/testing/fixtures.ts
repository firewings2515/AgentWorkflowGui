// Test inputs for the delivery service: a handoff to a bound Codex thread, a provision for a new Claude
// session, and a GUI "process" (service + adapters) that can be restarted on the same store and history.
import { HandoffId, InstanceId, NodeId, OperationId, type PayloadHash, SessionId, TaskId } from '../../../contracts';
import type { AcceptInput, HandoffMeta, PayloadKind } from '../../ports';
import { DeliveryService } from '../service';
import type { DeliveryEscalation, DeliveryServiceOptions } from '../types';
import { FakeHistory, FakeRuntime } from './fake-runtime';
import { MemoryDeliveryStore } from './memory-store';

export type PayloadInput = Extract<AcceptInput, { kind: PayloadKind }>;
export type ProvisionInput = Extract<AcceptInput, { kind: 'provision' }>;
/** Overrides where `undefined` removes the field. */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

const defined = <T extends object>(value: Record<string, unknown>): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/** A stand-in for sha256 (core has no crypto): deterministic, 64 hex digits, different for different text. */
export const hashOf = (text: string): PayloadHash => {
  let digits = '';
  for (let seed = 0; digits.length < 64; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    digits += h.toString(16).padStart(8, '0');
  }
  return `sha256:${digits.slice(0, 64)}`;
};

export const op = (id: string): OperationId => OperationId.parse(id);
export const at = (second = 0): string => new Date(Date.UTC(2026, 9, 26, 1, 0, second)).toISOString();

export const THREAD = 'thread-A';
export const COUNT_KEY = 'instance-1/task-1/node-review';
export const OP = op('op-1');

/** The handoff facts stored with a handoff (C-12); one handoff per operation. */
export const handoffMeta = (operationId: string = OP): HandoffMeta => ({
  handoffId: HandoffId.parse(`handoff-${operationId}`),
  instanceId: InstanceId.parse('instance-1'),
  taskId: TaskId.parse('task-1'),
  fromNodeId: NodeId.parse('node-implement'),
  toNodeId: NodeId.parse('node-review'),
  fromSessionId: SessionId.parse('session-implement'),
  ruleId: 'to-review',
  round: 0,
});

export const payloadInput = (overrides: Overrides<PayloadInput> = {}): PayloadInput => {
  const kind = 'kind' in overrides ? overrides.kind : 'handoff';
  const operationId = overrides.operationId ?? OP;
  return defined({
    ...(kind === 'handoff' && { handoff: handoffMeta(operationId) }),
    kind: 'handoff',
    operationId: OP,
    sourceCallRef: 'call-1',
    payloadHash: hashOf(overrides.payload ?? 'payload'),
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
    counts: [{ key: COUNT_KEY, limit: 3 }],
    ...overrides,
  });
};

/** A provision for target `name`: its own operationId, session, pre-allocated ref and binding key. */
export const provisionInput = (name = '1', overrides: Partial<ProvisionInput> = {}): ProvisionInput => {
  const operationId = overrides.operationId ?? op(`provision-${name}`);
  const spec: ProvisionInput['spec'] = {
    runtime: 'claude',
    sessionId: SessionId.parse(`session-new-${name}`),
    cwd: 'E:/work',
    model: { runtime: 'claude', model: 'claude-sonnet-5-5' },
    readOnly: true,
    preallocatedRef: `6f1c2a40-5b7e-4d89-9a3c-2e8f0b1d4c5${name}`,
  };
  return {
    kind: 'provision',
    operationId,
    payloadHash: hashOf(JSON.stringify(spec)),
    proposalRevision: 1,
    target: {
      sessionId: spec.sessionId,
      provision: { operationId, bindingKey: `binding/${name}`, state: 'pending', preallocated: true, nativeSessionRef: spec.preallocatedRef },
    },
    at: at(),
    spec,
    ...overrides,
  };
};

/** A payload for the Claude session that provision `name` creates, accepted before it exists. */
export const waitingPayload = (name = '1', overrides: Overrides<PayloadInput> = {}): PayloadInput => {
  const provision = provisionInput(name);
  return payloadInput({
    operationId: op(`payload-for-${name}`),
    target: { sessionId: provision.spec.sessionId, provision: provision.target.provision },
    context: { runtime: 'claude', cwd: 'E:/work', entry: { kind: 'new-turn' }, session: { model: provision.spec.model, readOnly: true } },
    counts: [{ key: `instance-1/task-1/node-${name}` }],
    ...overrides,
  });
};

let uuids = 0;
/** Valid v4-shaped UUIDs, unique within the test run. */
export const uuid = (): string => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;

/**
 * One GUI process: a service with fresh adapters over `store` and `history`. `restart()` gives a new
 * process on the same durable state; the old one's hanging calls are simply abandoned.
 */
export const gui = (store = new MemoryDeliveryStore(), history = new FakeHistory(), options: Partial<DeliveryServiceOptions> = {}) => {
  const codex = new FakeRuntime('codex', history);
  const claude = new FakeRuntime('claude', history);
  const escalations: DeliveryEscalation[] = [];
  const service = new DeliveryService({
    store,
    runtimes: { codex, claude },
    now: () => at(40),
    uuid,
    hashPayload: hashOf,
    onEscalation: (item) => escalations.push(item),
    ...options,
  });
  return { store, history, codex, claude, service, escalations, restart: () => gui(store, history, options) };
};

/** Lets every queued promise reaction run, so a call that will never settle has done all it can. */
export const flush = async (rounds = 50) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

// CR-2 delivery service (T008): R-04 steps 3-7 and CR2_DELIVERY_FIX §1-5 over the two ports only.
// The single way to reach a runtime is `claim → claimed` followed by exactly one runtime call; every
// other claim result, an uncertain commit or a thrown write leaves the runtime untouched. Unknown is
// never resent: it is reconciled read-only, and what stays unknown goes to the user, who may wait,
// cancel or retry. Provisions (target creation) are their own deliveries; payloads wait for them.
import {
  AttemptId,
  ClientMessageId,
  type DeliveryTarget,
  DeliveryTarget as DeliveryTargetSchema,
  type DispatchAttempt,
  type HandoffId,
  type InstanceId,
  MessageOrigin,
  type ModelSelection,
  type NodeId,
  type OperationId,
  type PeerMessageId,
  type Runtime,
  type SessionId,
  type TaskId,
  deliveryTargetIssues,
} from '../../contracts';
import {
  type AcceptInput,
  type ClaimInput,
  type ClaimResult,
  CommitUncertainError,
  type DispatchEntry,
  type DispatchResult,
  type HandoffMeta,
  type PayloadKind,
  type PeerMeta,
  type ReconcileResult,
  type SessionSettings,
  type StartSessionOptions,
  type StoredDelivery,
} from '../ports';
import type {
  AcceptOutcome,
  DeliveryEscalation,
  DeliveryServiceOptions,
  DispatchFailure,
  DispatchOptions,
  DispatchOutcome,
  NotDispatchedReason,
  PayloadDelivery,
  ProvisionDelivery,
  ReconcileOutcome,
  RecoverOptions,
  RecoveryReport,
  ResolveInput,
  ResolveOutcome,
  UnknownReason,
} from './types';

type UnknownAttempt = Extract<DispatchAttempt, { state: 'unknown' }>;
type Proof = Extract<DispatchResult, { state: 'sent' }>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type NotDispatched = Extract<DispatchOutcome, { status: 'not-dispatched' }>;

const notDispatched = (reason: NotDispatchedReason, detail: string, extra: Pick<NotDispatched, 'provisionState'> = {}): NotDispatched => ({
  status: 'not-dispatched',
  reason,
  detail,
  ...extra,
});

/** A write's failure as a not-dispatched reason: an uncertain commit is kept apart from a rollback. */
const writeFailed = (error: unknown, what: string): NotDispatched =>
  notDispatched(error instanceof CommitUncertainError ? 'commit-uncertain' : 'store-failed', `${what}: ${errorText(error)}`);

/** The attempt that may still turn out sent: the last one, unknown and not abandoned by a user retry. */
const liveUnknown = (record: StoredDelivery): UnknownAttempt | undefined => {
  const last = record.delivery.attempts.at(-1);
  return record.delivery.state === 'unknown' && last?.state === 'unknown' && last.resolution?.decision !== 'retry' ? last : undefined;
};

const startOptions = (spec: ProvisionDelivery['spec']): StartSessionOptions => ({
  sessionId: spec.sessionId,
  cwd: spec.cwd,
  model: spec.model,
  readOnly: spec.readOnly,
  ...(spec.instructions !== undefined && { instructions: spec.instructions }),
  ...(spec.preallocatedRef !== undefined && { preallocatedRef: spec.preallocatedRef }),
});

/**
 * A copy of a plain object's own data properties, read once through their descriptors (T017 r2-P1-1):
 * nothing is read a second time, so a getter never runs and a Proxy cannot answer one value to the check
 * and another to the copy. Undefined for anything that is not plain data: an array, an object of another
 * prototype, a symbol key, or an accessor.
 */
const snapshot = (v: unknown): Record<string, unknown> | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') return undefined;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    out[key] = descriptor.value;
  }
  return out;
};

const hasKey = (v: unknown, key: string): boolean =>
  Array.isArray(v) ? v.some((x) => hasKey(x, key)) : typeof v === 'object' && v !== null && Object.entries(v).some(([k, x]) => k === key || hasKey(x, key));

/**
 * Rebuilds what the store gets, every level from primitives the port allows (C-07: the MCP token never
 * reaches the store, T017 r1-P1-1). Anything that is not plain data where an object is expected (an
 * array, a class instance, a getter, a symbol key) is refused rather than read.
 */
class Rebuild {
  readonly issues: string[] = [];

  object(v: unknown, at: string): Record<string, unknown> {
    const copy = snapshot(v);
    if (copy !== undefined) return copy;
    this.issues.push(`${at} is not plain data`);
    return Object.create(null) as Record<string, unknown>;
  }

  /** Keys other than `allowed` make the object invalid (the target is a strict contract shape). */
  only(o: Record<string, unknown>, allowed: readonly string[], at: string): void {
    for (const key of Object.keys(o)) if (!allowed.includes(key)) this.issues.push(`${at}.${key} is not allowed`);
  }

  target(v: unknown): DeliveryTarget {
    const o = this.object(v, 'target');
    this.only(o, ['sessionId', 'nativeSessionRef', 'provision'], 'target');
    const sessionId = this.optionalString(o, 'sessionId', 'target');
    const nativeSessionRef = this.optionalString(o, 'nativeSessionRef', 'target');
    let provision: Record<string, unknown> | undefined;
    if (o.provision !== undefined) {
      const p = this.object(o.provision, 'target.provision');
      this.only(p, ['operationId', 'bindingKey', 'state', 'nativeSessionRef', 'preallocated'], 'target.provision');
      const ref = this.optionalString(p, 'nativeSessionRef', 'target.provision');
      provision = {
        operationId: this.string(p, 'operationId', 'target.provision'),
        bindingKey: this.string(p, 'bindingKey', 'target.provision'),
        state: this.string(p, 'state', 'target.provision'),
        ...(ref !== undefined && { nativeSessionRef: ref }),
        preallocated: p.preallocated,
      };
    }
    // Plain data from here on, so the contract check reads nothing it did not copy.
    const parsed = DeliveryTargetSchema.safeParse({
      ...(sessionId !== undefined && { sessionId }),
      ...(nativeSessionRef !== undefined && { nativeSessionRef }),
      ...(provision !== undefined && { provision }),
    });
    if (parsed.success) return parsed.data;
    for (const i of parsed.error.issues) this.issues.push(`target: ${i.message}`);
    return {};
  }

  string(o: Record<string, unknown>, key: string, at: string): string {
    const v = o[key];
    if (typeof v === 'string') return v;
    this.issues.push(`${at}.${key} is not a string`);
    return '';
  }

  optionalString(o: Record<string, unknown>, key: string, at: string): string | undefined {
    return o[key] === undefined ? undefined : this.string(o, key, at);
  }

  runtime(o: Record<string, unknown>, at: string): Runtime {
    const v = o.runtime;
    if (v === 'claude' || v === 'codex') return v;
    this.issues.push(`${at}.runtime is not a runtime`);
    return 'claude';
  }

  model(v: unknown, at: string): ModelSelection {
    const o = this.object(v, at);
    const effort = this.optionalString(o, 'effort', at);
    return { runtime: this.runtime(o, at), model: this.string(o, 'model', at), ...(effort !== undefined && { effort }) };
  }

  settings(v: unknown, at: string): SessionSettings {
    const o = this.object(v, at);
    // The types forbid it, but a spread through `SessionSettings` or a cast still compiles (C-07).
    if ('mcp' in o) this.issues.push(`${at} carries an MCP mount, which is never stored`);
    if (typeof o.readOnly !== 'boolean') this.issues.push(`${at}.readOnly is not a boolean`);
    const instructions = this.optionalString(o, 'instructions', at);
    return { model: this.model(o.model, `${at}.model`), readOnly: o.readOnly === true, ...(instructions !== undefined && { instructions }) };
  }

  number(o: Record<string, unknown>, key: string, at: string): number {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    this.issues.push(`${at}.${key} is not a number`);
    return 0;
  }

  /** A list's elements, read once through the array's own descriptors (no getters, no other prototype). */
  list(v: unknown, at: string): unknown[] {
    if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) {
      this.issues.push(`${at} is not a list`);
      return [];
    }
    // The length too comes from the one descriptor read: a Proxy cannot answer another length (T020 r1 P1-3).
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const length: unknown = (descriptors as Record<string, PropertyDescriptor | undefined>).length?.value;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
      this.issues.push(`${at} has no length`);
      return [];
    }
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const d = descriptors[i];
      if (d === undefined || !('value' in d)) this.issues.push(`${at}[${i}] is not plain data`);
      else out.push(d.value);
    }
    return out;
  }

  /** C-01: parsed from a plain copy, so only the contract's fields of the origin are stored. */
  origin(v: unknown, at: string): MessageOrigin {
    const parsed = MessageOrigin.safeParse(this.object(v, at));
    if (parsed.success) return parsed.data;
    this.issues.push(`${at} is not a message origin`);
    return { kind: 'system' };
  }

  handoff(v: unknown): HandoffMeta {
    const o = this.object(v, 'handoff');
    this.only(o, ['handoffId', 'instanceId', 'taskId', 'fromNodeId', 'toNodeId', 'fromSessionId', 'ruleId', 'rework', 'round', 'expectedUpstream'], 'handoff');
    if (typeof o.rework !== 'boolean') this.issues.push('handoff.rework is not a boolean');
    const upstream =
      o.expectedUpstream === undefined
        ? undefined
        : this.list(o.expectedUpstream, 'handoff.expectedUpstream').map((x, i) => {
            if (typeof x === 'string') return x as NodeId;
            this.issues.push(`handoff.expectedUpstream[${i}] is not a string`);
            return '' as NodeId;
          });
    return {
      handoffId: this.string(o, 'handoffId', 'handoff') as HandoffId,
      instanceId: this.string(o, 'instanceId', 'handoff') as InstanceId,
      taskId: this.string(o, 'taskId', 'handoff') as TaskId,
      fromNodeId: this.string(o, 'fromNodeId', 'handoff') as NodeId,
      toNodeId: this.string(o, 'toNodeId', 'handoff') as NodeId,
      fromSessionId: this.string(o, 'fromSessionId', 'handoff') as SessionId,
      ruleId: this.string(o, 'ruleId', 'handoff'),
      rework: o.rework === true,
      round: this.number(o, 'round', 'handoff'),
      ...(upstream !== undefined && { expectedUpstream: upstream }),
    };
  }

  peer(v: unknown): PeerMeta {
    const o = this.object(v, 'peer');
    this.only(o, ['peerMessageId', 'fromSessionId', 'toSessionId', 'instanceId'], 'peer');
    const instanceId = this.optionalString(o, 'instanceId', 'peer');
    return {
      peerMessageId: this.string(o, 'peerMessageId', 'peer') as PeerMessageId,
      fromSessionId: this.string(o, 'fromSessionId', 'peer') as SessionId,
      toSessionId: this.string(o, 'toSessionId', 'peer') as SessionId,
      ...(instanceId !== undefined && { instanceId: instanceId as InstanceId }),
    };
  }

  /** C-12: every count rebuilt as `{ key, limit? }`. */
  counts(v: unknown): { key: string; limit?: number }[] {
    return this.list(v, 'counts').map((x, i) => {
      const c = this.object(x, `counts[${i}]`);
      this.only(c, ['key', 'limit'], `counts[${i}]`);
      return { key: this.string(c, 'key', `counts[${i}]`), ...(c.limit !== undefined && { limit: this.number(c, 'limit', `counts[${i}]`) }) };
    });
  }

  entry(v: unknown, at: string): DispatchEntry {
    const o = this.object(v, at);
    if (o.kind === 'insert') {
      const expectedTurnRef = this.optionalString(o, 'expectedTurnRef', at);
      return { kind: 'insert', ...(expectedTurnRef !== undefined && { expectedTurnRef }) };
    }
    if (o.kind !== 'new-turn') this.issues.push(`${at}.kind is not an entry kind`);
    return { kind: 'new-turn', ...(o.model !== undefined && { model: this.model(o.model, `${at}.model`) }) };
  }
}

const PAYLOAD_KINDS: readonly PayloadKind[] = ['handoff', 'peer-message', 'transfer', 'user-message'];

/**
 * The origin this dispatch uses, read once (T020 r3 P1): the caller's `options.origin` is read a single
 * time, copied from its own data properties only and checked against the contract, so what is checked is
 * what is sent, whatever the caller's object does later. `invalid` when it is not plain origin data.
 */
const originFor = (record: PayloadDelivery, options: DispatchOptions): { origin?: MessageOrigin } | 'invalid' => {
  const given: unknown = options.origin;
  if (given !== undefined) {
    const parsed = MessageOrigin.safeParse(snapshot(given));
    return parsed.success ? { origin: parsed.data } : 'invalid';
  }
  const origin = record.context.origin ?? (record.kind === 'user-message' ? undefined : ({ kind: 'system' } as const));
  return origin === undefined ? {} : { origin };
};

const rebuild = (input: AcceptInput): { input: AcceptInput } | { issues: string[] } => {
  const r = new Rebuild();
  const top = r.object(input, 'input');
  const target = r.target(top.target);
  const counts = top.counts === undefined ? undefined : r.counts(top.counts);
  if (typeof top.proposalRevision !== 'number') r.issues.push('proposalRevision is not a number');
  const sourceCallRef = r.optionalString(top, 'sourceCallRef', 'input');
  const sender = r.optionalString(top, 'sender', 'input');
  const base = {
    operationId: r.string(top, 'operationId', 'input') as OperationId,
    ...(sourceCallRef !== undefined && { sourceCallRef }),
    ...(sender !== undefined && { sender: sender as SessionId }),
    payloadHash: r.string(top, 'payloadHash', 'input'),
    proposalRevision: top.proposalRevision as number,
    target,
    at: r.string(top, 'at', 'input'),
    ...(counts !== undefined && { counts }),
  };
  let built: AcceptInput;
  if (top.kind === 'provision') {
    const spec = r.object(top.spec, 'spec');
    const preallocatedRef = r.optionalString(spec, 'preallocatedRef', 'spec');
    built = {
      ...base,
      kind: 'provision',
      spec: {
        runtime: r.runtime(spec, 'spec'),
        sessionId: r.string(spec, 'sessionId', 'spec') as SessionId,
        cwd: r.string(spec, 'cwd', 'spec'),
        ...r.settings(spec, 'spec'),
        ...(preallocatedRef !== undefined && { preallocatedRef }),
      },
    };
  } else {
    const context = r.object(top.context, 'context');
    const kind = PAYLOAD_KINDS.find((k) => k === top.kind);
    if (kind === undefined) r.issues.push('input.kind is not a delivery kind');
    built = {
      ...base,
      kind: kind ?? 'user-message',
      payload: r.string(top, 'payload', 'input'),
      context: {
        runtime: r.runtime(context, 'context'),
        cwd: r.string(context, 'cwd', 'context'),
        entry: r.entry(context.entry, 'context.entry'),
        session: r.settings(context.session, 'context.session'),
        ...(context.origin !== undefined && { origin: r.origin(context.origin, 'context.origin') }),
      },
      ...(top.handoff !== undefined && { handoff: r.handoff(top.handoff) }),
      ...(top.peer !== undefined && { peer: r.peer(top.peer) }),
    };
  }
  // Last line of defence: the data as it will be serialised carries no `mcp` key anywhere.
  if (r.issues.length === 0 && hasKey(JSON.parse(JSON.stringify(built)), 'mcp')) r.issues.push('the delivery carries an MCP mount, which is never stored');
  return r.issues.length > 0 ? { issues: r.issues } : { input: built };
};

export class DeliveryService {
  /** Operations whose single runtime call is running in this process. */
  private readonly inFlight = new Set<OperationId>();

  constructor(private readonly options: DeliveryServiceOptions) {}

  /**
   * Acceptance (R-04 step 3): the operation is fixed with its payload, hash, revision and target and
   * counted once by the store. A resend with the same operationId is a duplicate; one that changes
   * anything is a conflict. Nothing is dispatched; the caller decides when (a handoff waits for the
   * target's turn to end).
   */
  async accept(given: AcceptInput): Promise<AcceptOutcome> {
    const rebuilt = rebuild(given);
    if ('issues' in rebuilt) return { status: 'invalid', issues: rebuilt.issues };
    const { input } = rebuilt;
    const issues = await this.acceptIssues(input);
    if (issues.length > 0) return { status: 'invalid', issues };
    try {
      const result = await this.options.store.accept(input);
      // The store's own refusal (a handoff without its facts) reads like the checks above.
      return result.status === 'invalid' ? { status: 'invalid', issues: [result.detail] } : result;
    } catch (error) {
      if (error instanceof CommitUncertainError) return { status: 'commit-uncertain', detail: error.message };
      throw error;
    }
  }

  /**
   * The one dispatch entry, for a first dispatch, a recovery and a user retry alike (CR2 §1 steps 2-5):
   * bind the target if it waited for a provision, re-check binding and revision in the claim, and call
   * the runtime once only after `claimed` committed. Anything but a live ack stays unknown and is
   * reconciled read-only right away; what is still unknown is escalated.
   */
  async dispatch(operationId: OperationId, options: DispatchOptions = {}): Promise<DispatchOutcome> {
    let record: StoredDelivery | undefined;
    try {
      record = await this.options.store.get(operationId);
    } catch (error) {
      return writeFailed(error, 'reading the delivery failed');
    }
    if (record === undefined) return notDispatched('not-found', `no delivery ${operationId}`);
    if (record.delivery.state !== 'pending') return notDispatched('not-pending', `delivery ${operationId} is ${record.delivery.state}`);
    return record.kind === 'provision' ? this.dispatchProvision(record, options) : this.dispatchPayload(record, options);
  }

  /** Read-only reconciliation of the live unknown attempt (CR2 §2): only a positive match records sent. */
  async reconcile(operationId: OperationId): Promise<ReconcileOutcome> {
    if (this.inFlight.has(operationId)) return { status: 'in-flight' };
    return this.reconcileLive(operationId);
  }

  /**
   * The user's decision on an unknown attempt (CR2 §2, contracts `delivery.resolve`). `wait` and
   * `cancel` keep the attempt unknown and reconcilable; `retry` needs `acceptDuplicateRisk`, keeps the
   * old attempt and returns the delivery to pending without recounting. The next `dispatch` then makes
   * a new attempt with a new attemptId and clientMessageId.
   */
  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    if (input.decision === 'retry' && !input.acceptDuplicateRisk) return { status: 'refused', reason: 'duplicate-risk-not-accepted' };
    // The old executor must have stopped before a retry, which would reach the runtime again. Wait and
    // cancel never do, so they are recorded while the call is still running (e.g. cancel after a create
    // request left); the store keeps them when that call turns out sent.
    if (input.decision === 'retry' && this.inFlight.has(input.operationId)) return { status: 'refused', reason: 'in-flight' };
    try {
      const written = await this.options.store.recordResolution(input.operationId, input.attemptId, {
        decision: input.decision,
        at: this.options.now(),
        ...(input.note !== undefined && { note: input.note }),
      });
      return written === 'recorded' ? { status: 'recorded', decision: input.decision } : { status: 'stale' };
    } catch (error) {
      if (error instanceof CommitUncertainError) return { status: 'commit-uncertain', detail: error.message };
      throw error;
    }
  }

  /**
   * After a restart (R-04 table): every unknown delivery is only reconciled, then every pending one goes
   * through `dispatch`, provisions first so their payloads can bind in the same pass.
   */
  async recover(options: RecoverOptions = {}): Promise<RecoveryReport> {
    const report: RecoveryReport = { reconciled: [], dispatched: [], failed: [] };
    const run = async <T>(operationId: OperationId, call: () => Promise<T>, done: (outcome: T) => void) => {
      try {
        done(await call());
      } catch (error) {
        report.failed.push({ operationId, detail: errorText(error) });
      }
    };
    for (const record of await this.options.store.listByState('unknown')) {
      const { operationId } = record;
      await run(operationId, () => this.reconcile(operationId), (outcome) => report.reconciled.push({ operationId, outcome }));
    }
    const pending = await this.options.store.listByState('pending');
    for (const record of [...pending.filter((r) => r.kind === 'provision'), ...pending.filter((r) => r.kind !== 'provision')]) {
      const { operationId } = record;
      const choice = options.select?.(record) ?? {};
      if (choice === 'skip') continue;
      await run(operationId, () => this.dispatch(operationId, choice), (outcome) => report.dispatched.push({ operationId, outcome }));
    }
    return report;
  }

  private async acceptIssues(input: AcceptInput): Promise<string[]> {
    const issues: string[] = deliveryTargetIssues(undefined, input.target);
    if (input.kind === 'provision') {
      if (input.target.provision?.operationId !== input.operationId) issues.push('a provision describes itself in target.provision');
    } else {
      if ((await this.options.hashPayload(input.payload)) !== input.payloadHash) issues.push('payloadHash does not match the payload');
      // A payload that is not the user's says whose it is, so no restart can deliver it as the user's (C-01).
      if ((input.kind === 'handoff' || input.kind === 'peer-message') && input.context.origin === undefined) issues.push(`a ${input.kind} names its origin in context.origin`);
      if (input.context.origin?.kind === 'user' && input.kind !== 'user-message') issues.push(`a ${input.kind} is never from the user`);
    }
    return issues;
  }

  private async dispatchPayload(accepted: PayloadDelivery, options: DispatchOptions): Promise<DispatchOutcome> {
    const adapter = this.options.runtimes[accepted.context.runtime];
    if (adapter === undefined) return notDispatched('no-runtime', `no ${accepted.context.runtime} adapter`);
    // Chosen and checked once, before the claim, and that same copy is sent: a caller's origin can never make
    // another kind of payload the user's (T020 r2, r3 P1).
    const selected = originFor(accepted, options);
    if (selected === 'invalid') return notDispatched('origin-mismatch', 'the origin is not plain origin data');
    const chosen = selected.origin;
    const fits = accepted.kind === 'user-message' ? chosen === undefined || chosen.kind === 'user' : chosen !== undefined && chosen.kind !== 'user';
    if (!fits) {
      return notDispatched('origin-mismatch', `a ${accepted.kind} cannot be dispatched as from ${chosen?.kind ?? 'nobody'}`);
    }
    let record = accepted;
    if (record.target.provision !== undefined) {
      const bound = await this.bindToProvision(record);
      if ('status' in bound) return bound;
      record = bound;
    }
    const nativeSessionRef = options.expectedNativeSessionRef ?? record.target.nativeSessionRef;
    if (nativeSessionRef === undefined) return notDispatched('target-not-ready', `delivery ${record.operationId} has no bound native session`);
    if (this.options.prepareTarget !== undefined) {
      try {
        await this.options.prepareTarget(record);
      } catch (error) {
        return notDispatched('prepare-failed', errorText(error));
      }
    }
    const claim = await this.claim(record, options, nativeSessionRef);
    if ('status' in claim) return claim;

    // Claimed and committed: the payload may now leave the GUI, once (CR2 §1 step 4).
    let result: DispatchResult | DispatchFailure;
    this.inFlight.add(record.operationId);
    try {
      const timeoutMs = options.timeoutMs ?? this.options.dispatchTimeoutMs;
      result = await adapter.dispatchOnce({
        nativeSessionRef,
        attempt: claim,
        // The persisted payload, never a caller's copy.
        text: record.payload,
        entry: options.entry ?? record.context.entry,
        // The caller's origin, else the one stored at acceptance (C-01), else, for anything but a user message,
        // "not the user" (T020 r1 P1-4): the copy checked above, never read from the caller again.
        ...(chosen !== undefined && { origin: chosen }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });
    } catch (error) {
      result = { reason: 'adapter-error', detail: errorText(error) };
    } finally {
      this.inFlight.delete(record.operationId);
    }
    if ('state' in result && result.state === 'unknown') {
      result = { reason: result.reason, written: result.written, detail: result.detail };
    }
    return this.settle(record.operationId, claim, result);
  }

  private async dispatchProvision(record: ProvisionDelivery, options: DispatchOptions): Promise<DispatchOutcome> {
    const adapter = this.options.runtimes[record.spec.runtime];
    if (adapter === undefined) return notDispatched('no-runtime', `no ${record.spec.runtime} adapter`);
    // A provision creates its target, so there is no binding to re-check (port: ClaimInput).
    const claim = await this.claim(record, options, undefined);
    if ('status' in claim) return claim;

    let result: Proof | DispatchFailure;
    this.inFlight.add(record.operationId);
    try {
      const info = await adapter.startSession(startOptions(record.spec));
      result = {
        state: 'sent',
        nativeRef: { sessionRef: info.nativeSessionRef },
        evidence: { kind: 'live-ack', at: this.options.now(), detail: `startSession returned native session ${info.nativeSessionRef} for ${record.spec.sessionId}` },
      };
    } catch (error) {
      // The runtime may have created it anyway (lost response): never create it again on our own.
      result = { reason: 'adapter-error', detail: errorText(error) };
    } finally {
      this.inFlight.delete(record.operationId);
    }
    return this.settle(record.operationId, claim, result);
  }

  /**
   * Moves a payload that waits for its provision to the session that provision created, by the store's
   * compare-and-set (R-04 step 4). Returns the re-read record, or why it cannot be dispatched yet.
   */
  private async bindToProvision(record: PayloadDelivery): Promise<PayloadDelivery | NotDispatched> {
    const { store } = this.options;
    const provisionId = record.target.provision?.operationId;
    try {
      const provision = provisionId === undefined ? undefined : await store.get(provisionId);
      if (provision?.kind !== 'provision') {
        return { status: 'not-dispatched', reason: 'provision-not-sent', detail: `the target's provision ${provisionId ?? ''} is not recorded` };
      }
      // The user cancelled after the create call left (CR2 §3): the created session stays recorded on the
      // provision, but no payload goes to it. A sent attempt can no longer be decided on, so this is final.
      if (provision.delivery.attempts.at(-1)?.resolution?.decision === 'cancel') {
        return {
          status: 'not-dispatched',
          reason: 'provision-cancelled',
          detail: `the user cancelled the target's provision ${provision.operationId}`,
          provisionState: provision.delivery.state,
        };
      }
      if (provision.delivery.state !== 'sent') {
        return {
          status: 'not-dispatched',
          reason: 'provision-not-sent',
          detail: `the target's provision ${provision.operationId} is ${provision.delivery.state}`,
          provisionState: provision.delivery.state,
        };
      }
      const created = provision.target.nativeSessionRef;
      const provisionRecord = provision.target.provision;
      if (created !== undefined && provisionRecord !== undefined) {
        const bound: DeliveryTarget = { sessionId: provision.spec.sessionId, nativeSessionRef: created, provision: provisionRecord };
        // `stale` is not an error here: the claim re-checks the target and says what is wrong.
        await store.updateTarget(record.operationId, record.target, bound);
      }
      const fresh = await store.get(record.operationId);
      if (fresh === undefined) return { status: 'not-dispatched', reason: 'not-found', detail: `no delivery ${record.operationId}` };
      if (fresh.kind === 'provision' || fresh.delivery.state !== 'pending') {
        return { status: 'not-dispatched', reason: 'not-pending', detail: `delivery ${record.operationId} is ${fresh.delivery.state}` };
      }
      return fresh;
    } catch (error) {
      return writeFailed(error, 'binding the target failed');
    }
  }

  /** The conditional `pending → unknown` with a new attempt; only a committed `claimed` returns the attempt. */
  private async claim(record: StoredDelivery, options: DispatchOptions, nativeSessionRef: string | undefined): Promise<UnknownAttempt | NotDispatched> {
    let input: ClaimInput;
    try {
      input = {
        operationId: record.operationId,
        expectedProposalRevision: options.expectedProposalRevision ?? record.proposalRevision,
        ...(nativeSessionRef !== undefined && { expectedNativeSessionRef: nativeSessionRef }),
        attemptId: AttemptId.parse(`attempt-${this.options.uuid()}`),
        clientMessageId: ClientMessageId.parse(this.options.uuid()),
        at: this.options.now(),
      };
    } catch (error) {
      return notDispatched('store-failed', `could not make attempt IDs: ${errorText(error)}`);
    }
    let result: ClaimResult;
    try {
      result = await this.options.store.claim(input);
    } catch (error) {
      // Uncertain or failed: either way the runtime is not called (CR2 §1 step 3).
      return writeFailed(error, 'the claim did not commit');
    }
    if (result.status !== 'claimed') return notDispatched(result.status, `claim of ${record.operationId}: ${result.status}`);
    return result.attempt;
  }

  /** Records a live ack as sent; anything else (or a failed write) is reconciled read-only, then escalated. */
  private async settle(operationId: OperationId, attempt: UnknownAttempt, result: Proof | DispatchFailure): Promise<DispatchOutcome> {
    let failure: DispatchFailure;
    if ('state' in result) {
      try {
        const written = await this.options.store.recordSent(operationId, attempt.attemptId, result.nativeRef, result.evidence);
        if (written === 'recorded') return { status: 'sent', attemptId: attempt.attemptId, nativeRef: result.nativeRef, evidence: result.evidence };
        failure = { reason: 'evidence-rejected', written: true, detail: `the store refused ${result.evidence.detail}` };
      } catch (error) {
        failure = { reason: 'record-failed', written: true, detail: `${result.evidence.detail}; writing sent failed: ${errorText(error)}` };
      }
    } else {
      failure = result;
    }
    let reconciled: ReconcileOutcome;
    try {
      reconciled = await this.reconcileLive(operationId, attempt.attemptId, failure);
    } catch (error) {
      // The store could not even be read: the attempt stays unknown and recovery escalates it later.
      return { status: 'unknown', attemptId: attempt.attemptId, failure: { ...failure, detail: `${failure.detail}; reconciling failed: ${errorText(error)}` } };
    }
    if (reconciled.status === 'sent') return reconciled;
    return {
      status: 'unknown',
      attemptId: attempt.attemptId,
      failure,
      ...(reconciled.status === 'unknown' && { escalation: reconciled.escalation }),
    };
  }

  /**
   * Reads the stored record (its payload, target, cwd and clientMessageId, never a caller's copy) and
   * asks the runtime's read-only `reconcile`. Only a positive match the store accepts becomes sent.
   */
  private async reconcileLive(operationId: OperationId, attemptId?: AttemptId, failure?: DispatchFailure): Promise<ReconcileOutcome> {
    const record = await this.options.store.get(operationId);
    const live = record === undefined ? undefined : liveUnknown(record);
    if (record === undefined || live === undefined || (attemptId !== undefined && live.attemptId !== attemptId)) {
      return { status: 'not-unknown', ...(record !== undefined && { state: record.delivery.state }) };
    }
    const unknown = (reason: UnknownReason, detail: string, matches: Extract<ReconcileResult, { state: 'unknown' }>['matches'] = []) =>
      this.escalate(record, live, { reason, detail, matches, ...(failure !== undefined && { failure }) });

    if (record.kind === 'provision') {
      return unknown('provision-unverifiable', 'whether the target session was created cannot be confirmed read-only; it is not created again without the user');
    }
    const adapter = this.options.runtimes[record.context.runtime];
    if (adapter === undefined) return unknown('no-runtime', `no ${record.context.runtime} adapter to reconcile with`);
    const nativeSessionRef = record.target.nativeSessionRef;
    if (nativeSessionRef === undefined) return unknown('read-failed', 'the dispatched delivery has no bound native session');

    let result: ReconcileResult;
    try {
      result = await adapter.reconcile({ nativeSessionRef, cwd: record.context.cwd, clientMessageId: live.clientMessageId, text: record.payload });
    } catch (error) {
      return unknown('read-failed', errorText(error));
    }
    if (result.state === 'unknown') return unknown(result.reason, result.detail, result.matches);
    try {
      const written = await this.options.store.recordSent(operationId, live.attemptId, result.nativeRef, result.evidence);
      if (written === 'stale') return unknown('evidence-rejected', `the store refused ${result.evidence.detail}`);
    } catch (error) {
      return unknown('record-failed', `${result.evidence.detail}; writing sent failed: ${errorText(error)}`);
    }
    return { status: 'sent', attemptId: live.attemptId, nativeRef: result.nativeRef, evidence: result.evidence };
  }

  private async escalate(
    record: StoredDelivery,
    attempt: UnknownAttempt,
    found: { reason: UnknownReason; detail: string; matches: DeliveryEscalation['matches']; failure?: DispatchFailure },
  ): Promise<ReconcileOutcome> {
    const decision = attempt.resolution?.decision;
    const blocked = record.kind === 'provision' ? await this.waitingFor(record.operationId) : undefined;
    const escalation: DeliveryEscalation = {
      kind: 'delivery-unknown',
      key: `${record.operationId}/${attempt.attemptId}`,
      operationId: record.operationId,
      deliveryKind: record.kind,
      attemptId: attempt.attemptId,
      clientMessageId: attempt.clientMessageId,
      dispatchStartedAt: attempt.dispatchStartedAt,
      target: record.target,
      ...found,
      duplicateRisk: found.reason === 'duplicate' ? 'suspected' : found.failure?.written === false ? 'unlikely' : 'possible',
      ...(blocked !== undefined && { blocked }),
      ...((decision === 'wait' || decision === 'cancel') && { decision }),
      at: this.options.now(),
    };
    this.options.onEscalation?.(escalation);
    return { status: 'unknown', escalation };
  }

  /** Pending payloads bound to wait for this provision; empty when the store cannot list them. */
  private async waitingFor(provisionId: OperationId): Promise<OperationId[]> {
    try {
      return (await this.options.store.listByState('pending')).filter((r) => r.kind !== 'provision' && r.target.provision?.operationId === provisionId).map((r) => r.operationId);
    } catch {
      return [];
    }
  }
}

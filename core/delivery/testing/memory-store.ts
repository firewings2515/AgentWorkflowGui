// In-memory `DeliveryStore` for the dispatcher's tests (T008). It follows the SQLite store's semantics
// (adapters/storage/delivery-store.ts, T007) without importing it: one atomic body per method, the
// destination fixed at acceptance, `updateTarget` only binding a payload to the session its own provision
// created, and `claim` as the single conditional `pending → unknown`. Faults can be injected per method to
// model a failed transaction, an uncertain commit (applied or not) or a process that dies inside a write.
import type {
  AttemptId,
  DeliveryEvidence,
  DeliveryRecord,
  DeliveryTarget,
  DispatchAttempt,
  NativeRef,
  OperationId,
  OperationOutcome,
  ProvisionRecord,
  SessionId,
} from '../../../contracts';
import {
  type AcceptInput,
  type AcceptResult,
  type ClaimInput,
  type ClaimResult,
  CommitUncertainError,
  type DeliveryStore,
  type EndUnclaimedResult,
  type HandoffMeta,
  type PayloadContext,
  type PeerMeta,
  type ProvisionSpec,
  type StoredDelivery,
  type WriteResult,
} from '../../ports';

type Method = 'accept' | 'updateTarget' | 'claim' | 'recordSent' | 'recordResolution' | 'recordOutcome' | 'endUnclaimed' | 'get' | 'findBySourceCallRef' | 'listByState' | 'listByTarget';

/**
 * `error`: the transaction fails before COMMIT, nothing is applied. `uncertain`: COMMIT fails and was in
 * fact not applied. `uncertain-applied`: COMMIT fails but was applied. `hang`: the process dies inside
 * the call, which never settles and applies nothing.
 */
export type Fault = 'error' | 'uncertain' | 'uncertain-applied' | 'hang';

interface Row {
  kind: StoredDelivery['kind'];
  operationId: OperationId;
  sourceCallRef?: string;
  sender?: SessionId;
  payloadHash: string;
  proposalRevision: number;
  acceptedTarget: string;
  target: string;
  body: string;
  state: DeliveryRecord['state'];
  acceptedAt: string;
  attempts: { attempt: DispatchAttempt; abandoned: boolean }[];
  countKeys: string[];
  bindingKey?: string;
  outcome?: OperationOutcome;
}

/** JSON with object keys sorted and undefined dropped, so equal values are equal text. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

const parse = <T>(text: string): T => JSON.parse(text) as T;
const copy = <T>(value: T): T => (value === undefined ? value : parse<T>(JSON.stringify(value)));

/** The kind-specific facts (C-12, C-09) are part of the body, so a resend that changes them is a conflict. */
const bodyOf = (input: AcceptInput) =>
  input.kind === 'provision'
    ? { spec: input.spec }
    : { payload: input.payload, context: input.context, ...(input.handoff !== undefined && { handoff: input.handoff }), ...(input.peer !== undefined && { peer: input.peer }) };

/** A provision's own target mirrors its delivery state and, once created, the new session (CR2 §3). */
const provisionTarget = (target: DeliveryTarget, state: DeliveryRecord['state'], createdRef?: string): DeliveryTarget => {
  if (target.provision === undefined) return target;
  const provision: ProvisionRecord = { ...target.provision, state, ...(createdRef !== undefined && { nativeSessionRef: createdRef }) };
  return { ...target, provision, ...(createdRef !== undefined && { nativeSessionRef: createdRef }) };
};

export class MemoryDeliveryStore implements DeliveryStore {
  private readonly rows = new Map<string, Row>();
  private readonly faults: { method: Method; fault: Fault }[] = [];
  /** Every call in order, so tests can see that a claim was attempted. */
  readonly calls: Method[] = [];

  /** The next call of `method` fails with `fault`; queued faults apply in order, once each. */
  inject(method: Method, fault: Fault, times = 1): this {
    for (let i = 0; i < times; i++) this.faults.push({ method, fault });
    return this;
  }

  /** Receive admissions under `key`, i.e. what the receive counter shows (R-04). */
  admissions(key: string): number {
    return [...this.rows.values()].filter((r) => r.countKeys.includes(key)).length;
  }

  accept(input: AcceptInput): Promise<AcceptResult> {
    return this.run<AcceptResult>('accept', () => {
      if (input.kind === 'handoff' && input.handoff === undefined) return { value: { status: 'invalid', detail: 'a handoff needs its handoff facts' } };
      if (input.kind === 'peer-message' && input.peer === undefined) return { value: { status: 'invalid', detail: 'a peer message needs its peer facts' } };
      const existing = this.rows.get(input.operationId);
      if (existing !== undefined) {
        return { value: this.sameAcceptance(existing, input) ? { status: 'duplicate', record: this.load(existing) } : { status: 'conflict', existing: this.load(existing) } };
      }
      // A tool call's identity names one operation (C-08), as the SQLite store's unique index does.
      const sameCall = input.sourceCallRef === undefined ? undefined : [...this.rows.values()].find((r) => r.sourceCallRef === input.sourceCallRef);
      if (sameCall !== undefined) return { value: { status: 'conflict', existing: this.load(sameCall) } };
      let target = input.target;
      let bindingKey: string | undefined;
      if (input.kind === 'provision') {
        const provision = input.target.provision;
        if (provision?.operationId !== input.operationId) {
          throw new TypeError('a provision is accepted with target.provision describing itself (operationId and bindingKey)');
        }
        bindingKey = provision.bindingKey;
        const other = [...this.rows.values()].find((r) => r.bindingKey === bindingKey);
        if (other !== undefined) return { value: { status: 'conflict', existing: this.load(other) } };
        target = provisionTarget(target, 'pending');
      }
      // Every count is checked before any is advanced: one at its limit writes nothing (R-04 step 3).
      const counts: { key: string; count: number }[] = [];
      for (const c of input.counts ?? []) {
        const counted = this.admissions(c.key);
        if (c.limit !== undefined && counted >= c.limit) return { value: { status: 'limit-exceeded', key: c.key, count: counted, limit: c.limit } };
        counts.push({ key: c.key, count: counted + 1 });
      }
      const row: Row = {
        kind: input.kind,
        operationId: input.operationId,
        ...(input.sourceCallRef !== undefined && { sourceCallRef: input.sourceCallRef }),
        ...(input.sender !== undefined && { sender: input.sender }),
        payloadHash: input.payloadHash,
        proposalRevision: input.proposalRevision,
        acceptedTarget: canonicalJson(input.target),
        target: canonicalJson(target),
        body: canonicalJson(bodyOf(input)),
        state: 'pending',
        acceptedAt: input.at,
        attempts: [],
        countKeys: counts.map((c) => c.key),
        ...(bindingKey !== undefined && { bindingKey }),
      };
      return {
        value: counts.length === 0 ? { status: 'accepted', record: this.load(row) } : { status: 'accepted', record: this.load(row), counts },
        apply: () => this.rows.set(row.operationId, row),
      };
    });
  }

  updateTarget(operationId: OperationId, expected: DeliveryTarget, next: DeliveryTarget): Promise<WriteResult> {
    return this.run<WriteResult>('updateTarget', () => {
      const row = this.rows.get(operationId);
      if (row === undefined || row.state !== 'pending' || row.target !== canonicalJson(expected)) return { value: 'stale' };
      if (canonicalJson(next) === row.target) return { value: 'recorded' };
      if (row.kind === 'provision') return { value: 'stale' };
      const binding = this.binding(row);
      if (binding.status !== 'bound' || canonicalJson(next) !== canonicalJson(binding.target)) return { value: 'stale' };
      return { value: 'recorded', apply: () => (row.target = canonicalJson(next)) };
    });
  }

  claim(input: ClaimInput): Promise<ClaimResult> {
    return this.run<ClaimResult>('claim', () => {
      const row = this.rows.get(input.operationId);
      if (row === undefined) return { value: { status: 'not-found' } };
      if (row.state !== 'pending') return { value: { status: 'not-pending' } };
      // Ended apart from delivery: never claimed (T065 r2), in this same step.
      if (row.outcome !== undefined) return { value: { status: 'ended' } };
      if (row.proposalRevision !== input.expectedProposalRevision) return { value: { status: 'revision-changed' } };
      const target = parse<DeliveryTarget>(row.target);
      const blocked = row.kind === 'provision' ? this.provisionBlocked(target, input) : this.payloadBlocked(row, target, input);
      if (blocked !== undefined) return { value: { status: blocked } };
      // Unique across every operation, as SQLite's keys on dispatch_attempt: a reused ID fails the transaction.
      const used = [...this.rows.values()].flatMap((r) => r.attempts);
      if (used.some((a) => a.attempt.attemptId === input.attemptId || a.attempt.clientMessageId === input.clientMessageId)) {
        throw new Error('attemptId and clientMessageId must be unique across all deliveries');
      }
      const attempt = { state: 'unknown' as const, attemptId: input.attemptId, clientMessageId: input.clientMessageId, dispatchStartedAt: input.at };
      return {
        value: { status: 'claimed', attempt },
        apply: () => {
          row.state = 'unknown';
          row.attempts.push({ attempt: copy(attempt), abandoned: false });
          if (row.kind === 'provision') row.target = canonicalJson(provisionTarget(target, 'unknown'));
        },
      };
    });
  }

  recordSent(operationId: OperationId, attemptId: AttemptId, nativeRef: NativeRef, evidence: DeliveryEvidence): Promise<WriteResult> {
    return this.run<WriteResult>('recordSent', () => {
      const row = this.rows.get(operationId);
      const live = row === undefined ? undefined : this.liveUnknown(row, attemptId);
      if (row?.state !== 'unknown' || live === undefined) return { value: 'stale' };
      const target = parse<DeliveryTarget>(row.target);
      if (!this.refMatchesTarget(row, target, nativeRef)) return { value: 'stale' };
      return {
        value: 'recorded',
        apply: () => {
          const { resolution } = live.attempt as Extract<DispatchAttempt, { state: 'unknown' }>;
          live.attempt = {
            attemptId: live.attempt.attemptId,
            clientMessageId: live.attempt.clientMessageId,
            dispatchStartedAt: live.attempt.dispatchStartedAt,
            state: 'sent',
            nativeRef: copy(nativeRef),
            evidence: copy(evidence),
            ...(resolution !== undefined && resolution.decision !== 'retry' && { resolution: { ...resolution, decision: resolution.decision } }),
          };
          row.state = 'sent';
          if (row.kind === 'provision') row.target = canonicalJson(provisionTarget(target, 'sent', nativeRef.sessionRef));
        },
      };
    });
  }

  recordResolution(
    operationId: OperationId,
    attemptId: AttemptId,
    resolution: { decision: 'wait' | 'cancel' | 'retry'; at: string; note?: string },
  ): Promise<WriteResult> {
    return this.run<WriteResult>('recordResolution', () => {
      const row = this.rows.get(operationId);
      const live = row === undefined ? undefined : this.liveUnknown(row, attemptId);
      if (row?.state !== 'unknown' || live === undefined) return { value: 'stale' };
      const decided = { decision: resolution.decision, decidedBy: 'user' as const, at: resolution.at, ...(resolution.note !== undefined && { note: resolution.note }) };
      return {
        value: 'recorded',
        apply: () => {
          live.attempt = { ...(live.attempt as Extract<DispatchAttempt, { state: 'unknown' }>), resolution: decided };
          if (resolution.decision !== 'retry') return;
          // Retry abandons the attempt but keeps it; the receive count does not change (CR2 §2).
          live.abandoned = true;
          row.state = 'pending';
          if (row.kind === 'provision') row.target = canonicalJson(provisionTarget(parse<DeliveryTarget>(row.target), 'pending'));
        },
      };
    });
  }

  recordOutcome(operationId: OperationId, outcome: OperationOutcome): Promise<WriteResult> {
    return this.run<WriteResult>('recordOutcome', () => {
      const row = this.rows.get(operationId);
      if (row === undefined) return { value: 'stale' };
      if (row.outcome !== undefined) return { value: canonicalJson(row.outcome) === canonicalJson(outcome) ? 'recorded' : 'stale' };
      return { value: 'recorded', apply: () => (row.outcome = copy(outcome)) };
    });
  }

  endUnclaimed(operationIds: OperationId[], outcome: OperationOutcome): Promise<EndUnclaimedResult> {
    return this.run<EndUnclaimedResult>('endUnclaimed', () => {
      const rows = operationIds.map((id) => this.rows.get(id)).filter((r): r is Row => r !== undefined);
      // Claimed now (T065 r3): nothing of the set is written, in one step, as `claim` is one step.
      const inFlight = rows.filter((r) => r.state === 'unknown' && r.outcome === undefined).map((r) => r.operationId);
      if (inFlight.length > 0) return { value: { status: 'in-flight', operationIds: inFlight } };
      const open = rows.filter((r) => r.state === 'pending' && r.outcome === undefined);
      return {
        value: { status: 'ended', ended: open.map((r) => r.operationId) },
        apply: () => {
          for (const r of open) r.outcome = copy(outcome);
        },
      };
    });
  }

  findBySourceCallRef(sourceCallRef: string): Promise<StoredDelivery | undefined> {
    return this.run('findBySourceCallRef', () => {
      const row = [...this.rows.values()].find((r) => r.sourceCallRef === sourceCallRef);
      return { value: row === undefined ? undefined : this.load(row) };
    });
  }

  get(operationId: OperationId): Promise<StoredDelivery | undefined> {
    return this.run('get', () => {
      const row = this.rows.get(operationId);
      return { value: row === undefined ? undefined : this.load(row) };
    });
  }

  listByState(state: DeliveryRecord['state']): Promise<StoredDelivery[]> {
    return this.run('listByState', () => ({
      value: [...this.rows.values()]
        .filter((r) => r.state === state)
        .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0))
        .map((r) => this.load(r)),
    }));
  }

  listByTarget(sessionId: SessionId): Promise<StoredDelivery[]> {
    return this.run('listByTarget', () => ({
      value: [...this.rows.values()]
        .filter((r) => (JSON.parse(r.target) as DeliveryTarget).sessionId === sessionId)
        .sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0))
        .map((r) => this.load(r)),
    }));
  }

  /**
   * Runs one atomic body after yielding once, so concurrent callers interleave between calls but never
   * inside one. `apply` is the write; it runs only when the body commits.
   */
  private async run<T>(method: Method, body: () => { value: T; apply?: () => void }): Promise<T> {
    this.calls.push(method);
    await Promise.resolve();
    const index = this.faults.findIndex((f) => f.method === method);
    const fault = index === -1 ? undefined : this.faults.splice(index, 1)[0]?.fault;
    if (fault === 'hang') return new Promise<T>(() => undefined);
    if (fault === 'error') throw new Error(`injected ${method} failure`);
    const { value, apply } = body();
    if (fault === 'uncertain' && apply !== undefined) throw new CommitUncertainError(`injected uncertain ${method} commit (not applied)`);
    apply?.();
    if (fault === 'uncertain-applied' && apply !== undefined) throw new CommitUncertainError(`injected uncertain ${method} commit (applied)`);
    return copy(value);
  }

  private load(row: Row): StoredDelivery {
    const base = {
      operationId: row.operationId,
      ...(row.sourceCallRef !== undefined && { sourceCallRef: row.sourceCallRef }),
      ...(row.sender !== undefined && { sender: row.sender }),
      ...(row.outcome !== undefined && { outcome: copy(row.outcome) }),
      payloadHash: row.payloadHash,
      proposalRevision: row.proposalRevision,
      target: parse<DeliveryTarget>(row.target),
      delivery: { state: row.state, attempts: row.attempts.map((a) => copy(a.attempt)) },
      acceptedAt: row.acceptedAt,
    };
    if (row.kind === 'provision') return { ...base, kind: 'provision', spec: parse<{ spec: ProvisionSpec }>(row.body).spec };
    const body = parse<{ payload: string; context: PayloadContext; handoff?: HandoffMeta; peer?: PeerMeta }>(row.body);
    return { ...base, ...body, kind: row.kind };
  }

  private sameAcceptance(row: Row, input: AcceptInput): boolean {
    return (
      row.kind === input.kind &&
      row.payloadHash === input.payloadHash &&
      row.proposalRevision === input.proposalRevision &&
      row.acceptedTarget === canonicalJson(input.target) &&
      row.body === canonicalJson(bodyOf(input)) &&
      row.sender === input.sender &&
      canonicalJson(row.countKeys) === canonicalJson((input.counts ?? []).map((c) => c.key))
    );
  }

  private liveUnknown(row: Row, attemptId: AttemptId) {
    const live = row.attempts.find((a) => !a.abandoned);
    return live?.attempt.attemptId === attemptId && live.attempt.state === 'unknown' ? live : undefined;
  }

  /** As T007: the binding a waiting payload may take, read from its provision's own records. */
  private binding(row: Row): { status: 'waiting' } | { status: 'mismatch' } | { status: 'bound'; target: DeliveryTarget } {
    const accepted = parse<DeliveryTarget>(row.acceptedTarget);
    if (accepted.provision === undefined) return { status: 'mismatch' };
    const provision = this.rows.get(accepted.provision.operationId);
    if (provision === undefined) return { status: 'waiting' };
    if (provision.kind !== 'provision') return { status: 'mismatch' };
    const record = parse<DeliveryTarget>(provision.target).provision;
    const sessionId = parse<{ spec: ProvisionSpec }>(provision.body).spec.sessionId;
    if (record === undefined || provision.bindingKey !== accepted.provision.bindingKey) return { status: 'mismatch' };
    if (accepted.sessionId !== undefined && accepted.sessionId !== sessionId) return { status: 'mismatch' };
    if (provision.state !== 'sent') return { status: 'waiting' };
    const live = provision.attempts.find((a) => !a.abandoned)?.attempt;
    const created = live?.state === 'sent' ? live.nativeRef.sessionRef : undefined;
    if (created === undefined || record.nativeSessionRef !== created) return { status: 'mismatch' };
    if (accepted.nativeSessionRef !== undefined && accepted.nativeSessionRef !== created) return { status: 'mismatch' };
    return { status: 'bound', target: { sessionId, nativeSessionRef: created, provision: record } };
  }

  private payloadBlocked(row: Row, target: DeliveryTarget, input: ClaimInput): 'target-not-ready' | 'target-changed' | undefined {
    const accepted = parse<DeliveryTarget>(row.acceptedTarget);
    if (accepted.provision === undefined) {
      if (row.target !== row.acceptedTarget) return 'target-changed';
      if (target.sessionId === undefined || target.nativeSessionRef === undefined) return 'target-not-ready';
    } else {
      const binding = this.binding(row);
      if (binding.status === 'mismatch') return 'target-changed';
      if (binding.status === 'waiting') return 'target-not-ready';
      if (target.nativeSessionRef === undefined || target.provision?.state !== 'sent') return 'target-not-ready';
      if (row.target !== canonicalJson(binding.target)) return 'target-changed';
    }
    return input.expectedNativeSessionRef === target.nativeSessionRef ? undefined : 'target-changed';
  }

  private provisionBlocked(target: DeliveryTarget, input: ClaimInput): 'target-changed' | undefined {
    if (input.expectedNativeSessionRef === undefined) return undefined;
    return input.expectedNativeSessionRef === (target.nativeSessionRef ?? target.provision?.nativeSessionRef) ? undefined : 'target-changed';
  }

  private refMatchesTarget(row: Row, target: DeliveryTarget, nativeRef: NativeRef): boolean {
    if (row.kind !== 'provision') return nativeRef.sessionRef === target.nativeSessionRef;
    const expected = parse<{ spec: ProvisionSpec }>(row.body).spec.preallocatedRef ?? target.provision?.nativeSessionRef ?? target.nativeSessionRef;
    return expected === undefined || nativeRef.sessionRef === expected;
  }
}

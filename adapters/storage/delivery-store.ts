// CR-2 delivery records on SQLite (T007): implements `DeliveryStore` (core/ports/delivery.ts) following
// CR2_DELIVERY_FIX §1-5 and R-04 steps 3-7. Every method is one transaction; the only way to dispatch is
// a committed conditional `pending → unknown` in `claim`. Each method body is synchronous, so two async
// callers in this process cannot interleave inside one, and `BEGIN IMMEDIATE` serialises other
// connections and processes.
import type { DatabaseSync } from 'node:sqlite';
import type {
  AttemptId,
  ClientMessageId,
  DeliveryEvidence,
  DeliveryRecord,
  DeliveryTarget,
  DispatchAttempt,
  NativeRef,
  OperationId,
  ProvisionRecord,
} from '../../contracts';
import type {
  AcceptInput,
  AcceptResult,
  ClaimInput,
  ClaimResult,
  DeliveryStore,
  PayloadContext,
  ProvisionSpec,
  StoredDelivery,
  WriteResult,
} from '../../core/ports';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';

interface DeliveryRow {
  operation_id: string;
  kind: StoredDelivery['kind'];
  source_call_ref: string | null;
  payload_hash: string;
  proposal_revision: number;
  accepted_target: string;
  target: string;
  body: string;
  state: DeliveryRecord['state'];
  accepted_at: string;
}

interface AttemptRow {
  attempt_id: string;
  client_message_id: string;
  state: DispatchAttempt['state'];
  dispatch_started_at: string;
  native_ref: string | null;
  evidence: string | null;
  resolution: string | null;
  abandoned: number;
}

/** JSON with object keys sorted and undefined dropped, so equal values are equal text. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

const parse = <T>(text: string): T => JSON.parse(text) as T;

const bodyOf = (input: AcceptInput) => (input.kind === 'provision' ? { spec: input.spec } : { payload: input.payload, context: input.context });

/** A provision's own target mirrors its delivery state and, once created, the new session (CR2 §3). */
const provisionTarget = (target: DeliveryTarget, state: DeliveryRecord['state'], createdRef?: string): DeliveryTarget => {
  if (target.provision === undefined) return target;
  const provision: ProvisionRecord = { ...target.provision, state, ...(createdRef !== undefined && { nativeSessionRef: createdRef }) };
  return { ...target, provision, ...(createdRef !== undefined && { nativeSessionRef: createdRef }) };
};

const toAttempt = (row: AttemptRow): DispatchAttempt => {
  const base = {
    attemptId: row.attempt_id as AttemptId,
    clientMessageId: row.client_message_id as ClientMessageId,
    dispatchStartedAt: row.dispatch_started_at,
  };
  if (row.state === 'sent' && row.native_ref !== null && row.evidence !== null) {
    const resolution = row.resolution === null ? {} : { resolution: parse<Extract<DispatchAttempt, { state: 'sent' }>['resolution']>(row.resolution) };
    return { ...base, state: 'sent', nativeRef: parse<NativeRef>(row.native_ref), evidence: parse<DeliveryEvidence>(row.evidence), ...resolution };
  }
  const resolution = row.resolution === null ? {} : { resolution: parse<Extract<DispatchAttempt, { state: 'unknown' }>['resolution']>(row.resolution) };
  return { ...base, state: 'unknown', ...resolution };
};

export class SqliteDeliveryStore implements DeliveryStore {
  constructor(private readonly db: DatabaseSync) {}

  accept(input: AcceptInput): Promise<AcceptResult> {
    return this.run(() =>
      writeTransaction<AcceptResult>(this.db, () => {
        const existing = this.row(input.operationId);
        if (existing !== undefined) {
          const record = this.load(existing);
          // Same operationId: a resend if every fixed part matches, otherwise rejected (R-04 step 3).
          return unchanged(this.sameAcceptance(existing, input) ? { status: 'duplicate', record } : { status: 'conflict', existing: record });
        }

        let target = input.target;
        let bindingKey: string | undefined;
        if (input.kind === 'provision') {
          const provision = input.target.provision;
          if (provision?.operationId !== input.operationId) {
            throw new TypeError('a provision is accepted with target.provision describing itself (operationId and bindingKey)');
          }
          bindingKey = provision.bindingKey;
          const other = this.db.prepare('SELECT operation_id FROM provision WHERE binding_key = ?').get(bindingKey) as { operation_id: string } | undefined;
          if (other !== undefined) return unchanged({ status: 'conflict', existing: this.load(this.mustRow(other.operation_id)) });
          target = provisionTarget(target, 'pending');
        }

        let count: number | undefined;
        if (input.count !== undefined) {
          const counted = this.receiveCount(input.count.key);
          if (input.count.limit !== undefined && counted >= input.count.limit) {
            return unchanged({ status: 'limit-exceeded', count: counted, limit: input.count.limit });
          }
          count = counted + 1;
        }

        this.db
          .prepare(
            `INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision, accepted_target, target, body, state, accepted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            input.operationId,
            input.kind,
            input.sourceCallRef ?? null,
            input.payloadHash,
            input.proposalRevision,
            canonicalJson(input.target),
            canonicalJson(target),
            canonicalJson(bodyOf(input)),
            input.at,
          );
        if (bindingKey !== undefined) this.db.prepare('INSERT INTO provision (operation_id, binding_key) VALUES (?, ?)').run(input.operationId, bindingKey);
        if (input.count !== undefined) this.db.prepare('INSERT INTO receive_admission (operation_id, count_key) VALUES (?, ?)').run(input.operationId, input.count.key);

        const record = this.load(this.mustRow(input.operationId));
        return committed(count === undefined ? { status: 'accepted', record } : { status: 'accepted', record, count });
      }),
    );
  }

  updateTarget(operationId: OperationId, expected: DeliveryTarget, next: DeliveryTarget): Promise<WriteResult> {
    return this.run(() =>
      writeTransaction<WriteResult>(this.db, () => {
        const row = this.row(operationId);
        if (row === undefined || row.state !== 'pending' || row.target !== canonicalJson(expected)) return unchanged('stale');
        if (row.kind === 'provision' && (next.provision?.operationId !== operationId || next.provision.bindingKey !== expected.provision?.bindingKey)) {
          throw new TypeError('a provision keeps its own operationId and binding key');
        }
        const updated = this.db
          .prepare("UPDATE delivery SET target = ? WHERE operation_id = ? AND state = 'pending' AND target = ?")
          .run(canonicalJson(next), operationId, row.target);
        return updated.changes === 1 ? committed('recorded') : unchanged('stale');
      }),
    );
  }

  claim(input: ClaimInput): Promise<ClaimResult> {
    return this.run(() =>
      writeTransaction<ClaimResult>(this.db, () => {
        const row = this.row(input.operationId);
        if (row === undefined) return unchanged({ status: 'not-found' });
        if (row.state !== 'pending') return unchanged({ status: 'not-pending' });
        // Re-checked inside the transaction (R-04 step 5).
        if (row.proposal_revision !== input.expectedProposalRevision) return unchanged({ status: 'revision-changed' });
        const target = parse<DeliveryTarget>(row.target);
        const blocked = row.kind === 'provision' ? this.provisionBlocked(target, input) : this.payloadBlocked(target, input);
        if (blocked !== undefined) return unchanged({ status: blocked });

        // The single conditional update that decides the one dispatcher (CR2_DELIVERY_FIX §1 step 3).
        const claimed = this.db.prepare("UPDATE delivery SET state = 'unknown' WHERE operation_id = ? AND state = 'pending' RETURNING operation_id").get(input.operationId);
        if (claimed === undefined) return unchanged({ status: 'not-pending' });
        const seq = (this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM dispatch_attempt WHERE operation_id = ?').get(input.operationId) as { seq: number }).seq;
        this.db
          .prepare(
            `INSERT INTO dispatch_attempt (attempt_id, operation_id, seq, client_message_id, state, dispatch_started_at)
             VALUES (?, ?, ?, ?, 'unknown', ?)`,
          )
          .run(input.attemptId, input.operationId, seq, input.clientMessageId, input.at);
        if (row.kind === 'provision') this.setTarget(input.operationId, provisionTarget(target, 'unknown'));
        return committed({
          status: 'claimed',
          attempt: { state: 'unknown', attemptId: input.attemptId, clientMessageId: input.clientMessageId, dispatchStartedAt: input.at },
        });
      }),
    );
  }

  recordSent(operationId: OperationId, attemptId: AttemptId, nativeRef: NativeRef, evidence: DeliveryEvidence): Promise<WriteResult> {
    return this.run(() =>
      writeTransaction<WriteResult>(this.db, () => {
        const row = this.row(operationId);
        if (row?.state !== 'unknown' || !this.isLiveUnknown(operationId, attemptId)) return unchanged('stale');
        const target = parse<DeliveryTarget>(row.target);
        if (!this.refMatchesTarget(row, target, nativeRef)) return unchanged('stale');

        // Conditioned on operationId + attemptId + unknown (CR2_DELIVERY_FIX §1 step 5).
        const sent = this.db
          .prepare("UPDATE dispatch_attempt SET state = 'sent', native_ref = ?, evidence = ? WHERE attempt_id = ? AND operation_id = ? AND state = 'unknown' AND abandoned = 0")
          .run(canonicalJson(nativeRef), canonicalJson(evidence), attemptId, operationId);
        const delivered = this.db.prepare("UPDATE delivery SET state = 'sent' WHERE operation_id = ? AND state = 'unknown'").run(operationId);
        if (sent.changes !== 1 || delivered.changes !== 1) throw new Error(`delivery ${operationId} changed inside its own transaction`);
        if (row.kind === 'provision') this.setTarget(operationId, provisionTarget(target, 'sent', nativeRef.sessionRef));
        return committed('recorded');
      }),
    );
  }

  recordResolution(
    operationId: OperationId,
    attemptId: AttemptId,
    resolution: { decision: 'wait' | 'cancel' | 'retry'; at: string; note?: string },
  ): Promise<WriteResult> {
    return this.run(() =>
      writeTransaction<WriteResult>(this.db, () => {
        const row = this.row(operationId);
        if (row?.state !== 'unknown' || !this.isLiveUnknown(operationId, attemptId)) return unchanged('stale');
        const decided = canonicalJson({ decision: resolution.decision, decidedBy: 'user', at: resolution.at, note: resolution.note });
        if (resolution.decision !== 'retry') {
          this.db.prepare('UPDATE dispatch_attempt SET resolution = ? WHERE attempt_id = ?').run(decided, attemptId);
          return committed('recorded');
        }
        // Retry abandons the attempt but keeps it; the receive count does not change (CR2 §2).
        this.db.prepare('UPDATE dispatch_attempt SET resolution = ?, abandoned = 1 WHERE attempt_id = ?').run(decided, attemptId);
        this.db.prepare("UPDATE delivery SET state = 'pending' WHERE operation_id = ? AND state = 'unknown'").run(operationId);
        if (row.kind === 'provision') this.setTarget(operationId, provisionTarget(parse<DeliveryTarget>(row.target), 'pending'));
        return committed('recorded');
      }),
    );
  }

  get(operationId: OperationId): Promise<StoredDelivery | undefined> {
    return this.run(() =>
      readTransaction(this.db, () => {
        const row = this.row(operationId);
        return row === undefined ? undefined : this.load(row);
      }),
    );
  }

  listByState(state: DeliveryRecord['state']): Promise<StoredDelivery[]> {
    return this.run(() =>
      readTransaction(this.db, () =>
        (this.db.prepare('SELECT * FROM delivery WHERE state = ? ORDER BY accepted_at, rowid').all(state) as unknown as DeliveryRow[]).map((row) => this.load(row)),
      ),
    );
  }

  /** The bodies are synchronous; a throw becomes a rejection. */
  private run<T>(body: () => T): Promise<T> {
    return new Promise((resolve) => resolve(body()));
  }

  private row(operationId: string): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM delivery WHERE operation_id = ?').get(operationId) as DeliveryRow | undefined;
  }

  private mustRow(operationId: string): DeliveryRow {
    const row = this.row(operationId);
    if (row === undefined) throw new Error(`delivery ${operationId} is missing`);
    return row;
  }

  private load(row: DeliveryRow): StoredDelivery {
    const attempts = (this.db.prepare('SELECT * FROM dispatch_attempt WHERE operation_id = ? ORDER BY seq').all(row.operation_id) as unknown as AttemptRow[]).map(toAttempt);
    const base = {
      operationId: row.operation_id as OperationId,
      ...(row.source_call_ref !== null && { sourceCallRef: row.source_call_ref }),
      payloadHash: row.payload_hash,
      proposalRevision: row.proposal_revision,
      target: parse<DeliveryTarget>(row.target),
      delivery: { state: row.state, attempts },
      acceptedAt: row.accepted_at,
    };
    if (row.kind === 'provision') return { ...base, kind: 'provision', spec: parse<{ spec: ProvisionSpec }>(row.body).spec };
    const body = parse<{ payload: string; context: PayloadContext }>(row.body);
    return { ...base, kind: row.kind, payload: body.payload, context: body.context };
  }

  private sameAcceptance(row: DeliveryRow, input: AcceptInput): boolean {
    const admission = this.db.prepare('SELECT count_key FROM receive_admission WHERE operation_id = ?').get(row.operation_id) as { count_key: string } | undefined;
    return (
      row.kind === input.kind &&
      row.payload_hash === input.payloadHash &&
      row.proposal_revision === input.proposalRevision &&
      row.accepted_target === canonicalJson(input.target) &&
      row.body === canonicalJson(bodyOf(input)) &&
      admission?.count_key === input.count?.key
    );
  }

  private receiveCount(key: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM receive_admission WHERE count_key = ?').get(key) as { n: number }).n;
  }

  private setTarget(operationId: string, target: DeliveryTarget) {
    this.db.prepare('UPDATE delivery SET target = ? WHERE operation_id = ?').run(canonicalJson(target), operationId);
  }

  private liveAttempt(operationId: string): AttemptRow | undefined {
    return this.db.prepare('SELECT * FROM dispatch_attempt WHERE operation_id = ? AND abandoned = 0').get(operationId) as AttemptRow | undefined;
  }

  private isLiveUnknown(operationId: string, attemptId: string): boolean {
    const live = this.liveAttempt(operationId);
    return live?.attempt_id === attemptId && live.state === 'unknown';
  }

  /** The session a sent provision created, read from its own record rather than from a snapshot. */
  private createdSession(provisionOperationId: string): string | undefined {
    const row = this.row(provisionOperationId);
    if (row?.kind !== 'provision' || row.state !== 'sent') return undefined;
    const live = this.liveAttempt(provisionOperationId);
    return live?.native_ref == null ? undefined : parse<NativeRef>(live.native_ref).sessionRef;
  }

  /** A payload leaves the GUI only to a bound target whose provision, if any, is sent (CR2 §2-3). */
  private payloadBlocked(target: DeliveryTarget, input: ClaimInput): 'target-not-ready' | 'target-changed' | undefined {
    if (target.sessionId === undefined || target.nativeSessionRef === undefined) return 'target-not-ready';
    if (target.provision !== undefined) {
      if (target.provision.state !== 'sent') return 'target-not-ready';
      const created = this.createdSession(target.provision.operationId);
      if (created === undefined) return 'target-not-ready';
      if (created !== target.nativeSessionRef) return 'target-changed';
    }
    return input.expectedNativeSessionRef === target.nativeSessionRef ? undefined : 'target-changed';
  }

  private provisionBlocked(target: DeliveryTarget, input: ClaimInput): 'target-changed' | undefined {
    if (input.expectedNativeSessionRef === undefined) return undefined;
    return input.expectedNativeSessionRef === (target.nativeSessionRef ?? target.provision?.nativeSessionRef) ? undefined : 'target-changed';
  }

  /** Evidence must point at this delivery's target; a pre-allocated session must be the one created. */
  private refMatchesTarget(row: DeliveryRow, target: DeliveryTarget, nativeRef: NativeRef): boolean {
    if (row.kind !== 'provision') return nativeRef.sessionRef === target.nativeSessionRef;
    const expected = parse<{ spec: ProvisionSpec }>(row.body).spec.preallocatedRef ?? target.provision?.nativeSessionRef ?? target.nativeSessionRef;
    return expected === undefined || nativeRef.sessionRef === expected;
  }
}

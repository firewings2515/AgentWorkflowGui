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
  OperationOutcome,
  ProvisionRecord,
  SessionId,
} from '../../contracts';
import { DeliveryTarget as TargetSchema, DispatchAttempt as AttemptSchema, OperationOutcome as OutcomeSchema } from '../../contracts';
import type {
  AcceptInput,
  AcceptResult,
  ClaimInput,
  ClaimResult,
  DeliveryStore,
  ProvisionSpec,
  StoredDelivery,
  WriteResult,
} from '../../core/ports';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';
import { checkRecord, epochMs, InvalidRecordError, readRecord, StoredDataError } from './codec';
import { readDeliveryBody, validateDelivery } from './delivery-codec';

interface DeliveryRow {
  operation_id: string;
  kind: StoredDelivery['kind'];
  source_call_ref: string | null;
  sender: string | null;
  outcome: string | null;
  metadata_required: number;
  payload_hash: string;
  proposal_revision: number;
  accepted_target: string;
  target: string;
  body: string;
  state: DeliveryRecord['state'];
  accepted_at: string;
}

interface AttemptRow {
  seq: number;
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

const parse = <T>(text: string): T => {
  try { return JSON.parse(text) as T; }
  catch { throw new StoredDataError('delivery', ['$:json']); }
};

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

const toAttempt = (row: AttemptRow): DispatchAttempt => {
  if ((row.state === 'sent') !== (row.native_ref !== null && row.evidence !== null) ||
    (row.state === 'unknown' && (row.native_ref !== null || row.evidence !== null))) throw new StoredDataError('dispatch_attempt', ['evidence:mismatch']);
  const base = {
    attemptId: row.attempt_id as AttemptId,
    clientMessageId: row.client_message_id as ClientMessageId,
    dispatchStartedAt: row.dispatch_started_at,
  };
  if (row.state === 'sent' && row.native_ref !== null && row.evidence !== null) {
    const resolution = row.resolution === null ? {} : { resolution: parse<Extract<DispatchAttempt, { state: 'sent' }>['resolution']>(row.resolution) };
    return readRecord(AttemptSchema, 'dispatch_attempt', JSON.stringify({ ...base, state: 'sent', nativeRef: parse<NativeRef>(row.native_ref), evidence: parse<DeliveryEvidence>(row.evidence), ...resolution }));
  }
  const resolution = row.resolution === null ? {} : { resolution: parse<Extract<DispatchAttempt, { state: 'unknown' }>['resolution']>(row.resolution) };
  return readRecord(AttemptSchema, 'dispatch_attempt', JSON.stringify({ ...base, state: row.state, ...resolution }));
};

export class SqliteDeliveryStore implements DeliveryStore {
  constructor(private readonly db: DatabaseSync) {}

  accept(input: AcceptInput): Promise<AcceptResult> {
    return this.run(() =>
      writeTransaction<AcceptResult>(this.db, () => {
        let target: DeliveryTarget;
        try {
          checkRecord(TargetSchema, 'delivery', input.target);
          target = input.kind === 'provision' ? provisionTarget(input.target, 'pending') : input.target;
          validateDelivery({
            ...bodyOf(input), kind: input.kind, operationId: input.operationId, sourceCallRef: input.sourceCallRef,
            sender: input.sender, payloadHash: input.payloadHash, proposalRevision: input.proposalRevision,
            target, acceptedAt: input.at, delivery: { state: 'pending', attempts: [] },
            ...('handoff' in input && { handoff: input.handoff }), ...('peer' in input && { peer: input.peer }),
          }, true);
        } catch (error) {
          if (error instanceof InvalidRecordError) return unchanged({ status: 'invalid', detail: 'invalid delivery acceptance' });
          throw error;
        }
        // A transfer payload belongs to its approved proposal (CR-5): one that does not match it is refused
        // here, before it could make every later read of the proposal fail closed (T022 r2 P2-1).
        if (input.kind === 'transfer' && this.transferMismatch(input.operationId, input.payloadHash, input.proposalRevision)) {
          return unchanged({ status: 'invalid', detail: 'the transfer delivery does not match its approved proposal' });
        }
        const existing = this.row(input.operationId);
        if (existing !== undefined) {
          const record = this.load(existing);
          // Same operationId: a resend if every fixed part matches, otherwise rejected (R-04 step 3).
          return unchanged(this.sameAcceptance(existing, input) ? { status: 'duplicate', record } : { status: 'conflict', existing: record });
        }

        let bindingKey: string | undefined;
        if (input.kind === 'provision') {
          const provision = input.target.provision;
          if (provision?.operationId !== input.operationId) {
            return unchanged({ status: 'invalid', detail: 'invalid delivery acceptance' });
          }
          bindingKey = provision.bindingKey;
          const other = this.db.prepare('SELECT operation_id FROM provision WHERE binding_key = ?').get(bindingKey) as { operation_id: string } | undefined;
          if (other !== undefined) return unchanged({ status: 'conflict', existing: this.load(this.mustRow(other.operation_id)) });
        }

        // Indexed lookups run under BEGIN IMMEDIATE; unique indexes also enforce these identities.
        if (input.sourceCallRef !== undefined) {
          const other = this.db.prepare('SELECT * FROM delivery WHERE source_call_ref = ?').get(input.sourceCallRef) as DeliveryRow | undefined;
          if (other !== undefined) return unchanged({ status: 'conflict', existing: this.load(other) });
        }
        if (input.kind === 'handoff' || input.kind === 'peer-message') {
          const other = this.loadProjection(input.kind, input.kind === 'handoff' ? input.handoff!.handoffId : input.peer!.peerMessageId);
          if (other !== undefined) return unchanged({ status: 'conflict', existing: other });
        }

        const counts: { key: string; count: number }[] = [];
        for (const c of input.counts ?? []) {
          if (typeof c.key !== 'string' || !c.key || (c.limit !== undefined && (!Number.isSafeInteger(c.limit) || c.limit < 0)) || counts.some((v) => v.key === c.key)) {
            return unchanged({ status: 'invalid', detail: 'invalid receive count' });
          }
          const counted = this.receiveCount(c.key);
          if (c.limit !== undefined && counted >= c.limit) return unchanged({ status: 'limit-exceeded', key: c.key, count: counted, limit: c.limit });
          counts.push({ key: c.key, count: counted + 1 });
        }

        this.db
          .prepare(
            `INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision, accepted_target, target, body, state, accepted_at, accepted_ms, sender, metadata_required)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)`,
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
            epochMs(input.at),
            input.sender ?? null,
          );
        if (bindingKey !== undefined) this.db.prepare('INSERT INTO provision (operation_id, binding_key) VALUES (?, ?)').run(input.operationId, bindingKey);
        counts.forEach((c, ordinal) => this.db.prepare('INSERT INTO receive_admission (operation_id, count_key, ordinal) VALUES (?, ?, ?)').run(input.operationId, c.key, ordinal));

        const record = this.load(this.mustRow(input.operationId));
        return committed(counts.length === 0 ? { status: 'accepted', record } : { status: 'accepted', record, counts });
      }),
    );
  }

  updateTarget(operationId: OperationId, expected: DeliveryTarget, next: DeliveryTarget): Promise<WriteResult> {
    return this.run(() =>
      writeTransaction<WriteResult>(this.db, () => {
        const row = this.row(operationId);
        if (row !== undefined) this.load(row);
        if (row === undefined || row.state !== 'pending' || row.target !== canonicalJson(expected)) return unchanged('stale');
        // Setting the target it already has is applied by definition: nothing changes, so nothing is written.
        if (canonicalJson(next) === row.target) return unchanged('recorded');
        // The destination is fixed at acceptance (R-04 step 3): the only change is moving a payload that waits
        // for its own provision to exactly the binding that provision's records give (the created session,
        // its sessionId and its sent ProvisionRecord). A provision's target follows its own state.
        if (row.kind === 'provision') return unchanged('stale');
        const binding = this.binding(row);
        if (binding.status !== 'bound' || canonicalJson(next) !== canonicalJson(binding.target)) return unchanged('stale');
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
        this.load(row);
        if (row.state !== 'pending') return unchanged({ status: 'not-pending' });
        // Re-checked inside the transaction (R-04 step 5).
        if (row.proposal_revision !== input.expectedProposalRevision) return unchanged({ status: 'revision-changed' });
        const target = parse<DeliveryTarget>(row.target);
        const blocked = row.kind === 'provision' ? this.provisionBlocked(target, input) : this.payloadBlocked(row, target, input);
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
        if (row !== undefined) this.load(row);
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
        if (row !== undefined) this.load(row);
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
        (this.db.prepare('SELECT * FROM delivery WHERE state = ? ORDER BY accepted_ms, rowid').all(state) as unknown as DeliveryRow[]).map((row) => this.load(row)),
      ),
    );
  }

  listByTarget(sessionId: SessionId): Promise<StoredDelivery[]> {
    return this.run(() =>
      readTransaction(this.db, () =>
        (this.db
          .prepare("SELECT * FROM delivery WHERE (CASE WHEN json_valid(target) THEN json_extract(target, '$.sessionId') END) = ? ORDER BY accepted_ms, rowid")
          .all(sessionId) as unknown as DeliveryRow[]).map((row) => this.load(row)),
      ),
    );
  }

  recordOutcome(operationId: OperationId, outcome: OperationOutcome): Promise<WriteResult> {
    return this.run(() => writeTransaction<WriteResult>(this.db, () => {
      const row = this.row(operationId);
      if (row === undefined) return unchanged('stale');
      this.load(row);
      const text = canonicalJson(checkRecord(OutcomeSchema, 'delivery', outcome));
      if (row.outcome !== null) return unchanged(canonicalJson(readRecord(OutcomeSchema, 'delivery', row.outcome)) === text ? 'recorded' : 'stale');
      this.db.prepare('UPDATE delivery SET outcome = ? WHERE operation_id = ? AND outcome IS NULL').run(text, operationId);
      return committed('recorded');
    }));
  }

  findBySourceCallRef(sourceCallRef: string): Promise<StoredDelivery | undefined> {
    return this.run(() => readTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM delivery WHERE source_call_ref = ?').get(sourceCallRef) as DeliveryRow | undefined;
      return row === undefined ? undefined : this.load(row);
    }));
  }

  /** Internal synchronous readers: caller owns the transaction (repository projections/snapshot). */
  loadById(operationId: string): StoredDelivery | undefined {
    const row = this.row(operationId);
    return row === undefined ? undefined : this.load(row);
  }

  loadAll(): StoredDelivery[] {
    return (this.db.prepare('SELECT * FROM delivery ORDER BY accepted_ms, rowid').all() as unknown as DeliveryRow[]).map((row) => this.load(row));
  }

  loadProjection(kind: 'handoff' | 'peer-message', id: string): StoredDelivery | undefined {
    const field = kind === 'handoff' ? 'handoff.handoffId' : 'peer.peerMessageId';
    const row = this.db.prepare(`SELECT * FROM delivery WHERE kind = '${kind}' AND
      CASE WHEN json_valid(body) THEN json_extract(body, '$.${field}') END = ?`).get(id) as DeliveryRow | undefined;
    return row === undefined ? undefined : this.load(row);
  }

  /** True when a proposal names this operation and is not approved for exactly this payload and revision. */
  private transferMismatch(operationId: string, payloadHash: string, proposalRevision: number): boolean {
    const row = this.db
      .prepare("SELECT body FROM transfer_proposal WHERE CASE WHEN json_valid(body) THEN json_extract(body, '$.operationId') END = ?")
      .get(operationId) as { body: string } | undefined;
    if (row === undefined) return false;
    const proposal = JSON.parse(row.body) as { payloadHash?: unknown; approvedRevision?: unknown };
    return proposal.payloadHash !== payloadHash || proposal.approvedRevision !== proposalRevision;
  }

  loadProjections(kind: 'handoff' | 'peer-message', instanceId?: string): StoredDelivery[] {
    // The instance is in the kind's own facts: `$.handoff.instanceId` or `$.peer.instanceId` (T022 r2 P2-3).
    const path = kind === 'handoff' ? '$.handoff.instanceId' : '$.peer.instanceId';
    const filter = instanceId === undefined ? '' : ` AND CASE WHEN json_valid(body) THEN json_extract(body, '${path}') END = ?`;
    const rows = this.db.prepare(`SELECT * FROM delivery WHERE kind = '${kind}'${filter} ORDER BY accepted_ms, rowid`)
      .all(...(instanceId === undefined ? [] : [instanceId])) as unknown as DeliveryRow[];
    return rows.map((row) => this.load(row));
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
    if (row.metadata_required !== 0 && row.metadata_required !== 1) throw new StoredDataError('delivery', ['metadata:flag']);
    readRecord(TargetSchema, 'delivery', row.accepted_target);
    const admissions = this.db.prepare('SELECT count_key, ordinal FROM receive_admission WHERE operation_id = ? ORDER BY ordinal').all(row.operation_id);
    if (admissions.some((a, i) => typeof a.count_key !== 'string' || a.count_key.length === 0 || a.ordinal !== i)) {
      throw new StoredDataError('receive_admission', ['count:invalid']);
    }
    const attemptRows = this.db.prepare('SELECT * FROM dispatch_attempt WHERE operation_id = ? ORDER BY seq').all(row.operation_id) as unknown as AttemptRow[];
    if (attemptRows.some((a, i) => a.seq !== i + 1 || (a.abandoned !== 0 && a.abandoned !== 1))) throw new StoredDataError('dispatch_attempt', ['sequence:invalid']);
    const attempts = attemptRows.map(toAttempt);
    if (attemptRows.some((a, i) => (a.abandoned === 1) !== (attempts[i]?.resolution?.decision === 'retry'))) throw new StoredDataError('dispatch_attempt', ['abandoned:mismatch']);
    const base = {
      operationId: row.operation_id as OperationId,
      ...(row.source_call_ref !== null && { sourceCallRef: row.source_call_ref }),
      ...(row.sender !== null && { sender: row.sender as SessionId }),
      ...(row.outcome !== null && { outcome: readRecord(OutcomeSchema, 'delivery', row.outcome) }),
      payloadHash: row.payload_hash,
      proposalRevision: row.proposal_revision,
      target: parse<DeliveryTarget>(row.target),
      delivery: { state: row.state, attempts },
      acceptedAt: row.accepted_at,
    };
    if (row.kind === 'provision') {
      const record = validateDelivery({ ...readDeliveryBody(row.kind, row.body), ...base, kind: 'provision' });
      const link = this.db.prepare('SELECT binding_key FROM provision WHERE operation_id = ?').get(row.operation_id);
      if (link?.binding_key !== record.target.provision?.bindingKey) throw new StoredDataError('provision', ['binding:mismatch']);
      return record;
    }
    const body = readDeliveryBody(row.kind, row.body);
    const record = validateDelivery({ ...body, ...base, kind: row.kind });
    if (row.metadata_required === 1 && ((record.kind === 'handoff' && record.handoff === undefined) || (record.kind === 'peer-message' && record.peer === undefined))) {
      throw new StoredDataError('delivery', ['metadata:missing']);
    }
    return record;
  }

  private sameAcceptance(row: DeliveryRow, input: AcceptInput): boolean {
    const admissions = this.db.prepare('SELECT count_key FROM receive_admission WHERE operation_id = ? ORDER BY ordinal').all(row.operation_id) as { count_key: string }[];
    return (
      row.kind === input.kind &&
      row.payload_hash === input.payloadHash &&
      row.proposal_revision === input.proposalRevision &&
      row.accepted_target === canonicalJson(input.target) &&
      row.body === canonicalJson(bodyOf(input)) &&
      row.sender === (input.sender ?? null) &&
      canonicalJson(admissions.map((a) => a.count_key)) === canonicalJson((input.counts ?? []).map((c) => c.key))
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

  /**
   * The binding a payload that waits for a provision may take, read from the provision's own records
   * rather than from the payload's snapshot: `waiting` until that provision is sent, `mismatch` when the
   * accepted target does not describe that provision (operationId, binding key, session) consistently.
   */
  private binding(row: DeliveryRow): { status: 'waiting' } | { status: 'mismatch' } | { status: 'bound'; target: DeliveryTarget } {
    const accepted = parse<DeliveryTarget>(row.accepted_target);
    if (accepted.provision === undefined) return { status: 'mismatch' };
    const provision = this.row(accepted.provision.operationId);
    if (provision === undefined) return { status: 'waiting' };
    if (provision.kind !== 'provision') return { status: 'mismatch' };
    const bindingKey = (this.db.prepare('SELECT binding_key FROM provision WHERE operation_id = ?').get(provision.operation_id) as { binding_key: string } | undefined)?.binding_key;
    const record = parse<DeliveryTarget>(provision.target).provision;
    const sessionId = parse<{ spec: ProvisionSpec }>(provision.body).spec.sessionId;
    if (record === undefined || bindingKey !== accepted.provision.bindingKey) return { status: 'mismatch' };
    if (accepted.sessionId !== undefined && accepted.sessionId !== sessionId) return { status: 'mismatch' };
    if (provision.state !== 'sent') return { status: 'waiting' };
    const live = this.liveAttempt(provision.operation_id);
    const created = live?.native_ref == null ? undefined : parse<NativeRef>(live.native_ref).sessionRef;
    if (created === undefined || record.nativeSessionRef !== created) return { status: 'mismatch' };
    if (accepted.nativeSessionRef !== undefined && accepted.nativeSessionRef !== created) return { status: 'mismatch' };
    return { status: 'bound', target: { sessionId, nativeSessionRef: created, provision: record } };
  }

  /**
   * A payload leaves the GUI only to the target fixed at acceptance: as accepted, or bound to the session
   * its own provision created (CR2 §2-3). The whole target is checked, not only the native ref.
   */
  private payloadBlocked(row: DeliveryRow, target: DeliveryTarget, input: ClaimInput): 'target-not-ready' | 'target-changed' | undefined {
    const accepted = parse<DeliveryTarget>(row.accepted_target);
    if (accepted.provision === undefined) {
      if (row.target !== row.accepted_target) return 'target-changed';
      if (target.sessionId === undefined || target.nativeSessionRef === undefined) return 'target-not-ready';
    } else {
      const binding = this.binding(row);
      if (binding.status === 'mismatch') return 'target-changed';
      if (binding.status === 'waiting') return 'target-not-ready';
      // Bound means the target names a session and a created provision, whether it was accepted that way
      // or moved there by updateTarget; it must then be exactly the provision's own binding.
      if (target.nativeSessionRef === undefined || target.provision?.state !== 'sent') return 'target-not-ready';
      if (row.target !== canonicalJson(binding.target)) return 'target-changed';
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

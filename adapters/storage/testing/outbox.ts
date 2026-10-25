// The CR-2 outbox scenarios' moving parts, ported from spike/review-followup/cr2-outbox.mjs: a receiver
// ledger standing in for the runtime (its own SQLite file, so a crashed process cannot lose what it
// received), and a minimal dispatcher that crosses the boundary the way T008 must. Kept free of zod so
// the child process bundle stays small.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AttemptId, ClientMessageId, DeliveryEvidence, DispatchAttempt, NativeRef, OperationId } from '../../../contracts';
import type { ClaimResult, DeliveryStore, StoredDelivery } from '../../../core/ports';

export type Stage = 'before-call' | 'after-receive' | 'after-ack' | 'sent';
export type Proof = { nativeRef: NativeRef; evidence: DeliveryEvidence };
type UnknownAttempt = Extract<DispatchAttempt, { state: 'unknown' }>;

export interface Received {
  n: number;
  operation_id: string;
  session_ref: string;
  payload_hash: string;
  attempt_id: string;
  client_message_id: string;
}

const openReceiver = (path: string) => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS received (n INTEGER PRIMARY KEY, operation_id TEXT, session_ref TEXT, payload_hash TEXT, attempt_id TEXT, client_message_id TEXT)',
  );
  return db;
};

export const createReceiver = (path: string) => openReceiver(path).close();

/** The runtime accepting the payload: recorded durably, then acknowledged with a live ack. */
export const receive = (path: string, record: StoredDelivery, attempt: UnknownAttempt): Proof => {
  const db = openReceiver(path);
  try {
    const sessionRef = record.target.nativeSessionRef ?? '';
    const { lastInsertRowid } = db
      .prepare('INSERT INTO received (operation_id, session_ref, payload_hash, attempt_id, client_message_id) VALUES (?, ?, ?, ?, ?)')
      .run(record.operationId, sessionRef, record.payloadHash, attempt.attemptId, attempt.clientMessageId);
    return {
      nativeRef: { sessionRef, itemRef: `item-${String(lastInsertRowid)}` },
      evidence: { kind: 'live-ack', at: new Date().toISOString(), detail: `accepted ${attempt.clientMessageId}` },
    };
  } finally {
    db.close();
  }
};

export const receivedRows = (path: string): Received[] => {
  const db = openReceiver(path);
  try {
    return db.prepare('SELECT * FROM received ORDER BY n').all() as unknown as Received[];
  } finally {
    db.close();
  }
};

/**
 * One dispatch through the store: claim (committed `pending → unknown`), only then call the receiver
 * once, then record sent for this attempt. `checkpoint` lets a test crash the process at each step.
 */
export const dispatch = async (
  store: DeliveryStore,
  operationId: OperationId,
  call: (record: StoredDelivery, attempt: UnknownAttempt) => Proof | Promise<Proof>,
  checkpoint: (stage: Stage) => Promise<void> = () => Promise.resolve(),
): Promise<Exclude<ClaimResult['status'], 'claimed'> | 'sent' | 'stale'> => {
  const record = await store.get(operationId);
  if (record === undefined) return 'not-found';
  const claim = await store.claim({
    operationId,
    expectedProposalRevision: record.proposalRevision,
    ...(record.kind !== 'provision' && record.target.nativeSessionRef !== undefined && { expectedNativeSessionRef: record.target.nativeSessionRef }),
    attemptId: `attempt-${randomUUID()}` as AttemptId,
    clientMessageId: randomUUID() as ClientMessageId,
    at: new Date().toISOString(),
  });
  if (claim.status !== 'claimed') return claim.status;
  await checkpoint('before-call');
  const proof = await call(record, claim.attempt);
  await checkpoint('after-receive');
  await checkpoint('after-ack');
  const written = await store.recordSent(operationId, claim.attempt.attemptId, proof.nativeRef, proof.evidence);
  await checkpoint('sent');
  return written === 'recorded' ? 'sent' : 'stale';
};

/**
 * Read-only reconciliation against the receiver, as an adapter's `reconcile` would do it: exactly one
 * entry with the live attempt's clientMessageId and the same content counts; anything else stays unknown.
 */
export const reconcile = async (store: DeliveryStore, operationId: OperationId, receiverPath: string): Promise<StoredDelivery['delivery']['state']> => {
  const record = await store.get(operationId);
  if (record === undefined) throw new Error(`no delivery ${operationId}`);
  const live = record.delivery.attempts.at(-1);
  if (record.delivery.state !== 'unknown' || live === undefined) return record.delivery.state;
  const matches = receivedRows(receiverPath).filter((r) => r.client_message_id === live.clientMessageId);
  const [match] = matches;
  if (matches.length !== 1 || match === undefined || match.payload_hash !== record.payloadHash) return 'unknown';
  const written = await store.recordSent(
    operationId,
    live.attemptId,
    { sessionRef: match.session_ref, itemRef: `item-${match.n}` },
    { kind: 'reconciled', at: new Date().toISOString(), detail: `receiver entry ${match.n}` },
  );
  return written === 'recorded' ? 'sent' : ((await store.get(operationId))?.delivery.state ?? 'unknown');
};

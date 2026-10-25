// Schema migrations (T007). Each migration runs once, in order, inside the same transaction that records
// it in `schema_migration`; a database written by a newer app is refused instead of being guessed at.
import type { DatabaseSync } from 'node:sqlite';
import { committed, unchanged, writeTransaction } from './transaction';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * v1: CR-2 delivery records (CR2_DELIVERY_FIX §5). JSON columns hold contract-shaped values written by
 * this adapter in canonical form (sorted keys), so equal values compare equal as text.
 */
const deliveryV1 = `
CREATE TABLE delivery (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'peer-message', 'transfer', 'user-message', 'provision')),
  source_call_ref TEXT,
  payload_hash TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 0),
  -- The target as accepted, compared when the same operationId arrives again.
  accepted_target TEXT NOT NULL,
  -- The current binding: changed only by compare-and-set while pending, or as a provision progresses.
  target TEXT NOT NULL,
  -- {payload, context} for a payload, {spec} for a provision.
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'sent')),
  accepted_at TEXT NOT NULL
) STRICT;
CREATE INDEX delivery_by_state ON delivery (state, accepted_at);

-- One row per crossing of the dispatch boundary. Only a user retry abandons an attempt (CR2 §2).
CREATE TABLE dispatch_attempt (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES delivery (operation_id),
  seq INTEGER NOT NULL,
  client_message_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'sent')),
  dispatch_started_at TEXT NOT NULL,
  native_ref TEXT,
  evidence TEXT,
  resolution TEXT,
  abandoned INTEGER NOT NULL DEFAULT 0 CHECK (abandoned IN (0, 1)),
  UNIQUE (operation_id, seq),
  CHECK ((state = 'sent') = (native_ref IS NOT NULL AND evidence IS NOT NULL)),
  CHECK (abandoned = 0 OR state = 'unknown')
) STRICT;
-- At most one live (not abandoned) attempt per operation.
CREATE UNIQUE INDEX dispatch_attempt_live ON dispatch_attempt (operation_id) WHERE abandoned = 0;

-- Creating a target session (CR2 §3). The binding key is unique, so two provisions cannot race to
-- create the same target.
CREATE TABLE provision (
  operation_id TEXT PRIMARY KEY REFERENCES delivery (operation_id),
  binding_key TEXT NOT NULL UNIQUE
) STRICT;

-- Receive counting (R-04 step 3): one row per counted operation, so the primary key keeps an operationId
-- from being counted twice; the count for a key is the number of its rows.
CREATE TABLE receive_admission (
  operation_id TEXT PRIMARY KEY REFERENCES delivery (operation_id),
  count_key TEXT NOT NULL
) STRICT;
CREATE INDEX receive_admission_by_key ON receive_admission (count_key);
`;

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'delivery', sql: deliveryV1 }];

export const latestVersion = (migrations: readonly Migration[] = MIGRATIONS): number => migrations.at(-1)?.version ?? 0;

/** Brings the database up to the latest version; returns the version it is at afterwards. */
export const migrate = (db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number =>
  writeTransaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const row = db.prepare('SELECT max(version) AS version FROM schema_migration').get() as { version: number | null } | undefined;
    const current = row?.version ?? 0;
    const latest = latestVersion(migrations);
    if (current > latest) throw new Error(`database schema version ${current} is newer than this app supports (${latest})`);
    const pending = migrations.filter((m) => m.version > current);
    if (pending.length === 0) return unchanged(current);
    const record = db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    }
    return committed(latest);
  });

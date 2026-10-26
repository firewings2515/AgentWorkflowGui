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

/**
 * v2: the records the GUI shows (T015, core/ports/repository.ts). `body` is the contract-shaped record as
 * JSON, validated with its schema when read. Columns beside it exist only to find, order and guard rows:
 * `revision` for compare-and-set, `*_ms` (UTC epoch ms) so timestamps with different offsets sort right.
 * Text over the blob threshold moves to `blob`, keyed by its owner so replacing a record replaces its blobs.
 */
const repositoriesV2 = `
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  body TEXT NOT NULL
) STRICT;

CREATE TABLE workflow (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  body TEXT NOT NULL
) STRICT;

CREATE TABLE logical_session (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_ms INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;

-- Runtime-observed records of a session, oldest first by (at_ms, rowid). An upsert keeps the row, so the
-- order of arrival survives later updates.
CREATE TABLE turn (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX turn_by_session ON turn (session_id, at_ms);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX message_by_session ON message (session_id, at_ms);

CREATE TABLE session_item (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX session_item_by_session ON session_item (session_id, at_ms);

CREATE TABLE native_task (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX native_task_by_session ON native_task (session_id, at_ms);

CREATE TABLE permission_request (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX permission_request_by_session ON permission_request (session_id, at_ms);

-- Artifacts are listed in the order they first appeared (their updatedAt moves), so only rowid orders
-- them; at_ms and has_blob keep the columns the same as their siblings'.
CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES logical_session (id),
  at_ms INTEGER NOT NULL,
  has_blob INTEGER NOT NULL DEFAULT 0 CHECK (has_blob IN (0, 1)),
  body TEXT NOT NULL
) STRICT;
CREATE INDEX artifact_by_session ON artifact (session_id);

CREATE TABLE blob (
  kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  field TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (kind, owner_id, field)
) STRICT;

CREATE TABLE escalation (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE INDEX escalation_by_state ON escalation (state, created_ms);

-- At most one row (the GUI has one set of preferences).
CREATE TABLE preference (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL
) STRICT;

-- A process is its PID and creation time (PIDs are reused, R-14). body omits endedAt, kept in its column.
CREATE TABLE owned_process (
  pid INTEGER NOT NULL,
  started_ms INTEGER NOT NULL,
  recorded_ms INTEGER NOT NULL,
  ended_at TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (pid, started_ms)
) STRICT;
CREATE INDEX owned_process_live ON owned_process (recorded_ms) WHERE ended_at IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'delivery', sql: deliveryV1 },
  { version: 2, name: 'repositories', sql: repositoriesV2 },
];

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

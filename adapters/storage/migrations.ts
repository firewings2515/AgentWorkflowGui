// Schema migrations (T007). Each migration runs once, in order, inside the same transaction that records
// it in `schema_migration`; a database written by a newer app is refused instead of being guessed at.
import type { DatabaseSync } from 'node:sqlite';
import { TARGET_SESSION_V7 } from './delivery-target-query';
import { committed, unchanged, writeTransaction } from './transaction';
import { storageHealth } from './health';

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
 * Text over the blob threshold moves to `blob` (stored JSON-encoded, see codec.ts), keyed by its owner so
 * replacing a record replaces its blobs.
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
  -- sha256 of content; content is the JSON encoding of the text, so NUL and lone surrogates survive.
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

-- A process is its PID and creation time (PIDs are reused, R-14); started_key is that instant at full
-- precision (codec.ts instantKey). body omits endedAt, kept in its column.
CREATE TABLE owned_process (
  pid INTEGER NOT NULL,
  started_key TEXT NOT NULL,
  recorded_ms INTEGER NOT NULL,
  ended_at TEXT,
  body TEXT NOT NULL,
  PRIMARY KEY (pid, started_key)
) STRICT;
CREATE INDEX owned_process_live ON owned_process (recorded_ms) WHERE ended_at IS NULL;
`;

/**
 * v3: records written under contracts 0.4 read under 0.5 (T020 review r1 P1-5). Agents and workflow
 * templates carry the contracts version; an MCP elicitation names its server in `server` too (C-04).
 * Nothing else stored under 0.4 changed shape: the new fields are optional, and a payload stored without
 * an origin is dispatched as not the user's (C-01).
 */
const contracts05V3 = `
UPDATE agent SET body = json_set(body, '$.schemaVersion', '0.5.0') WHERE json_extract(body, '$.schemaVersion') = '0.4.0';
UPDATE workflow SET body = json_set(body, '$.schemaVersion', '0.5.0') WHERE json_extract(body, '$.schemaVersion') = '0.4.0';
UPDATE permission_request SET body = json_set(body, '$.server', json_extract(body, '$.elicitation.serverName'))
  WHERE json_extract(body, '$.elicitation.serverName') IS NOT NULL AND json_extract(body, '$.server') IS NULL;
`;

/** v4: atomic multi-count admissions and workflow/transfer persistence (T022). */
const storage05V4 = `
ALTER TABLE delivery ADD COLUMN sender TEXT;
ALTER TABLE delivery ADD COLUMN outcome TEXT;
-- Older payloads did not always carry projection metadata. Never invent missing facts.
ALTER TABLE delivery ADD COLUMN metadata_required INTEGER NOT NULL DEFAULT 0 CHECK (metadata_required IN (0, 1));
CREATE INDEX delivery_by_source_call ON delivery (source_call_ref);
ALTER TABLE receive_admission RENAME TO receive_admission_v1;
DROP INDEX receive_admission_by_key;
CREATE TABLE receive_admission (
  operation_id TEXT NOT NULL REFERENCES delivery (operation_id),
  count_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (operation_id, count_key),
  UNIQUE (operation_id, ordinal)
) STRICT;
INSERT INTO receive_admission SELECT operation_id, count_key, 0 FROM receive_admission_v1;
DROP TABLE receive_admission_v1;
CREATE INDEX receive_admission_by_key ON receive_admission (count_key);
CREATE TABLE workflow_instance (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_ms INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
CREATE TABLE node_session (
  instance_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  -- Empty task means the root; contract task IDs are nonempty.
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (instance_id, node_id, task_id)
) STRICT;
CREATE TABLE transfer_proposal (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_ms INTEGER NOT NULL,
  body TEXT NOT NULL
) STRICT;
`;

/** v5: indexed identities, chronological delivery ordering and pending transfer links. */
const storageReviewV5 = `
ALTER TABLE delivery ADD COLUMN accepted_ms INTEGER NOT NULL DEFAULT 0;
-- Parse whole seconds, truncate fractions like Date.parse, and apply the offset as integer math.
-- This avoids SQLite rounding sub-ms fractions or restricting otherwise valid ISO offsets.
-- An unparsable time becomes 0 (T022 r2 P2-2): the migration still opens the database, and reading the
-- record then fails closed on its acceptedAt, as for any other damaged row.
UPDATE delivery SET accepted_ms = coalesce(CAST(strftime('%s', substr(accepted_at, 1, 19)) AS INTEGER) * 1000
  + CASE WHEN substr(accepted_at, 20, 1) = '.' THEN CAST(substr(substr(accepted_at, 21,
      length(accepted_at) - 20 - CASE WHEN substr(accepted_at, -1) = 'Z' THEN 1 ELSE 6 END) || '000', 1, 3) AS INTEGER) ELSE 0 END
  - CASE WHEN substr(accepted_at, -1) = 'Z' THEN 0 ELSE
      (CASE WHEN substr(accepted_at, -6, 1) = '+' THEN 1 ELSE -1 END)
      * (CAST(substr(accepted_at, -5, 2) AS INTEGER) * 60 + CAST(substr(accepted_at, -2) AS INTEGER)) * 60000 END, 0);
DROP INDEX delivery_by_state;
CREATE INDEX delivery_by_state ON delivery (state, accepted_ms);
DROP INDEX delivery_by_source_call;
CREATE UNIQUE INDEX delivery_by_source_call ON delivery (source_call_ref) WHERE source_call_ref IS NOT NULL;
-- Guard JSON extraction so unrelated damaged bodies do not prevent accepting new operations.
CREATE UNIQUE INDEX delivery_handoff_id ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.handoff.handoffId') END) WHERE kind = 'handoff';
CREATE UNIQUE INDEX delivery_peer_id ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.peer.peerMessageId') END) WHERE kind = 'peer-message';
CREATE INDEX delivery_handoff_instance ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.handoff.instanceId') END, accepted_ms) WHERE kind = 'handoff';
-- v4 kept only the identity. Recover known preallocation facts from the accepted provision, if any.
UPDATE transfer_proposal SET body = json_set(body, '$.provision', json_patch(
  coalesce((SELECT json_set(json_extract(d.accepted_target, '$.provision'), '$.state', 'pending')
    FROM delivery d WHERE d.operation_id = json_extract(transfer_proposal.body, '$.provision.operationId') AND d.kind = 'provision'),
    json_object('state', 'pending', 'preallocated', json('false'))), json_extract(body, '$.provision')))
  WHERE json_type(body, '$.provision') = 'object';
`;

/**
 * v6: records written under contracts 0.5 read under 0.6 (T028). Agents, workflow templates and the template
 * pinned in each instance carry the contracts version. Everything else new in 0.6 is optional or has a
 * default. Projects (C-17) are saved like the definitions. Indexes and the other 0.6 tables come with T029.
 */
const contracts06V6 = `
UPDATE agent SET body = json_set(body, '$.schemaVersion', '0.6.0') WHERE json_extract(body, '$.schemaVersion') = '0.5.0';
UPDATE workflow SET body = json_set(body, '$.schemaVersion', '0.6.0') WHERE json_extract(body, '$.schemaVersion') = '0.5.0';
UPDATE workflow_instance SET body = json_set(body, '$.template.schemaVersion', '0.6.0') WHERE json_extract(body, '$.template.schemaVersion') = '0.5.0';
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  body TEXT NOT NULL
) STRICT;
`;

/** v7: target lookup, including the NULL bucket of unbound/undecidable targets (T029, C-20). */
const storage06V7 = `
CREATE INDEX delivery_by_target ON delivery (${TARGET_SESSION_V7}, accepted_ms);
`;

/**
 * v8: records written under contracts 0.6 read under 0.7 (T037). Agents, workflow templates, projects and the
 * template pinned in each instance carry the contracts version; everything new in 0.7 is optional or has a
 * default (preferences without `supervisor` read with its defaults). Paging indexes, backups and the
 * `system-notice` delivery kind come with T038.
 */
const contracts07V8 = `
UPDATE agent SET body = json_set(body, '$.schemaVersion', '0.7.0') WHERE json_extract(body, '$.schemaVersion') = '0.6.0';
UPDATE workflow SET body = json_set(body, '$.schemaVersion', '0.7.0') WHERE json_extract(body, '$.schemaVersion') = '0.6.0';
UPDATE project SET body = json_set(body, '$.schemaVersion', '0.7.0') WHERE json_extract(body, '$.schemaVersion') = '0.6.0';
UPDATE workflow_instance SET body = json_set(body, '$.template.schemaVersion', '0.7.0') WHERE json_extract(body, '$.template.schemaVersion') = '0.6.0';
`;

// Rebuild with foreign_keys disabled outside the transaction. Preserve rowid (arrival ordering),
// every column and every index, including the exact frozen v7 index text.
const storage07V9 = `
CREATE TABLE delivery_v9 (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('handoff', 'peer-message', 'transfer', 'user-message', 'provision', 'system-notice')),
  source_call_ref TEXT,
  payload_hash TEXT NOT NULL,
  proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 0),
  accepted_target TEXT NOT NULL,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'sent')),
  accepted_at TEXT NOT NULL,
  sender TEXT,
  outcome TEXT,
  metadata_required INTEGER NOT NULL DEFAULT 0 CHECK (metadata_required IN (0, 1)),
  accepted_ms INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO delivery_v9 (rowid, operation_id, kind, source_call_ref, payload_hash, proposal_revision,
  accepted_target, target, body, state, accepted_at, sender, outcome, metadata_required, accepted_ms)
  SELECT rowid, * FROM delivery;
DROP TABLE delivery;
ALTER TABLE delivery_v9 RENAME TO delivery;
CREATE INDEX delivery_by_state ON delivery (state, accepted_ms);
CREATE UNIQUE INDEX delivery_by_source_call ON delivery (source_call_ref) WHERE source_call_ref IS NOT NULL;
CREATE UNIQUE INDEX delivery_handoff_id ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.handoff.handoffId') END) WHERE kind = 'handoff';
CREATE UNIQUE INDEX delivery_peer_id ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.peer.peerMessageId') END) WHERE kind = 'peer-message';
CREATE INDEX delivery_handoff_instance ON delivery
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.handoff.instanceId') END, accepted_ms) WHERE kind = 'handoff';
CREATE INDEX delivery_by_target ON delivery (${TARGET_SESSION_V7}, accepted_ms);
ALTER TABLE delivery ADD COLUMN target_ambiguous INTEGER NOT NULL DEFAULT 0;
CREATE INDEX delivery_ambiguous ON delivery (target_ambiguous) WHERE target_ambiguous = 1;
UPDATE delivery SET target_ambiguous = CASE WHEN json_valid(target) THEN EXISTS (
  SELECT 1 FROM json_tree(target) WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1
) ELSE 0 END;
CREATE TRIGGER delivery_target_insert AFTER INSERT ON delivery BEGIN
  UPDATE delivery SET target_ambiguous = CASE WHEN json_valid(NEW.target) THEN EXISTS (
    SELECT 1 FROM json_tree(NEW.target) WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1
  ) ELSE 0 END WHERE operation_id = NEW.operation_id;
END;
CREATE TRIGGER delivery_target_update AFTER UPDATE OF target ON delivery BEGIN
  UPDATE delivery SET target_ambiguous = CASE WHEN json_valid(NEW.target) THEN EXISTS (
    SELECT 1 FROM json_tree(NEW.target) WHERE key IS NOT NULL GROUP BY parent, key HAVING count(*) > 1
  ) ELSE 0 END WHERE operation_id = NEW.operation_id;
END;
`;

const pagingV10 = ['turn', 'message', 'session_item', 'native_task', 'permission_request', 'artifact'].map((table) => `
ALTER TABLE ${table} ADD COLUMN history_turn TEXT GENERATED ALWAYS AS
  (CASE WHEN json_valid(body) THEN json_extract(body, '$.turnId') END) VIRTUAL;
CREATE INDEX ${table}_history_turn ON ${table} (session_id, history_turn, at_ms);
ALTER TABLE ${table} ADD COLUMN history_open INTEGER GENERATED ALWAYS AS
  (CASE WHEN json_valid(body) THEN ${table === 'turn' ? "json_extract(body, '$.state') = 'running'" : table === 'permission_request' ? "json_extract(body, '$.state') IN ('pending', 'held')" : table === 'native_task' ? "json_extract(body, '$.endedAt') IS NULL" : '0'} ELSE 1 END) VIRTUAL;
CREATE INDEX ${table}_history_open ON ${table} (session_id, history_open, at_ms);
`).join('\n') + '\nCREATE INDEX artifact_history_time ON artifact (session_id, at_ms);\n';

/**
 * v11: records written under contracts 0.7 read under 0.8 (T048). Agents, workflow templates, projects and the
 * template pinned in each instance carry the contracts version; everything new in 0.8 is optional (a session without
 * an Agent, `autoTitle`, `workFolderRoot`, a run's two folders), so sessions, preferences and instances keep their
 * bodies. The work folder claims (core/ports/work-folders.ts): one per session, a path claimed once without case;
 * `made` (with the real path then) only once this program's make created the folder.
 */
const contracts08V11 = `
UPDATE agent SET body = json_set(body, '$.schemaVersion', '0.8.0') WHERE json_extract(body, '$.schemaVersion') = '0.7.0';
UPDATE workflow SET body = json_set(body, '$.schemaVersion', '0.8.0') WHERE json_extract(body, '$.schemaVersion') = '0.7.0';
UPDATE project SET body = json_set(body, '$.schemaVersion', '0.8.0') WHERE json_extract(body, '$.schemaVersion') = '0.7.0';
UPDATE workflow_instance SET body = json_set(body, '$.template.schemaVersion', '0.8.0') WHERE json_extract(body, '$.template.schemaVersion') = '0.7.0';
CREATE TABLE work_folder_claim (
  session_id TEXT PRIMARY KEY,
  instance_id TEXT,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  day TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'made')),
  made_real TEXT CHECK ((state = 'made') = (made_real IS NOT NULL)),
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX work_folder_claim_by_day ON work_folder_claim (day, seq);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'delivery', sql: deliveryV1 },
  { version: 2, name: 'repositories', sql: repositoriesV2 },
  { version: 3, name: 'contracts-0.5', sql: contracts05V3 },
  { version: 4, name: 'storage-0.5', sql: storage05V4 },
  { version: 5, name: 'storage-0.5-review', sql: storageReviewV5 },
  { version: 6, name: 'contracts-0.6', sql: contracts06V6 },
  { version: 7, name: 'storage-0.6', sql: storage06V7 },
  { version: 8, name: 'contracts-0.7', sql: contracts07V8 },
  { version: 9, name: 'storage-0.7-delivery', sql: storage07V9 },
  { version: 10, name: 'storage-0.7-history', sql: pagingV10 },
  { version: 11, name: 'contracts-0.8', sql: contracts08V11 },
];

export const latestVersion = (migrations: readonly Migration[] = MIGRATIONS): number => migrations.at(-1)?.version ?? 0;

/** Brings the database up to the latest version; returns the version it is at afterwards. */
export const migrate = (db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number => {
  const health = storageHealth(db);
  delete health.failedMigrationVersion;
  let applying: number | undefined;
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  db.exec('PRAGMA foreign_keys = OFF');
  try { return writeTransaction(db, () => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const row = db.prepare('SELECT max(version) AS version FROM schema_migration').get() as { version: number | null } | undefined;
    const current = row?.version ?? 0;
    const latest = latestVersion(migrations);
    if (current > latest) throw new Error(`database schema version ${current} is newer than this app supports (${latest})`);
    const pending = migrations.filter((m) => m.version > current);
    if (pending.length === 0) return unchanged(current);
    const record = db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)');
    for (const m of pending) {
      applying = m.version;
      if (!storageHealth(db).hooks?.migration(db, m.sql)) db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('schema:foreign-key');
    return committed(latest);
  }); } catch (error) {
    health.failedMigrationVersion = applying;
    throw error;
  } finally { db.exec(`PRAGMA foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`); }
};

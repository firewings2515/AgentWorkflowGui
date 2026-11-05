// What the runtimes showed in a session (T015): turns, completed messages, the latest item state, native
// tasks, permission requests and artifacts. Every kind has the same row shape (id, session, time, body);
// text over the blob threshold (a message's `text`, a command's `output`, a file change's `diff`) is kept
// apart in `blob` and joined back when read (IMPLEMENTATION_DRAFT §5).
import type { z } from 'zod';
import type { SQLInputValue, StatementSync } from 'node:sqlite';
import {
  Artifact,
  Message,
  NativeTask,
  PermissionRequest,
  SessionItem,
  Turn,
  type HistoryPage,
  type HistoryCursor,
  type SessionId,
} from '../../contracts';
import type { Conversation, ConversationRepository } from '../../core/ports';
import { InvalidRecordError, StoredDataError, checkRecord, epochMs, joinBlobs, readRecord, run, splitBlobs, writeBlobs, type StorageContext } from './codec';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';
import { checkHistoryLimit, HistoryCursors, type HistoryBoundary } from './history';

interface Kind<T extends { id: string; sessionId: string }> {
  table: 'turn' | 'message' | 'session_item' | 'native_task' | 'permission_request' | 'artifact';
  schema: z.ZodType<T>;
  /** The time rows are ordered by. */
  at: (record: T) => string;
  /** Fields that move to `blob` when large. */
  blobFields: (record: T) => readonly string[];
  /** Listed in arrival order (rowid) rather than by time. */
  byArrival: boolean;
}

const kind = <T extends { id: string; sessionId: string }>(spec: Omit<Kind<T>, 'blobFields' | 'byArrival'> & Partial<Pick<Kind<T>, 'blobFields' | 'byArrival'>>): Kind<T> => ({
  blobFields: () => [],
  byArrival: false,
  ...spec,
});

const KINDS = {
  turn: kind<Turn>({ table: 'turn', schema: Turn, at: (r) => r.startedAt }),
  message: kind<Message>({ table: 'message', schema: Message, at: (r) => r.createdAt, blobFields: () => ['text'] }),
  item: kind<SessionItem>({
    table: 'session_item',
    schema: SessionItem,
    at: (r) => r.startedAt,
    blobFields: (r) => (r.kind === 'command' ? ['output'] : r.kind === 'fileChange' ? ['diff'] : []),
  }),
  nativeTask: kind<NativeTask>({ table: 'native_task', schema: NativeTask, at: (r) => r.startedAt }),
  permissionRequest: kind<PermissionRequest>({ table: 'permission_request', schema: PermissionRequest, at: (r) => r.createdAt }),
  artifact: kind<Artifact>({ table: 'artifact', schema: Artifact, at: (r) => r.updatedAt, byArrival: true }),
};

interface Row {
  id: string;
  session_id: string;
  has_blob: number;
  body: string;
}

/** Turns looked up per statement when a page gathers their records. */
const TURN_LIST = 50;

export class SqliteConversationRepository implements ConversationRepository {
  private readonly cursors = new HistoryCursors();
  private readonly statements = new Map<string, StatementSync>();
  constructor(private readonly ctx: StorageContext) {}

  private historyStatement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.ctx.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  upsertTurn(turn: Turn): Promise<void> {
    return run(() => this.upsert(KINDS.turn, turn));
  }

  page(sessionId: SessionId, before: HistoryCursor, limitTurns: number): Promise<HistoryPage | 'invalid-cursor'> {
    return run(() => readTransaction(this.ctx.db, () => {
      const boundary = this.cursors.get(sessionId, before);
      if (!boundary) return 'invalid-cursor';
      return this.loadPage(sessionId, limitTurns, boundary);
    }));
  }

  /** Called inside the snapshot's read transaction. Keyset by (time, arrival), never OFFSET. */
  loadPage(sessionId: SessionId, limit: number, before?: HistoryBoundary, includeOpen = false): HistoryPage {
    checkHistoryLimit(limit);
    const db = this.ctx.db;
    // A failed migration leaves the previous schema intact and readable. Do not depend on v10 indexes
    // when opening that database read-only; a full history is explicitly allowed by the Snapshot port.
    if (!db.prepare("SELECT 1 FROM pragma_table_xinfo('turn') WHERE name = 'history_turn'").get()) {
      return { ...this.load(sessionId), sessionId, olderCursor: null };
    }
    const params: SQLInputValue[] = [sessionId];
    if (before) params.push(before.at, before.row);
    params.push(limit + 1);
    const rows = this.historyStatement(`SELECT rowid AS position, at_ms, id, session_id, body, has_blob FROM turn
      WHERE session_id = ? ${before ? 'AND (at_ms, rowid) < (?, ?)' : ''}
      ORDER BY at_ms DESC, rowid DESC LIMIT ?`).all(...params) as unknown as (Row & { position: number; at_ms: number })[];
    const hasOlder = rows.length > limit;
    const selected = rows.slice(0, limit).reverse();
    const first = selected[0];
    const lower = hasOlder && first ? first.at_ms : undefined;
    const turns = new Map(selected.map((row) => [row.id, row]));
    if (!includeOpen) for (const [id, row] of turns) if (this.decode(KINDS.turn, row).state === 'running') turns.delete(id);
    if (includeOpen) {
      for (const row of this.historyStatement('SELECT rowid AS position, at_ms, id, session_id, body, has_blob FROM turn WHERE session_id = ? AND history_open = 1').all(sessionId) as unknown as typeof rows) turns.set(row.id, row);
    }
    const turnRows = [...turns.values()].sort((a, b) => a.at_ms - b.at_ms || a.position - b.position);
    const related = <T extends { id: string; sessionId: string }>(k: Kind<T>): T[] => {
      const found = new Map<string, Row & { position: number; at_ms: number }>();
      const collect = (where: string, values: SQLInputValue[], index = '') => {
        for (const row of this.historyStatement(`SELECT rowid AS position, at_ms, id, session_id, has_blob, body FROM ${k.table} ${index} WHERE session_id = ? AND ${where}${includeOpen ? '' : ' AND history_open = 0'}`).all(sessionId, ...values) as unknown as (Row & { position: number; at_ms: number })[]) found.set(row.id, row);
      };
      // The page's turns in fixed-size lists, each one seek per turn on `<table>_history_turn` (T040). Named, because
      // SQLite otherwise takes `<table>_history_open` (session_id, history_open) for this query and reads the
      // session's whole history once per turn. A short list repeats its first ID, so one statement serves every page.
      const ids = [...turns.keys()];
      for (let i = 0; i < ids.length; i += TURN_LIST) {
        const chunk = ids.slice(i, i + TURN_LIST);
        while (chunk.length < TURN_LIST) chunk.push(chunk[0]!);
        collect(`history_turn IN (${chunk.map(() => '?').join(', ')})`, chunk, `INDEXED BY ${k.table}_history_turn`);
      }
      const timeArgs: SQLInputValue[] = [];
      let timeWhere = 'history_turn IS NULL';
      if (lower !== undefined) { timeWhere += ' AND at_ms >= ?'; timeArgs.push(lower); }
      if (before) { timeWhere += ' AND at_ms < ?'; timeArgs.push(before.at); }
      collect(timeWhere, timeArgs);
      // Runtime events may arrive before their turn record. Such a reference has no turn to page with
      // yet; use the same time window, seeking the session/time index, instead of silently losing it.
      collect(timeWhere.replace('history_turn IS NULL', `history_turn IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM turn WHERE turn.id = ${k.table}.history_turn AND turn.session_id = ${k.table}.session_id
      )`), timeArgs, `INDEXED BY ${k.table === 'artifact' ? 'artifact_history_time' : `${k.table}_by_session`}`);
      if (includeOpen) collect('history_open = 1', []);
      return [...found.values()].sort((a, b) => k.byArrival ? a.position - b.position : a.at_ms - b.at_ms || a.position - b.position).map((r) => this.decode(k, r));
    };
    return {
      sessionId,
      turns: turnRows.map((r) => this.decode(KINDS.turn, r)),
      messages: related(KINDS.message), items: related(KINDS.item), nativeTasks: related(KINDS.nativeTask),
      permissionRequests: related(KINDS.permissionRequest), artifacts: related(KINDS.artifact),
      olderCursor: hasOlder && first ? this.cursors.issue(sessionId, { at: first.at_ms, row: first.position }) : null,
    };
  }

  private decode<T extends { id: string; sessionId: string }>(kind: Kind<T>, row: Row): T {
    const value = readRecord(kind.schema, kind.table, row.has_blob === 1 ? joinBlobs(this.ctx, kind.table, kind.table, row.id, row.body) : row.body);
    if (value.id !== row.id || value.sessionId !== row.session_id) throw new StoredDataError(kind.table, ['identity:mismatch']);
    return value;
  }

  latestMessageMs(sessionId: SessionId): Promise<number | undefined> {
    return run(() => {
      // Newest first on message_by_session (session_id, at_ms); the role and sub-agent checks are those of
      // countsAsLastMessage (Q-17), so usually the first row read is the answer.
      const row = this.historyStatement(`SELECT at_ms FROM message INDEXED BY message_by_session WHERE session_id = ?
        AND json_extract(body, '$.role') IN ('user', 'assistant') AND json_extract(body, '$.nativeTaskId') IS NULL
        ORDER BY at_ms DESC LIMIT 1`).get(sessionId) as { at_ms: number } | undefined;
      return row?.at_ms;
    });
  }

  appendMessage(message: Message): Promise<void> {
    return run(() => {
      const k = KINDS.message;
      writeTransaction(this.ctx.db, () => {
        const parsed = checkRecord(k.schema, k.table, message);
        const { body, blobs } = splitBlobs(this.ctx, parsed, k.blobFields(parsed));
        const result = this.ctx.db
          .prepare(`INSERT INTO ${k.table} (id, session_id, at_ms, has_blob, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
          .run(parsed.id, parsed.sessionId, epochMs(k.at(parsed)), Object.keys(blobs).length > 0 ? 1 : 0, body);
        // A repeat is ignored whole: its blobs must not replace the first write's.
        if (Number(result.changes) === 0) return unchanged(undefined);
        writeBlobs(this.ctx, k.table, parsed.id, blobs);
        return committed(undefined);
      });
    });
  }

  upsertItem(item: SessionItem): Promise<void> {
    return run(() => this.upsert(KINDS.item, item));
  }

  upsertNativeTask(task: NativeTask): Promise<void> {
    return run(() => this.upsert(KINDS.nativeTask, task));
  }

  upsertPermissionRequest(request: PermissionRequest): Promise<void> {
    return run(() => this.upsert(KINDS.permissionRequest, request));
  }

  upsertArtifact(artifact: Artifact): Promise<void> {
    return run(() => this.upsert(KINDS.artifact, artifact));
  }

  get(sessionId: SessionId): Promise<Conversation> {
    return run(() => readTransaction(this.ctx.db, () => this.load(sessionId)));
  }

  /** One session's records, or every session's when `sessionId` is omitted; oldest first. Call inside a transaction. */
  load(sessionId?: SessionId): Conversation {
    return {
      turns: this.loadKind(KINDS.turn, sessionId),
      messages: this.loadKind(KINDS.message, sessionId),
      items: this.loadKind(KINDS.item, sessionId),
      nativeTasks: this.loadKind(KINDS.nativeTask, sessionId),
      permissionRequests: this.loadKind(KINDS.permissionRequest, sessionId),
      artifacts: this.loadKind(KINDS.artifact, sessionId),
    };
  }

  private upsert<T extends { id: string; sessionId: string }>(kind: Kind<T>, record: T): void {
    writeTransaction(this.ctx.db, () => {
      const parsed = checkRecord(kind.schema, kind.table, record);
      const { body, blobs } = splitBlobs(this.ctx, parsed, kind.blobFields(parsed));
      // A record keeps its session: the same ID under another session is a bug, not an update.
      const result = this.ctx.db
        .prepare(
          `INSERT INTO ${kind.table} (id, session_id, at_ms, has_blob, body) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET at_ms = excluded.at_ms, has_blob = excluded.has_blob, body = excluded.body
           WHERE ${kind.table}.session_id = excluded.session_id`,
        )
        .run(parsed.id, parsed.sessionId, epochMs(kind.at(parsed)), Object.keys(blobs).length > 0 ? 1 : 0, body);
      if (Number(result.changes) === 0) throw new InvalidRecordError(kind.table, ['id:other-session']);
      writeBlobs(this.ctx, kind.table, parsed.id, blobs);
      return committed(undefined);
    });
  }

  private loadKind<T extends { id: string; sessionId: string }>(kind: Kind<T>, sessionId: SessionId | undefined): T[] {
    const order = kind.byArrival ? 'rowid' : 'at_ms, rowid';
    const sql = `SELECT id, session_id, has_blob, body FROM ${kind.table} ${sessionId === undefined ? '' : 'WHERE session_id = ?'} ORDER BY ${order}`;
    const statement = this.ctx.db.prepare(sql);
    const rows = (sessionId === undefined ? statement.all() : statement.all(sessionId)) as unknown as Row[];
    return rows.map((row) => this.decode(kind, row));
  }
}

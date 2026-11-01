// What the runtimes showed in a session (T015): turns, completed messages, the latest item state, native
// tasks, permission requests and artifacts. Every kind has the same row shape (id, session, time, body);
// text over the blob threshold (a message's `text`, a command's `output`, a file change's `diff`) is kept
// apart in `blob` and joined back when read (IMPLEMENTATION_DRAFT §5).
import type { z } from 'zod';
import {
  Artifact,
  Message,
  NativeTask,
  PermissionRequest,
  SessionItem,
  Turn,
  type HistoryPage,
  type SessionId,
} from '../../contracts';
import type { Conversation, ConversationRepository } from '../../core/ports';
import { InvalidRecordError, checkRecord, epochMs, joinBlobs, readRecord, run, splitBlobs, writeBlobs, type StorageContext } from './codec';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';

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
  has_blob: number;
  body: string;
}

export class SqliteConversationRepository implements ConversationRepository {
  constructor(private readonly ctx: StorageContext) {}

  upsertTurn(turn: Turn): Promise<void> {
    return run(() => this.upsert(KINDS.turn, turn));
  }

  /** Paging (C-26) comes with T038; until then the Snapshot holds whole histories and no cursor is handed out. */
  page(): Promise<HistoryPage | 'invalid-cursor'> {
    return Promise.resolve('invalid-cursor');
  }

  appendMessage(message: Message): Promise<void> {
    return run(() => {
      const k = KINDS.message;
      const parsed = checkRecord(k.schema, k.table, message);
      writeTransaction(this.ctx.db, () => {
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
    const parsed = checkRecord(kind.schema, kind.table, record);
    writeTransaction(this.ctx.db, () => {
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
    const sql = `SELECT id, has_blob, body FROM ${kind.table} ${sessionId === undefined ? '' : 'WHERE session_id = ?'} ORDER BY ${order}`;
    const statement = this.ctx.db.prepare(sql);
    const rows = (sessionId === undefined ? statement.all() : statement.all(sessionId)) as unknown as Row[];
    return rows.map((row) => readRecord(kind.schema, kind.table, row.has_blob === 1 ? joinBlobs(this.ctx, kind.table, kind.table, row.id, row.body) : row.body));
  }
}

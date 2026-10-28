// Logical sessions (T015): compare-and-set on `revision`, like the definitions; the renderer chooses the
// ID, so creating the same ID again reports `exists` instead of a second session.
import { LogicalSession, type Revision, type SessionId } from '../../contracts';
import type { SaveResult, SessionRepository } from '../../core/ports';
import { StoredDataError, checkRecord, epochMs, readRecord, run, type StorageContext } from './codec';
import { committed, unchanged, writeTransaction } from './transaction';

interface Row {
  revision: number;
  body: string;
}

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly ctx: StorageContext) {}

  list(): Promise<LogicalSession[]> {
    return run(() => this.loadAll());
  }

  get(id: SessionId): Promise<LogicalSession | undefined> {
    return run(() => {
      const row = this.row(id);
      return row === undefined ? undefined : this.read(row);
    });
  }

  create(session: LogicalSession): Promise<'created' | 'exists'> {
    return run(() =>
      writeTransaction<'created' | 'exists'>(this.ctx.db, () => {
        const parsed = checkRecord(LogicalSession, 'session', session);
        const result = this.ctx.db
          .prepare('INSERT INTO logical_session (id, revision, created_ms, body) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
          .run(parsed.id, parsed.revision, epochMs(parsed.createdAt), JSON.stringify(parsed));
        return Number(result.changes) === 1 ? committed('created') : unchanged('exists');
      }),
    );
  }

  update(session: LogicalSession, expectedRevision: Revision): Promise<SaveResult<LogicalSession>> {
    return run(() =>
      writeTransaction<SaveResult<LogicalSession>>(this.ctx.db, () => {
        const parsed = checkRecord(LogicalSession, 'session', session);
        const row = this.row(parsed.id);
        if (row === undefined) return unchanged({ status: 'stale', current: undefined });
        if (row.revision !== expectedRevision) return unchanged({ status: 'stale', current: this.read(row) });
        const stored: LogicalSession = { ...parsed, revision: expectedRevision + 1 };
        this.ctx.db
          .prepare('UPDATE logical_session SET revision = ?, body = ? WHERE id = ? AND revision = ?')
          .run(stored.revision, JSON.stringify(stored), parsed.id, expectedRevision);
        return committed({ status: 'saved', record: stored });
      }),
    );
  }

  /** In creation order. */
  loadAll(): LogicalSession[] {
    return (this.ctx.db.prepare('SELECT revision, body FROM logical_session ORDER BY created_ms, rowid').all() as unknown as Row[]).map((row) => this.read(row));
  }

  private row(id: string): Row | undefined {
    return this.ctx.db.prepare('SELECT revision, body FROM logical_session WHERE id = ?').get(id) as Row | undefined;
  }

  private read(row: Row): LogicalSession {
    const record = readRecord(LogicalSession, 'session', row.body);
    if (record.revision !== row.revision) throw new StoredDataError('session', ['revision:mismatch']);
    return record;
  }
}

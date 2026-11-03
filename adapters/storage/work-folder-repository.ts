// Work folder claims (T048, core/ports/work-folders.ts): which GUI-made folder belongs to which session. A path is
// claimed once, compared without case as Windows does; the claim is written before the folder is made.
import type { InstanceId, SessionId } from '../../contracts';
import type { WorkFolderClaim, WorkFolderClaimRepository } from '../../core/ports';
import { epochMs, run, StoredDataError, type StorageContext } from './codec';
import { committed, unchanged, writeTransaction } from './transaction';

interface Row {
  session_id: string;
  instance_id: string | null;
  path: string;
  day: string;
  seq: number;
  created_at: string;
}

const COLUMNS = 'session_id, instance_id, path, day, seq, created_at';

const claimOf = (row: Row): WorkFolderClaim => {
  if (!Number.isSafeInteger(row.seq) || row.seq < 1 || row.path.length === 0) throw new StoredDataError('work_folder_claim', ['claim:invalid']);
  return {
    sessionId: row.session_id as SessionId,
    ...(row.instance_id !== null && { instanceId: row.instance_id as InstanceId }),
    path: row.path,
    day: row.day,
    seq: row.seq,
    createdAt: row.created_at,
  };
};

export class SqliteWorkFolderClaimRepository implements WorkFolderClaimRepository {
  constructor(private readonly ctx: StorageContext) {}

  get(sessionId: SessionId): Promise<WorkFolderClaim | undefined> {
    return run(() => {
      const row = this.ctx.db.prepare(`SELECT ${COLUMNS} FROM work_folder_claim WHERE session_id = ?`).get(sessionId) as Row | undefined;
      return row === undefined ? undefined : claimOf(row);
    });
  }

  list(): Promise<WorkFolderClaim[]> {
    return run(() => (this.ctx.db.prepare(`SELECT ${COLUMNS} FROM work_folder_claim ORDER BY created_ms, rowid`).all() as unknown as Row[]).map(claimOf));
  }

  listDay(day: string): Promise<WorkFolderClaim[]> {
    return run(() => (this.ctx.db.prepare(`SELECT ${COLUMNS} FROM work_folder_claim WHERE day = ? ORDER BY seq`).all(day) as unknown as Row[]).map(claimOf));
  }

  claim(claim: WorkFolderClaim): Promise<'claimed' | 'taken'> {
    return run(() =>
      writeTransaction<'claimed' | 'taken'>(this.ctx.db, () => {
        const taken = this.ctx.db.prepare('SELECT 1 AS taken FROM work_folder_claim WHERE session_id = ? OR path_key = ?').get(claim.sessionId, claim.path.toLowerCase());
        if (taken !== undefined) return unchanged('taken');
        this.ctx.db
          .prepare('INSERT INTO work_folder_claim (session_id, instance_id, path, path_key, day, seq, created_at, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(claim.sessionId, claim.instanceId ?? null, claim.path, claim.path.toLowerCase(), claim.day, claim.seq, claim.createdAt, epochMs(claim.createdAt));
        return committed('claimed');
      }),
    );
  }

  remove(sessionId: SessionId): Promise<void> {
    return run(() => {
      writeTransaction(this.ctx.db, () => {
        const result = this.ctx.db.prepare('DELETE FROM work_folder_claim WHERE session_id = ?').run(sessionId);
        return Number(result.changes) > 0 ? committed(undefined) : unchanged(undefined);
      });
    });
  }
}

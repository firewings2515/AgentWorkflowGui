// Escalations, preferences and owned processes (T015): small records without revisions to compare.
import {
  Escalation,
  OwnedProcess,
  Timestamp,
  UiPreferences,
  type EscalationId,
} from '../../contracts';
import type { EscalationRepository, OwnedProcessRepository, PreferencesRepository } from '../../core/ports';
import { checkRecord, epochMs, readRecord, run, type StorageContext } from './codec';
import { committed, unchanged, writeTransaction } from './transaction';

interface BodyRow {
  body: string;
}

export class SqliteEscalationRepository implements EscalationRepository {
  constructor(private readonly ctx: StorageContext) {}

  upsert(escalation: Escalation): Promise<void> {
    return run(() => {
      const parsed = checkRecord(Escalation, 'escalation', escalation);
      writeTransaction(this.ctx.db, () => {
        this.ctx.db
          .prepare(
            `INSERT INTO escalation (id, state, created_ms, body) VALUES (?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET state = excluded.state, body = excluded.body`,
          )
          .run(parsed.id, parsed.state, epochMs(parsed.createdAt), JSON.stringify(parsed));
        return committed(undefined);
      });
    });
  }

  get(id: EscalationId): Promise<Escalation | undefined> {
    return run(() => {
      const row = this.ctx.db.prepare('SELECT body FROM escalation WHERE id = ?').get(id) as BodyRow | undefined;
      return row === undefined ? undefined : readRecord(Escalation, 'escalation', row.body);
    });
  }

  list(filter?: { state?: Escalation['state'] }): Promise<Escalation[]> {
    return run(() => this.loadAll(filter?.state));
  }

  /** Oldest first. */
  loadAll(state?: Escalation['state']): Escalation[] {
    const statement = this.ctx.db.prepare(`SELECT body FROM escalation ${state === undefined ? '' : 'WHERE state = ?'} ORDER BY created_ms, rowid`);
    const rows = (state === undefined ? statement.all() : statement.all(state)) as unknown as BodyRow[];
    return rows.map((row) => readRecord(Escalation, 'escalation', row.body));
  }
}

export class SqlitePreferencesRepository implements PreferencesRepository {
  constructor(private readonly ctx: StorageContext) {}

  get(): Promise<UiPreferences> {
    return run(() => this.load());
  }

  set(preferences: UiPreferences): Promise<UiPreferences> {
    return run(() => {
      const parsed = checkRecord(UiPreferences, 'preference', preferences);
      return writeTransaction(this.ctx.db, () => {
        this.ctx.db.prepare('INSERT INTO preference (id, body) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body').run(JSON.stringify(parsed));
        return committed(parsed);
      });
    });
  }

  /** The saved preferences, or the defaults (dark theme, R-15) when none were saved. */
  load(): UiPreferences {
    const row = this.ctx.db.prepare('SELECT body FROM preference WHERE id = 1').get() as BodyRow | undefined;
    return row === undefined ? UiPreferences.parse({}) : readRecord(UiPreferences, 'preference', row.body);
  }
}

export class SqliteOwnedProcessRepository implements OwnedProcessRepository {
  constructor(private readonly ctx: StorageContext) {}

  record(process: OwnedProcess): Promise<void> {
    return run(() => {
      const { endedAt, ...rest } = checkRecord(OwnedProcess, 'owned_process', process);
      writeTransaction(this.ctx.db, () => {
        // Recording the same process again refreshes its details but never revives one already ended.
        this.ctx.db
          .prepare(
            `INSERT INTO owned_process (pid, started_ms, recorded_ms, ended_at, body) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (pid, started_ms) DO UPDATE SET body = excluded.body, ended_at = coalesce(owned_process.ended_at, excluded.ended_at)`,
          )
          .run(rest.pid, epochMs(rest.startedAt), epochMs(rest.recordedAt), endedAt ?? null, JSON.stringify(rest));
        return committed(undefined);
      });
    });
  }

  markEnded(pid: number, startedAt: Timestamp, at: Timestamp): Promise<void> {
    return run(() => {
      const started = checkRecord(Timestamp, 'owned_process', startedAt);
      const ended = checkRecord(Timestamp, 'owned_process', at);
      writeTransaction(this.ctx.db, () => {
        // The first end is kept; an unknown process is nothing to end.
        const result = this.ctx.db
          .prepare('UPDATE owned_process SET ended_at = ? WHERE pid = ? AND started_ms = ? AND ended_at IS NULL')
          .run(ended, pid, epochMs(started));
        return Number(result.changes) === 0 ? unchanged(undefined) : committed(undefined);
      });
    });
  }

  listLive(): Promise<OwnedProcess[]> {
    return run(() => {
      const rows = this.ctx.db.prepare('SELECT body FROM owned_process WHERE ended_at IS NULL ORDER BY recorded_ms, rowid').all() as unknown as BodyRow[];
      return rows.map((row) => readRecord(OwnedProcess, 'owned_process', row.body));
    });
  }
}

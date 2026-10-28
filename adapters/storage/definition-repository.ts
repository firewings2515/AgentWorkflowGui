// Agents and workflow templates (T015): one row per ID, edited by compare-and-set on `revision`
// (DATA_RUNTIME §1). The stored record always carries the row's revision, so reading needs no second source.
import type { z } from 'zod';
import { AgentDefinition, WorkflowTemplate, type AgentId, type Revision, type WorkflowId } from '../../contracts';
import type { DefinitionRepository, DeleteResult, SaveResult } from '../../core/ports';
import { StoredDataError, checkRecord, readRecord, run, type StorageContext } from './codec';
import { committed, unchanged, writeTransaction } from './transaction';

interface Row {
  revision: number;
  body: string;
}

export class SqliteDefinitionRepository<T extends { id: string; revision: number }, Id extends string> implements DefinitionRepository<T, Id> {
  constructor(
    private readonly ctx: StorageContext,
    private readonly table: 'agent' | 'workflow',
    private readonly schema: z.ZodType<T>,
  ) {}

  list(): Promise<T[]> {
    return run(() => this.loadAll());
  }

  get(id: Id): Promise<T | undefined> {
    return run(() => {
      const row = this.row(id);
      return row === undefined ? undefined : this.read(row);
    });
  }

  save(record: T, expectedRevision: Revision | null): Promise<SaveResult<T>> {
    return run(() =>
      writeTransaction<SaveResult<T>>(this.ctx.db, () => {
        const parsed = checkRecord(this.schema, this.table, record);
        const row = this.row(parsed.id);
        if (expectedRevision === null) {
          if (row !== undefined) return unchanged({ status: 'stale', current: this.read(row) });
          const stored = { ...parsed, revision: 0 };
          this.ctx.db.prepare(`INSERT INTO ${this.table} (id, revision, body) VALUES (?, 0, ?)`).run(parsed.id, JSON.stringify(stored));
          return committed({ status: 'saved', record: stored });
        }
        if (row === undefined) return unchanged({ status: 'stale', current: undefined });
        if (row.revision !== expectedRevision) return unchanged({ status: 'stale', current: this.read(row) });
        const stored = { ...parsed, revision: expectedRevision + 1 };
        this.ctx.db
          .prepare(`UPDATE ${this.table} SET revision = ?, body = ? WHERE id = ? AND revision = ?`)
          .run(stored.revision, JSON.stringify(stored), parsed.id, expectedRevision);
        return committed({ status: 'saved', record: stored });
      }),
    );
  }

  delete(id: Id, expectedRevision: Revision): Promise<DeleteResult> {
    return run(() =>
      writeTransaction<DeleteResult>(this.ctx.db, () => {
        const row = this.row(id);
        if (row === undefined) return unchanged('not-found');
        if (row.revision !== expectedRevision) return unchanged('stale');
        this.ctx.db.prepare(`DELETE FROM ${this.table} WHERE id = ? AND revision = ?`).run(id, expectedRevision);
        return committed('deleted');
      }),
    );
  }

  /** In creation order (an edit keeps the row). */
  loadAll(): T[] {
    return (this.ctx.db.prepare(`SELECT revision, body FROM ${this.table} ORDER BY rowid`).all() as unknown as Row[]).map((row) => this.read(row));
  }

  private row(id: string): Row | undefined {
    return this.ctx.db.prepare(`SELECT revision, body FROM ${this.table} WHERE id = ?`).get(id) as Row | undefined;
  }

  private read(row: Row): T {
    const record = readRecord(this.schema, this.table, row.body);
    if (record.revision !== row.revision) throw new StoredDataError(this.table, ['revision:mismatch']);
    return record;
  }
}

export const agentRepository = (ctx: StorageContext) => new SqliteDefinitionRepository<AgentDefinition, AgentId>(ctx, 'agent', AgentDefinition);
export const workflowRepository = (ctx: StorageContext) => new SqliteDefinitionRepository<WorkflowTemplate, WorkflowId>(ctx, 'workflow', WorkflowTemplate);

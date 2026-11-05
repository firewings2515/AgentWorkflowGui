// Agents and workflow templates (T015): one row per ID, edited by compare-and-set on `revision`
// (DATA_RUNTIME §1). The stored record always carries the row's revision, so reading needs no second source.
import type { z } from 'zod';
import { AgentDefinition, ProjectSettings, Timestamp, WorkflowTemplate, type AgentId, type ProjectId, type Revision, type WorkflowId } from '../../contracts';
import type { DefinitionRepository, DefinitionSeed, DeleteResult, SaveResult } from '../../core/ports';
import { StoredDataError, checkRecord, readRecord, run, type StorageContext } from './codec';
import { committed, unchanged, writeTransaction } from './transaction';

interface Row {
  revision: number;
  body: string;
}

export class SqliteDefinitionRepository<T extends { id: string; revision: number }, Id extends string> implements DefinitionRepository<T, Id> {
  constructor(
    private readonly ctx: StorageContext,
    private readonly table: 'agent' | 'workflow' | 'project',
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
export const projectRepository = (ctx: StorageContext) => new SqliteDefinitionRepository<ProjectSettings, ProjectId>(ctx, 'project', ProjectSettings);

/**
 * The starter set's write (T063): in one transaction, each record whose ID is free is inserted with revision 0 (as
 * `save(record, null)` would), then the mark (`app_marker`, migration v14); any failure rolls all of it back.
 */
export const seedDefinitions = (ctx: StorageContext, seed: DefinitionSeed): Promise<string[]> =>
  run(() =>
    writeTransaction<string[]>(ctx.db, () => {
      const added: string[] = [];
      const insert = <T extends { id: string }>(table: 'agent' | 'workflow', schema: z.ZodType<T>, record: T) => {
        const parsed = checkRecord(schema, table, record);
        if (ctx.db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`).get(parsed.id) !== undefined) return;
        ctx.db.prepare(`INSERT INTO ${table} (id, revision, body) VALUES (?, 0, ?)`).run(parsed.id, JSON.stringify({ ...parsed, revision: 0 }));
        added.push(parsed.id);
      };
      for (const agent of seed.agents) insert('agent', AgentDefinition, agent);
      for (const workflow of seed.workflows) insert('workflow', WorkflowTemplate, workflow);
      let marked = false;
      if (seed.mark !== undefined) {
        const at = checkRecord(Timestamp, 'app_marker', seed.mark.at);
        marked = ctx.db.prepare('INSERT INTO app_marker (name, at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING').run(seed.mark.name, at).changes > 0;
      }
      return added.length > 0 || marked ? committed(added) : unchanged(added);
    }),
  );

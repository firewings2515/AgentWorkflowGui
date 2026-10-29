import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { InstanceId, NodeId, SessionId, TaskId, WorkflowInstance, type Revision } from '../../contracts';
import type { InstanceRepository, NodeSessionKey, SaveResult } from '../../core/ports';
import { checkRecord, epochMs, readRecord, run, StoredDataError } from './codec';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';

interface Row { id: string; revision: number; body: string }
const bindingSchema = z.strictObject({ instance_id: InstanceId, node_id: NodeId, task_id: z.union([TaskId, z.literal('')]), session_id: SessionId });

export class SqliteInstanceRepository implements InstanceRepository {
  constructor(private readonly db: DatabaseSync) {}

  list(): Promise<WorkflowInstance[]> { return run(() => readTransaction(this.db, () => this.loadAll())); }
  get(id: InstanceId): Promise<WorkflowInstance | undefined> { return run(() => readTransaction(this.db, () => this.load(id))); }

  create(instance: WorkflowInstance): Promise<'created' | 'exists'> {
    return run(() => writeTransaction<'created' | 'exists'>(this.db, () => {
      const record = checkRecord(WorkflowInstance, 'workflow_instance', { ...instance, revision: 0 });
      if (this.load(record.id) !== undefined) return unchanged('exists');
      this.db.prepare('INSERT INTO workflow_instance (id, revision, created_ms, body) VALUES (?, ?, ?, ?)')
        .run(record.id, 0, epochMs(record.createdAt), JSON.stringify(record));
      return committed('created');
    }));
  }

  update(instance: WorkflowInstance, expectedRevision: Revision): Promise<SaveResult<WorkflowInstance>> {
    return run(() => writeTransaction<SaveResult<WorkflowInstance>>(this.db, () => {
      const current = this.load(instance.id);
      // createdAt is immutable: a changed value is stale, including a different timestamp spelling.
      if (current === undefined || current.revision !== expectedRevision || current.createdAt !== instance.createdAt) return unchanged({ status: 'stale', current });
      const record = checkRecord(WorkflowInstance, 'workflow_instance', { ...instance, revision: expectedRevision + 1 });
      this.db.prepare('UPDATE workflow_instance SET revision = ?, body = ? WHERE id = ? AND revision = ?')
        .run(record.revision, JSON.stringify(record), record.id, expectedRevision);
      return committed({ status: 'saved', record });
    }));
  }

  bindNodeSession(key: NodeSessionKey, sessionId: SessionId): Promise<{ status: 'bound' } | { status: 'exists'; sessionId: SessionId }> {
    return run(() => writeTransaction<{ status: 'bound' } | { status: 'exists'; sessionId: SessionId }>(this.db, () => {
      if (key.taskId !== undefined) checkRecord(TaskId, 'node_session', key.taskId);
      const record = checkRecord(bindingSchema, 'node_session', { instance_id: key.instanceId, node_id: key.nodeId, task_id: key.taskId ?? '', session_id: sessionId });
      const existing = this.binding(key);
      if (existing !== undefined) return unchanged({ status: 'exists', sessionId: existing });
      this.db.prepare('INSERT INTO node_session (instance_id, node_id, task_id, session_id) VALUES (?, ?, ?, ?)')
        .run(record.instance_id, record.node_id, record.task_id, record.session_id);
      return committed({ status: 'bound' });
    }));
  }

  findNodeSession(key: NodeSessionKey): Promise<SessionId | undefined> { return run(() => readTransaction(this.db, () => this.binding(key))); }

  /** Snapshot readers share the enclosing transaction, including bindings absent from the DTO. */
  loadAll(): WorkflowInstance[] {
    this.db.prepare('SELECT * FROM node_session').all().forEach((row) => readRecord(bindingSchema, 'node_session', JSON.stringify(row)));
    return (this.db.prepare('SELECT id, revision, body FROM workflow_instance ORDER BY created_ms, rowid').all() as unknown as Row[]).map((row) => this.read(row));
  }

  private load(id: string): WorkflowInstance | undefined {
    const row = this.db.prepare('SELECT id, revision, body FROM workflow_instance WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : this.read(row);
  }
  private read(row: Row): WorkflowInstance {
    const record = readRecord(WorkflowInstance, 'workflow_instance', row.body);
    if (record.id !== row.id || record.revision !== row.revision) throw new StoredDataError('workflow_instance', ['identity:mismatch']);
    return record;
  }
  private binding(key: NodeSessionKey): SessionId | undefined {
    const row = this.db.prepare('SELECT * FROM node_session WHERE instance_id = ? AND node_id = ? AND task_id = ?').get(key.instanceId, key.nodeId, key.taskId ?? '');
    return row === undefined ? undefined : readRecord(bindingSchema, 'node_session', JSON.stringify(row)).session_id;
  }
}

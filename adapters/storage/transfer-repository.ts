import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ProvisionRecord, TransferProposal, type Revision, type TransferId } from '../../contracts';
import type { SaveResult, TransferRepository } from '../../core/ports';
import { checkRecord, epochMs, InvalidRecordError, readRecord, run, StoredDataError } from './codec';
import { SqliteDeliveryStore } from './delivery-store';
import { committed, readTransaction, unchanged, writeTransaction } from './transaction';

// Persist the complete pending link for the approval/acceptance gap. Delivery owns subsequent state.
const StoredProposal = z.strictObject({
  ...TransferProposal.shape,
  provision: ProvisionRecord.refine((p) => p.state === 'pending').optional(),
  delivery: z.never().optional(), createdSessionId: z.never().optional(),
});
type StoredProposal = z.infer<typeof StoredProposal>;
interface Row { id: string; revision: number; body: string }

export class SqliteTransferRepository implements TransferRepository {
  constructor(private readonly db: DatabaseSync, private readonly store: SqliteDeliveryStore) {}
  get(id: TransferId): Promise<TransferProposal | undefined> { return run(() => readTransaction(this.db, () => this.load(id))); }
  list(): Promise<TransferProposal[]> { return run(() => readTransaction(this.db, () => this.loadAll())); }
  create(proposal: TransferProposal): Promise<'created' | 'exists'> {
    return run(() => writeTransaction<'created' | 'exists'>(this.db, () => {
      if (this.load(proposal.id) !== undefined) return unchanged('exists');
      const stored = this.prepare({ ...proposal, revision: 0 });
      this.db.prepare('INSERT INTO transfer_proposal (id, revision, created_ms, body) VALUES (?, ?, ?, ?)')
        .run(stored.id, stored.revision, epochMs(stored.createdAt), JSON.stringify(stored));
      return committed('created');
    }));
  }
  update(proposal: TransferProposal, expectedRevision: Revision): Promise<SaveResult<TransferProposal>> {
    return run(() => writeTransaction<SaveResult<TransferProposal>>(this.db, () => {
      if (proposal.revision !== expectedRevision + 1) throw new TypeError('transfer update must carry the next revision');
      const current = this.load(proposal.id);
      // createdAt is immutable: a changed value is stale, including a different timestamp spelling.
      if (current === undefined || current.revision !== expectedRevision || current.createdAt !== proposal.createdAt) return unchanged({ status: 'stale', current });
      const stored = this.prepare(proposal);
      this.db.prepare('UPDATE transfer_proposal SET revision = ?, body = ? WHERE id = ? AND revision = ?')
        .run(stored.revision, JSON.stringify(stored), stored.id, expectedRevision);
      return committed({ status: 'saved', record: this.project(stored) });
    }));
  }
  loadAll(): TransferProposal[] {
    return (this.db.prepare('SELECT id, revision, body FROM transfer_proposal ORDER BY created_ms, rowid').all() as unknown as Row[]).map((row) => this.read(row));
  }
  private load(id: string): TransferProposal | undefined {
    const row = this.db.prepare('SELECT id, revision, body FROM transfer_proposal WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : this.read(row);
  }
  private read(row: Row): TransferProposal {
    const stored = readRecord(StoredProposal, 'transfer_proposal', row.body);
    if (stored.id !== row.id || stored.revision !== row.revision) throw new StoredDataError('transfer_proposal', ['identity:mismatch']);
    return this.project(stored);
  }
  private prepare(proposal: TransferProposal): StoredProposal {
    const { provision, ...rest } = proposal;
    delete rest.delivery;
    delete rest.createdSessionId;
    const stored = checkRecord(StoredProposal, 'transfer_proposal', { ...rest, ...(provision !== undefined && { provision: { ...provision, state: 'pending' } }) });
    try { this.project(stored); }
    catch (error) {
      if (error instanceof StoredDataError && error.table === 'transfer_proposal') throw new InvalidRecordError(error.table, error.problems);
      throw error;
    }
    return stored;
  }
  private project(stored: StoredProposal): TransferProposal {
    const { provision: link, ...base } = stored;
    if (link !== undefined && stored.approvedAt === undefined) throw new StoredDataError('transfer_proposal', ['transfer.nothing-before-approval']);
    const payload = this.store.loadById(stored.operationId);
    const provision = link === undefined ? undefined : this.store.loadById(link.operationId);
    if (payload !== undefined && payload.kind !== 'transfer') throw new StoredDataError('transfer_proposal', ['delivery:kind']);
    if (payload !== undefined && (payload.payloadHash !== stored.payloadHash || payload.proposalRevision !== stored.approvedRevision)) {
      throw new StoredDataError('transfer_proposal', ['delivery:approval-mismatch']);
    }
    if (provision !== undefined && (provision.kind !== 'provision' || provision.target.provision?.bindingKey !== link?.bindingKey)) {
      throw new StoredDataError('transfer_proposal', ['provision:link-mismatch']);
    }
    if (payload?.target.provision !== undefined && (payload.target.provision.operationId !== link?.operationId || payload.target.provision.bindingKey !== link.bindingKey)) {
      throw new StoredDataError('transfer_proposal', ['delivery:link-mismatch']);
    }
    // Approval can commit before acceptance. Until that operation exists there is no delivery to project.
    return readRecord(TransferProposal, 'transfer_proposal', JSON.stringify({
      ...base, provision: provision?.target.provision ?? link, delivery: payload?.delivery,
      createdSessionId: provision?.delivery.state === 'sent' ? provision.target.sessionId : undefined,
    }));
  }
}

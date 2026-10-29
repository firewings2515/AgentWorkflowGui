import type { DatabaseSync } from 'node:sqlite';
import type { Handoff, HandoffId, InstanceId, PeerMessage, PeerMessageId } from '../../contracts';
import type { HandoffRepository, PeerMessageRepository, StoredDelivery } from '../../core/ports';
import { run } from './codec';
import { projectHandoff, projectPeer } from './delivery-codec';
import { SqliteDeliveryStore } from './delivery-store';
import { readTransaction } from './transaction';

export class SqliteHandoffRepository implements HandoffRepository {
  constructor(private readonly db: DatabaseSync, private readonly store: SqliteDeliveryStore) {}
  get(id: HandoffId): Promise<Handoff | undefined> { return run(() => readTransaction(this.db, () => {
    const record = this.store.loadProjection('handoff', id);
    return record === undefined ? undefined : projectHandoff(record);
  })); }
  listByInstance(instanceId: InstanceId): Promise<Handoff[]> { return run(() => readTransaction(this.db, () => this.loadAll(this.store.loadProjections('handoff', instanceId)))); }
  loadAll(records = this.store.loadProjections('handoff')): Handoff[] { return records.flatMap((r) => { const h = projectHandoff(r); return h === undefined ? [] : [h]; }); }
}

export class SqlitePeerMessageRepository implements PeerMessageRepository {
  constructor(private readonly db: DatabaseSync, private readonly store: SqliteDeliveryStore) {}
  get(id: PeerMessageId): Promise<PeerMessage | undefined> { return run(() => readTransaction(this.db, () => {
    const record = this.store.loadProjection('peer-message', id);
    return record === undefined ? undefined : projectPeer(record);
  })); }
  list(): Promise<PeerMessage[]> { return run(() => readTransaction(this.db, () => this.loadAll())); }
  loadAll(records: StoredDelivery[] = this.store.loadProjections('peer-message')): PeerMessage[] { return records.flatMap((r) => { const p = projectPeer(r); return p === undefined ? [] : [p]; }); }
}

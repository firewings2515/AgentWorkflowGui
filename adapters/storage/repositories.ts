// The repositories of core/ports/repository.ts on the app database (T015). Every port method is one
// transaction (transaction.ts), so a reader never sees half of a write and a failed write leaves nothing.
import type { DatabaseSync } from 'node:sqlite';
import type { AppRepositories, SnapshotData } from '../../core/ports';
import { SqliteDeliveryStore } from './delivery-store';
import { SqliteInstanceRepository } from './instance-repository';
import { SqliteHandoffRepository, SqlitePeerMessageRepository } from './delivery-repositories';
import { SqliteTransferRepository } from './transfer-repository';
import { DEFAULT_BLOB_THRESHOLD_BYTES, run, type StorageContext } from './codec';
import { SqliteConversationRepository } from './conversation-repository';
import { agentRepository, workflowRepository } from './definition-repository';
import { SqliteSessionRepository } from './session-repository';
import { SqliteEscalationRepository, SqliteOwnedProcessRepository, SqlitePreferencesRepository } from './small-repositories';
import { readTransaction } from './transaction';

export interface RepositoryOptions {
  /** Message text, command output and diffs over this many UTF-8 bytes are stored apart; default 64 KiB. */
  blobThresholdBytes?: number;
}

/** The repositories on `db` (opened with `openDatabase`, so the schema is at the latest version). */
export const createRepositories = (db: DatabaseSync, options: RepositoryOptions = {}): AppRepositories => {
  const ctx: StorageContext = { db, blobThresholdBytes: options.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES };
  const agents = agentRepository(ctx);
  const workflows = workflowRepository(ctx);
  const sessions = new SqliteSessionRepository(ctx);
  const conversations = new SqliteConversationRepository(ctx);
  const escalations = new SqliteEscalationRepository(ctx);
  const preferences = new SqlitePreferencesRepository(ctx);
  const processes = new SqliteOwnedProcessRepository(ctx);
  const delivery = new SqliteDeliveryStore(db);
  const instances = new SqliteInstanceRepository(db);
  const handoffs = new SqliteHandoffRepository(db, delivery);
  const peerMessages = new SqlitePeerMessageRepository(db, delivery);
  const transfers = new SqliteTransferRepository(db, delivery);
  return {
    agents,
    workflows,
    sessions,
    conversations,
    escalations,
    preferences,
    processes,
    instances,
    handoffs,
    peerMessages,
    transfers,
    readSnapshotData: () =>
      run(() =>
        readTransaction(db, (): SnapshotData => {
          const records = delivery.loadAll();
          return {
            agents: agents.loadAll(),
            workflows: workflows.loadAll(),
            sessions: sessions.loadAll(),
            conversations: conversations.load(),
            escalations: escalations.loadAll(),
            preferences: preferences.load(),
            instances: instances.loadAll(),
            handoffs: handoffs.loadAll(records),
            peerMessages: peerMessages.loadAll(records),
            transfers: transfers.loadAll(),
          };
        }),
      ),
  };
};

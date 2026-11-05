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
import { agentRepository, projectRepository, seedDefinitions, workflowRepository } from './definition-repository';
import { SqliteSessionRepository } from './session-repository';
import { SqliteEscalationRepository, SqliteMarkerRepository, SqliteOwnedProcessRepository, SqlitePreferencesRepository } from './small-repositories';
import { readTransaction } from './transaction';
import { SqliteWorkFolderClaimRepository } from './work-folder-repository';

export interface RepositoryOptions {
  /** Message text, command output and diffs over this many UTF-8 bytes are stored apart; default 64 KiB. */
  blobThresholdBytes?: number;
}

/** The repositories on `db` (opened with `openDatabase`, so the schema is at the latest version). */
export const createRepositories = (db: DatabaseSync, options: RepositoryOptions = {}): AppRepositories => {
  const ctx: StorageContext = { db, blobThresholdBytes: options.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES };
  const agents = agentRepository(ctx);
  const workflows = workflowRepository(ctx);
  const projects = projectRepository(ctx);
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
    projects,
    workFolders: new SqliteWorkFolderClaimRepository(ctx),
    markers: new SqliteMarkerRepository(ctx),
    seedDefinitions: (seed) => seedDefinitions(ctx, seed),
    readSnapshotData: (options = {}) =>
      run(() =>
        readTransaction(db, (): SnapshotData => {
          const records = delivery.loadAll();
          const sessionRecords = sessions.loadAll();
          const pages = options.recentTurns === undefined ? [] : sessionRecords.map((s) => conversations.loadPage(s.id, options.recentTurns!, undefined, true));
          const conversation = options.recentTurns === undefined ? conversations.load() : {
            turns: pages.flatMap((p) => p.turns), messages: pages.flatMap((p) => p.messages), items: pages.flatMap((p) => p.items),
            nativeTasks: pages.flatMap((p) => p.nativeTasks), permissionRequests: pages.flatMap((p) => p.permissionRequests), artifacts: pages.flatMap((p) => p.artifacts),
          };
          return {
            agents: agents.loadAll(),
            workflows: workflows.loadAll(),
            projects: projects.loadAll(),
            sessions: sessionRecords,
            conversations: conversation,
            escalations: escalations.loadAll(),
            preferences: preferences.load(),
            instances: instances.loadAll(),
            handoffs: handoffs.loadAll(records),
            peerMessages: peerMessages.loadAll(records),
            transfers: transfers.loadAll(),
            historyPages: pages.map(({ sessionId, olderCursor }) => ({ sessionId, olderCursor })),
          };
        }),
      ),
  };
};

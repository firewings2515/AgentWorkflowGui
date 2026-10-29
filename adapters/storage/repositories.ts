// The repositories of core/ports/repository.ts on the app database (T015). Every port method is one
// transaction (transaction.ts), so a reader never sees half of a write and a failed write leaves nothing.
import type { DatabaseSync } from 'node:sqlite';
import type { AppRepositories, SnapshotData } from '../../core/ports';
import { NotStoredYetError } from './delivery-store';
import { DEFAULT_BLOB_THRESHOLD_BYTES, run, type StorageContext } from './codec';
import { SqliteConversationRepository } from './conversation-repository';
import { agentRepository, workflowRepository } from './definition-repository';
import { SqliteSessionRepository } from './session-repository';
import { SqliteEscalationRepository, SqliteOwnedProcessRepository, SqlitePreferencesRepository } from './small-repositories';
import { readTransaction } from './transaction';

const refuse = (what: string) => () => Promise.reject(new NotStoredYetError(`${what} are stored from T022 on`));

/** Contracts 0.5 records before T022: nothing is stored, so lists are empty and writes are refused. */
const notStoredYet: Pick<AppRepositories, 'instances' | 'handoffs' | 'peerMessages' | 'transfers'> = {
  instances: {
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    create: refuse('workflow instances'),
    update: refuse('workflow instances'),
    bindNodeSession: refuse('node sessions'),
    findNodeSession: () => Promise.resolve(undefined),
  },
  handoffs: { get: () => Promise.resolve(undefined), listByInstance: () => Promise.resolve([]) },
  peerMessages: { get: () => Promise.resolve(undefined), list: () => Promise.resolve([]) },
  transfers: {
    get: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    create: refuse('transfer proposals'),
    update: refuse('transfer proposals'),
  },
};

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
  return {
    agents,
    workflows,
    sessions,
    conversations,
    escalations,
    preferences,
    processes,
    // Contracts 0.5 (T020): stored from T022 on. Until then they read as empty and refuse writes.
    instances: notStoredYet.instances,
    handoffs: notStoredYet.handoffs,
    peerMessages: notStoredYet.peerMessages,
    transfers: notStoredYet.transfers,
    readSnapshotData: () =>
      run(() =>
        readTransaction(
          db,
          (): SnapshotData => ({
            agents: agents.loadAll(),
            workflows: workflows.loadAll(),
            sessions: sessions.loadAll(),
            conversations: conversations.load(),
            escalations: escalations.loadAll(),
            preferences: preferences.load(),
            instances: [],
            handoffs: [],
            peerMessages: [],
            transfers: [],
          }),
        ),
      ),
  };
};

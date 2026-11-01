// In-memory `AppRepositories` for the session service's tests, with the T015 semantics the service relies
// on: compare-and-set on revision, a session must exist before its conversation, a repeated message is
// ignored, and records are copied in and out so a caller cannot change what is stored. The 0.5 views
// (handoffs, peer messages, transfers) are plain lists here: they do not read the delivery store, so they
// are no reference for the projection rules of core/ports/repository.ts, which T022 tests on SQLite.
import type {
  AgentDefinition,
  AgentId,
  Escalation,
  Handoff,
  InstanceId,
  LogicalSession,
  OwnedProcess,
  PeerMessage,
  SessionId,
  TransferProposal,
  UiPreferences,
  WorkflowId,
  WorkflowInstance,
  WorkflowTemplate,
  ProjectId,
  ProjectSettings,
  HistoryCursor,
  HistoryPage,
  HistoryPageInfo,
} from '../../../contracts';
import type { AppRepositories, Conversation, DefinitionRepository, NodeSessionKey, SaveResult, SnapshotData } from '../../ports';

/** A deep copy (core has no structuredClone: no DOM or Node types); records are plain JSON. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class Definitions<T extends { id: string; revision: number }, Id extends string> implements DefinitionRepository<T, Id> {
  readonly records = new Map<string, T>();

  list(): Promise<T[]> {
    return Promise.resolve([...this.records.values()].map(copy));
  }

  get(id: Id): Promise<T | undefined> {
    const record = this.records.get(id);
    return Promise.resolve(record && copy(record));
  }

  save(record: T, expectedRevision: number | null): Promise<SaveResult<T>> {
    const current = this.records.get(record.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return Promise.resolve({ status: 'stale', current: current && copy(current) });
    const stored = { ...copy(record), revision: expectedRevision === null ? 0 : expectedRevision + 1 };
    this.records.set(record.id, stored);
    return Promise.resolve({ status: 'saved', record: copy(stored) });
  }

  delete(id: Id, expectedRevision: number): Promise<'deleted' | 'stale' | 'not-found'> {
    const current = this.records.get(id);
    if (current === undefined) return Promise.resolve('not-found');
    if (current.revision !== expectedRevision) return Promise.resolve('stale');
    this.records.delete(id);
    return Promise.resolve('deleted');
  }
}

const emptyConversation = (): Conversation => ({ turns: [], messages: [], items: [], nativeTasks: [], permissionRequests: [], artifacts: [] });
let cursorStore = 0;

export class MemoryRepositories implements AppRepositories {
  private readonly cursorPrefix = `memory-${++cursorStore}-`;
  private cursorSequence = 0;
  private readonly cursors = new Map<SessionId, Map<HistoryCursor, { at: number; row: number }>>();

  private history(sessionId: SessionId, limit: number, before?: { at: number; row: number }, includeOpen = false): HistoryPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('history:limit');
    const c = this.conversationRecords.get(sessionId) ?? emptyConversation();
    const ordered = c.turns.map((turn, row) => ({ turn, row, at: Date.parse(turn.startedAt) })).sort((a, b) => a.at - b.at || a.row - b.row);
    const older = ordered.filter((t) => !before || t.at < before.at || (t.at === before.at && t.row < before.row));
    const selected = older.slice(-limit);
    const first = selected[0];
    const hasOlder = older.length > limit;
    const ids = new Set(selected.filter((t) => includeOpen || t.turn.state !== 'running').map((t) => t.turn.id));
    const knownTurns = new Set(c.turns.map((t) => t.id));
    if (includeOpen) for (const t of c.turns) if (t.state === 'running') ids.add(t.id);
    const result = emptyConversation();
    result.turns = ordered.filter((t) => ids.has(t.turn.id)).map((t) => t.turn);
    for (const key of ['messages', 'items', 'nativeTasks', 'permissionRequests', 'artifacts'] as const) {
      const sorted = c[key].map((record, row) => ({ record, row, at: Date.parse('createdAt' in record ? record.createdAt : 'startedAt' in record ? record.startedAt : record.updatedAt) }));
      if (key !== 'artifacts') sorted.sort((a, b) => a.at - b.at || a.row - b.row);
      const records = sorted.filter(({ record, at }) => {
        if ((key === 'nativeTasks' && (!('endedAt' in record) || record.endedAt === undefined)) ||
          (key === 'permissionRequests' && 'state' in record && (record.state === 'pending' || record.state === 'held'))) return includeOpen;
        if ('turnId' in record && record.turnId !== undefined && knownTurns.has(record.turnId)) return ids.has(record.turnId);
        return (!hasOlder || !first || at >= first.at) && (!before || at < before.at);
      }).map(({ record }) => record);
      (result[key] as unknown[]) = records;
    }
    let olderCursor: HistoryCursor | null = null;
    if (hasOlder && first) {
      olderCursor = `${this.cursorPrefix}${++this.cursorSequence}` as HistoryCursor;
      let cursors = this.cursors.get(sessionId);
      if (!cursors) { cursors = new Map(); this.cursors.set(sessionId, cursors); }
      cursors.set(olderCursor, { at: first.at, row: first.row });
      if (cursors.size > 8) cursors.delete(cursors.keys().next().value!);
    }
    return copy({ ...result, sessionId, olderCursor });
  }
  readonly agents = new Definitions<AgentDefinition, AgentId>();
  readonly workflows = new Definitions<WorkflowTemplate, WorkflowId>();
  readonly projects = new Definitions<ProjectSettings, ProjectId>();
  readonly sessionRecords = new Map<SessionId, LogicalSession>();
  readonly conversationRecords = new Map<SessionId, Conversation>();
  readonly escalationRecords = new Map<string, Escalation>();
  preferencesRecord: UiPreferences = { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } };
  readonly processRecords: OwnedProcess[] = [];
  readonly instanceRecords = new Map<string, WorkflowInstance>();
  readonly nodeSessions = new Map<string, SessionId>();
  /** Handoffs and peer messages are views of the delivery store (C-12); tests put what they need here. */
  readonly handoffRecords: Handoff[] = [];
  readonly peerMessageRecords: PeerMessage[] = [];
  readonly transferRecords = new Map<string, TransferProposal>();

  readonly sessions = {
    list: () => Promise.resolve([...this.sessionRecords.values()].map(copy)),
    get: (id: SessionId) => Promise.resolve(this.sessionRecords.has(id) ? copy(this.sessionRecords.get(id)!) : undefined),
    create: (session: LogicalSession) => {
      if (this.sessionRecords.has(session.id)) return Promise.resolve('exists' as const);
      this.sessionRecords.set(session.id, copy(session));
      return Promise.resolve('created' as const);
    },
    update: (session: LogicalSession, expectedRevision: number): Promise<SaveResult<LogicalSession>> => {
      const current = this.sessionRecords.get(session.id);
      if (current?.revision !== expectedRevision) return Promise.resolve({ status: 'stale', current: current && copy(current) });
      const stored = { ...copy(session), revision: expectedRevision + 1 };
      this.sessionRecords.set(session.id, stored);
      return Promise.resolve({ status: 'saved', record: copy(stored) });
    },
  };

  private conversationOf(sessionId: SessionId): Conversation {
    if (!this.sessionRecords.has(sessionId)) throw new Error('FOREIGN KEY constraint failed');
    let conversation = this.conversationRecords.get(sessionId);
    if (conversation === undefined) {
      conversation = emptyConversation();
      this.conversationRecords.set(sessionId, conversation);
    }
    return conversation;
  }

  private upsert<T extends { id: string; sessionId: SessionId }>(key: keyof Conversation, record: T): Promise<void> {
    const list = this.conversationOf(record.sessionId)[key] as unknown as T[];
    const index = list.findIndex((r) => r.id === record.id);
    if (index < 0) list.push(copy(record));
    else list[index] = copy(record);
    return Promise.resolve();
  }

  readonly conversations = {
    upsertTurn: (turn: Conversation['turns'][number]) => this.upsert('turns', turn),
    appendMessage: (message: Conversation['messages'][number]) => {
      const list = this.conversationOf(message.sessionId).messages;
      // As in SQLite, a message ID is unique across sessions and a repeat is ignored, wherever it is (T015).
      const taken = [...this.conversationRecords.values()].some((c) => c.messages.some((m) => m.id === message.id));
      if (!taken) list.push(copy(message));
      return Promise.resolve();
    },
    upsertItem: (item: Conversation['items'][number]) => this.upsert('items', item),
    upsertNativeTask: (task: Conversation['nativeTasks'][number]) => this.upsert('nativeTasks', task),
    upsertPermissionRequest: (request: Conversation['permissionRequests'][number]) => this.upsert('permissionRequests', request),
    upsertArtifact: (artifact: Conversation['artifacts'][number]) => this.upsert('artifacts', artifact),
    get: (sessionId: SessionId) => Promise.resolve(copy(this.conversationRecords.get(sessionId) ?? emptyConversation())),
    page: (sessionId: SessionId, before: HistoryCursor, limitTurns: number): Promise<HistoryPage | 'invalid-cursor'> =>
      new Promise((resolve) => {
        const boundary = this.cursors.get(sessionId)?.get(before);
        resolve(boundary ? this.history(sessionId, limitTurns, boundary) : 'invalid-cursor');
      }),
  };

  readonly escalations = {
    upsert: (escalation: Escalation) => {
      this.escalationRecords.set(escalation.id, copy(escalation));
      return Promise.resolve();
    },
    get: (id: string) => Promise.resolve(this.escalationRecords.has(id) ? copy(this.escalationRecords.get(id)!) : undefined),
    list: (filter: { state?: Escalation['state'] } = {}) =>
      Promise.resolve([...this.escalationRecords.values()].filter((e) => filter.state === undefined || e.state === filter.state).map(copy)),
  };

  readonly preferences = {
    get: () => Promise.resolve(copy(this.preferencesRecord)),
    set: (preferences: UiPreferences) => {
      this.preferencesRecord = copy(preferences);
      return Promise.resolve(copy(preferences));
    },
  };

  readonly processes = {
    record: (process: OwnedProcess) => {
      this.processRecords.push(copy(process));
      return Promise.resolve();
    },
    markEnded: () => Promise.resolve(),
    listLive: () => Promise.resolve(this.processRecords.filter((p) => p.endedAt === undefined).map(copy)),
  };

  readonly instances = {
    list: () => Promise.resolve([...this.instanceRecords.values()].map(copy)),
    get: (id: InstanceId) => Promise.resolve(this.instanceRecords.has(id) ? copy(this.instanceRecords.get(id)!) : undefined),
    create: (instance: WorkflowInstance) => {
      if (this.instanceRecords.has(instance.id)) return Promise.resolve('exists' as const);
      this.instanceRecords.set(instance.id, { ...copy(instance), revision: 0 });
      return Promise.resolve('created' as const);
    },
    update: (instance: WorkflowInstance, expectedRevision: number): Promise<SaveResult<WorkflowInstance>> => {
      const current = this.instanceRecords.get(instance.id);
      if (current?.revision !== expectedRevision) return Promise.resolve({ status: 'stale', current: current && copy(current) });
      const stored = { ...copy(instance), revision: expectedRevision + 1 };
      this.instanceRecords.set(instance.id, stored);
      return Promise.resolve({ status: 'saved', record: copy(stored) });
    },
    bindNodeSession: (key: NodeSessionKey, sessionId: SessionId) => {
      const k = JSON.stringify([key.instanceId, key.nodeId, key.taskId ?? null]);
      const bound = this.nodeSessions.get(k);
      if (bound !== undefined) return Promise.resolve({ status: 'exists' as const, sessionId: bound });
      this.nodeSessions.set(k, sessionId);
      return Promise.resolve({ status: 'bound' as const });
    },
    findNodeSession: (key: NodeSessionKey) => Promise.resolve(this.nodeSessions.get(JSON.stringify([key.instanceId, key.nodeId, key.taskId ?? null]))),
  };

  readonly handoffs = {
    get: (id: string) => {
      const found = this.handoffRecords.find((h) => h.id === id);
      return Promise.resolve(found && copy(found));
    },
    listByInstance: (instanceId: InstanceId) => Promise.resolve(this.handoffRecords.filter((h) => h.instanceId === instanceId).map(copy)),
  };

  readonly peerMessages = {
    get: (id: string) => {
      const found = this.peerMessageRecords.find((m) => m.id === id);
      return Promise.resolve(found && copy(found));
    },
    list: () => Promise.resolve(this.peerMessageRecords.map(copy)),
  };

  readonly transfers = {
    get: (id: string) => Promise.resolve(this.transferRecords.has(id) ? copy(this.transferRecords.get(id)!) : undefined),
    list: () => Promise.resolve([...this.transferRecords.values()].map(copy)),
    create: (proposal: TransferProposal) => {
      if (this.transferRecords.has(proposal.id)) return Promise.resolve('exists' as const);
      this.transferRecords.set(proposal.id, copy(proposal));
      return Promise.resolve('created' as const);
    },
    // T020 r2 P1: an approval, then a failure or cancel, each with the next revision.
    update: (proposal: TransferProposal, expectedRevision: number): Promise<SaveResult<TransferProposal>> => {
      if (proposal.revision !== expectedRevision + 1) return Promise.reject(new TypeError('a transfer update carries revision expectedRevision + 1'));
      const current = this.transferRecords.get(proposal.id);
      if (current?.revision !== expectedRevision) return Promise.resolve({ status: 'stale', current: current && copy(current) });
      this.transferRecords.set(proposal.id, copy(proposal));
      return Promise.resolve({ status: 'saved', record: copy(proposal) });
    },
  };

  readSnapshotData(options: { recentTurns?: number } = {}): Promise<SnapshotData> {
    return new Promise((resolve) => {
      const merged = emptyConversation();
      const historyPages: HistoryPageInfo[] = [];
      for (const sessionId of this.sessionRecords.keys()) {
        const c = options.recentTurns === undefined ? this.conversationRecords.get(sessionId) ?? emptyConversation() : this.history(sessionId, options.recentTurns, undefined, true);
        if ('olderCursor' in c) historyPages.push({ sessionId, olderCursor: c.olderCursor as HistoryCursor | null });
        for (const key of Object.keys(merged) as (keyof Conversation)[]) (merged[key] as unknown[]).push(...copy(c[key]));
      }
      // Capture every list before yielding, like a SQLite read transaction.
      resolve(copy({
        agents: [...this.agents.records.values()],
        workflows: [...this.workflows.records.values()],
        sessions: [...this.sessionRecords.values()],
        conversations: merged,
        escalations: [...this.escalationRecords.values()],
        preferences: this.preferencesRecord,
        instances: [...this.instanceRecords.values()],
        handoffs: this.handoffRecords.map(copy),
        peerMessages: this.peerMessageRecords.map(copy),
        transfers: [...this.transferRecords.values()],
        projects: [...this.projects.records.values()],
        historyPages,
      }));
    });
  }
}

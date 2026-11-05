// Repository ports (T012, C-12): durable records of what the GUI shows, beside the delivery store (CR-2).
// T015 implements them on the T007 SQLite database; the session service (T017) uses them. Every method
// is one transaction. Editable records use compare-and-set on `revision` (DATA_RUNTIME §1).
import type {
  AgentDefinition,
  AgentId,
  Artifact,
  Escalation,
  EscalationId,
  Handoff,
  HistoryCursor,
  HistoryPage,
  HistoryPageInfo,
  HandoffId,
  InstanceId,
  LogicalSession,
  Message,
  NativeTask,
  NodeId,
  OwnedProcess,
  PeerMessage,
  PeerMessageId,
  PermissionRequest,
  ProjectId,
  ProjectSettings,
  Revision,
  SessionId,
  SessionItem,
  TaskId,
  Timestamp,
  TransferId,
  TransferProposal,
  Turn,
  UiPreferences,
  WorkflowId,
  WorkflowInstance,
  WorkflowTemplate,
} from '../../contracts';
import type { WorkFolderClaimRepository } from './work-folders';

/** Result of a compare-and-set save: `stale` returns what is stored now so the caller can show both. */
export type SaveResult<T> = { status: 'saved'; record: T } | { status: 'stale'; current: T | undefined };

export type DeleteResult = 'deleted' | 'stale' | 'not-found';

/**
 * Agents and workflow templates: `expectedRevision` null means "create; it must not exist yet". Only the
 * current revision is kept (C-11): a session started or resumed later uses the Agent's current
 * instructions; a running workflow instance keeps its own copy of the template it started with
 * (`WorkflowInstance.template`), so it never needs an older revision from here.
 */
export interface DefinitionRepository<T, Id> {
  list(): Promise<T[]>;
  get(id: Id): Promise<T | undefined>;
  /** Stores `record` with revision `expectedRevision + 1` (or 0 when creating); the stored record is returned. */
  save(record: T, expectedRevision: Revision | null): Promise<SaveResult<T>>;
  delete(id: Id, expectedRevision: Revision): Promise<DeleteResult>;
}

export type AgentRepository = DefinitionRepository<AgentDefinition, AgentId>;
export type WorkflowRepository = DefinitionRepository<WorkflowTemplate, WorkflowId>;
/** Project settings (C-17, O-06), saved like the definitions. */
export type ProjectRepository = DefinitionRepository<ProjectSettings, ProjectId>;

export interface SessionRepository {
  list(): Promise<LogicalSession[]>;
  get(id: SessionId): Promise<LogicalSession | undefined>;
  /** `exists` when the ID is taken (the renderer chose it, so a repeat is not a new session). */
  create(session: LogicalSession): Promise<'created' | 'exists'>;
  /** Compare-and-set on `revision`; the stored session gets `expectedRevision + 1`. */
  update(session: LogicalSession, expectedRevision: Revision): Promise<SaveResult<LogicalSession>>;
}

/** What a session's conversation view needs, oldest first. */
export interface Conversation {
  turns: Turn[];
  messages: Message[];
  items: SessionItem[];
  nativeTasks: NativeTask[];
  permissionRequests: PermissionRequest[];
  artifacts: Artifact[];
}

/**
 * The runtime-observed records of sessions, written as adapter events arrive. Upserts replace the record
 * with the same ID; streaming deltas are not stored, only completed messages and the latest item state.
 */
export interface ConversationRepository {
  upsertTurn(turn: Turn): Promise<void>;
  /** A message is written once, when completed; a repeat with the same ID is ignored. */
  appendMessage(message: Message): Promise<void>;
  upsertItem(item: SessionItem): Promise<void>;
  upsertNativeTask(task: NativeTask): Promise<void>;
  upsertPermissionRequest(request: PermissionRequest): Promise<void>;
  upsertArtifact(artifact: Artifact): Promise<void>;
  get(sessionId: SessionId): Promise<Conversation>;
  /**
   * The page of the session's history before `before` (C-26): whole turns, at most `limitTurns` of them, with
   * their records; a record without a turn goes by its time. Indexed by session, never a scan of every record.
   * `invalid-cursor` for a cursor this store did not hand out for this session.
   */
  page(sessionId: SessionId, before: HistoryCursor, limitTurns: number): Promise<HistoryPage | 'invalid-cursor'>;
  /**
   * When the session's newest message that counts for its last-message time (`countsAsLastMessage`, Q-17) was created, in
   * epoch milliseconds; undefined when it has none. Seeks the session's message index from its newest end (U4).
   */
  latestMessageMs(sessionId: SessionId): Promise<number | undefined>;
}

export interface EscalationRepository {
  upsert(escalation: Escalation): Promise<void>;
  get(id: EscalationId): Promise<Escalation | undefined>;
  list(filter?: { state?: Escalation['state'] }): Promise<Escalation[]>;
}

export interface PreferencesRepository {
  /** Defaults (dark theme, R-15) when nothing was saved. */
  get(): Promise<UiPreferences>;
  set(preferences: UiPreferences): Promise<UiPreferences>;
}

/**
 * One-time marks of the app (T063), set once and never cleared: `starter-offered` says the starter set was added (or
 * not needed) once, so a first start adds it only once. Kept in the database, so a restored backup carries its marks.
 */
export interface MarkerRepository {
  has(name: string): Promise<boolean>;
  /** A mark already set keeps its first time. */
  set(name: string, at: Timestamp): Promise<void>;
}

/**
 * What `AppRepositories.seedDefinitions` writes (T063, the starter set): Agents and templates made only where their ID is
 * free, and a mark, all in one transaction.
 */
export interface DefinitionSeed {
  agents: readonly AgentDefinition[];
  workflows: readonly WorkflowTemplate[];
  mark?: { name: string; at: Timestamp };
}

export interface OwnedProcessRepository {
  record(process: OwnedProcess): Promise<void>;
  markEnded(pid: number, startedAt: Timestamp, at: Timestamp): Promise<void>;
  /** Recorded and not marked ended: the candidates for orphan cleanup at start (R-14). */
  listLive(): Promise<OwnedProcess[]>;
}

/** The one GUI session of a (node, task) of an instance (R-06); root has no task. */
export interface NodeSessionKey {
  instanceId: InstanceId;
  nodeId: NodeId;
  taskId?: TaskId;
}

/** Workflow instances with their tasks, and which session works each (node, task) (C-12). */
export interface InstanceRepository {
  list(): Promise<WorkflowInstance[]>;
  get(id: InstanceId): Promise<WorkflowInstance | undefined>;
  /** `exists` when the ID is taken (the renderer chose it with `workflow.start`). Stored with revision 0. */
  create(instance: WorkflowInstance): Promise<'created' | 'exists'>;
  /** Compare-and-set on `revision`; the stored instance gets `expectedRevision + 1`. */
  update(instance: WorkflowInstance, expectedRevision: Revision): Promise<SaveResult<WorkflowInstance>>;
  /**
   * Binds the session of a (node, task) once: a second bind of the same key returns the session already
   * bound and changes nothing, so two handoffs racing to the same node share one session.
   */
  bindNodeSession(key: NodeSessionKey, sessionId: SessionId): Promise<{ status: 'bound' } | { status: 'exists'; sessionId: SessionId }>;
  findNodeSession(key: NodeSessionKey): Promise<SessionId | undefined>;
}

/**
 * Handoffs as the views show them (C-12). They are written only by the delivery store's acceptance (with
 * their `HandoffMeta`), so a handoff, its count and its delivery record cannot disagree; `delivery`,
 * `target` and `outcome` are always the delivery store's current record.
 */
export interface HandoffRepository {
  get(id: HandoffId): Promise<Handoff | undefined>;
  listByInstance(instanceId: InstanceId): Promise<Handoff[]>;
}

/** Peer messages as the views show them (C-09), read from the delivery store's records with `PeerMeta`. */
export interface PeerMessageRepository {
  get(id: PeerMessageId): Promise<PeerMessage | undefined>;
  list(): Promise<PeerMessage[]>;
}

/**
 * Cross-tool transfer proposals (R-02, C-12). The proposal itself is saved here with compare-and-set on
 * `revision` (a changed source makes it stale, CR-5). What is saved of the delivery side is only the link:
 * `operationId` and `provision.operationId` (with its `bindingKey`, fixed at approval). Every read takes
 * the rest from the delivery store in the same transaction: `provision` is that provision's current
 * record, `delivery` the payload's, and `createdSessionId` is the provision's target session once the
 * provision is sent (so `transfer.created-session` always holds). What a save passes for these is ignored.
 */
export interface TransferRepository {
  get(id: TransferId): Promise<TransferProposal | undefined>;
  list(): Promise<TransferProposal[]>;
  /** `exists` when the ID is taken (the renderer chose it with `transfer.prepare`). */
  create(proposal: TransferProposal): Promise<'created' | 'exists'>;
  /**
   * Compare-and-set on `revision`: `stale` unless the stored proposal is at `expectedRevision`. The proposal
   * is stored as given and must already carry `revision: expectedRevision + 1` (anything else is a caller
   * bug and is refused with a thrown `TypeError`), so an approval saved with `approvedRevision` equal to
   * that revision passes `transfer.approval-revision` and binds exactly what was stored with it; a later
   * cancel or failure is another update with the next revision, keeping `approvedRevision`.
   */
  update(proposal: TransferProposal, expectedRevision: Revision): Promise<SaveResult<TransferProposal>>;
}

/**
 * Everything the Snapshot holds that lives in these repositories, read in one transaction so it is
 * consistent. With `recentTurns`, `conversations` holds of each session only its last `recentTurns` turns and
 * their records, plus whatever is still open (running turns, pending permission requests, native tasks not
 * ended), and `historyPages` says where each shortened history continues (C-26); without it, everything.
 */
export interface SnapshotData {
  agents: AgentDefinition[];
  workflows: WorkflowTemplate[];
  sessions: LogicalSession[];
  conversations: Conversation;
  escalations: Escalation[];
  preferences: UiPreferences;
  instances: WorkflowInstance[];
  handoffs: Handoff[];
  peerMessages: PeerMessage[];
  transfers: TransferProposal[];
  projects: ProjectSettings[];
  historyPages: HistoryPageInfo[];
}

export interface SnapshotOptions {
  recentTurns?: number;
}

export interface AppRepositories {
  agents: AgentRepository;
  workflows: WorkflowRepository;
  sessions: SessionRepository;
  conversations: ConversationRepository;
  escalations: EscalationRepository;
  preferences: PreferencesRepository;
  processes: OwnedProcessRepository;
  instances: InstanceRepository;
  handoffs: HandoffRepository;
  peerMessages: PeerMessageRepository;
  transfers: TransferRepository;
  projects: ProjectRepository;
  /** Which GUI-made work folder belongs to which session (T048). */
  workFolders: WorkFolderClaimRepository;
  /** One-time marks (T063). */
  markers: MarkerRepository;
  /**
   * In ONE transaction (T063): each Agent and template whose ID is free is stored with revision 0 (one already stored
   * under its ID is kept as it is), then the mark is set; every record passes its schema. All or nothing: a failure
   * leaves none of it. Returns the IDs stored now.
   */
  seedDefinitions(seed: DefinitionSeed): Promise<string[]>;
  readSnapshotData(options?: SnapshotOptions): Promise<SnapshotData>;
}

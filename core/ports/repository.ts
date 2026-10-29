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

/** Result of a compare-and-set save: `stale` returns what is stored now so the caller can show both. */
export type SaveResult<T> = { status: 'saved'; record: T } | { status: 'stale'; current: T | undefined };

export type DeleteResult = 'deleted' | 'stale' | 'not-found';

/**
 * Agents and workflow templates: `expectedRevision` null means "create; it must not exist yet". Only the
 * current revision is kept (C-11): a session started or resumed later uses the Agent's current
 * instructions; a running workflow instance keeps its own pinned `workflowRevision` by number only.
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
 * `revision` (a changed source makes it stale, CR-5); its `provision` and `delivery` are the delivery
 * store's records of `provision.operationId` and `operationId`, read back on every get, and what a save
 * passes for them is ignored.
 */
export interface TransferRepository {
  get(id: TransferId): Promise<TransferProposal | undefined>;
  list(): Promise<TransferProposal[]>;
  /** `exists` when the ID is taken (the renderer chose it with `transfer.prepare`). */
  create(proposal: TransferProposal): Promise<'created' | 'exists'>;
  /**
   * Compare-and-set on `revision`; the stored proposal gets `expectedRevision + 1`. An approval is saved
   * with `approvedRevision` set to that new revision, so the approval binds what was stored with it.
   */
  update(proposal: TransferProposal, expectedRevision: Revision): Promise<SaveResult<TransferProposal>>;
}

/**
 * Everything the Snapshot holds that lives in these repositories, read in one transaction so it is
 * consistent.
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
  readSnapshotData(): Promise<SnapshotData>;
}

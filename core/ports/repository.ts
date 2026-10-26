// Repository ports (T012, C-12): durable records of what the GUI shows, beside the delivery store (CR-2).
// T015 implements them on the T007 SQLite database; the session service (T017) uses them. Every method
// is one transaction. Editable records use compare-and-set on `revision` (DATA_RUNTIME §1).
import type {
  AgentDefinition,
  AgentId,
  Artifact,
  Escalation,
  EscalationId,
  LogicalSession,
  Message,
  NativeTask,
  OwnedProcess,
  PermissionRequest,
  Revision,
  SessionId,
  SessionItem,
  Timestamp,
  Turn,
  UiPreferences,
  WorkflowId,
  WorkflowTemplate,
} from '../../contracts';

/** Result of a compare-and-set save: `stale` returns what is stored now so the caller can show both. */
export type SaveResult<T> = { status: 'saved'; record: T } | { status: 'stale'; current: T | undefined };

export type DeleteResult = 'deleted' | 'stale' | 'not-found';

/** Agents and workflow templates: `expectedRevision` null means "create; it must not exist yet". */
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

/**
 * Everything the Snapshot holds that lives in these repositories, read in one transaction so it is
 * consistent. Workflow instances, handoffs, peer messages and transfers come with batch 4; until then an
 * implementation returns them empty.
 */
export interface SnapshotData {
  agents: AgentDefinition[];
  workflows: WorkflowTemplate[];
  sessions: LogicalSession[];
  conversations: Conversation;
  escalations: Escalation[];
  preferences: UiPreferences;
}

export interface AppRepositories {
  agents: AgentRepository;
  workflows: WorkflowRepository;
  sessions: SessionRepository;
  conversations: ConversationRepository;
  escalations: EscalationRepository;
  preferences: PreferencesRepository;
  processes: OwnedProcessRepository;
  readSnapshotData(): Promise<SnapshotData>;
}

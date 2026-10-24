// IPC commands (renderer -> main), results, and events (main -> renderer). DATA_RUNTIME §7.
// Every command carries a requestId and explicit target IDs; the renderer's current selection is
// never used to decide where a command goes (HC-05).
import { z } from 'zod';
import { AgentDefinition, ModelSelection } from './agent';
import { AgentId, EscalationId, NativeTaskId, RequestId, Revision, SessionId, Timestamp, TransferId, WorkflowId } from './common';
import { Attachment, LogicalSession, Message, NativeTask, SessionActivity, Turn } from './session';
import { TransferProposal, UiPreferences } from './transfer';
import { Escalation, WorkflowInstance, WorkflowTemplate } from './workflow';

const cmd = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), requestId: RequestId, ...shape });

export const Command = z.discriminatedUnion('type', [
  cmd('session.create', { kind: z.literal('ordinary'), agentId: AgentId, model: ModelSelection, cwd: z.string().min(1), parentId: SessionId.optional() }),
  cmd('session.send', { sessionId: SessionId, expectedRevision: Revision, text: z.string().min(1), attachments: z.array(Attachment).default([]) }),
  cmd('session.interrupt', { sessionId: SessionId }),
  /** Same-runtime model change only; changing runtime goes through transfer (R-02, R-12). */
  cmd('session.setModel', { sessionId: SessionId, expectedRevision: Revision, model: ModelSelection }),
  /** Rejected for workflow sessions (WB-02). */
  cmd('session.setAgent', { sessionId: SessionId, expectedRevision: Revision, agentId: AgentId }),
  cmd('session.reparent', { sessionId: SessionId, expectedRevision: Revision, parentId: SessionId.nullable() }),
  cmd('nativeTask.stop', { sessionId: SessionId, nativeTaskId: NativeTaskId }),
  cmd('agent.save', { agent: AgentDefinition, expectedRevision: Revision.nullable() }),
  cmd('workflow.save', { workflow: WorkflowTemplate, expectedRevision: Revision.nullable() }),
  cmd('workflow.start', { workflowId: WorkflowId, workflowRevision: Revision, title: z.string().min(1), cwd: z.string().min(1), firstMessage: z.string().min(1), crossToolConsent: z.boolean() }),
  cmd('escalation.respond', { escalationId: EscalationId, decision: z.enum(['approve', 'decline']), note: z.string().optional() }),
  cmd('transfer.prepare', { sourceSessionId: SessionId, target: ModelSelection, noteSource: z.enum(['agent', 'gui-digest']) }),
  cmd('transfer.confirm', { transferId: TransferId, expectedRevision: Revision }),
  cmd('transfer.cancel', { transferId: TransferId }),
  cmd('preferences.set', { preferences: UiPreferences }),
]);
export type Command = z.infer<typeof Command>;

/** Error codes the renderer can act on; it must not parse message text (DATA_RUNTIME §7). */
export const ErrorCode = z.enum([
  'unsupported',
  'stale_revision',
  'permission_denied',
  'runtime_unavailable',
  'invalid_transition',
  'unknown_outcome',
  'storage_failed',
  'not_found',
  'invalid_request',
  'usage_limit', // a RULES.md threshold stopped the action
]);

export const CommandResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), requestId: RequestId, revision: Revision.optional() }),
  z.strictObject({
    ok: z.literal(false),
    requestId: RequestId,
    code: ErrorCode,
    message: z.string(),
    retryable: z.boolean(),
    /** True when a side effect may already have happened (do not blindly retry). */
    mayHaveSideEffects: z.boolean(),
  }),
]);
export type CommandResult = z.infer<typeof CommandResult>;

/** Push events. Each carries the target ID it belongs to; views filter by it (HC-05). */
export const AppEvent = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('session.updated'), session: LogicalSession }),
  z.strictObject({ type: z.literal('session.activity'), sessionId: SessionId, activity: SessionActivity, at: Timestamp }),
  z.strictObject({ type: z.literal('turn.updated'), turn: Turn }),
  z.strictObject({ type: z.literal('message.delta'), sessionId: SessionId, messageId: z.string().min(1), delta: z.string() }),
  z.strictObject({ type: z.literal('message.completed'), message: Message }),
  z.strictObject({ type: z.literal('nativeTask.updated'), task: NativeTask }),
  z.strictObject({ type: z.literal('instance.updated'), instance: WorkflowInstance }),
  z.strictObject({ type: z.literal('escalation.updated'), escalation: Escalation }),
  z.strictObject({ type: z.literal('transfer.updated'), proposal: TransferProposal }),
  z.strictObject({ type: z.literal('usage.updated'), claude5h: z.number().min(0).max(100).optional(), claudeWeekly: z.number().min(0).max(100).optional(), codexWeekly: z.number().min(0).max(100).optional(), at: Timestamp }),
]);
export type AppEvent = z.infer<typeof AppEvent>;

/** Read-only snapshot the renderer loads on start / reconnect (UI re-mount never resends commands). */
export const Snapshot = z.strictObject({
  agents: z.array(AgentDefinition),
  workflows: z.array(WorkflowTemplate),
  sessions: z.array(LogicalSession),
  messages: z.array(Message),
  turns: z.array(Turn),
  nativeTasks: z.array(NativeTask),
  instances: z.array(WorkflowInstance),
  escalations: z.array(Escalation),
  transfers: z.array(TransferProposal),
  preferences: UiPreferences,
});
export type Snapshot = z.infer<typeof Snapshot>;


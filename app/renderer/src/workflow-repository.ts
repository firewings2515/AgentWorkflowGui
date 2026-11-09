import { Command, RequestId, WorkflowTemplate } from '../../../contracts';
import type { BuiltinTemplateKey, CommandResult } from '../../../contracts';
import type { RendererStore } from './renderer-store';

export type SaveWorkflowCommand = Extract<Command, { type: 'workflow.save' }>;
export type DeleteWorkflowCommand = Extract<Command, { type: 'workflow.delete' }>;
export type AddStarterCommand = Extract<Command, { type: 'workflow.addStarter' }>;
export interface WorkflowRepository {
  readonly mode: 'demo' | 'ipc';
  getSnapshot: () => readonly WorkflowTemplate[];
  subscribe: (listener: () => void) => () => void;
  save: (command: SaveWorkflowCommand) => Promise<CommandResult>;
  /** T063: deletes a saved template (contracts 0.11). */
  delete: (command: DeleteWorkflowCommand) => Promise<CommandResult>;
  /** T063, T070: adds a template of the template library (the starter set without a key); absent in the demo (it has no core to make it). */
  addStarter?: (command: AddStarterCommand) => Promise<CommandResult>;
  isBlocked?: (id: string) => boolean;
  acknowledge?: (id: string) => void;
}
const emptyWorkflows: readonly WorkflowTemplate[] = [];
export function createIpcWorkflowRepository(store: RendererStore): WorkflowRepository {
  return { mode: 'ipc', getSnapshot: () => store.getSnapshot().snapshot?.workflows ?? emptyWorkflows, subscribe: store.subscribe,
    save: store.send, delete: store.send, addStarter: store.send,
    isBlocked: id => store.isBlocked('workflow.save', `workflow:${id}`) || store.isBlocked('workflow.delete', `workflow:${id}`),
    acknowledge: id => { store.acknowledge('workflow.save', `workflow:${id}`); store.acknowledge('workflow.delete', `workflow:${id}`); } };
}
export const workflowDeleteCommand = (workflow: WorkflowTemplate): DeleteWorkflowCommand => ({
  type: 'workflow.delete', requestId: RequestId.parse(crypto.randomUUID()), workflowId: workflow.id, expectedRevision: workflow.revision,
});
/** The 0.11 call without a key (the starter set); with one, that library template (T070). */
export const addStarterCommand = (template?: BuiltinTemplateKey): AddStarterCommand => ({
  type: 'workflow.addStarter', requestId: RequestId.parse(crypto.randomUUID()), ...(template !== undefined && { template }),
});
export const workflowSaveCommand = (workflow: WorkflowTemplate, expectedRevision: number | null): SaveWorkflowCommand => ({
  type: 'workflow.save', requestId: RequestId.parse(crypto.randomUUID()), workflow, expectedRevision,
});

// Demo facade: only fixtures and explicit user edits, used when no preload bridge exists.
export function createWorkflowRepository(initial: readonly WorkflowTemplate[], shouldFail: (command: SaveWorkflowCommand) => boolean = () => false): WorkflowRepository {
  let workflows = initial.map(item => WorkflowTemplate.parse(item));
  const listeners = new Set<() => void>();
  return {
    mode: 'demo',
    getSnapshot: () => workflows,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: async command => {
      await Promise.resolve();
      const error = (code: Extract<CommandResult, { ok: false }>['code'], message: string, retryable = false): CommandResult => ({
        ok: false, requestId: command.requestId, code, message, retryable, mayHaveSideEffects: false,
      });
      if (!Command.safeParse(command).success) return error('invalid_request', 'Workflow 不符合契約，草稿仍保留。');
      const current = workflows.find(item => item.id === command.workflow.id);
      if (command.expectedRevision === null && current) return error('already_exists', '此 Workflow ID 已存在。');
      if (command.expectedRevision !== null && !current) return error('not_found', '此 Workflow 已不存在，草稿仍保留。');
      if (current && current.revision !== command.expectedRevision) return error('stale_revision', 'Workflow 已有較新版本，請比對後重新編輯。');
      if (shouldFail(command)) return error('storage_failed', '模擬儲存失敗；草稿仍保留，可再次儲存。', true);
      const saved = WorkflowTemplate.parse({ ...command.workflow, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
      workflows = current ? workflows.map(item => item.id === saved.id ? saved : item) : [...workflows, saved];
      listeners.forEach(listener => listener());
      return { ok: true, requestId: command.requestId, revision: saved.revision, created: [] };
    },
    delete: async command => {
      await Promise.resolve();
      const current = workflows.find(item => item.id === command.workflowId);
      const fail = (code: Extract<CommandResult, { ok: false }>['code'], message: string): CommandResult => ({ ok: false, requestId: command.requestId, code, message, retryable: false, mayHaveSideEffects: false });
      if (!current) return fail('not_found', '此 Workflow 已不存在。');
      if (current.revision !== command.expectedRevision) return fail('stale_revision', 'Workflow 已有較新版本。');
      workflows = workflows.filter(item => item.id !== command.workflowId);
      listeners.forEach(listener => listener());
      return { ok: true, requestId: command.requestId, created: [] };
    },
  };
}

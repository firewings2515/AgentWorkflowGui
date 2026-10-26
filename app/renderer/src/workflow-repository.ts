import { Command, RequestId, WorkflowTemplate } from '../../../contracts';
import type { CommandResult } from '../../../contracts';

export type SaveWorkflowCommand = Extract<Command, { type: 'workflow.save' }>;
export interface WorkflowRepository {
  getSnapshot: () => readonly WorkflowTemplate[];
  subscribe: (listener: () => void) => () => void;
  save: (command: SaveWorkflowCommand) => Promise<CommandResult>;
}
export const workflowSaveCommand = (workflow: WorkflowTemplate, expectedRevision: number | null): SaveWorkflowCommand => ({
  type: 'workflow.save', requestId: RequestId.parse(crypto.randomUUID()), workflow, expectedRevision,
});

// Demo facade: only fixtures and explicit user edits. T018 can replace this with IPC.
export function createWorkflowRepository(initial: readonly WorkflowTemplate[], shouldFail: (command: SaveWorkflowCommand) => boolean = () => false): WorkflowRepository {
  let workflows = initial.map(item => WorkflowTemplate.parse(item));
  const listeners = new Set<() => void>();
  return {
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
  };
}

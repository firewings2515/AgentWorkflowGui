import { AgentDefinition, Command, RequestId } from '../../../contracts';
import type { CommandResult } from '../../../contracts';
import type { RendererStore } from './renderer-store';

export type SaveAgentCommand = Extract<Command, { type: 'agent.save' }>;
export type DeleteAgentCommand = Extract<Command, { type: 'agent.delete' }>;
export interface AgentRepository {
  readonly mode: 'demo' | 'ipc';
  getSnapshot: () => readonly AgentDefinition[];
  subscribe: (listener: () => void) => () => void;
  save: (command: SaveAgentCommand) => Promise<CommandResult>;
  delete: (command: DeleteAgentCommand) => Promise<CommandResult>;
  isBlocked?: (id: string, type?: 'agent.save' | 'agent.delete') => boolean;
  acknowledge?: (id: string, type?: 'agent.save' | 'agent.delete') => void;
}

const emptyAgents: readonly AgentDefinition[] = [];
export function createIpcAgentRepository(store: RendererStore): AgentRepository {
  return { mode: 'ipc', getSnapshot: () => store.getSnapshot().snapshot?.agents ?? emptyAgents, subscribe: store.subscribe,
    save: store.send,
    delete: async command => {
      const result = await store.send(command);
      if (result.ok && store.getSnapshot().snapshot?.agents.some(agent => agent.id === command.agentId)) {
        return { ok: false, requestId: command.requestId, code: 'internal_error', message: '刪除已接受，但尚未取得刪除後的快照。', retryable: false, mayHaveSideEffects: true };
      }
      return result;
    },
    isBlocked: (id, type = 'agent.save') => store.isBlocked(type, `agent:${id}`),
    acknowledge: (id, type = 'agent.save') => store.acknowledge(type, `agent:${id}`) };
}
export const agentDeleteCommand = (agent: AgentDefinition): DeleteAgentCommand => ({
  type: 'agent.delete', requestId: RequestId.parse(crypto.randomUUID()), agentId: agent.id, expectedRevision: agent.revision,
});

export const agentSaveCommand = (agent: AgentDefinition, expectedRevision: number | null): SaveAgentCommand => ({
  type: 'agent.save', requestId: RequestId.parse(crypto.randomUUID()), agent, expectedRevision,
});

// In-memory demo facade. Only fixture records and explicit user edits enter this store.
// The IPC implementation above shares the renderer store; this implementation is preview-only.
export function createAgentRepository(initial: readonly AgentDefinition[], shouldFailSave: (command: SaveAgentCommand) => boolean = () => false, isUsed: (id: string) => boolean = () => false): AgentRepository {
  let agents = initial.map(agent => AgentDefinition.parse(agent));
  const listeners = new Set<() => void>();
  return {
    mode: 'demo',
    getSnapshot: () => agents,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    delete: async command => {
      await Promise.resolve();
      const current = agents.find(agent => agent.id === command.agentId);
      const code = !current ? 'not_found' : current.revision !== command.expectedRevision ? 'stale_revision' : isUsed(command.agentId) ? 'invalid_transition' : null;
      if (code) return { ok: false, requestId: command.requestId, code, message: '', retryable: false, mayHaveSideEffects: false };
      agents = agents.filter(agent => agent.id !== command.agentId);
      listeners.forEach(listener => listener());
      return { ok: true, requestId: command.requestId, created: [] };
    },
    save: async command => {
      // Yield once so the form presents pending state; check the revision at write time.
      await Promise.resolve();
      const error = (code: Extract<CommandResult, { ok: false }>['code'], message: string, retryable = false): CommandResult => ({
        ok: false, requestId: command.requestId, code, message, retryable, mayHaveSideEffects: false,
      });
      if (!Command.safeParse(command).success || !command.agent.name.trim() || !command.agent.instructions.trim()) {
        return error('invalid_request', '請填寫名稱及指示。');
      }
      const current = agents.find(agent => agent.id === command.agent.id);
      if (command.expectedRevision === null && current) return error('already_exists', '此 Agent ID 已存在。');
      if (command.expectedRevision !== null && !current) return error('not_found', '此 Agent 已不存在，草稿仍保留。');
      if (current && current.revision !== command.expectedRevision) return error('stale_revision', 'Agent 已有較新版本，請比對後重新編輯。');
      if (shouldFailSave(command)) return error('storage_failed', '模擬儲存失敗；資料未變更，草稿仍保留，可再次儲存。', true);
      const saved = AgentDefinition.parse({ ...command.agent, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
      agents = current ? agents.map(agent => agent.id === saved.id ? saved : agent) : [...agents, saved];
      listeners.forEach(listener => listener());
      return { ok: true, requestId: command.requestId, revision: saved.revision, created: [] };
    },
  };
}

import { AgentDefinition, Command, RequestId } from '../../../contracts';
import type { CommandResult } from '../../../contracts';

export type SaveAgentCommand = Extract<Command, { type: 'agent.save' }>;
export interface AgentRepository {
  getSnapshot: () => readonly AgentDefinition[];
  subscribe: (listener: () => void) => () => void;
  save: (command: SaveAgentCommand) => Promise<CommandResult>;
}

export const agentSaveCommand = (agent: AgentDefinition, expectedRevision: number | null): SaveAgentCommand => ({
  type: 'agent.save', requestId: RequestId.parse(crypto.randomUUID()), agent, expectedRevision,
});

// In-memory demo facade. Only fixture records and explicit user edits enter this store.
// A future bridge can implement this interface without moving repository state into the form.
export function createAgentRepository(initial: readonly AgentDefinition[], shouldFailSave: (command: SaveAgentCommand) => boolean = () => false): AgentRepository {
  let agents = initial.map(agent => AgentDefinition.parse(agent));
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => agents,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
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

import type { AgentDefinition } from '../../../contracts';
import { createAgentRepository } from './agent-repository';

export interface AgentDemoControls {
  setSaveFailure: (id: string, enabled: boolean) => void;
}

// Demo-only controls are injected at construction, outside the save contract.
export function createAgentDemo(initial: readonly AgentDefinition[], isUsed?: (id: string) => boolean) {
  const failures = new Set<string>();
  const controls: AgentDemoControls = {
    setSaveFailure: (id, enabled) => { if (enabled) failures.add(id); else failures.delete(id); },
  };
  return { repository: createAgentRepository(initial, command => failures.delete(command.agent.id), isUsed), controls };
}

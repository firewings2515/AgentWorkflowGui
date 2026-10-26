import type { WorkflowTemplate } from '../../../contracts';
import { createWorkflowRepository } from './workflow-repository';

export interface WorkflowDemoControls { setSaveFailure: (id: string, enabled: boolean) => void; hasSaveFailure: (id: string) => boolean }
export function createWorkflowDemo(initial: readonly WorkflowTemplate[]) {
  const failures = new Set<string>();
  const controls: WorkflowDemoControls = {
    setSaveFailure: (id, enabled) => { if (enabled) failures.add(id); else failures.delete(id); },
    hasSaveFailure: id => failures.has(id),
  };
  return { repository: createWorkflowRepository(initial, command => failures.delete(command.workflow.id)), controls };
}

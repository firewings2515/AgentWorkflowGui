// T048 a run's two folders on the memory ports (the same cases on SQLite: app/main/workflow-t048.test.ts).
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { WorkflowRepositories, worldOn } from './testing/harness';
import { t048WorkflowCases } from './testing/t048-cases';

t048WorkflowCases('memory', (workflow, extra) => {
  const store = new MemoryDeliveryStore();
  return worldOn(new WorkflowRepositories(store), store, workflow, undefined, undefined, extra);
});

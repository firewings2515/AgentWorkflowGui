// T048 a run's two folders on the memory ports and folders (the same cases on SQLite and real work folders:
// app/main/workflow-t048.test.ts).
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { MemoryWorkFolderFs } from '../sessions/testing/memory-work-folders';
import { CWD, WorkflowRepositories, worldOn } from './testing/harness';
import { memoryRealPath, t048WorkflowCases } from './testing/t048-cases';

t048WorkflowCases(
  'memory',
  (workflow, extra) => {
    const store = new MemoryDeliveryStore();
    return worldOn(new WorkflowRepositories(store), store, workflow, undefined, undefined, extra);
  },
  () => {
    const fs = new MemoryWorkFolderFs(['E:\\work', CWD]);
    return {
      fs,
      location: 'E:\\work\\AgentWorkflowGui',
      elsewhere: 'E:\\work\\elsewhere',
      exists: (path) => fs.exists(path),
      makeForeign: (path) => fs.makeTree(path),
      realPath: memoryRealPath,
    };
  },
);

// T063 workflow.delete and workflow.addStarter on the memory ports (the same cases on SQLite: app/main/workflow-t063.test.ts).
import { world } from './testing/harness';
import { t063WorkflowCases } from './testing/t063-cases';

t063WorkflowCases('memory', (workflow) => world(workflow));

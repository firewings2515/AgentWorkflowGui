// T069 on the memory ports (the cases: core/workflow/testing/t069-cases.ts; on SQLite: app/main/workflow-t069.test.ts).
import { world } from './testing/harness';
import { t069Cases } from './testing/t069-cases';

t069Cases('memory', (workflow) => world(workflow));

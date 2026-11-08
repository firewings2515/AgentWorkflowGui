// T068 on the memory ports (the cases: core/workflow/testing/t068-cases.ts; on SQLite: app/main/workflow-t068.test.ts).
import { world } from './testing/harness';
import { t068Cases } from './testing/t068-cases';

t068Cases('memory', (workflow) => world(workflow));

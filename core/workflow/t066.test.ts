// T066 on the memory ports (the cases: core/workflow/testing/t066-cases.ts; on SQLite: app/main/workflow-t066.test.ts).
import { world } from './testing/harness';
import { t066Cases } from './testing/t066-cases';

t066Cases('memory', (workflow) => world(workflow));

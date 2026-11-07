// T065 on the memory ports (the cases: core/workflow/testing/t065-cases.ts; on SQLite: app/main/workflow-t065.test.ts).
import { world } from './testing/harness';
import { t065Cases } from './testing/t065-cases';

t065Cases('memory', (workflow) => world(workflow));

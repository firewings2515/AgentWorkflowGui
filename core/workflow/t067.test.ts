// T067 on the memory ports (the cases: core/workflow/testing/t067-cases.ts; on SQLite: app/main/workflow-t067.test.ts).
import { world } from './testing/harness';
import { t067Cases } from './testing/t067-cases';

t067Cases('memory', (workflow) => world(workflow));

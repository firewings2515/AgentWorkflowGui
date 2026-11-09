// T070 the template library and the built-in templates on fake runtimes, on the memory ports (the same cases on SQLite:
// app/main/workflow-t070.test.ts).
import { world } from './testing/harness';
import { t070LibraryCases, t070RunCases } from './testing/t070-cases';

t070LibraryCases('memory', (workflow) => world(workflow));
t070RunCases('memory', (workflow) => world(workflow));

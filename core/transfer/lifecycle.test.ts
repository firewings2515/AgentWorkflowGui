// T023 in core: unknown outcomes, cancels in every state, failures, restarts between steps, the MCP token.
// The same cases run on the SQLite storage in app/main/transfer-sqlite.test.ts.
import { lifecycleCases } from './testing/lifecycle-cases';
import { world } from './testing/harness';

lifecycleCases('memory', world);

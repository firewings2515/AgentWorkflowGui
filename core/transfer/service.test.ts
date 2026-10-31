// T023 acceptance in core: fake adapters and memory ports (the proposals projected from the delivery store).
// The same cases run on the SQLite storage in app/main/transfer-sqlite.test.ts.
import { commandCases } from './testing/command-cases';
import { world } from './testing/harness';

commandCases('memory', world);

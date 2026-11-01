// T039 crash matrix on memory storage; the same cases run on SQLite in crash-sqlite.test.ts.
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { supWorldOn } from '../../core/supervisor/testing/harness';
import { world } from '../../core/workflow/testing/harness';
import { crashCases } from './cases';

crashCases(
  'memory',
  (o) => supWorldOn(new MemoryRepositories(), new MemoryDeliveryStore(), o),
  (workflow) => world(workflow),
);

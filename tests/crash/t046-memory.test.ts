// T046 cases on memory storage; the same cases run on SQLite in t046-sqlite.test.ts.
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { supWorldOn } from '../../core/supervisor/testing/harness';
import { world } from '../../core/workflow/testing/harness';
import { noHistoryCases } from './t046-cases';

noHistoryCases(
  'memory',
  (o) => supWorldOn(new MemoryRepositories(), new MemoryDeliveryStore(), o),
  (workflow) => world(workflow),
);

// T050 pinned lists and session.rename sent again, on the memory ports (the same cases on SQLite:
// app/main/t050-sqlite.test.ts).
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { MemoryRepositories } from './testing/memory-repositories';
import { t050SessionCases } from './testing/t050-cases';

t050SessionCases('memory', () => ({ repositories: new MemoryRepositories(), store: new MemoryDeliveryStore() }));

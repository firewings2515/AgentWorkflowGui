// T059 archiving (U4), on the memory ports (the same cases on SQLite: app/main/t059-sqlite.test.ts).
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { MemoryRepositories } from './testing/memory-repositories';
import { t059Cases } from './testing/t059-cases';

t059Cases('memory', () => ({ repositories: new MemoryRepositories(), store: new MemoryDeliveryStore() }));

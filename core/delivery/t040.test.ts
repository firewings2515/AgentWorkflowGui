// T040 system-notice on the memory store.
import { MemoryDeliveryStore } from './testing/memory-store';
import { t040DeliveryCases } from './testing/t040-cases';

t040DeliveryCases('memory', () => {
  const store = new MemoryDeliveryStore();
  return { store, reopen: () => store };
});

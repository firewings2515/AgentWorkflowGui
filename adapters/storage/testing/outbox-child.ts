// A GUI process for the crash and race scenarios (outbox.test.ts bundles and forks it): dispatches one
// operation and, at the named stage, reports it and hangs until the parent kills it. In `race` mode it
// reports ready, waits for the parent's go, and holds its claim briefly before calling the receiver.
// argv: <database> <receiver> <operationId> <stage | 'before-claim' | 'race' | 'none'>
import type { OperationId } from '../../../contracts';
import { openDatabase } from '../database';
import { SqliteDeliveryStore } from '../delivery-store';
import { dispatch, receive } from './outbox';

const [databasePath = '', receiverPath = '', operationId = '', stage = 'none'] = process.argv.slice(2);

const hang = (reached: string): Promise<never> => {
  process.send?.({ stage: reached });
  return new Promise<never>(() => setInterval(() => undefined, 1000));
};

const db = openDatabase(databasePath);
if (stage === 'before-claim') await hang(stage);
if (stage === 'race') {
  await new Promise<void>((resolve) => {
    process.once('message', () => resolve());
    process.send?.({ ready: true });
  });
}
const result = await dispatch(
  new SqliteDeliveryStore(db),
  operationId as OperationId,
  (record, attempt) => receive(receiverPath, record, attempt),
  async (reached) => {
    if (reached === stage) await hang(reached);
    if (stage === 'race' && reached === 'before-call') await new Promise((resolve) => setTimeout(resolve, 300));
  },
);
db.close();
process.send?.({ result }, () => process.exit(0));

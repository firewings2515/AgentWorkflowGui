// A GUI process for the crash and race scenarios (outbox.test.ts bundles and forks it): dispatches one
// operation and, at the named stage, reports it and hangs until the parent kills it. In `race` mode it
// reports ready and waits for the parent's go; if it wins the claim, it reports that and waits for the
// parent to release it (after every other process settled its claim) before calling the receiver.
// argv: <database> <receiver> <operationId> <stage | 'before-claim' | 'race' | 'none'>
import type { OperationId } from '../../../contracts';
import { openDatabase } from '../database';
import { SqliteDeliveryStore } from '../delivery-store';
import { dispatch, receive } from './outbox';
import { payloadInput, COUNT_KEY } from './fixtures';

const [databasePath = '', receiverPath = '', operationId = '', stage = 'none'] = process.argv.slice(2);

const hang = (reached: string): Promise<never> => {
  process.send?.({ stage: reached });
  return new Promise<never>(() => setInterval(() => undefined, 1000));
};

const db = openDatabase(databasePath);
if (stage === 'before-claim') await hang(stage);
/** Reports `message` and waits for the parent's answer. */
const handshake = (message: object) =>
  new Promise<void>((resolve) => {
    process.once('message', () => resolve());
    process.send?.(message);
  });

if (stage === 'race') await handshake({ ready: true });
if (stage.startsWith('accept-')) {
  if (stage === 'accept-race') await handshake({ ready: true });
  if (stage === 'accept-uncommitted') {
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === 'COMMIT') {
        process.send?.({ stage });
        // Stop inside the transaction after all inserts; the parent kills this process.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      exec(sql);
    };
  }
  const accepted = await new SqliteDeliveryStore(db).accept(payloadInput({
    counts: [{ key: COUNT_KEY, limit: 3 }, { key: 'rework', limit: 1 }],
  }));
  if (stage === 'accept-committed') await hang(stage);
  db.close();
  process.send?.({ result: accepted.status }, () => process.exit(0));
  // Keep the child from entering the unrelated dispatch scenario below.
  await new Promise<never>(() => undefined);
}
const result = await dispatch(
  new SqliteDeliveryStore(db),
  operationId as OperationId,
  (record, attempt) => receive(receiverPath, record, attempt),
  async (reached) => {
    if (reached === stage) await hang(reached);
    if (stage === 'race' && reached === 'before-call') await handshake({ claimed: true });
  },
);
db.close();
process.send?.({ result }, () => process.exit(0));

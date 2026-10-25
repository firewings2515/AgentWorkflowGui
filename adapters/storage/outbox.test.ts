// The 10 CR-2 scenarios of spike/review-followup/cr2-outbox-test.mjs, on the real store and real SQLite
// files. Races and crashes use separate GUI processes (testing/outbox-child.ts, bundled once with vite)
// that are killed at each stage; the receiver ledger is its own SQLite file.
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommitUncertainError } from '../../core/ports';
import { openDatabase } from './database';
import { SqliteDeliveryStore } from './delivery-store';
import { THREAD, at, claimInput, hashOf, op, payloadInput } from './testing/fixtures';
import { createReceiver, dispatch, receive, receivedRows, reconcile, type Stage } from './testing/outbox';

const here = dirname(fileURLToPath(import.meta.url));
const OP = op('op-1');
let root = '';
let child = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'awg-t007-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root: here,
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: join(here, 'testing/outbox-child.ts'),
      outDir: join(root, 'child'),
      write: true,
      minify: false,
      rolldownOptions: { output: { format: 'es', entryFileNames: 'outbox-child.mjs' } },
    },
  });
  child = join(root, 'child', 'outbox-child.mjs');
}, 60_000);

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold a just-killed child's files a little longer; the OS temp folder is cleaned later.
  }
});

let n = 0;
/** A GUI database with op-1 accepted (pending, target bound) and an empty receiver. */
const fresh = async () => {
  const dir = join(root, String(++n));
  mkdirSync(dir);
  const paths = { db: join(dir, 'local.sqlite'), receiver: join(dir, 'receiver.sqlite') };
  await withStore(paths.db, async (store) => expect((await store.accept(payloadInput())).status).toBe('accepted'));
  createReceiver(paths.receiver);
  return paths;
};

const withStore = async <T>(path: string, body: (store: SqliteDeliveryStore, db: DatabaseSync) => Promise<T>): Promise<T> => {
  const db = openDatabase(path);
  try {
    return await body(new SqliteDeliveryStore(db), db);
  } finally {
    db.close();
  }
};

type Mode = Stage | 'before-claim' | 'race' | 'none';
const runsToEnd = (stage: Mode) => stage === 'none' || stage === 'race';

/**
 * Runs one GUI process; with a stage, kills it as soon as it reports reaching that stage. In `race` mode
 * the process waits for `start` and then holds its claim briefly before calling the receiver.
 */
const launch = (paths: { db: string; receiver: string }, stage: Mode, start?: () => Promise<void>) =>
  new Promise<{ result?: string }>((resolve, reject) => {
    const proc = fork(child, [paths.db, paths.receiver, OP, stage], {
      execArgv: ['--disable-warning=ExperimentalWarning'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let stderr = '';
    let reached = false;
    let result: string | undefined;
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`child timed out at ${stage}: ${stderr}`));
    }, 20_000);
    proc.on('message', (message: { ready?: boolean; stage?: string; result?: string }) => {
      if (message.ready === true) void start?.().then(() => proc.send('go'));
      if (message.stage !== undefined) {
        reached = true;
        proc.kill('SIGKILL');
      }
      result = message.result ?? result;
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (runsToEnd(stage) && code !== 0) reject(new Error(`child failed with ${String(code)}: ${stderr}`));
      else if (!runsToEnd(stage) && !reached) reject(new Error(`checkpoint ${stage} not reached: ${stderr}`));
      else resolve(result === undefined ? {} : { result });
    });
  });

/** Starts `count` GUI processes that all begin dispatching once every one of them is ready. */
const race = (paths: { db: string; receiver: string }, count: number) => {
  let ready = 0;
  let go = () => undefined as void;
  const started = new Promise<void>((resolve) => (go = resolve));
  return Promise.all(
    Array.from({ length: count }, () =>
      launch(paths, 'race', () => {
        if (++ready === count) go();
        return started;
      }),
    ),
  );
};

/** A restarted GUI: dispatch every pending delivery again (twice), then reconcile every unknown one. */
const recover = (paths: { db: string; receiver: string }) =>
  withStore(paths.db, async (store) => {
    for (let i = 0; i < 2; i++) {
      for (const record of await store.listByState('pending')) {
        await dispatch(store, record.operationId, (r, a) => receive(paths.receiver, r, a));
      }
    }
    for (const record of await store.listByState('unknown')) await reconcile(store, record.operationId, paths.receiver);
    return (await store.get(OP))?.delivery.state;
  });

describe('CR-2 outbox scenarios (spike cr2-outbox-test.mjs)', () => {
  it('1. duplicate admission counts once; changed payload or destination is rejected', async () => {
    await withStore(join(mkdtempSync(join(root, 'dup-')), 'local.sqlite'), async (store, db) => {
      expect(await store.accept(payloadInput())).toMatchObject({ status: 'accepted', count: 1 });
      expect(await store.accept(payloadInput({ at: at(5), sourceCallRef: 'call-1-resent' }))).toMatchObject({ status: 'duplicate' });
      expect(await store.accept(payloadInput({ target: { ...payloadInput().target, nativeSessionRef: 'thread-B' } }))).toMatchObject({ status: 'conflict' });
      expect(await store.accept(payloadInput({ payload: 'changed', payloadHash: hashOf('changed') }))).toMatchObject({ status: 'conflict' });
      expect(db.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 1 });
    });
  });

  it('2. two independent dispatch processes produce one delivery', async () => {
    const paths = await fresh();
    // Both start together and the winner holds its claim for a while, so the loser's claim really overlaps.
    const results = await race(paths, 2);
    expect(results.map((r) => r.result).sort()).toEqual(['not-pending', 'sent']);
    expect(receivedRows(paths.receiver)).toHaveLength(1);
    await withStore(paths.db, async (store) => expect((await store.get(OP))?.delivery.state).toBe('sent'));
  }, 30_000);

  // 3-6: the four crash positions of the spike, each followed by repeated recovery.
  it.each<[Stage, 'unknown' | 'sent', 'unknown' | 'sent', number]>([
    ['before-call', 'unknown', 'unknown', 0],
    ['after-receive', 'unknown', 'sent', 1],
    ['after-ack', 'unknown', 'sent', 1],
    ['sent', 'sent', 'sent', 1],
  ])('3-6. crash at %s, then repeated recovery never resends', async (stage, stateAtRestart, resolved, received) => {
    const paths = await fresh();
    await launch(paths, stage);
    await withStore(paths.db, async (store) => expect((await store.get(OP))?.delivery.state).toBe(stateAtRestart));
    expect(await recover(paths)).toBe(resolved);
    expect(await recover(paths)).toBe(resolved);
    expect(receivedRows(paths.receiver)).toHaveLength(received);
  }, 30_000);

  it('7. recovery of pending goes through the same committed claim; a second crash cannot duplicate', async () => {
    const paths = await fresh();
    // The first GUI dies with only the pending record committed.
    await launch(paths, 'before-claim');
    await withStore(paths.db, async (store) => expect((await store.get(OP))?.delivery.state).toBe('pending'));
    // The recovering GUI crashes again after the receiver got it; two more restarts follow.
    await launch(paths, 'after-receive');
    expect((await launch(paths, 'none')).result).toBe('not-pending');
    expect((await launch(paths, 'none')).result).toBe('not-pending');
    expect(receivedRows(paths.receiver)).toHaveLength(1);
    expect(await recover(paths)).toBe('sent');
  }, 30_000);

  it('8. a failed pre-dispatch transaction prevents the receiver call', async () => {
    const paths = await fresh();
    await withStore(paths.db, async (store, db) => {
      db.exec("CREATE TRIGGER fail_claim BEFORE UPDATE OF state ON delivery WHEN NEW.state = 'unknown' BEGIN SELECT RAISE(ABORT, 'injected db error'); END");
      await expect(dispatch(store, OP, (r, a) => receive(paths.receiver, r, a))).rejects.toThrow('injected db error');
      expect(receivedRows(paths.receiver)).toHaveLength(0);
      expect((await store.get(OP))?.delivery).toEqual({ state: 'pending', attempts: [] });
    });
  });

  it('8b. a COMMIT that fails is uncertain: CommitUncertainError, no receiver call, nothing claimed', async () => {
    const paths = await fresh();
    await withStore(paths.db, async (store, db) => {
      // A deferred foreign key is only checked by COMMIT, so the COMMIT statement itself fails.
      db.exec('CREATE TABLE commit_guard (ref TEXT REFERENCES missing_parent (id) DEFERRABLE INITIALLY DEFERRED)');
      db.exec('CREATE TABLE missing_parent (id TEXT PRIMARY KEY)');
      db.exec("CREATE TRIGGER fail_commit AFTER UPDATE OF state ON delivery WHEN NEW.state = 'unknown' BEGIN INSERT INTO commit_guard VALUES ('none'); END");
      const claim = store.claim(claimInput(OP));
      await expect(claim).rejects.toBeInstanceOf(CommitUncertainError);
      await expect(dispatch(store, OP, (r, a) => receive(paths.receiver, r, a))).rejects.toBeInstanceOf(CommitUncertainError);
      expect(receivedRows(paths.receiver)).toHaveLength(0);
      expect((await store.get(OP))?.delivery).toEqual({ state: 'pending', attempts: [] });
      // The connection is usable afterwards.
      db.exec('DROP TRIGGER fail_commit');
      expect(await dispatch(store, OP, (r, a) => receive(paths.receiver, r, a))).toBe('sent');
    });
  });

  it('9. a failed sent write stays unknown and recovery does not resend', async () => {
    const paths = await fresh();
    await withStore(paths.db, async (store, db) => {
      db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF state ON dispatch_attempt WHEN NEW.state = 'sent' BEGIN SELECT RAISE(ABORT, 'injected ack db error'); END");
      await expect(dispatch(store, OP, (r, a) => receive(paths.receiver, r, a))).rejects.toThrow('injected ack db error');
      expect((await store.get(OP))?.delivery.state).toBe('unknown');
      expect(await dispatch(store, OP, (r, a) => receive(paths.receiver, r, a))).toBe('not-pending');
      db.exec('DROP TRIGGER fail_ack');
    });
    expect(receivedRows(paths.receiver)).toHaveLength(1);
    expect(await recover(paths)).toBe('sent');
  });

  it('10. absent or mismatched evidence, including a stale attempt, never clears unknown', async () => {
    const paths = await fresh();
    await launch(paths, 'before-call');
    await withStore(paths.db, async (store) => {
      const record = await store.get(OP);
      const live = record?.delivery.attempts.at(-1);
      if (live === undefined) throw new Error('no attempt');
      const ref = { sessionRef: THREAD, itemRef: 'item-1' };
      const evidence = { kind: 'reconciled' as const, at: at(20), detail: 'test' };
      // Absent: nothing in the receiver.
      expect(await reconcile(store, OP, paths.receiver)).toBe('unknown');
      // Wrong operation, wrong target, stale or foreign attempt.
      expect(await store.recordSent(op('op-other'), live.attemptId, ref, evidence)).toBe('stale');
      expect(await store.recordSent(OP, live.attemptId, { ...ref, sessionRef: 'thread-B' }, evidence)).toBe('stale');
      expect(await store.recordSent(OP, claimInput(OP).attemptId, ref, evidence)).toBe('stale');
      // Content mismatch is caught by reconciliation, which compares the stored payload hash.
      const db = new DatabaseSync(paths.receiver);
      db.prepare('INSERT INTO received (operation_id, session_ref, payload_hash, attempt_id, client_message_id) VALUES (?, ?, ?, ?, ?)').run(
        OP,
        THREAD,
        hashOf('other content'),
        live.attemptId,
        live.clientMessageId,
      );
      db.close();
      expect(await reconcile(store, OP, paths.receiver)).toBe('unknown');
      // A user retry abandons the attempt; evidence for it is stale from then on.
      expect(await store.recordResolution(OP, live.attemptId, { decision: 'retry', at: at(30) })).toBe('recorded');
      expect(await store.recordSent(OP, live.attemptId, ref, evidence)).toBe('stale');
      expect((await store.get(OP))?.delivery.state).toBe('pending');
    });
  }, 30_000);
});

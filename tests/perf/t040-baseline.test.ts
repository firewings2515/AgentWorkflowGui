// T040 performance baseline, the automated part (V-18). Skipped unless AWG_PERF=1, so `npm test` stays fast:
//
//   AWG_PERF=1 AWG_PERF_OUT=<file.json> npx vitest run tests/perf --maxWorkers=1
//
// Fixtures: 50,000 mixed events (app/main/testing/event-stream.ts, seed 40) through the bus and the batcher; 100 deltas a
// second for 60 s; a 10,000-message conversation (5,000 turns, contracts/fixtures/long-conversation.ts) in a real
// SQLite file, read as the Snapshot (paged and whole) and paged through with `session.history`. Each number is given
// as median, P95 and maximum over the runs. Correctness is asserted too: nothing that must not be lost is lost.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type AppEvent, type EventBatch, type MessageId, type SessionId } from '../../contracts';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { createRepositories, openDatabase, openStorage } from '../../adapters/storage';
import { WindowBatcher } from '../../app/main/event-batcher';
import { EventBus } from '../../app/main/event-bus';
import { BatchLedger, isDelta, seeded, streamEvent } from '../../app/main/testing/event-stream';

const ON = process.env['AWG_PERF'] === '1';
const results: Record<string, unknown> = {};

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;
  const round = (n: number) => Math.round(n * 100) / 100;
  return { runs: values.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? NaN) };
};

afterAll(() => {
  if (!ON) return;
  const out = process.env['AWG_PERF_OUT'];
  const text = JSON.stringify({ at: new Date().toISOString(), node: process.versions.node, results }, null, 2);
  if (out !== undefined) writeFileSync(out, text);
  else console.log(text);
});

/** A bus, a batcher, and a renderer that takes each batch on the next turn of the event loop and acknowledges it. */
const pipe = () => {
  const bus = new EventBus({ seq: 0, onRejected: (reason) => { throw new Error(reason); } });
  const ledger = new BatchLedger();
  let bytes = 0;
  const batcher: WindowBatcher = new WindowBatcher({
    startSeq: 0,
    invalidate: () => void bus.publish({ type: 'snapshot.invalidated', reason: 'event-overflow', at: '2026-11-03T10:00:00.000Z' }),
    target: () => ({
      isAvailable: () => true,
      send: (batch: EventBatch) => {
        // What crossing the IPC costs: the structured clone of the batch.
        bytes += JSON.stringify(batch).length;
        const copy = structuredClone(batch);
        setImmediate(() => {
          ledger.apply(copy);
          appliedAt.set(copy.toSeq, performance.now());
          batcher.ack(copy.toSeq);
        });
      },
    }),
  });
  const published: { seq: number; delta: boolean }[] = [];
  /** When the renderer applied the batch ending at each toSeq. */
  const appliedAt = new Map<number, number>();
  bus.subscribe((e) => {
    published.push({ seq: e.seq, delta: isDelta(e.event) });
    batcher.push(e);
  });
  return { bus, batcher, ledger, published, appliedAt, bytes: () => bytes };
};

const until = async (done: () => boolean, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe.skipIf(!ON)('T040 baseline: events', () => {
  it('50,000 mixed events published as fast as possible, 20 runs', async () => {
    const total: number[] = [];
    const publishMs: number[] = [];
    const delay: number[] = [];
    const ratio: number[] = [];
    const batches: number[] = [];
    const maxPending: number[] = [];
    const kb: number[] = [];
    for (let run = 0; run < 20; run++) {
      const p = pipe();
      const random = seeded(40);
      const events: AppEvent[] = Array.from({ length: 50_000 }, (_, i) => streamEvent(random, i));
      const h = monitorEventLoopDelay({ resolution: 1 });
      h.enable();
      const began = performance.now();
      // Bursts of 500, as runtimes deliver them, with the event loop free in between.
      for (let i = 0; i < events.length; i += 500) {
        for (const e of events.slice(i, i + 500)) p.bus.publish(e);
        await new Promise((resolve) => setImmediate(resolve));
      }
      publishMs.push(performance.now() - began);
      await until(() => p.ledger.lastSeq === p.bus.seq && p.batcher.pendingCount === 0);
      total.push(performance.now() - began);
      h.disable();
      delay.push(h.max / 1e6);
      // Nothing that must not be lost was lost or reordered, and no window was let go.
      expect(p.batcher.stats.overflows).toBe(0);
      expect(p.ledger.kept.map((e) => e.seq)).toEqual(p.published.filter((e) => !e.delta).map((e) => e.seq));
      expect(p.ledger.gaps).toBe(0);
      ratio.push(p.batcher.stats.envelopesSent / p.batcher.stats.envelopesIn);
      batches.push(p.batcher.stats.batches);
      maxPending.push(p.batcher.stats.maxPending);
      kb.push(p.bytes() / 1024);
    }
    results['events50k'] = {
      totalMs: stats(total),
      publishMs: stats(publishMs),
      eventLoopMaxDelayMs: stats(delay),
      sentPerPublished: stats(ratio),
      batches: stats(batches),
      maxPending: stats(maxPending),
      ipcKb: stats(kb),
    };
  }, 600_000);

  it('100 deltas a second for 60 s with other events between, 3 runs: event loop delay and delivery lag', async () => {
    const p50: number[] = [];
    const p95: number[] = [];
    const max: number[] = [];
    const lag: number[] = [];
    const batchesPerRun: number[] = [];
    for (let run = 0; run < 3; run++) {
      const p = pipe();
      const sentAt = new Map<number, number>();
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      const began = Date.now();
      let n = 0;
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const due = Math.min(6000, Math.floor(((Date.now() - began) * 100) / 1000));
          while (n < due) {
            const e = p.bus.publish({ type: 'message.delta', sessionId: 's-research' as SessionId, messageId: 'perf' as MessageId, delta: 'x'.repeat(23) + '\n' });
            if (n % 20 === 0) p.bus.publish({ type: 'session.activity', sessionId: 's-research' as SessionId, activity: 'running', at: '2026-11-03T10:00:00.000Z' });
            sentAt.set(e!.seq, performance.now());
            n++;
          }
          if (n >= 6000) {
            clearInterval(timer);
            resolve();
          }
        }, 10);
      });
      await until(() => p.ledger.lastSeq === p.bus.seq);
      h.disable();
      p50.push(h.percentile(50) / 1e6);
      p95.push(h.percentile(95) / 1e6);
      max.push(h.max / 1e6);
      // From publishing a delta to the renderer applying the batch that carries it (merged or not).
      let previous = 0;
      for (const b of p.ledger.batches) {
        const applied = p.appliedAt.get(b.toSeq)!;
        for (let seq = previous + 1; seq <= b.toSeq; seq++) {
          const sent = sentAt.get(seq);
          if (sent !== undefined) lag.push(applied - sent);
        }
        previous = b.toSeq;
      }
      expect(previous).toBe(p.bus.seq);
      expect(p.batcher.stats.overflows).toBe(0);
      batchesPerRun.push(p.batcher.stats.batches);
    }
    results['deltas100PerSecond60s'] = {
      eventLoopDelayMs: { p50: stats(p50), p95: stats(p95), max: stats(max) },
      deliveryLagMs: stats(lag),
      batchesPerRun: stats(batchesPerRun),
    };
  }, 600_000);
});

describe.skipIf(!ON)('T040 baseline: a 10,000-message conversation', () => {
  const sessionId = 's-long' as SessionId;
  // Made in the test, so a skipped run leaves no folder behind.
  let dir: string | undefined;
  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('seeds it, reads the Snapshot paged (50 turns) and whole 20 times, and pages through all of it 3 times', async () => {
    dir = mkdtempSync(join(tmpdir(), 'awg-t040-perf-'));
    const path = join(dir, 'awg.sqlite');
    const seededAt = performance.now();
    {
      const db = openDatabase(path);
      db.exec('PRAGMA synchronous = OFF');
      const repos = createRepositories(db);
      const history = longConversation({ sessionId, turns: 5000 });
      const now = '2026-11-03T10:00:00.000Z';
      const template = fixtureSnapshot.sessions.find((x) => x.kind === 'ordinary')!;
      await repos.sessions.create({ ...template, id: sessionId, revision: 0, activity: 'closed', createdAt: now, updatedAt: now });
      for (const t of history.turns) await repos.conversations.upsertTurn(t);
      for (const m of history.messages) await repos.conversations.appendMessage(m);
      for (const i of history.items) await repos.conversations.upsertItem(i);
      db.close();
    }
    const seedMs = performance.now() - seededAt;
    const opened = await openStorage(path);
    const repos = createRepositories(opened.db);
    const paged: number[] = [];
    const whole: number[] = [];
    const pagedBytes: number[] = [];
    const wholeBytes: number[] = [];
    const pageMs: number[] = [];
    const fullWalk: number[] = [];
    for (let run = 0; run < 20; run++) {
      let t = performance.now();
      const p = await repos.readSnapshotData({ recentTurns: 50 });
      paged.push(performance.now() - t);
      pagedBytes.push(Buffer.byteLength(JSON.stringify(p)));
      t = performance.now();
      const w = await repos.readSnapshotData();
      whole.push(performance.now() - t);
      wholeBytes.push(Buffer.byteLength(JSON.stringify(w)));
      expect(w.conversations.messages).toHaveLength(10_000);
      expect(p.conversations.messages).toHaveLength(100);
      // A whole walk is 99 pages: three are enough (about 300 samples of one page).
      if (run >= 3) continue;
      let cursor = p.historyPages.find((x) => x.sessionId === sessionId)?.olderCursor ?? null;
      let messages = p.conversations.messages.length;
      const walk = performance.now();
      while (cursor !== null) {
        const t0 = performance.now();
        const page = await repos.conversations.page(sessionId, cursor, 50);
        pageMs.push(performance.now() - t0);
        if (page === 'invalid-cursor') throw new Error('invalid cursor');
        messages += page.messages.length;
        cursor = page.olderCursor;
      }
      fullWalk.push(performance.now() - walk);
      expect(messages).toBe(10_000);
    }
    opened.close();
    results['conversation10k'] = {
      seedMs: Math.round(seedMs),
      snapshotPagedMs: stats(paged),
      snapshotWholeMs: stats(whole),
      snapshotPagedKb: stats(pagedBytes.map((b) => b / 1024)),
      snapshotWholeKb: stats(wholeBytes.map((b) => b / 1024)),
      historyPageMs: stats(pageMs),
      historyAllPagesMs: stats(fullWalk),
    };
  }, 900_000);
});

// T040: `session.history` pages (C-26) after the paging query was made to seek by turn (`<table>_history_turn`). On the
// memory repositories and on SQLite, the same cases: a page holds exactly the records of its turns, in the order the
// whole history has them; paging through 10,000 messages finds each once and misses none; another session's records,
// interleaved in time with this one's, never appear.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type HistoryCursor, type HistoryPage, SessionId } from '../../contracts';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { createRepositories, openDatabase } from '../../adapters/storage';
import type { AppRepositories, Conversation } from '../../core/ports';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { addMissed, type MissedRecords, noteMissed, sessionsToRead } from './missed-records';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const A = SessionId.parse('s-page-a');
const B = SessionId.parse('s-page-b');
const backends: [string, () => AppRepositories][] = [
  ['memory', () => new MemoryRepositories()],
  [
    'SQLite',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'awg-t040-'));
      const db = openDatabase(join(dir, 'awg.sqlite'));
      db.exec('PRAGMA synchronous = OFF');
      opened.push({ db, dir });
      return createRepositories(db);
    },
  ],
];

/** Two sessions whose turns interleave in time (B's a little after each of A's), A with `turns` turns. */
const seed = async (repos: AppRepositories, turns: number) => {
  const template = fixtureSnapshot.sessions.find((s) => s.kind === 'ordinary')!;
  for (const id of [A, B]) await repos.sessions.create({ ...template, id, revision: 0 });
  const a = longConversation({ sessionId: A, turns, replyLength: 40 });
  const shift = (iso: string) => new Date(Date.parse(iso) + 20_000).toISOString();
  const b = longConversation({ sessionId: B, turns: Math.min(turns, 300), replyLength: 40 });
  const bShifted = {
    turns: b.turns.map((t) => ({ ...t, startedAt: shift(t.startedAt), ...(t.endedAt !== undefined && { endedAt: shift(t.endedAt) }) })),
    messages: b.messages.map((m) => ({ ...m, createdAt: shift(m.createdAt) })),
    items: b.items.map((i) => ({ ...i, startedAt: shift(i.startedAt), ...(i.endedAt !== undefined && { endedAt: shift(i.endedAt) }) })),
  };
  // Written interleaved, as two sessions running at once would be.
  for (let i = 0; i < a.turns.length; i++) {
    for (const h of [a, ...(i < bShifted.turns.length ? [bShifted] : [])]) {
      await repos.conversations.upsertTurn(h.turns[i]!);
      await repos.conversations.appendMessage(h.messages[2 * i]!);
      await repos.conversations.upsertItem(h.items[i]!);
      await repos.conversations.appendMessage(h.messages[2 * i + 1]!);
    }
  }
  return a;
};

/** Walks every page of A from the Snapshot's cursor; returns the Snapshot part and the pages. */
const walk = async (repos: AppRepositories) => {
  const snap = await repos.readSnapshotData({ recentTurns: 50 });
  const pages: HistoryPage[] = [];
  let cursor: HistoryCursor | null = snap.historyPages.find((p) => p.sessionId === A)?.olderCursor ?? null;
  while (cursor !== null) {
    const page = await repos.conversations.page(A, cursor, 50);
    if (page === 'invalid-cursor') throw new Error('invalid cursor');
    pages.push(page);
    cursor = page.olderCursor;
  }
  return { snap, pages };
};

/** The records of `turnIds` in the whole history, in the whole history's order. */
const ofTurns = (whole: Conversation, turnIds: Set<string>) => ({
  turns: whole.turns.filter((t) => turnIds.has(t.id)),
  messages: whole.messages.filter((m) => m.turnId !== undefined && turnIds.has(m.turnId)),
  items: whole.items.filter((i) => i.turnId !== undefined && turnIds.has(i.turnId)),
});

describe.each(backends)('history pages (C-26, T040) on %s', (_name, make) => {
  it('each page holds exactly the records of its 50 turns, in the whole history order, and nothing of the other session', async () => {
    const repos = make();
    await seed(repos, 400);
    const whole = await repos.conversations.get(A);
    const { pages } = await walk(repos);
    expect(pages).toHaveLength(7);
    for (const page of pages) {
      expect(page.sessionId).toBe(A);
      expect(page.turns.length).toBeLessThanOrEqual(50);
      const expected = ofTurns(whole, new Set(page.turns.map((t) => t.id)));
      expect({ turns: page.turns, messages: page.messages, items: page.items }).toEqual(expected);
      for (const record of [...page.turns, ...page.messages, ...page.items, ...page.nativeTasks, ...page.permissionRequests, ...page.artifacts]) expect(record.sessionId).toBe(A);
    }
  });

  it('pages through 10,000 messages: each once, none missing', async () => {
    const repos = make();
    const history = await seed(repos, 5000);
    const { snap, pages } = await walk(repos);
    const messages = [...snap.conversations.messages.filter((m) => m.sessionId === A), ...pages.flatMap((p) => p.messages)].map((m) => m.id);
    expect(messages).toHaveLength(10_000);
    expect(new Set(messages).size).toBe(10_000);
    expect(new Set(messages)).toEqual(new Set(history.messages.map((m) => m.id)));
    const turns = [...snap.conversations.turns.filter((t) => t.sessionId === A), ...pages.flatMap((p) => p.turns)].map((t) => t.id);
    expect(new Set(turns)).toEqual(new Set(history.turns.map((t) => t.id)));
    expect(pages.flatMap((p) => p.messages).every((m) => m.sessionId === A)).toBe(true);
  }, 300_000);

  // r1 P1-1: what a window was not sent comes back with the Snapshot, however old.
  it('records the window missed, far older than the Snapshot turns, are added whole and once; nothing of another session', async () => {
    const repos = make();
    const history = await seed(repos, 120);
    const snap = await repos.readSnapshotData({ recentTurns: 50 });
    const old = history.turns[3]!;
    const free = { ...history.messages[0]!, id: 'm-free' as never, turnId: undefined };
    await repos.conversations.appendMessage(free);
    expect(snap.conversations.turns.some((t) => t.id === old.id)).toBe(false);
    const missed: MissedRecords = new Map();
    noteMissed(missed, { type: 'turn.updated', turn: old });
    noteMissed(missed, { type: 'message.completed', message: free });
    // A turn the Snapshot holds anyway asks for no read.
    const recent = history.turns.at(-1)!;
    noteMissed(missed, { type: 'turn.updated', turn: recent });
    expect(sessionsToRead(snap.conversations, missed)).toEqual([A]);
    const held = (await repos.readSnapshotData({ recentTurns: 50 })).conversations;
    const merged = addMissed(held, await repos.conversations.get(A), missed.get(A)!);
    const whole = await repos.conversations.get(A);
    const of = ofTurns(whole, new Set([old.id]));
    expect(merged.turns.filter((t) => t.id === old.id)).toEqual(of.turns);
    for (const m of of.messages) expect(merged.messages).toContainEqual(m);
    for (const i of of.items) expect(merged.items).toContainEqual(i);
    expect(merged.messages).toContainEqual(free);
    // Nothing twice; everything held is still there; messages in time order; B untouched.
    const ids = merged.messages.map((m) => `${m.sessionId}/${m.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of held.messages) expect(merged.messages).toContainEqual(m);
    expect(merged.messages.map((m) => Date.parse(m.createdAt))).toEqual([...merged.messages.map((m) => Date.parse(m.createdAt))].sort((a, b) => a - b));
    expect(merged.messages.filter((m) => m.sessionId === B)).toEqual(held.messages.filter((m) => m.sessionId === B));
    expect(merged.turns.length).toBe(held.turns.length + 1);
  });

  it('a session missed past the limit is added whole', async () => {
    const repos = make();
    await seed(repos, 80);
    const held = (await repos.readSnapshotData({ recentTurns: 50 })).conversations;
    const whole = await repos.conversations.get(A);
    const merged = addMissed(held, whole, { turns: new Set(), records: new Set(), whole: true });
    expect(merged.turns.filter((t) => t.sessionId === A)).toHaveLength(80);
    expect(merged.messages.filter((m) => m.sessionId === A)).toHaveLength(160);
  });
});

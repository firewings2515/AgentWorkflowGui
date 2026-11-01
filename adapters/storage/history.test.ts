import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQLInputValue } from 'node:sqlite';
import { HistoryCursor, HistoryPage, LogicalSession, Message, NativeTask, PermissionRequest, Turn } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import type { AppRepositories } from '../../core/ports';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { openDatabase } from './database';
import { createRepositories } from './repositories';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const make = (adapter: string): AppRepositories => {
  if (adapter === 'memory') return new MemoryRepositories();
  const db = openDatabase(':memory:'); databases.push(db); return createRepositories(db, { blobThresholdBytes: 20 });
};
const seed = async (repos: AppRepositories, count = 7) => {
  const page = longConversation({ turns: count });
  await repos.sessions.create(LogicalSession.parse({ ...fixtureSnapshot.sessions[0], id: page.sessionId }));
  for (const t of page.turns) await repos.conversations.upsertTurn(t);
  for (const m of page.messages) await repos.conversations.appendMessage(m);
  for (const i of page.items) await repos.conversations.upsertItem(i);
  return page;
};

describe.each(['memory', 'SQLite'])('history shared scenarios: %s', (adapter) => {
  it('whole turns, blob content, chronological no-turn rows, empty sessions, and opaque store/session cursors', async () => {
    const repos = make(adapter); const original = await seed(repos);
    const sid = original.sessionId;
    const orphan = Message.parse({ ...original.messages[0], id: 'before-first', turnId: undefined, createdAt: '2020-01-01T00:00:00Z' });
    await repos.conversations.appendMessage(orphan);
    const middle = Message.parse({ ...orphan, id: 'between-turns', createdAt: original.messages[5]!.createdAt });
    await repos.conversations.appendMessage(middle);
    const other = LogicalSession.parse({ ...fixtureSnapshot.sessions[0], id: 'other' });
    await repos.sessions.create(other);
    const snapshot = await repos.readSnapshotData({ recentTurns: 2 });
    expect(snapshot.conversations.turns).toEqual(original.turns.slice(-2));
    expect(snapshot.conversations.messages).toEqual(original.messages.slice(-4));
    expect(snapshot.historyPages.find((p) => p.sessionId === other.id)?.olderCursor).toBeNull();
    const cursor = snapshot.historyPages.find((p) => p.sessionId === sid)!.olderCursor!;
    for (const invalid of [HistoryCursor.parse(`${cursor}x`), HistoryCursor.parse('forged')]) expect(await repos.conversations.page(sid, invalid, 2)).toBe('invalid-cursor');
    expect(await repos.conversations.page(other.id, cursor, 2)).toBe('invalid-cursor');
    expect(await make(adapter).conversations.page(sid, cursor, 2)).toBe('invalid-cursor');
    const turns = [...snapshot.conversations.turns]; const messages = [...snapshot.conversations.messages];
    let next: HistoryCursor | null = cursor;
    while (next) {
      const page = HistoryPage.parse(await repos.conversations.page(sid, next, 2));
      expect(page.turns.length).toBeLessThanOrEqual(2);
      expect(page.items).toHaveLength(page.turns.length);
      turns.unshift(...page.turns); messages.unshift(...page.messages); next = page.olderCursor;
    }
    expect(turns).toEqual(original.turns);
    expect(new Set(messages.map((m) => m.id)).size).toBe(original.messages.length + 2);
    expect(messages).toContainEqual(orphan); expect(messages).toContainEqual(middle);
    expect((await repos.readSnapshotData()).historyPages).toEqual([]);
  });

  it('always includes old running turns with their records, pending/held permissions, and unended children', async () => {
    const repos = make(adapter); const original = await seed(repos);
    const running = Turn.parse({ ...original.turns[0], state: 'running', endedAt: undefined });
    await repos.conversations.upsertTurn(running);
    const request = PermissionRequest.parse({ id: 'old-permission', sessionId: original.sessionId, turnId: original.turns[1]!.id, kind: 'command', summary: 'approve', state: 'pending', createdAt: original.turns[1]!.startedAt });
    await repos.conversations.upsertPermissionRequest(request);
    const held = PermissionRequest.parse({ ...request, id: 'old-held', state: 'held', hold: { reason: 'awaiting-user', escalationId: 'esc-1' }, turnId: original.turns[2]!.id });
    await repos.conversations.upsertPermissionRequest(held);
    const child = NativeTask.parse({ id: 'old-child', sessionId: original.sessionId, runtime: 'claude', parentRef: 'parent', nativeRef: 'child', label: '', state: 'running', background: true, startedAt: original.turns[0]!.startedAt });
    await repos.conversations.upsertNativeTask(child);
    const snapshot = await repos.readSnapshotData({ recentTurns: 1 });
    expect(snapshot.conversations.turns).toEqual([running, original.turns.at(-1)]);
    expect(snapshot.conversations.messages).toContainEqual(original.messages[0]);
    expect(snapshot.conversations.permissionRequests).toEqual([request, held]);
    expect(snapshot.conversations.nativeTasks).toEqual([child]);
    expect(snapshot.historyPages[0]!.olderCursor).not.toBeNull();
    const full = await repos.conversations.get(original.sessionId);
    const keys = ['turns', 'messages', 'items', 'nativeTasks', 'permissionRequests', 'artifacts'] as const;
    const ids = new Map(keys.map((key) => [key, snapshot.conversations[key].map((r) => r.id as string)]));
    let cursor = snapshot.historyPages[0]!.olderCursor;
    while (cursor) {
      const page = HistoryPage.parse(await repos.conversations.page(original.sessionId, cursor, 2));
      for (const key of keys) ids.get(key)!.push(...page[key].map((r) => r.id));
      cursor = page.olderCursor;
    }
    for (const key of keys) {
      expect(ids.get(key)!.length).toBe(new Set(ids.get(key)).size);
      expect(ids.get(key)!.sort()).toEqual(full[key].map((r) => r.id).sort());
    }
  });

  it('expires old cursors without reusing tokens or losing the newest cursor', async () => {
    const repos = make(adapter); const original = await seed(repos, 2);
    const old = (await repos.readSnapshotData({ recentTurns: 1 })).historyPages[0]!.olderCursor!;
    let newest = old;
    for (let i = 0; i < 8; i++) newest = (await repos.readSnapshotData({ recentTurns: 1 })).historyPages[0]!.olderCursor!;
    expect(newest).not.toBe(old);
    expect(await repos.conversations.page(original.sessionId, old, 1)).toBe('invalid-cursor');
    expect(HistoryPage.parse(await repos.conversations.page(original.sessionId, newest, 1)).turns).toEqual(original.turns.slice(0, 1));
  });

  it('keeps every Snapshot cursor usable across 1100 sessions and repeated Snapshots', async () => {
    const repos = make(adapter);
    const template = longConversation({ turns: 2 });
    for (let i = 0; i < 1100; i++) {
      const session = LogicalSession.parse({ ...fixtureSnapshot.sessions[0], id: `many-${i}` });
      await repos.sessions.create(session);
      for (const [j, turn] of template.turns.entries()) {
        await repos.conversations.upsertTurn(Turn.parse({ ...turn, id: `many-${i}-${j}`, sessionId: session.id }));
      }
    }
    const first = await repos.readSnapshotData({ recentTurns: 1 });
    const second = await repos.readSnapshotData({ recentTurns: 1 });
    for (const snapshot of [first, second]) {
      expect(snapshot.historyPages).toHaveLength(1100);
      for (const { sessionId, olderCursor } of snapshot.historyPages) {
        expect(olderCursor).not.toBeNull();
        const page = HistoryPage.parse(await repos.conversations.page(sessionId, olderCursor!, 1));
        expect(page.turns.map((turn) => turn.id)).toEqual([`${sessionId}-0`]);
      }
    }
  });

  it.each([0, 501])('rejects invalid limit %s through a Promise for page and Snapshot', async (limit) => {
    const repos = make(adapter); const original = await seed(repos, 2);
    const cursor = (await repos.readSnapshotData({ recentTurns: 1 })).historyPages[0]!.olderCursor!;
    const result = repos.conversations.page(original.sessionId, cursor, limit);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).rejects.toThrow('history:limit');
    await expect(repos.readSnapshotData({ recentTurns: limit })).rejects.toThrow('history:limit');
  });

  it('ties use arrival order, no-turn rows appear once, and inserts after issuing a cursor do not shift it', async () => {
    const repos = make(adapter); const original = await seed(repos, 3);
    for (const turn of original.turns) await repos.conversations.upsertTurn(Turn.parse({ ...turn, startedAt: original.turns[0]!.startedAt }));
    const loose = Message.parse({ ...original.messages[0], id: 'loose', turnId: undefined });
    await repos.conversations.appendMessage(loose);
    const snap = await repos.readSnapshotData({ recentTurns: 1 });
    expect(snap.conversations.messages).toContainEqual(loose);
    const cursor = snap.historyPages[0]!.olderCursor!;
    await repos.conversations.upsertTurn(Turn.parse({ ...original.turns[2], id: 'new', startedAt: '2027-01-01T00:00:00Z', endedAt: '2027-01-01T00:01:00Z' }));
    const page = HistoryPage.parse(await repos.conversations.page(original.sessionId, cursor, 1));
    expect(page.turns.map((t) => t.id)).toEqual([original.turns[1]!.id]);
    expect(page.messages).not.toContainEqual(loose);
  });

  it('a session with no turns still returns its timed records', async () => {
    const repos = make(adapter); const original = await seed(repos, 0);
    const message = Message.parse({ id: 'loose-only', sessionId: original.sessionId, role: 'system', origin: { kind: 'system' }, text: 'notice', createdAt: '2026-01-01T00:00:00Z' });
    await repos.conversations.appendMessage(message);
    const snap = await repos.readSnapshotData({ recentTurns: 1 });
    expect(snap.conversations.messages).toEqual([message]); expect(snap.historyPages[0]!.olderCursor).toBeNull();
    const early = Message.parse({ ...message, id: 'turn-not-arrived', turnId: 'future-turn' });
    await repos.conversations.appendMessage(early);
    expect((await repos.readSnapshotData({ recentTurns: 1 })).conversations.messages).toEqual([message, early]);
  });
});

it('EXPLAIN uses actual loadPage queries and bindings; statements are reused across turns and calls', async () => {
  const db = openDatabase(':memory:'); databases.push(db);
  const repos = createRepositories(db); const original = await seed(repos, 20);
  const queries: [string, SQLInputValue[]][] = [];
  const prepared: string[] = [];
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const stmt = prepare(sql);
    if (sql.startsWith('SELECT rowid AS position')) {
      prepared.push(sql);
      const all = stmt.all.bind(stmt);
      vi.spyOn(stmt, 'all').mockImplementation((...args) => {
        const positional = args as SQLInputValue[];
        queries.push([sql, positional]); return all(...positional);
      });
    }
    return stmt;
  });
  try {
    const snapshot = await repos.readSnapshotData({ recentTurns: 2 });
    await repos.readSnapshotData({ recentTurns: 2 });
    let cursor = snapshot.historyPages[0]!.olderCursor;
    while (cursor) cursor = HistoryPage.parse(await repos.conversations.page(original.sessionId, cursor, 5)).olderCursor;
    expect(new Set(prepared).size).toBe(prepared.length);
    expect(queries.length).toBeGreaterThan(prepared.length * 2);
    expect(queries.some(([sql]) => sql.includes('(at_ms, rowid) <'))).toBe(true);
    expect(queries.some(([sql]) => sql.includes('history_open = 1'))).toBe(true);
    expect(queries.some(([sql]) => sql.includes('NOT EXISTS'))).toBe(true);
    for (const [sql, args] of queries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => String(r.detail)).join('\n');
      expect(plan).toMatch(/SEARCH .* USING INDEX/); expect(plan).not.toMatch(/SCAN |TEMP B-TREE/);
    }
  } finally {
    spy.mockRestore();
  }
});

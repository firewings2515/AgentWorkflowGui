// Ports of contracts 0.7 (T037): backups and read-only mode can be implemented against the port alone, write
// failures are classified, history is read in pages, and the GUI can notify a session as itself (C-31).
import { describe, expect, it } from 'vitest';
import { BackupId, HistoryCursor, SessionId, type BackupInfo, type StorageInfo } from '../../contracts';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import {
  StorageReadOnlyError,
  StorageWriteError,
  type BackupStore,
  type ConversationRepository,
  type DeliveryKind,
  type PayloadContext,
  type StorageHealth,
  type StorageState,
} from './index';

const at = '2026-11-01T10:00:00+08:00';

describe('backup store (C-28)', () => {
  it('lists verified backups, restores only a listed ID and keeps one pending restore', async () => {
    const backups: BackupInfo[] = [];
    let info: StorageInfo = {};
    const store: BackupStore = {
      list: () => Promise.resolve([...backups].reverse()),
      create: (reason, createdAt) => {
        const backup: BackupInfo = { id: BackupId.parse(`bk-${backups.length + 1}`), createdAt, reason, storageVersion: 8, sizeBytes: 4096 };
        backups.push(backup);
        info = { ...info, lastBackupAt: createdAt };
        return Promise.resolve(backup);
      },
      prune: () => Promise.resolve([]),
      scheduleRestore: (id, requestedAt) => {
        if (!backups.some((b) => b.id === id)) return Promise.resolve('not-found');
        info = { ...info, pendingRestore: { backupId: id, requestedAt } };
        return Promise.resolve('scheduled');
      },
      cancelRestore: () => {
        info = { ...info, pendingRestore: undefined };
        return Promise.resolve();
      },
      info: () => Promise.resolve(info),
    };
    await store.create('pre-migration', at);
    const daily = await store.create('daily', at);
    expect((await store.list()).map((b) => b.reason)).toEqual(['daily', 'pre-migration']);
    expect(await store.scheduleRestore(BackupId.parse('bk-9'), at)).toBe('not-found');
    expect(await store.scheduleRestore(daily.id, at)).toBe('scheduled');
    expect((await store.info()).pendingRestore?.backupId).toBe(daily.id);
    await store.cancelRestore();
    expect((await store.info()).pendingRestore).toBeUndefined();
  });
});

describe('read-only mode (C-29)', () => {
  it('turns read-only once and never back while the app runs', () => {
    let state: StorageState = { status: 'ready' };
    const listeners: ((reason: 'disk-full') => void)[] = [];
    const health: StorageHealth = {
      state: () => state,
      onReadOnly: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const seen: string[] = [];
    health.onReadOnly((reason) => seen.push(reason));
    state = { status: 'read-only', reason: 'disk-full' };
    for (const listener of listeners) listener('disk-full');
    expect(health.state()).toEqual({ status: 'read-only', reason: 'disk-full' });
    expect(seen).toEqual(['disk-full']);
  });

  it('classifies a failed write and a refused one', () => {
    const full = new StorageWriteError('disk-full', 'SQLITE_FULL');
    expect([full.name, full.kind]).toEqual(['StorageWriteError', 'disk-full']);
    const refused = new StorageReadOnlyError('newer-schema');
    expect([refused.name, refused.reason]).toEqual(['StorageReadOnlyError', 'newer-schema']);
  });
});

describe('history pages (C-26)', () => {
  it('reads the page before a cursor it handed out, and refuses any other cursor', async () => {
    const sessionId = SessionId.parse('s-long');
    const whole = longConversation({ sessionId, turns: 5 });
    const cursor = HistoryCursor.parse('cursor-s-long-3');
    const page: ConversationRepository['page'] = (id, before, limitTurns) => {
      if (id !== sessionId || before !== cursor) return Promise.resolve('invalid-cursor');
      const turns = whole.turns.slice(0, 3).slice(-limitTurns);
      const ids = new Set(turns.map((t) => t.id));
      return Promise.resolve({
        ...whole,
        turns,
        messages: whole.messages.filter((m) => m.turnId !== undefined && ids.has(m.turnId)),
        items: whole.items.filter((i) => i.turnId !== undefined && ids.has(i.turnId)),
        olderCursor: turns.length < 3 ? HistoryCursor.parse('cursor-s-long-1') : null,
      });
    };
    const older = await page(sessionId, cursor, 2);
    expect(older).not.toBe('invalid-cursor');
    if (older === 'invalid-cursor') return;
    expect(older.turns.map((t) => t.id)).toEqual(['s-long-turn-1', 's-long-turn-2']);
    expect(older.messages).toHaveLength(4);
    expect(older.olderCursor).toBe('cursor-s-long-1');
    expect(await page(SessionId.parse('s-other'), cursor, 2)).toBe('invalid-cursor');
  });
});

describe('system notices (C-31)', () => {
  it('are a delivery kind of their own whose origin is the GUI, never the user or a peer', () => {
    const kind: DeliveryKind = 'system-notice';
    const origin: PayloadContext['origin'] = { kind: 'system' };
    expect([kind, origin?.kind]).toEqual(['system-notice', 'system']);
  });
});

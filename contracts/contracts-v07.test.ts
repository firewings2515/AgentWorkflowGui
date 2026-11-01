// Contracts 0.7 (T037): the new or changed schemas (BATCH6_PLAN C-26 to C-32). Rule codes of the new
// refinements carry no input values, as before.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppEvent,
  AppStatus,
  BACKUP_RETENTION_DAYS,
  BackupInfo,
  Command,
  CONTRACTS_VERSION,
  ErrorCode,
  EventBatch,
  HistoryPage,
  issueRule,
  McpRejection,
  MERGEABLE_EVENT_TYPES,
  QueryRequest,
  QueryResult,
  Snapshot,
  StorageInfo,
  UiPreferences,
} from './index';
import { fixtureBackupList, fixtureReadOnlySnapshot, fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';
import { longConversation } from './fixtures/long-conversation';

const at = '2026-11-01T10:00:00+08:00';
const MARKER = 'SENSITIVE_INPUT_MARKER';
const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const rules = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  const issues = r.error?.issues ?? [];
  expect(JSON.stringify(issues)).not.toContain(MARKER);
  return issues.map(issueRule).filter((rule) => rule !== undefined);
};
const envelope = (seq: number, event: unknown) => ({ schemaVersion: CONTRACTS_VERSION, seq, event });
const delta = (text: string) => ({ type: 'message.delta', sessionId: 's-1', messageId: 'm-1', delta: text });

describe('contracts 0.7', () => {
  it('C-32: is version 0.7.0; the fixtures show a paged history, backups, a pending restore and read-only data', () => {
    expect(CONTRACTS_VERSION).toBe('0.7.0');
    expect(fixtureSnapshot.historyPages).toEqual([{ sessionId: 's-plan-notes', olderCursor: 'cursor-plan-notes-1' }]);
    expect(fixtureSnapshot.storage.lastBackupAt).toBeDefined();
    expect(fixtureReadOnlySnapshot.app).toMatchObject({ status: 'read-only', reason: 'disk-full' });
    expect(fixtureReadOnlySnapshot.storage.pendingRestore?.backupId).toBe('bk-1023-daily');
    expect(fixtureBackupList.ok && fixtureBackupList.type === 'backup.list' && fixtureBackupList.backups.map((b) => b.reason)).toEqual(['daily', 'pre-migration', 'daily']);
  });

  describe('C-26 paging', () => {
    // A Snapshot is never stored (main and renderer ship together); this is a Snapshot built by code that does
    // not know the 0.7 fields yet, such as a main process wired before T040 (T037 r1 P1-1).
    it('a Snapshot without the 0.7 fields reads with whole histories and no storage information', () => {
      const before: Record<string, unknown> = { ...fixtureSnapshotInput, preferences: { theme: 'light' } };
      delete before['historyPages'];
      delete before['storage'];
      const snapshot = Snapshot.parse(before);
      expect(snapshot.historyPages).toEqual([]);
      expect(snapshot.storage).toEqual({});
      expect(snapshot.preferences.supervisor).toEqual({ idleCloseMinutes: 15, maxOpenRuntimes: 6 });
    });

    it('lists a session at most once in historyPages', () => {
      const page = { sessionId: 's-plan-notes', olderCursor: null };
      expect(rules(Snapshot, { ...fixtureSnapshotInput, historyPages: [page, page] })).toEqual(['snapshot.history-page-unique']);
    });

    it('a history page holds only its own session’s records', () => {
      const page = longConversation({ turns: 3 });
      expect(page.olderCursor).toBeNull();
      expect(page.turns).toHaveLength(3);
      expect(page.messages).toHaveLength(6);
      expect(rules(HistoryPage, { ...page, messages: [...page.messages, { ...page.messages[0], id: 'other', sessionId: MARKER }] })).toEqual(['history.one-session']);
    });

    it('reads a page through the query channel only with a cursor and a bounded limit', () => {
      const query = { type: 'session.history', requestId: 'q-1', sessionId: 's-plan-notes', before: 'cursor-plan-notes-1', limit: 50 };
      expect(ok(QueryRequest, query)).toBe(true);
      expect(ok(QueryRequest, { ...query, limit: 501 })).toBe(false);
      expect(ok(QueryRequest, { ...query, before: '' })).toBe(false);
      expect(ok(QueryRequest, { ...query, path: 'E:/elsewhere' })).toBe(false);
      const page = longConversation({ sessionId: 's-plan-notes', turns: 2 });
      expect(ok(QueryResult, { ok: true, type: 'session.history', requestId: 'q-1', page })).toBe(true);
      expect(ok(QueryResult, { ok: false, requestId: 'q-1', code: 'invalid_request', message: 'unknown cursor' })).toBe(true);
    });

    it('the long-conversation fixture is the same every time', () => {
      expect(longConversation({ turns: 200 })).toEqual(longConversation({ turns: 200 }));
      expect(longConversation({ turns: 1, replyLength: 1000 }).messages[1]?.text).toHaveLength(1000);
    });
  });

  describe('C-27 event batches', () => {
    const batch = (envelopes: unknown[], fromSeq: number, toSeq: number) => ({ schemaVersion: CONTRACTS_VERSION, fromSeq, toSeq, envelopes });

    it('covers fromSeq..toSeq in order; a seq without an envelope was a merged delta', () => {
      expect(ok(EventBatch, batch([envelope(4, delta('ab')), envelope(5, { type: 'snapshot.invalidated', reason: 'recovered', at })], 3, 5))).toBe(true);
      expect(rules(EventBatch, batch([envelope(5, delta('a')), envelope(4, delta('b'))], 4, 5))).toContain('batch.seq-increasing');
      expect(rules(EventBatch, batch([envelope(4, delta('a'))], 4, 6))).toEqual(['batch.seq-range']);
      expect(rules(EventBatch, batch([envelope(2, delta('a'))], 3, 2))).toEqual(['batch.seq-range']);
      expect(ok(EventBatch, batch([], 1, 1))).toBe(false);
      expect(ok(EventBatch, batch([{ ...envelope(1, delta('a')), schemaVersion: '0.6.0' }], 1, 1))).toBe(false);
      expect(ok(EventBatch, { ...batch([envelope(1, delta('a'))], 1, 1), schemaVersion: '0.6.0' })).toBe(false);
    });

    it('only deltas may be merged; permission, turn end, escalation, handoff and transfer events never are', () => {
      expect([...MERGEABLE_EVENT_TYPES].sort()).toEqual(['item.outputDelta', 'message.delta']);
      for (const type of ['permission.updated', 'turn.updated', 'escalation.updated', 'handoff.updated', 'transfer.updated'])
        expect(MERGEABLE_EVENT_TYPES as readonly string[]).not.toContain(type);
    });

    it('a window too far behind is told to read the Snapshot again', () => {
      expect(ok(AppEvent, { type: 'snapshot.invalidated', reason: 'event-overflow', at })).toBe(true);
    });
  });

  describe('C-28 backups', () => {
    const backup = { id: 'bk-1', createdAt: at, reason: 'daily', storageVersion: 8, sizeBytes: 1024 };

    it('keeps 30 days; backups are daily, before a migration, or the data in use before a restore', () => {
      expect(BACKUP_RETENTION_DAYS).toBe(30);
      for (const reason of ['daily', 'pre-migration', 'pre-restore']) expect(ok(BackupInfo, { ...backup, reason })).toBe(true);
      expect(ok(BackupInfo, { ...backup, reason: 'manual' })).toBe(false);
      expect(ok(BackupInfo, { ...backup, path: 'E:/backups/bk-1.db' })).toBe(false);
    });

    it('lists backups through the query channel and restores one only by its ID', () => {
      expect(ok(QueryRequest, { type: 'backup.list', requestId: 'q-2' })).toBe(true);
      expect(ok(QueryResult, { ok: true, type: 'backup.list', requestId: 'q-2', backups: [backup] })).toBe(true);
      expect(ok(Command, { type: 'backup.restore', requestId: 'r-1', backupId: 'bk-1' })).toBe(true);
      expect(ok(Command, { type: 'backup.restore', requestId: 'r-1', path: 'E:/backups/bk-1.db' })).toBe(false);
      expect(ok(Command, { type: 'backup.cancelRestore', requestId: 'r-2' })).toBe(true);
    });

    it('shows a pending restore or the last failed one, not both; changes come as storage.updated', () => {
      const pendingRestore = { backupId: 'bk-1', requestedAt: at };
      const lastRestoreFailure = { backupId: 'bk-0', reason: 'integrity-failed', at };
      expect(ok(StorageInfo, { lastBackupAt: at, pendingRestore })).toBe(true);
      expect(ok(StorageInfo, { lastRestoreFailure })).toBe(true);
      expect(rules(StorageInfo, { pendingRestore, lastRestoreFailure })).toEqual(['storage.restore-pending-or-failed']);
      expect(ok(AppEvent, { type: 'storage.updated', storage: { pendingRestore }, at })).toBe(true);
    });
  });

  describe('C-29 read-only mode', () => {
    it('says why the data is read-only and where it is; writing commands get storage_read_only', () => {
      for (const reason of ['disk-full', 'newer-schema', 'migration-failed'])
        expect(ok(AppStatus, { status: 'read-only', reason, location: 'C:/Users/u/AppData/Roaming/AgentWorkflowGui/awg.db' })).toBe(true);
      expect(ok(AppStatus, { status: 'read-only', reason: MARKER, location: 'x' })).toBe(false);
      expect(ErrorCode.options).toContain('storage_read_only');
      expect(ok(AppEvent, { type: 'app.readOnly', reason: 'disk-full', location: 'awg.db', at })).toBe(true);
      expect(Snapshot.parse({ ...fixtureSnapshotInput, app: { status: 'read-only', reason: 'disk-full', location: 'awg.db' } }).app.status).toBe('read-only');
    });
  });

  describe('C-30 supervisor settings and closes', () => {
    it('preferences carry the idle time and the runtime limit, within bounds, defaulting to 15 minutes and 6', () => {
      expect(UiPreferences.parse({})).toEqual({ theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
      expect(UiPreferences.parse({ supervisor: { idleCloseMinutes: 30 } }).supervisor).toEqual({ idleCloseMinutes: 30, maxOpenRuntimes: 6 });
      for (const supervisor of [{ idleCloseMinutes: 0 }, { idleCloseMinutes: 1441 }, { maxOpenRuntimes: 0 }, { maxOpenRuntimes: 33 }, { idleCloseMinutes: 1.5 }])
        expect(ok(UiPreferences, { supervisor })).toBe(false);
    });

    it('a close by the supervisor says why; only a close has a cause', () => {
      const activity = { type: 'session.activity', sessionId: 's-1', activity: 'closed', at };
      expect(ok(AppEvent, activity)).toBe(true);
      expect(ok(AppEvent, { ...activity, cause: 'idle' })).toBe(true);
      expect(ok(AppEvent, { ...activity, cause: 'process-limit' })).toBe(true);
      expect(rules(AppEvent, { ...activity, activity: 'running', cause: 'idle' })).toEqual(['activity.cause-only-closed']);
    });

    it('a tool call whose target session’s folder is gone is rejected as folder-missing', () => {
      expect(ok(McpRejection, { reason: 'folder-missing', detail: 'the task was merged and its folder removed' })).toBe(true);
    });
  });
});

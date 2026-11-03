// Demo-only data for the v0.4 shell (T047, U0). Everything here is invented in the renderer; U2 needs the
// backend to provide the fields marked "U2" (see T047-report.md).
import { Snapshot } from '../../../../contracts';
import type { LogicalSession, SessionId } from '../../../../contracts';
import { fixtureSnapshotInput } from '../../../../contracts/fixtures/snapshot';

const t = (time: string) => `2026-10-24T${time}:00+08:00`;

/** The fixture plus a conversation for 「實作：Session 儲存」 with tool calls, a held push and sub-tasks. */
export const v4DemoSnapshot = Snapshot.parse({
  ...fixtureSnapshotInput,
  messages: [
    ...(fixtureSnapshotInput.messages ?? []),
    { id: 'm-b1', sessionId: 's-wf-build-b', turnId: 'turn-b1', role: 'user', origin: { kind: 'handoff', fromSessionId: 's-wf-root', handoffId: 'h-3' },
      text: '[來自 root] 請實作 Session 儲存：登入後保存 session，期限 30 分鐘，過期要重新登入。驗收條件見計畫第 3 節。', createdAt: t('11:12') },
    { id: 'm-b2', sessionId: 's-wf-build-b', turnId: 'turn-b1', role: 'assistant', origin: { kind: 'agent' },
      text: '先看現有的 session 是怎麼存的，再決定要不要加資料表。', createdAt: t('11:13') },
    { id: 'm-b3', sessionId: 's-wf-build-b', turnId: 'turn-b1', role: 'assistant', origin: { kind: 'agent' },
      text: '儲存層和測試都寫好了，8 個測試通過。\n\n接下來：\n1. 產生 migration（子任務進行中）\n2. 把 task/t2 推上遠端，交給 review', createdAt: t('11:25') },
  ],
  items: [
    ...(fixtureSnapshotInput.items ?? []),
    { id: 'it-b1', sessionId: 's-wf-build-b', turnId: 'turn-b1', kind: 'command', command: 'rg -n "session" src/', cwd: 'E:/work/.awg/wt/t2', state: 'completed', exitCode: 0,
      output: 'src/auth/login.ts:14:  const session = createSession(user);\nsrc/auth/store.ts:3:export const sessions = new Map();', startedAt: t('11:13'), endedAt: t('11:13') },
    { id: 'it-b2', sessionId: 's-wf-build-b', turnId: 'turn-b1', kind: 'fileChange', changes: [{ path: 'src/session/store.ts', change: 'add' }, { path: 'src/session/store.test.ts', change: 'add' }, { path: 'src/auth/login.ts', change: 'update' }],
      state: 'applied', startedAt: t('11:17'), endedAt: t('11:17') },
    { id: 'it-b3', sessionId: 's-wf-build-b', turnId: 'turn-b1', kind: 'command', command: 'npm test -- src/session', cwd: 'E:/work/.awg/wt/t2', state: 'completed', exitCode: 0,
      output: 'Tests  8 passed (8)', startedAt: t('11:21'), endedAt: t('11:22') },
  ],
  nativeTasks: [
    ...(fixtureSnapshotInput.nativeTasks ?? []),
    { id: 'nt-4', sessionId: 's-wf-build-b', runtime: 'codex', parentRef: 'thread-build-b', nativeRef: 'thread-child-schema', label: '讀取現有 schema', state: 'completed', background: false,
      summary: '目前沒有 session 資料表。', startedAt: t('11:14'), endedAt: t('11:15') },
  ],
});

/** U2: pinned sessions are a per-user preference the backend should store. */
export const demoPinned: readonly string[] = ['s-handoff-codex'];

/** U2: default location for auto-created folders (Q-1). Shown unexpanded, as the user would type it. */
export const defaultFolderRoot = '%USERPROFILE%\\AgentWorkflowGui';

/** U2: recently used folders, newest first. */
export const recentFolders: readonly string[] = ['E:/work/demo', 'E:/work/docs'];

const pad = (value: number, size = 2) => String(value).padStart(size, '0');
export const datePrefix = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * The folder name main would create next (Q-2): today's date plus the next three-digit sequence, growing past 999.
 * U2: main assigns the real name when the session is created; the renderer only previews it.
 */
export function nextAutoFolder(date: Date, existing: readonly string[] = []): string {
  const prefix = datePrefix(date);
  const used = existing.flatMap(name => {
    const match = new RegExp(`^${prefix}-(\\d{3,})$`).exec(name);
    return match ? [Number(match[1])] : [];
  });
  return `${prefix}-${pad(Math.max(0, ...used) + 1, 3)}`;
}

/** Sessions with the most recent activity first (Q-6: no folder grouping). */
export const byRecent = (a: LogicalSession, b: LogicalSession) => b.updatedAt.localeCompare(a.updatedAt);

export type V4Page = 'new' | 'chat' | 'settings' | 'workflow-start' | 'agents' | 'templates' | 'progress';
export interface V4Pane { id: string; sessionId: SessionId; details: boolean; tab: 'files' | 'tasks' | 'messages' | 'info' }

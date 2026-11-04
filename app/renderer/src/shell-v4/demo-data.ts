// Demo data for the v0.4 shell: the fixture plus a conversation with tool calls, earlier runs and a chat escalation.
// The demo (no app service) and the T051 screenshots of the connected app use it.
import { Snapshot } from '../../../../contracts';
import type { LogicalSession } from '../../../../contracts';
import { fixtureSnapshotInput } from '../../../../contracts/fixtures/snapshot';

const t = (time: string) => `2026-10-24T${time}:00+08:00`;

const docsRun = fixtureSnapshotInput.instances.find(instance => instance.id === 'inst-docs')!;
const docsLead = fixtureSnapshotInput.sessions.find(session => session.id === 's-docs-lead')!;
/** Two earlier runs, so the Workflow list shows every state: completed, and blocked (shown as 卡住, Q-12). */
const pastRun = (id: string, title: string, state: 'completed' | 'blocked', time: string) => ({
  instance: { ...docsRun, id, title, rootSessionId: `s-${id}-lead`, state, tasks: [], rounds: [], createdAt: t(time) },
  session: { ...docsLead, id: `s-${id}-lead`, title: `${title}（root）`, activity: 'idle', workflow: { instanceId: id, nodeId: 'n-lead' }, createdAt: t(time), updatedAt: t(time) },
});
const pastRuns = [pastRun('inst-onboard', '新人文件整理', 'completed', '09:20'), pastRun('inst-export', '匯出報表', 'blocked', '08:40')];

/** The fixture plus a conversation for 「實作：Session 儲存」 with tool calls, a held push and sub-tasks, two earlier runs and a chat escalation. */
export const v4DemoSnapshot = Snapshot.parse({
  ...fixtureSnapshotInput,
  // One pinned chat and one pinned run, saved like the app saves them (contracts 0.9, T050).
  preferences: { ...fixtureSnapshotInput.preferences, pinned: { chat: ['s-handoff-codex'], workflow: ['inst-onboard'] } },
  sessions: [...fixtureSnapshotInput.sessions, ...pastRuns.map(run => run.session)],
  instances: [...fixtureSnapshotInput.instances, ...pastRuns.map(run => run.instance)],
  escalations: [
    ...fixtureSnapshotInput.escalations,
    // An ordinary chat waiting for the user, so the 對話 switch shows a count while the sidebar is in Workflow mode.
    { id: 'esc-chat-1', rootSessionId: 's-handoff-codex', fromSessionId: 's-handoff-codex', kind: 'confirmation', title: '確認轉交內容', detail: '轉交 Codex 的目標與備註', state: 'open', createdAt: t('10:41') },
  ],
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

export type SidebarMode = 'chat' | 'workflow';

/** Sessions with the most recent activity first (Q-6: no folder grouping). */
export const byRecent = (a: LogicalSession, b: LogicalSession) => b.updatedAt.localeCompare(a.updatedAt);

export type V4Page = 'new' | 'chat' | 'settings' | 'workflow-start' | 'agents' | 'templates' | 'progress';

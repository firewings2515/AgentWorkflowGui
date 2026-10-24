// Fake data for building the UI before the backend exists (T002, T004). All names are fictional.
// Covers: ordinary and workflow sessions, a session with native sub-agents, a cross-tool transfer,
// a multi-task workflow instance, and open escalations.
import type { z } from 'zod';
import { Snapshot } from '../ipc';

const t = (hhmm: string) => `2026-10-24T${hhmm}:00+08:00`;
const claudeSonnet = { runtime: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } as const;
const claudeOpus = { runtime: 'claude', model: 'claude-opus-5-5', effort: 'high' } as const;
const codexAstra = { runtime: 'codex', model: 'gpt-6-astra', effort: 'high' } as const;

export const fixtureSnapshotInput: z.input<typeof Snapshot> = {
  agents: [
    { id: 'agent-planner', revision: 1, name: '規劃 Agent', description: '拆解需求、規劃 task', instructions: '先釐清目標，再列出可驗證的步驟。', updatedAt: t('09:00') },
    { id: 'agent-builder', revision: 2, name: '實作 Agent', description: '依規格實作並跑測試', instructions: '只改負責的資料夾，完成後跑測試。', updatedAt: t('09:05') },
    { id: 'agent-reviewer', revision: 1, name: 'Review Agent', description: '只提問題，不改程式碼', instructions: '問題分 P1／P2，附位置與理由。', updatedAt: t('09:10') },
    { id: 'agent-tester', revision: 1, name: '測試 Agent', description: '執行測試並回報', instructions: '不改原始碼，只執行指令。', updatedAt: t('09:15') },
  ],
  workflows: [
    {
      id: 'wf-default',
      revision: 3,
      name: '規劃 → 實作 → Review → 測試',
      description: '內建範本',
      reworkLimit: 3,
      isolation: 'worktree',
      nodes: [
        { id: 'n-plan', kind: 'agent', label: '規劃', agentId: 'agent-planner', model: claudeOpus, writePolicy: 'read-only', isRoot: true, position: { x: 0, y: 120 },
          inputRules: [{ id: 'in-user', condition: '使用者訊息：閒聊直接回答，需求整理成計畫' }],
          outputRules: [{ id: 'out-plan', condition: '計畫經使用者確認', payload: '計畫與驗收條件', target: 'n-build', requiresUserConfirmation: true }] },
        { id: 'n-build', kind: 'agent', label: '實作', agentId: 'agent-builder', model: codexAstra, writePolicy: 'write', concurrency: 2, position: { x: 260, y: 120 },
          inputRules: [{ id: 'in-plan', condition: '來自規劃的計畫' }, { id: 'in-rework', condition: '來自 review 或測試的退回' }],
          outputRules: [{ id: 'out-done', condition: '完成', payload: '變更摘要與檔案清單', target: 'n-review' }, { id: 'out-unclear', condition: '需求不清楚', payload: '問題', target: 'root' }] },
        { id: 'n-review', kind: 'agent', label: 'Review', agentId: 'agent-reviewer', model: claudeSonnet, writePolicy: 'read-only', position: { x: 520, y: 60 },
          inputRules: [{ id: 'in-impl', condition: '來自實作', acceptanceLimit: 3 }],
          outputRules: [{ id: 'out-pass', condition: '通過', payload: '結論', target: 'n-test' }, { id: 'out-fix', condition: '需要修改', payload: '問題清單', target: 'n-build' }] },
        { id: 'n-test', kind: 'agent', label: '測試', agentId: 'agent-tester', model: claudeSonnet, writePolicy: 'exec-only', position: { x: 780, y: 60 },
          inputRules: [{ id: 'in-review', condition: '來自 review 的通過' }],
          outputRules: [{ id: 'out-green', condition: '全部通過', payload: '測試結果', target: 'n-merge' }, { id: 'out-red', condition: '失敗', payload: '失敗紀錄', target: 'n-build' }] },
        { id: 'n-merge', kind: 'merge', label: '合併', writePolicy: 'write', position: { x: 1040, y: 120 }, inputRules: [], outputRules: [{ id: 'out-merged', condition: '整合測試通過並合併', payload: '合併 commit', target: 'root' }] },
      ],
      edges: [
        { source: 'n-plan', target: 'n-build' },
        { source: 'n-build', target: 'n-review' },
        { source: 'n-review', target: 'n-test' },
        { source: 'n-review', target: 'n-build' },
        { source: 'n-test', target: 'n-merge' },
        { source: 'n-test', target: 'n-build' },
      ],
      updatedAt: t('09:30'),
    },
  ],
  sessions: [
    { id: 's-plan-notes', revision: 4, kind: 'ordinary', title: '規劃想法', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeOpus,
      observedModel: { source: 'per-message', model: 'claude-opus-5-5', observedAt: t('10:02') }, activity: 'idle', cwd: 'E:/work/demo', createdAt: t('10:00'), updatedAt: t('10:02') },
    { id: 's-research', revision: 2, kind: 'ordinary', title: '參考資料整理', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeSonnet,
      observedModel: { source: 'per-message', model: 'claude-sonnet-5-5', observedAt: t('10:20') }, activity: 'running', cwd: 'E:/work/demo', parentId: 's-plan-notes', createdAt: t('10:10'), updatedAt: t('10:20') },
    { id: 's-handoff-codex', revision: 1, kind: 'ordinary', title: '規劃想法（轉交 Codex）', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'configured', model: 'gpt-6-astra', observedAt: t('10:40') }, activity: 'idle', cwd: 'E:/work/demo', derivedFromSessionId: 's-plan-notes', createdAt: t('10:40'), updatedAt: t('10:41') },
    { id: 's-wf-root', revision: 6, kind: 'workflow', title: '登入功能（root）', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeOpus,
      observedModel: { source: 'per-message', model: 'claude-opus-5-5', observedAt: t('11:05') }, activity: 'waiting-user', cwd: 'E:/work/demo',
      workflow: { instanceId: 'inst-login', nodeId: 'n-plan' }, createdAt: t('11:00'), updatedAt: t('11:30') },
    { id: 's-wf-build-a', revision: 3, kind: 'workflow', title: '實作：表單驗證', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'configured', model: 'gpt-6-astra', observedAt: t('11:20') }, activity: 'idle', cwd: 'E:/work/.awg/wt/t1', parentId: 's-wf-root',
      workflow: { instanceId: 'inst-login', nodeId: 'n-build', taskId: 'task-a' }, createdAt: t('11:10'), updatedAt: t('11:20') },
    { id: 's-wf-review-a', revision: 2, kind: 'workflow', title: 'Review：表單驗證', agent: { id: 'agent-reviewer', revision: 1 }, requestedModel: claudeSonnet,
      observedModel: { source: 'per-message', model: 'claude-sonnet-5-5', observedAt: t('11:28') }, activity: 'running', cwd: 'E:/work/.awg/wt/t1', parentId: 's-wf-build-a',
      workflow: { instanceId: 'inst-login', nodeId: 'n-review', taskId: 'task-a' }, createdAt: t('11:22'), updatedAt: t('11:28') },
    { id: 's-wf-build-b', revision: 2, kind: 'workflow', title: '實作：Session 儲存', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'configured', model: 'gpt-6-astra', observedAt: t('11:25') }, activity: 'running', cwd: 'E:/work/.awg/wt/t2', parentId: 's-wf-root',
      workflow: { instanceId: 'inst-login', nodeId: 'n-build', taskId: 'task-b' }, createdAt: t('11:12'), updatedAt: t('11:25') },
  ],
  messages: [
    { id: 'm1', sessionId: 's-plan-notes', role: 'user', origin: { kind: 'user' }, text: '先整理成草稿，不要開始執行。', createdAt: t('10:00') },
    { id: 'm2', sessionId: 's-plan-notes', role: 'assistant', origin: { kind: 'agent' }, text: '好，我先列三個步驟：釐清目標、比較方案、列出待確認事項。', createdAt: t('10:01') },
    { id: 'm3', sessionId: 's-plan-notes', role: 'user', origin: { kind: 'user' }, text: '參考這兩個檔案。', attachments: [{ kind: 'image', path: 'E:/work/demo/concept.png', name: 'concept.png' }, { kind: 'folder', path: 'E:/work/demo/refs', name: 'refs' }], createdAt: t('10:02') },
    { id: 'm4', sessionId: 's-wf-root', role: 'assistant', origin: { kind: 'agent' }, text: '計畫已拆成 3 個 task，task C 依賴 task A。請確認後開始。', createdAt: t('11:05') },
    { id: 'm5', sessionId: 's-wf-build-a', role: 'user', origin: { kind: 'peer', fromSessionId: 's-wf-root' }, text: '[來自 root] 請實作表單驗證，驗收條件見計畫第 2 節。', createdAt: t('11:10') },
    { id: 'm6', sessionId: 's-wf-build-a', role: 'assistant', origin: { kind: 'agent' }, text: '已完成表單驗證，12 個測試通過，交給 review。', createdAt: t('11:20') },
  ],
  turns: [
    { id: 'turn-r1', sessionId: 's-research', state: 'running', startedAt: t('10:19') },
    { id: 'turn-a1', sessionId: 's-wf-build-a', state: 'completed', startedAt: t('11:10'), endedAt: t('11:20') },
  ],
  nativeTasks: [
    { id: 'nt-1', sessionId: 's-research', runtime: 'claude', parentRef: 'toolu_demo_1', nativeRef: 'a1b2c3', label: '讀取 refs/a.md', agentType: 'researcher', state: 'completed', background: false, summary: '整理出三個重點。', startedAt: t('10:19'), endedAt: t('10:20') },
    { id: 'nt-2', sessionId: 's-research', runtime: 'claude', parentRef: 'toolu_demo_2', nativeRef: 'd4e5f6', label: '讀取 refs/b.md', agentType: 'researcher', state: 'running', background: false, lastActivity: 'Read', startedAt: t('10:19') },
    { id: 'nt-3', sessionId: 's-wf-build-b', runtime: 'codex', parentRef: 'thread-parent-demo', nativeRef: 'thread-child-demo', label: '產生 migration', state: 'running', background: false, lastActivity: 'commandExecution', startedAt: t('11:24') },
  ],
  instances: [
    {
      id: 'inst-login', workflowId: 'wf-default', workflowRevision: 3, title: '登入功能', rootSessionId: 's-wf-root', state: 'running', crossToolConsentAt: t('11:00'),
      tasks: [
        { id: 'task-a', instanceId: 'inst-login', title: '表單驗證', dependsOn: [], status: 'running', currentNodeId: 'n-review', worktree: { path: 'E:/work/.awg/wt/t1', branch: 'task/t1' }, reworkCount: 0 },
        { id: 'task-b', instanceId: 'inst-login', title: 'Session 儲存', dependsOn: [], status: 'running', currentNodeId: 'n-build', worktree: { path: 'E:/work/.awg/wt/t2', branch: 'task/t2' }, reworkCount: 1 },
        { id: 'task-c', instanceId: 'inst-login', title: '登入頁 UI', dependsOn: ['task-a'], status: 'pending', reworkCount: 0 },
      ],
      createdAt: t('11:00'),
    },
  ],
  escalations: [
    { id: 'esc-1', instanceId: 'inst-login', rootSessionId: 's-wf-root', fromSessionId: 's-wf-build-b', kind: 'permission', title: '要求執行 git push', detail: 'git push origin task/t2', rule: 'git-push', state: 'open', createdAt: t('11:26') },
    { id: 'esc-2', instanceId: 'inst-login', rootSessionId: 's-wf-root', fromSessionId: 's-wf-root', kind: 'confirmation', title: '確認 task 清單', detail: '3 個 task，task C 依賴 task A', state: 'open', createdAt: t('11:05') },
  ],
  transfers: [
    { id: 'tr-1', revision: 1, sourceSessionId: 's-plan-notes', sourceRevision: 4, target: codexAstra,
      content: { goal: '完成規劃草稿並開始實作', note: '已完成：目標與方案比較。未完成：待確認事項。', noteSource: 'gui-digest', diff: '', testOutput: '' },
      state: 'awaiting-confirmation', createdAt: t('10:35') },
  ],
  preferences: { theme: 'dark' },
};

/** Parsed fixture (branded IDs applied). Throws at import time if the fixture drifts from the contracts. */
export const fixtureSnapshot = Snapshot.parse(fixtureSnapshotInput);

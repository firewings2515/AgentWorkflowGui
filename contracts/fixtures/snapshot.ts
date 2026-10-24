// Fake data for building the UI before the backend exists (T002, T004). All names are fictional.
// Covers: ordinary and workflow sessions, a session with native sub-agents, items and permission
// requests, artifacts, a cross-tool transfer (done) and one awaiting confirmation, a multi-task workflow
// instance with handoffs, cross-session messages (one with unknown delivery), and escalations.
import type { z } from 'zod';
import { CONTRACTS_VERSION } from '../common';
import type { DeliveryRecord } from '../delivery';
import { Snapshot } from '../ipc';

const v = CONTRACTS_VERSION;
const t = (hhmm: string) => `2026-10-24T${hhmm}:00+08:00`;
/** Placeholder content hash; real ones are sha256 of the fixed payload snapshot. */
const hash = (hexDigit: string) => `sha256:${hexDigit.repeat(64)}`;
const uuid = (n: number) => `6f1c2a4e-8b3d-4c7a-9e21-${n.toString().padStart(12, '0')}`;
const claudeSonnet = { runtime: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } as const;
const claudeOpus = { runtime: 'claude', model: 'claude-opus-5-5', effort: 'high' } as const;
const codexAstra = { runtime: 'codex', model: 'gpt-6-astra', effort: 'high' } as const;
const node = (nodeId: string) => ({ kind: 'node', nodeId }) as const;
const root = { kind: 'root' } as const;
const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const codexEfforts = ['low', 'medium', 'high'];

/** A delivery acknowledged live by the runtime (CR-2). */
const sentDelivery = (n: number, at: string, sessionRef: string, turnRef?: string): z.input<typeof DeliveryRecord> => ({
  state: 'sent',
  attempts: [{
    attemptId: `att-${n}`, clientMessageId: uuid(n), state: 'sent', dispatchStartedAt: at,
    nativeRef: turnRef ? { sessionRef, turnRef } : { sessionRef },
    evidence: { kind: 'live-ack', at, detail: '接受回應帶回相同 clientMessageId' },
  }],
});

export const fixtureSnapshotInput: z.input<typeof Snapshot> = {
  schemaVersion: v,
  seq: 42,
  agents: [
    { schemaVersion: v, id: 'agent-planner', revision: 1, name: '規劃 Agent', description: '拆解需求、規劃 task', instructions: '先釐清目標，再列出可驗證的步驟。', updatedAt: t('09:00') },
    { schemaVersion: v, id: 'agent-builder', revision: 2, name: '實作 Agent', description: '依規格實作並跑測試', instructions: '只改負責的資料夾，完成後跑測試。', updatedAt: t('09:05') },
    { schemaVersion: v, id: 'agent-reviewer', revision: 1, name: 'Review Agent', description: '只提問題，不改程式碼', instructions: '問題分 P1／P2，附位置與理由。', updatedAt: t('09:10') },
    { schemaVersion: v, id: 'agent-tester', revision: 1, name: '測試 Agent', description: '執行測試並回報', instructions: '不改原始碼，只執行指令。', updatedAt: t('09:15') },
  ],
  workflows: [
    {
      schemaVersion: v,
      id: 'wf-default',
      revision: 3,
      name: '規劃 → 實作 → Review → 測試',
      description: '內建範本',
      reworkLimit: 3,
      isolation: 'worktree',
      nodes: [
        { id: 'n-plan', kind: 'agent', label: '規劃', agentId: 'agent-planner', model: claudeOpus, writePolicy: 'read-only', isRoot: true, position: { x: 0, y: 120 },
          inputRules: [{ id: 'in-user', condition: '使用者訊息：閒聊直接回答，需求整理成計畫' }],
          outputRules: [{ id: 'out-plan', condition: '計畫經使用者確認', payload: '計畫與驗收條件', target: node('n-build'), requiresUserConfirmation: true }] },
        { id: 'n-build', kind: 'agent', label: '實作', agentId: 'agent-builder', model: codexAstra, writePolicy: 'write', concurrency: 2, position: { x: 260, y: 120 },
          inputRules: [{ id: 'in-plan', condition: '來自規劃的計畫' }, { id: 'in-rework', condition: '來自 review 或測試的退回' }],
          outputRules: [{ id: 'out-done', condition: '完成', payload: '變更摘要與檔案清單', target: node('n-review') }, { id: 'out-unclear', condition: '需求不清楚', payload: '問題', target: root }] },
        { id: 'n-review', kind: 'agent', label: 'Review', agentId: 'agent-reviewer', model: claudeSonnet, writePolicy: 'read-only', position: { x: 520, y: 60 },
          inputRules: [{ id: 'in-impl', condition: '來自實作', acceptanceLimit: 3 }],
          outputRules: [{ id: 'out-pass', condition: '通過', payload: '結論', target: node('n-test') }, { id: 'out-fix', condition: '需要修改', payload: '問題清單', target: node('n-build') }] },
        { id: 'n-test', kind: 'agent', label: '測試', agentId: 'agent-tester', model: claudeSonnet, writePolicy: 'exec-only', position: { x: 780, y: 60 },
          inputRules: [{ id: 'in-review', condition: '來自 review 的通過' }],
          outputRules: [{ id: 'out-green', condition: '全部通過', payload: '測試結果', target: node('n-merge') }, { id: 'out-red', condition: '失敗', payload: '失敗紀錄', target: node('n-build') }] },
        { id: 'n-merge', kind: 'merge', label: '合併', writePolicy: 'write', position: { x: 1040, y: 120 }, inputRules: [], outputRules: [{ id: 'out-merged', condition: '整合測試通過並合併', payload: '合併 commit', target: root }] },
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
  modelOptions: [
    { runtime: 'claude', model: 'claude-opus-5-5', displayName: 'Opus 5.5', efforts: claudeEfforts, defaultEffort: 'high' },
    { runtime: 'claude', model: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', efforts: claudeEfforts, defaultEffort: 'high', isDefault: true },
    { runtime: 'claude', model: 'claude-haiku-5-5', displayName: 'Haiku 5.5', efforts: claudeEfforts, defaultEffort: 'medium' },
    { runtime: 'codex', model: 'gpt-6-astra', displayName: 'GPT-6 Astra', efforts: codexEfforts, defaultEffort: 'high', isDefault: true },
    { runtime: 'codex', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: codexEfforts, defaultEffort: 'low' },
    { runtime: 'codex', model: 'gpt-6-luna-preview', displayName: 'GPT-6 Luna Preview', efforts: codexEfforts, hidden: true },
  ],
  sessions: [
    { id: 's-plan-notes', revision: 4, kind: 'ordinary', title: '規劃想法', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeOpus,
      observedModel: { source: 'per-message', model: 'claude-opus-5-5', observedAt: t('10:02') }, activity: 'idle', cwd: 'E:/work/demo', createdAt: t('10:00'), updatedAt: t('10:30') },
    { id: 's-research', revision: 2, kind: 'ordinary', title: '參考資料整理', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeSonnet,
      observedModel: { source: 'per-message', model: 'claude-sonnet-5-5', observedAt: t('10:20') }, activity: 'running', cwd: 'E:/work/demo', parentId: 's-plan-notes',
      tokenUsage: { sessionId: 's-research', turnId: 'turn-r1', latest: { input: 1800, cachedInput: 1200, output: 420, total: 2220 }, cumulative: { input: 9600, cachedInput: 6400, output: 2100, total: 11700 }, contextWindow: 200000, at: t('10:20') },
      createdAt: t('10:10'), updatedAt: t('10:20') },
    { id: 's-handoff-codex', revision: 1, kind: 'ordinary', title: '規劃想法（轉交 Codex）', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'configured', model: 'gpt-6-astra', observedAt: t('10:40') }, activity: 'idle', cwd: 'E:/work/demo', derivedFromSessionId: 's-plan-notes', createdAt: t('10:40'), updatedAt: t('10:41') },
    { id: 's-wf-root', revision: 6, kind: 'workflow', title: '登入功能（root）', agent: { id: 'agent-planner', revision: 1 }, requestedModel: claudeOpus,
      observedModel: { source: 'per-message', model: 'claude-opus-5-5', observedAt: t('11:05') }, activity: 'waiting-user', cwd: 'E:/work/demo',
      workflow: { instanceId: 'inst-login', nodeId: 'n-plan' }, createdAt: t('11:00'), updatedAt: t('11:31') },
    { id: 's-wf-build-a', revision: 3, kind: 'workflow', title: '實作：表單驗證', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'configured', model: 'gpt-6-astra', observedAt: t('11:20') }, activity: 'idle', cwd: 'E:/work/.awg/wt/t1', parentId: 's-wf-root',
      workflow: { instanceId: 'inst-login', nodeId: 'n-build', taskId: 'task-a' }, createdAt: t('11:10'), updatedAt: t('11:20') },
    { id: 's-wf-review-a', revision: 2, kind: 'workflow', title: 'Review：表單驗證', agent: { id: 'agent-reviewer', revision: 1 }, requestedModel: claudeSonnet,
      observedModel: { source: 'per-message', model: 'claude-sonnet-5-5', observedAt: t('11:28') }, activity: 'running', cwd: 'E:/work/.awg/wt/t1', parentId: 's-wf-build-a',
      workflow: { instanceId: 'inst-login', nodeId: 'n-review', taskId: 'task-a' }, createdAt: t('11:22'), updatedAt: t('11:28') },
    { id: 's-wf-build-b', revision: 2, kind: 'workflow', title: '實作：Session 儲存', agent: { id: 'agent-builder', revision: 2 }, requestedModel: codexAstra,
      observedModel: { source: 'rerouted', from: 'gpt-6-astra', to: 'gpt-6-luna', reason: '暫時容量不足', observedAt: t('11:25') }, activity: 'running', cwd: 'E:/work/.awg/wt/t2', parentId: 's-wf-root',
      workflow: { instanceId: 'inst-login', nodeId: 'n-build', taskId: 'task-b' }, createdAt: t('11:12'), updatedAt: t('11:30') },
  ],
  messages: [
    { id: 'm1', sessionId: 's-plan-notes', role: 'user', origin: { kind: 'user' }, text: '先整理成草稿，不要開始執行。', createdAt: t('10:00') },
    { id: 'm2', sessionId: 's-plan-notes', role: 'assistant', origin: { kind: 'agent' }, text: '好，我先列三個步驟：釐清目標、比較方案、列出待確認事項。', observedModel: 'claude-opus-5-5', createdAt: t('10:01') },
    { id: 'm3', sessionId: 's-plan-notes', role: 'user', origin: { kind: 'user' }, text: '參考這兩個檔案。', attachments: [{ kind: 'image', path: 'E:/work/demo/concept.png', name: 'concept.png' }, { kind: 'folder', path: 'E:/work/demo/refs', name: 'refs' }], createdAt: t('10:02') },
    { id: 'm4', sessionId: 's-research', turnId: 'turn-r1', nativeTaskId: 'nt-1', role: 'assistant', origin: { kind: 'agent' }, text: 'refs/a.md 有三個重點：登入流程、錯誤訊息、session 期限。', observedModel: 'claude-haiku-5-5', createdAt: t('10:20') },
    { id: 'm5', sessionId: 's-research', turnId: 'turn-r1', role: 'assistant', origin: { kind: 'agent' }, text: '第一份資料整理完了，正在讀第二份。', observedModel: 'claude-sonnet-5-5', createdAt: t('10:20') },
    { id: 'm6', sessionId: 's-plan-notes', role: 'user', origin: { kind: 'peer', fromSessionId: 's-research', peerMessageId: 'pm-1' }, text: '[來自 參考資料整理] 三個重點已整理在 refs/summary.md。', createdAt: t('10:30') },
    { id: 'm7', sessionId: 's-wf-root', role: 'assistant', origin: { kind: 'agent' }, text: '計畫已拆成 3 個 task，task C 依賴 task A。請確認後開始。', observedModel: 'claude-opus-5-5', createdAt: t('11:05') },
    { id: 'm8', sessionId: 's-wf-root', role: 'system', origin: { kind: 'system' }, text: '使用者已確認 task 清單，開始執行。', createdAt: t('11:06') },
    { id: 'm9', sessionId: 's-wf-build-a', turnId: 'turn-a1', role: 'user', origin: { kind: 'handoff', fromSessionId: 's-wf-root', handoffId: 'h-1' }, text: '[來自 root] 請實作表單驗證，驗收條件見計畫第 2 節。', createdAt: t('11:10') },
    { id: 'm10', sessionId: 's-wf-build-a', turnId: 'turn-a1', role: 'assistant', origin: { kind: 'agent' }, text: '已完成表單驗證，12 個測試通過，交給 review。', createdAt: t('11:20') },
    { id: 'm11', sessionId: 's-wf-review-a', role: 'user', origin: { kind: 'handoff', fromSessionId: 's-wf-build-a', handoffId: 'h-2' }, text: '[來自 實作] 變更：src/form/validate.ts 與測試。', createdAt: t('11:22') },
  ],
  turns: [
    { id: 'turn-r1', sessionId: 's-research', state: 'running', requestedModel: claudeSonnet, startedAt: t('10:19') },
    { id: 'turn-a1', sessionId: 's-wf-build-a', state: 'completed', requestedModel: codexAstra, startedAt: t('11:10'), endedAt: t('11:20') },
    { id: 'turn-b1', sessionId: 's-wf-build-b', state: 'running', requestedModel: codexAstra, startedAt: t('11:12') },
  ],
  items: [
    { id: 'it-1', sessionId: 's-wf-build-a', turnId: 'turn-a1', kind: 'command', command: 'npm test', cwd: 'E:/work/.awg/wt/t1', state: 'completed', exitCode: 0, output: 'Tests  12 passed (12)', startedAt: t('11:18'), endedAt: t('11:19') },
    { id: 'it-2', sessionId: 's-wf-build-a', turnId: 'turn-a1', kind: 'fileChange', changes: [{ path: 'src/form/validate.ts', change: 'update' }, { path: 'src/form/validate.test.ts', change: 'add' }], state: 'applied', startedAt: t('11:15'), endedAt: t('11:15') },
    { id: 'it-3', sessionId: 's-wf-build-b', turnId: 'turn-b1', nativeTaskId: 'nt-3', kind: 'command', command: 'npm run migrate:gen', cwd: 'E:/work/.awg/wt/t2', state: 'running', output: 'generating…', startedAt: t('11:24') },
    { id: 'it-4', sessionId: 's-research', turnId: 'turn-r1', nativeTaskId: 'nt-2', kind: 'toolCall', tool: 'Read', summary: 'refs/b.md', state: 'running', startedAt: t('10:20') },
  ],
  permissionRequests: [
    { id: 'pr-1', sessionId: 's-wf-build-b', turnId: 'turn-b1', kind: 'command', summary: '執行 git push', command: 'git push origin task/t2', cwd: 'E:/work/.awg/wt/t2', matchedRule: 'git-push',
      state: 'held', hold: { reason: 'awaiting-user', escalationId: 'esc-1' }, createdAt: t('11:26') },
    { id: 'pr-2', sessionId: 's-wf-build-a', turnId: 'turn-a1', itemId: 'it-1', kind: 'command', summary: '執行 npm test', command: 'npm test', cwd: 'E:/work/.awg/wt/t1',
      state: 'answered', decision: { outcome: 'approve', decidedBy: 'policy', at: t('11:18') }, createdAt: t('11:18') },
  ],
  nativeTasks: [
    { id: 'nt-1', sessionId: 's-research', runtime: 'claude', parentRef: 'toolu_demo_1', nativeRef: 'a1b2c3', label: '讀取 refs/a.md', agentType: 'researcher', state: 'completed', background: false, summary: '整理出三個重點。', startedAt: t('10:19'), endedAt: t('10:20') },
    { id: 'nt-2', sessionId: 's-research', runtime: 'claude', parentRef: 'toolu_demo_2', nativeRef: 'd4e5f6', label: '讀取 refs/b.md', agentType: 'researcher', state: 'running', background: false, lastActivity: 'Read', startedAt: t('10:19') },
    { id: 'nt-3', sessionId: 's-wf-build-b', runtime: 'codex', parentRef: 'thread-build-b', nativeRef: 'thread-child-demo', label: '產生 migration', state: 'running', background: false, lastActivity: 'commandExecution', startedAt: t('11:24') },
  ],
  artifacts: [
    { id: 'art-1', sessionId: 's-plan-notes', section: 'input', source: 'user-attachment', kind: 'image', name: 'concept.png', path: 'E:/work/demo/concept.png', mimeType: 'image/png', sizeBytes: 182044, revision: 1, access: 'available', messageId: 'm3', updatedAt: t('10:02') },
    { id: 'art-2', sessionId: 's-plan-notes', section: 'input', source: 'user-attachment', kind: 'folder', name: 'refs', path: 'E:/work/demo/refs', revision: 1, access: 'available', messageId: 'm3', updatedAt: t('10:02') },
    { id: 'art-3', sessionId: 's-wf-build-a', section: 'output', source: 'agent', kind: 'file', name: 'validate.ts', path: 'E:/work/.awg/wt/t1/src/form/validate.ts', mimeType: 'text/typescript', sizeBytes: 2048, revision: 2, access: 'available', turnId: 'turn-a1', updatedAt: t('11:15') },
    { id: 'art-4', sessionId: 's-research', section: 'output', source: 'agent', kind: 'file', name: 'summary.md', path: 'E:/work/demo/refs/summary.md', mimeType: 'text/markdown', revision: 1, access: 'missing', turnId: 'turn-r1', updatedAt: t('10:30') },
  ],
  instances: [
    {
      id: 'inst-login', workflowId: 'wf-default', workflowRevision: 3, title: '登入功能', rootSessionId: 's-wf-root', state: 'running', crossToolConsentAt: t('11:00'),
      tasks: [
        { id: 'task-a', instanceId: 'inst-login', title: '表單驗證', dependsOn: [], status: 'running', currentNodeId: 'n-review', worktree: { path: 'E:/work/.awg/wt/t1', branch: 'task/t1' }, reworkCount: 0 },
        { id: 'task-b', instanceId: 'inst-login', title: 'Session 儲存', dependsOn: [], status: 'running', currentNodeId: 'n-build', worktree: { path: 'E:/work/.awg/wt/t2', branch: 'task/t2' }, reworkCount: 0 },
        { id: 'task-c', instanceId: 'inst-login', title: '登入頁 UI', dependsOn: ['task-a'], status: 'pending', reworkCount: 0 },
      ],
      createdAt: t('11:00'),
    },
  ],
  handoffs: [
    { id: 'h-1', operationId: 'op-h1', sourceCallRef: 'toolu_root_handoff_1', instanceId: 'inst-login', taskId: 'task-a', fromNodeId: 'n-plan', toNodeId: 'n-build', fromSessionId: 's-wf-root', ruleId: 'out-plan',
      payload: '請實作表單驗證，驗收條件見計畫第 2 節。', payloadHash: hash('a'), proposalRevision: 1, round: 0,
      target: { sessionId: 's-wf-build-a', provision: { operationId: 'op-h1-target', bindingKey: 'inst-login/n-build/task-a', state: 'sent', nativeSessionRef: 'thread-build-a', preallocated: false } },
      delivery: sentDelivery(1, t('11:10'), 'thread-build-a', 'turn-native-a1'), acceptedAt: t('11:07') },
    { id: 'h-2', operationId: 'op-h2', sourceCallRef: 'call_build_a_handoff_1', instanceId: 'inst-login', taskId: 'task-a', fromNodeId: 'n-build', toNodeId: 'n-review', fromSessionId: 's-wf-build-a', ruleId: 'out-done',
      payload: '變更：src/form/validate.ts 與測試。', payloadHash: hash('b'), proposalRevision: 0, round: 0,
      target: { sessionId: 's-wf-review-a', provision: { operationId: 'op-h2-target', bindingKey: 'inst-login/n-review/task-a', state: 'sent', nativeSessionRef: uuid(102), preallocated: true } },
      delivery: sentDelivery(2, t('11:22'), uuid(102)), acceptedAt: t('11:21') },
    { id: 'h-3', operationId: 'op-h3', sourceCallRef: 'toolu_root_handoff_2', instanceId: 'inst-login', taskId: 'task-b', fromNodeId: 'n-plan', toNodeId: 'n-build', fromSessionId: 's-wf-root', ruleId: 'out-plan',
      payload: '請實作 session 儲存。', payloadHash: hash('c'), proposalRevision: 1, round: 0,
      target: { sessionId: 's-wf-build-b', provision: { operationId: 'op-h3-target', bindingKey: 'inst-login/n-build/task-b', state: 'sent', nativeSessionRef: 'thread-build-b', preallocated: false } },
      delivery: sentDelivery(3, t('11:12'), 'thread-build-b', 'turn-native-b1'), acceptedAt: t('11:07') },
  ],
  peerMessages: [
    { id: 'pm-1', operationId: 'op-pm1', fromSessionId: 's-research', toSessionId: 's-plan-notes', text: '三個重點已整理在 refs/summary.md。', payloadHash: hash('d'), entry: 'new-turn',
      delivery: sentDelivery(4, t('10:30'), uuid(100)), createdAt: t('10:30') },
    { id: 'pm-2', operationId: 'op-pm2', fromSessionId: 's-wf-root', toSessionId: 's-wf-build-b', instanceId: 'inst-login', text: '請一併處理 session 過期的情況。', payloadHash: hash('e'), entry: 'insert',
      delivery: { state: 'unknown', attempts: [{ attemptId: 'att-5', clientMessageId: uuid(5), state: 'unknown', dispatchStartedAt: t('11:29') }] }, createdAt: t('11:29') },
  ],
  escalations: [
    { id: 'esc-1', instanceId: 'inst-login', rootSessionId: 's-wf-root', fromSessionId: 's-wf-build-b', kind: 'permission', title: '要求執行 git push', detail: 'git push origin task/t2', rule: 'git-push',
      ref: { kind: 'permission', permissionRequestId: 'pr-1' }, state: 'open', createdAt: t('11:26') },
    { id: 'esc-2', instanceId: 'inst-login', rootSessionId: 's-wf-root', fromSessionId: 's-wf-root', kind: 'confirmation', title: '確認 task 清單', detail: '3 個 task，task C 依賴 task A',
      state: 'approved', resolvedBy: 'user', createdAt: t('11:05'), resolvedAt: t('11:06') },
    { id: 'esc-3', instanceId: 'inst-login', rootSessionId: 's-wf-root', fromSessionId: 's-wf-root', kind: 'delivery-unknown', title: '訊息送達結果未知',
      detail: '送往「實作：Session 儲存」時 app-server 斷線，歷史中查不到相同 clientMessageId；未自動重送。', ref: { kind: 'peerMessage', peerMessageId: 'pm-2' }, state: 'open', createdAt: t('11:31') },
  ],
  transfers: [
    { id: 'tr-1', operationId: 'op-tr1', revision: 1, sourceSessionId: 's-plan-notes', sourceRevision: 3, target: codexAstra,
      content: { goal: '完成規劃草稿並開始實作', note: '已完成：目標與方案比較。未完成：待確認事項。', noteSource: 'gui-digest', diff: '', testOutput: '' }, payloadHash: hash('f'),
      state: 'approved', approvedRevision: 1, approvedAt: t('10:38'),
      provision: { operationId: 'op-tr1-target', bindingKey: 'transfer/tr-1', state: 'sent', nativeSessionRef: 'thread-handoff-codex', preallocated: false },
      createdSessionId: 's-handoff-codex', delivery: sentDelivery(6, t('10:40'), 'thread-handoff-codex', 'turn-native-h1'), createdAt: t('10:35') },
    { id: 'tr-2', operationId: 'op-tr2', revision: 0, sourceSessionId: 's-research', sourceRevision: 2, target: codexAstra,
      content: { goal: '把整理好的重點交給 Codex 實作', note: '已完成：refs/a.md。未完成：refs/b.md。', noteSource: 'agent', diff: '', testOutput: '' }, payloadHash: hash('0'),
      state: 'awaiting-confirmation', createdAt: t('10:21') },
  ],
  preferences: { theme: 'dark' },
};

/** Parsed fixture (branded IDs applied). Throws at import time if the fixture drifts from the contracts. */
export const fixtureSnapshot = Snapshot.parse(fixtureSnapshotInput);

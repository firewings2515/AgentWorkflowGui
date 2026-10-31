import type { JoinRound, MergeAttempt, TaskPlan, WorkflowInstance, WorkflowTask } from '../../../contracts';
import { FolderButton } from './FolderButton';
import { PipelineActions } from './PipelineActions';
import type { PipelineControlProps } from './PipelineActions';
import { Empty, Status } from './ui';

export const nodeLabel = (instance: WorkflowInstance, id: string) => instance.template.nodes.find(n => n.id === id)?.label ?? id;
export const taskLabel = (instance: WorkflowInstance, id: string) => instance.tasks.find(t => t.id === id)?.title ?? id;
const blockedReasons: Record<NonNullable<WorkflowTask['blockedReason']>, string> = {
  'setup-failed': '初始化失敗', 'merge-conflict': '合併衝突', 'tests-failed': '整合測試失敗', 'merge-failed': '合併失敗',
  'round-blocked': '匯流輪次受阻', 'limit-exceeded': '超過上限', 'delivery-unknown': '送達結果未知',
};
const cleanupLabels = { active: '使用中', 'pending-cleanup': '待清理', removed: '已清理' };
export function TaskFacts({ instance, task, store, ipcState }: PipelineControlProps & { instance: WorkflowInstance; task: WorkflowTask }) {
  const pendingCleanup = task.worktree?.cleanup === 'pending-cleanup' || instance.mergeQueue.some(m => m.taskId === task.id && m.integration?.cleanup === 'pending-cleanup');
  return <div className="task-facts">
    <p>依賴：{task.dependsOn.length ? task.dependsOn.map(id => `${taskLabel(instance, id)}（${id}）`).join('、') : '無'}</p>
    {task.status === 'blocked' && <p className="command-warning">受阻原因：{task.blockedReason ? blockedReasons[task.blockedReason] : '尚無原因資料'}</p>}
    {task.worktree ? <><p>Worktree：<code>{task.worktree.path}</code> · 分支 {task.worktree.branch} · {cleanupLabels[task.worktree.cleanup]}</p>
      {task.worktree.cleanup !== 'removed' && <FolderButton target={{ kind: 'task-worktree', instanceId: instance.id, taskId: task.id }} />}</> : <p>Worktree：{instance.template.isolation === 'same-folder' ? '共用資料夾' : '尚未建立'}</p>}
    {pendingCleanup && !instance.mergeQueue.some(m => m.taskId === task.id) && <PipelineActions instance={instance} task={task} store={store} ipcState={ipcState} />}
    {task.completedAt && <p>完成時間：<time dateTime={task.completedAt}>{new Date(task.completedAt).toLocaleString('zh-TW')}</time></p>}
    {task.setup && <details><summary>初始化：{({ running: '執行中', succeeded: '成功', failed: '失敗' })[task.setup.state]}</summary><code>{task.setup.command}</code><p>結束碼：{task.setup.exitCode ?? '尚無'}</p><pre>{task.setup.outputTail}</pre></details>}
  </div>;
}

export function RoundDetails({ instance, round }: { instance: WorkflowInstance; round: JoinRound }) {
  const reasons = { 'upstream-failed': '上游失敗', 'upstream-cancelled': '上游已取消', timeout: '等待逾時' };
  return <article className="detail-card" aria-label={`${nodeLabel(instance, round.nodeId)} · 第 ${round.round} 輪`}>
    <h4>{nodeLabel(instance, round.nodeId)} · 第 {round.round} 輪 · {({ waiting: '等待上游', ready: '已到齊', blocked: '受阻' })[round.state]}</h4>
    <p>預期上游：{round.expectedUpstream.map(id => nodeLabel(instance, id)).join('、')}</p>
    <p>本輪已到：{round.arrived.length ? round.arrived.map(a => `${nodeLabel(instance, a.fromNodeId)}（${a.handoffId}）`).join('、') : '無'}</p>
    <p>尚未到達：{round.expectedUpstream.filter(id => !round.arrived.some(a => a.fromNodeId === id)).map(id => nodeLabel(instance, id)).join('、') || '無'}</p>
    {round.blockedReason && <p className="command-warning">受阻原因：{reasons[round.blockedReason]}{round.blockedUpstream && ` · ${nodeLabel(instance, round.blockedUpstream)}`}；不視為完成。</p>}
    {round.deadline && <p>等待期限：<time dateTime={round.deadline}>{new Date(round.deadline).toLocaleString('zh-TW')}</time></p>}
  </article>;
}

const mergeLabels: Record<MergeAttempt['state'], string> = { queued: '排隊中', merging: '合併中', resolving: '處理衝突中', testing: '整合測試中', advancing: '更新目標分支中', merged: '已合併', conflict: '合併衝突', 'tests-failed': '整合測試失敗', failed: '合併失敗', cancelled: '已取消' };
export function MergeDetails({ merge }: { merge: MergeAttempt }) {
  return <>
    <p>{mergeLabels[merge.state]} · 第 {merge.attempt + 1} 次嘗試 · 分支變更後重來 {merge.restarts} 次</p>
    {merge.conflictFiles.length > 0 && <><h4>衝突檔案</h4><ul>{merge.conflictFiles.map(path => <li key={path}><code>{path}</code></li>)}</ul></>}
    {merge.test ? <details open={!merge.test.passed}><summary>整合測試：{merge.test.passed ? '通過' : '失敗'} · 結束碼 {merge.test.exitCode ?? '未知'}</summary><code>{merge.test.command}</code><pre>{merge.test.outputTail}</pre></details> : <p>整合測試：尚無結果</p>}
    {merge.integration && <p>整合 Worktree：<code>{merge.integration.path}</code> · {cleanupLabels[merge.integration.cleanup]}</p>}
    {merge.detail && <p className="preserve-text">{merge.detail}</p>}
  </>;
}
export function MergeQueue({ instance, ...controls }: PipelineControlProps & { instance: WorkflowInstance }) {
  return <section aria-label="合併佇列"><h3>合併佇列 · 目標分支 {instance.targetBranch ?? '尚未指定'}</h3>
    <p className="muted">依序處理，一次一個 task；整合測試通過且目標分支更新後才解除依賴。</p>
    {!instance.mergeQueue.length ? <Empty>尚無合併紀錄。</Empty> : <ol className="merge-queue">{instance.mergeQueue.toSorted((a, b) => a.seq - b.seq).map(merge => {
      const task = instance.tasks.find(t => t.id === merge.taskId);
      const latest = !instance.mergeQueue.some(m => m.taskId === merge.taskId && m.attempt > merge.attempt);
      const taskCleanup = latest && task?.worktree?.cleanup === 'pending-cleanup';
      return <li className="detail-card" key={`${merge.taskId}:${merge.attempt}`}><h4>順序 {merge.seq} · {taskLabel(instance, merge.taskId)}</h4><MergeDetails merge={merge} />
        {taskCleanup && <p>Task Worktree：待清理 · <code>{task.worktree?.path}</code></p>}
        {(taskCleanup || merge.integration?.cleanup === 'pending-cleanup') && task && <PipelineActions instance={instance} task={task} {...controls} />}
      </li>;
    })}</ol>}
  </section>;
}
export function TaskPlanDetails({ instance, plan }: { instance: WorkflowInstance; plan: TaskPlan }) {
  return <section aria-label="提出的 task 清單"><h4>拆分 task 清單 · <Status value={plan.state} /></h4><p>規則：{plan.ruleId} · 清單：{plan.id}</p>
    <ol>{plan.items.map(item => <li key={item.key}><strong>{item.title}</strong>（{item.key}）
      <p>清單內依賴：{item.dependsOn.map(key => `${plan.items.find(i => i.key === key)?.title ?? key}（${key}）`).join('、') || '無'}</p>
      <p>既有 task 依賴：{item.dependsOnExisting.map(id => `${taskLabel(instance, id)}（${id}）`).join('、') || '無'}</p>
    </li>)}</ol><p>此決定僅適用這份清單。</p>
  </section>;
}

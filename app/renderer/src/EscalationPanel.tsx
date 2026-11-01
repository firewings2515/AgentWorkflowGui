import { readOnlyProps } from './read-only';
import { useState } from 'react';
import { Command, RequestId } from '../../../contracts';
import type { Escalation, EscalationKind, PermissionRequest, SessionId, Snapshot } from '../../../contracts';
import { commandFeedback } from './command-feedback';
import { ElicitationFields } from './ElicitationFields';
import { MergeDetails, RoundDetails, TaskPlanDetails } from './PipelineDetails';
import { LockWaits } from './LockWaits';
import type { RendererState, RendererStore } from './renderer-store';

const groups: Record<EscalationKind, string> = {
  permission: '權限', confirmation: '確認', 'delivery-unknown': '結果未知', 'limit-exceeded': '超過上限',
  'no-rule-matched': '沒有規則符合', 'setup-failed': '初始化失敗', 'merge-failed': '合併失敗',
  'round-blocked': '匯流受阻', 'lock-timeout': '等待檔案鎖逾時', 'unlocked-write': '未上鎖的寫入',
};

function ReferenceDetails({ escalation, snapshot }: { escalation: Escalation; snapshot: Snapshot }) {
  const ref = escalation.ref;
  if (!ref || ref.kind === 'permission') return null;
  const instance = snapshot.instances.find(i => i.id === escalation.instanceId);
  if (ref.kind === 'taskPlan') {
    const plan = instance?.taskPlans.find(p => p.id === ref.taskPlanId);
    return instance && plan ? <TaskPlanDetails instance={instance} plan={plan} /> : null;
  }
  if (ref.kind === 'round') {
    const round = instance?.rounds.find(r => r.taskId === ref.taskId && r.nodeId === ref.nodeId && r.round === ref.round);
    if (instance && round) return <RoundDetails instance={instance} round={round} />;
  }
  if (ref.kind === 'merge') {
    const merge = instance?.mergeQueue.find(m => m.taskId === ref.taskId && m.attempt === ref.attempt);
    if (merge) return <MergeDetails merge={merge} />;
  }
  if (ref.kind === 'lock') return <><p>檔案：<code>{ref.path}</code> · 當時持有者：{ref.holderSessionId ?? '無記錄'} · 等待／寫入者：{ref.sessionId}</p><LockWaits snapshot={snapshot} sessionId={ref.sessionId} /></>;
  let content: string | undefined;
  switch (ref.kind) {
    case 'message': content = snapshot.messages.find(item => item.id === ref.messageId)?.text; break;
    case 'handoff': content = snapshot.handoffs.find(item => item.id === ref.handoffId)?.payload; break;
    case 'peerMessage': content = snapshot.peerMessages.find(item => item.id === ref.peerMessageId)?.text; break;
    case 'report': content = snapshot.peerMessages.find(item => item.operationId === ref.operationId)?.text; break;
    case 'task': content = snapshot.instances.flatMap(item => item.tasks).find(item => item.id === ref.taskId)?.title; break;
    case 'transfer': case 'provision': break;
  }
  return <details><summary>關聯內容與識別碼 · {ref.kind}</summary>{content && <p className="preserve-text">{content}</p>}<pre>{JSON.stringify(ref, null, 2)}</pre></details>;
}

function EscalationCard({ escalation, permission, snapshot, store, ipcState }: {
  escalation: Escalation; permission: PermissionRequest | undefined; snapshot: Snapshot;
  store: RendererStore | undefined; ipcState: RendererState | undefined;
}) {
  const [note, setNote] = useState('');
  const [content, setContent] = useState('{}');
  const [risk, setRisk] = useState(false);
  const [validation, setValidation] = useState('');
  const target = `escalation:${escalation.id}`;
  const delivery = escalation.kind === 'delivery-unknown';
  const type = delivery ? 'delivery.resolve' : 'escalation.respond';
  const activity = Object.values(ipcState?.commands ?? {}).filter(item => 'escalationId' in item.command && item.command.escalationId === escalation.id).at(-1);
  const accepted = !!activity?.result?.ok && !(activity.command.type === 'delivery.resolve' && activity.command.decision === 'wait');
  const permissionUnavailable = escalation.kind === 'permission' && (!permission || !['pending', 'held'].includes(permission.state));
  const taskPlanId = escalation.ref?.kind === 'taskPlan' ? escalation.ref.taskPlanId : undefined;
  const plan = snapshot.instances.find(i => i.id === escalation.instanceId)?.taskPlans.find(p => p.id === taskPlanId);
  const planUnavailable = taskPlanId === undefined ? undefined
    : !plan ? 'Task 清單尚未齊全，無法回覆。請重新讀取資料。'
    : plan.state === 'declined' ? '此 task 清單已拒絕，不再等待確認，無法再次回覆。'
    : plan.state === 'created' ? '此 task 清單已建立 task，不再等待確認，無法再次回覆。'
    : plan.escalationId !== escalation.id ? '此 task 清單的確認項目已變更，與目前項目不符，無法回覆。請重新讀取資料。'
    : undefined;
  const disabled = !store || ipcState?.connection !== 'ready' || snapshot.app.status !== 'ready' || permissionUnavailable
    || !!planUnavailable || store.isBlocked(type, target) || accepted;
  const respond = (decision: 'approve' | 'decline') => {
    if (disabled) return;
    let answer: unknown;
    if (decision === 'approve' && permission?.elicitation?.mode === 'form') {
      try { answer = JSON.parse(content); } catch { setValidation('表單內容必須是有效的 JSON。'); return; }
    }
    const command = Command.safeParse({ type: 'escalation.respond', requestId: crypto.randomUUID(), escalationId: escalation.id, decision,
      ...(note.trim() ? { note } : {}), ...(answer !== undefined ? { content: answer } : {}),
    });
    if (!command.success) { setValidation('回覆內容不符合契約，請檢查表單。'); return; }
    setValidation('');
    void store.send(command.data);
  };
  const resolve = (decision: 'wait' | 'cancel' | 'retry') => {
    if (disabled || (decision === 'retry' && !risk)) return;
    void store.send({ type: 'delivery.resolve', requestId: RequestId.parse(crypto.randomUUID()), escalationId: escalation.id, decision, acceptDuplicateRisk: decision === 'retry' && risk });
  };
  return <article className="escalation-card" aria-label={escalation.title}>
    <h4>{escalation.title}</h4>
    <p className="muted">來源：{snapshot.sessions.find(session => session.id === escalation.fromSessionId)?.title ?? escalation.fromSessionId} · {escalation.fromSessionId}</p>
    <p className="preserve-text">{escalation.detail}</p>
    {(escalation.rule || permission?.matchedRule) && <p>升級原因：<code>{escalation.rule ?? permission?.matchedRule}</code></p>}
    {permission && <div className="permission-evidence">
      <p>{permission.summary}</p>
      <dl>{permission.tool && <><dt>工具</dt><dd>{permission.tool}</dd></>}{permission.server && <><dt>MCP server</dt><dd>{permission.server}</dd></>}
        {permission.shell && <><dt>Shell</dt><dd>{permission.shell}</dd></>}{permission.cwd && <><dt>工作資料夾</dt><dd>{permission.cwd}</dd></>}
        {permission.paths.length > 0 && <><dt>涉及路徑</dt><dd>{permission.paths.join('\n')}</dd></>}
      </dl>
      {permission.command && <pre>{permission.command}</pre>}
      {permission.elicitation?.mode === 'url' && <><p>{permission.elicitation.message}</p><p>請先自行確認此網址的內容，再決定是否核准：</p><code>{permission.elicitation.url}</code></>}
    </div>}
    <ReferenceDetails escalation={escalation} snapshot={snapshot} />
    {planUnavailable && <p role="status" className="command-warning">{planUnavailable}</p>}
    {permissionUnavailable && <p role="status" className="command-warning">權限請求已撤回、已處理或資料尚未齊全，無法回覆。請重新讀取資料。</p>}
    <form onSubmit={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Enter' && (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) event.preventDefault();
    }}>
      <fieldset {...readOnlyProps(snapshot.app.status === 'read-only')} disabled={disabled}>
        <legend className="sr-only">回覆 {escalation.title}</legend>
        {delivery ? <>
          <p className="command-warning">尚無可靠的送達結果。取消後也不代表已執行的工作能撤回。</p>
          <label className="check-label"><input type="checkbox" checked={risk} onChange={event => setRisk(event.target.checked)} />我了解重試可能重複送達</label>
          <div className="escalation-actions"><button {...readOnlyProps(snapshot.app.status === 'read-only')} type="button" onClick={() => resolve('wait')}>繼續等待</button><button {...readOnlyProps(snapshot.app.status === 'read-only')} type="button" onClick={() => resolve('cancel')}>取消送達</button><button {...readOnlyProps(snapshot.app.status === 'read-only')} type="button" disabled={!risk} onClick={() => resolve('retry')}>重試送達</button></div>
        </> : <>
          {permission?.elicitation?.mode === 'form' && <ElicitationFields elicitation={permission.elicitation} value={content} onChange={setContent} />}
          <label>回覆說明（選填）<textarea rows={2} value={note} onChange={event => setNote(event.target.value)} /></label>
          <div className="escalation-actions"><button {...readOnlyProps(snapshot.app.status === 'read-only')} type="button" className="primary" onClick={event => { if (event.currentTarget.form?.reportValidity()) respond('approve'); }}>核准</button><button {...readOnlyProps(snapshot.app.status === 'read-only')} type="button" onClick={() => respond('decline')}>拒絕</button></div>
        </>}
      </fieldset>
    </form>
    {validation && <p role="alert" className="field-error">{validation}</p>}
    {activity && <p role={activity.result && !activity.result.ok ? 'alert' : 'status'}>{!activity.result ? '正在送出決定…' : activity.result.ok ? accepted ? '決定已接受，等待最新狀態。' : '已選擇繼續等待，仍可另行決定取消或重試。' : `${commandFeedback(activity.result)}（${activity.result.code}）`}</p>}
  </article>;
}

export function openEscalations(snapshot: Snapshot, sessionId: SessionId) {
  const session = snapshot.sessions.find(item => item.id === sessionId);
  return snapshot.escalations.filter(item => item.state === 'open' && (item.rootSessionId === sessionId || (session?.kind === 'ordinary' && item.fromSessionId === sessionId)));
}

export function EscalationPanel({ snapshot, sessionId, store, ipcState }: {
  snapshot: Snapshot; sessionId: SessionId; store: RendererStore | undefined; ipcState: RendererState | undefined;
}) {
  const session = snapshot.sessions.find(item => item.id === sessionId);
  const escalations = openEscalations(snapshot, sessionId);
  if (escalations.length === 0) return null;
  return <section className="escalation-panel" aria-label="升級待處理項目">
    <h3>待你處理（{escalations.length}）</h3><p className="approval-authority">{session?.kind === 'ordinary' ? '由你決定，不是 agent' : '由你決定，不是 root 的 AI'}</p>
    {!store && <p className="muted">示意資料，未送出任何核准。</p>}
    {(Object.entries(groups) as [EscalationKind, string][]).map(([kind, label]) => {
      const items = escalations.filter(item => item.kind === kind);
      return items.length > 0 && <section key={kind} aria-label={label}><h3>{label}（{items.length}）</h3>{items.map(escalation => {
        const ref = escalation.ref;
        const permission = ref?.kind === 'permission' ? snapshot.permissionRequests.find(item => item.id === ref.permissionRequestId && item.sessionId === escalation.fromSessionId) : undefined;
        return <EscalationCard key={escalation.id} escalation={escalation} permission={permission} snapshot={snapshot} store={store} ipcState={ipcState} />;
      })}</section>;
    })}
  </section>;
}

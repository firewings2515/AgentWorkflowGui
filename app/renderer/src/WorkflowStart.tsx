import { readOnlyProps } from './read-only';
import { useState } from 'react';
import { InstanceId, RequestId, SessionId } from '../../../contracts';
import type { CommandResult, Snapshot, WorkflowTemplate } from '../../../contracts';
import { commandFeedback } from './command-feedback';
import { FolderButton } from './FolderButton';
import type { RendererState, RendererStore } from './renderer-store';

export function WorkflowStart({ snapshot, store, ipcState, onOpen }: {
  snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined;
  onOpen: (id: SessionId) => void;
}) {
  const [template, setTemplate] = useState<WorkflowTemplate | undefined>(() => snapshot.workflows[0]);
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<{ result: CommandResult; requestId: RequestId; rootSessionId: SessionId; instanceId: InstanceId }>();
  const unresolved = Object.values(ipcState?.blockedCommands ?? {}).find(item => item.command.type === 'workflow.start');
  const attempt = receipt ?? (unresolved?.command.type === 'workflow.start' ? unresolved.command : undefined);
  const result = receipt ? ipcState?.commands[receipt.requestId]?.result ?? receipt.result : unresolved?.result;
  const confirmed = !!attempt && snapshot.instances.some(instance => instance.id === attempt.instanceId);
  const stale = !!template && !snapshot.workflows.some(item => item.id === template.id && item.revision === template.revision);
  const crossTool = new Set(template?.nodes.flatMap(node => node.kind === 'agent' ? [node.model.runtime] : [])).size > 1;
  const blocked = Object.values(ipcState?.blockedCommands ?? {}).some(item => item.command.type === 'workflow.start');
  const disabled = !store || ipcState?.connection !== 'ready' || snapshot.app.status !== 'ready' || pending || blocked || !!result?.ok || confirmed;
  const select = (next: WorkflowTemplate | undefined) => { setTemplate(next); setConsent(false); setReceipt(undefined); };
  return <section className="workflow-start" aria-label="啟動 Workflow">
    <p>從已儲存的範本開始。啟動時會固定範本版本與此執行群組的跨工具同意範圍。</p>
    {!store && <p className="command-warning">示意模式：連接應用程式服務後才能啟動。</p>}
    {snapshot.workflows.length === 0 && <p>尚無 Workflow 範本，請先在編輯器儲存範本。</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (disabled || stale || !template || !title.trim() || !cwd.trim() || !firstMessage.trim() || (crossTool && !consent)) return;
      const instanceId = InstanceId.parse(crypto.randomUUID());
      const rootSessionId = SessionId.parse(crypto.randomUUID());
      const requestId = RequestId.parse(crypto.randomUUID());
      setPending(true);
      void store.send({ type: 'workflow.start', requestId, instanceId, rootSessionId,
        workflowId: template.id, workflowRevision: template.revision, title, cwd, firstMessage, crossToolConsent: consent,
      }).then(result => { setReceipt({ result, requestId, instanceId, rootSessionId }); setPending(false); });
    }}>
      <fieldset {...readOnlyProps(snapshot.app.status === 'read-only')} disabled={disabled}>
        <legend>啟動設定</legend>
        <label>Workflow 範本<select value={template?.id ?? ''} onChange={event => select(snapshot.workflows.find(item => item.id === event.target.value))}>
          {!template && <option value="">選擇範本</option>}
          {template && !snapshot.workflows.some(item => item.id === template.id) && <option value={template.id}>範本已移除</option>}
          {snapshot.workflows.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}
        </select></label>
        {template && <>
          <p>已審閱版本：{template.name} · v{template.revision} · 返工上限 {template.reworkLimit}</p>
          <p className="muted">{template.isolation === 'same-folder' ? '同資料夾模式' : 'Worktree 模式'} · {template.description}</p>
          <div className="node-tools" role="region" aria-label="各 node 使用的工具" tabIndex={0}><table><thead><tr><th>Node</th><th>工具</th><th>Model</th></tr></thead><tbody>
            {template.nodes.map(node => <tr key={node.id}><td>{node.label}{node.kind === 'agent' && node.isRoot ? '（root）' : ''}</td><td>{node.kind === 'agent' ? node.model.runtime : 'GUI 合併節點'}</td><td>{node.kind === 'agent' ? node.model.model : '—'}</td></tr>)}
          </tbody></table></div>
        </>}
        {stale && <div role="alert" className="command-warning">範本版本已變更或移除，請重新審閱後再啟動。<button type="button" onClick={() => select(snapshot.workflows.find(item => item.id === template?.id))}>載入目前範本</button></div>}
        <label>標題<input required value={title} onChange={event => setTitle(event.target.value)} /></label>
        <label>工作資料夾<input required value={cwd} onChange={event => setCwd(event.target.value)} placeholder="輸入完整資料夾路徑" /></label>
        <FolderButton disabled={disabled} onPick={setCwd} />
        <label>第一則訊息<textarea required rows={4} value={firstMessage} onChange={event => setFirstMessage(event.target.value)} /></label>
        {crossTool && <label className="check-label"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我同意此版本、此執行群組內的跨工具交接（handoff、send_message、report_to_root）。</label>}
        <p className="muted">手動更換工具或傳給群組外的 session，仍需另行確認。</p>
        <button {...readOnlyProps(snapshot.app.status === 'read-only')} className="primary" type="submit" disabled={!template || stale || !title.trim() || !cwd.trim() || !firstMessage.trim() || (crossTool && !consent)}>啟動 Workflow</button>
      </fieldset>
    </form>
    {pending && <p role="status">正在啟動…</p>}
    {blocked && !pending && !confirmed && <div className="command-warning">
      <p>啟動結果待核對，最新資料尚未出現本次執行群組。可在此重新讀取資料，畫面會依執行群組 ID 自動核對；請勿重複啟動。</p>
      {attempt && <p>待核對的執行群組：{attempt.instanceId}</p>}
      <button disabled={!store || ipcState?.connection === 'loading'} onClick={() => void store?.reconnect()}>重新讀取資料並核對</button>
      {ipcState?.connection === 'loading' && <p role="status">正在重新讀取資料…</p>}
      {ipcState?.connection === 'error' && <p role="alert">資料同步失敗，請重新讀取資料並核對。</p>}
    </div>}
    {attempt && (result || confirmed) && <div role={result?.ok || confirmed ? 'status' : 'alert'}>
      {result?.ok || confirmed ? <><p>{confirmed ? '已核對：執行群組已啟動。' : '啟動指令已接受。'}執行群組：{attempt.instanceId}</p><button disabled={!snapshot.sessions.some(session => session.id === attempt.rootSessionId)} onClick={() => onOpen(attempt.rootSessionId)}>開啟 root session</button></> : result && <p className="command-warning">{commandFeedback(result)}（{result.code}）</p>}
    </div>}
  </section>;
}

import { readOnlyProps } from './read-only';
import { useState } from 'react';
import { InstanceId, RequestId, SessionId } from '../../../contracts';
import type { CommandResult, Snapshot, WorkflowTemplate } from '../../../contracts';
import { commandFeedback } from './command-feedback';
import { FolderButton } from './FolderButton';
import type { RendererState, RendererStore } from './renderer-store';
import { Field } from './shell-v4/Pages';
import { recentFolders, workFolderRoot } from './shell-v4/folders';

/**
 * Start a run from a saved template with the two folders of Q-4／Q-8 (T048): the work folder for reports and plans
 * (empty: a new dated folder in the default location) and the project folder, the repository task worktrees come from
 * (required with worktree isolation; optional in a same-folder run, where non-root nodes then work in it).
 */
export function WorkflowStart({ snapshot, store, ipcState, onOpen }: {
  snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined;
  onOpen: (id: SessionId) => void;
}) {
  const [template, setTemplate] = useState<WorkflowTemplate | undefined>(() => snapshot.workflows[0]);
  const [title, setTitle] = useState('');
  const [work, setWork] = useState('');
  const [project, setProject] = useState('');
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
  const worktree = template?.isolation === 'worktree';
  const blocked = Object.values(ipcState?.blockedCommands ?? {}).some(item => item.command.type === 'workflow.start');
  const readOnly = snapshot.app.status === 'read-only';
  const disabled = !store || ipcState?.connection !== 'ready' || snapshot.app.status !== 'ready' || pending || blocked || !!result?.ok || confirmed;
  const ready = !!template && !stale && !!title.trim() && !!firstMessage.trim() && (!worktree || !!project.trim()) && (!crossTool || consent);
  const select = (next: WorkflowTemplate | undefined) => { setTemplate(next); setConsent(false); setReceipt(undefined); };
  const recent = recentFolders(snapshot);
  return <section className="v4-page" aria-labelledby="v4-start-heading">
    <form className="v4-page-column" onSubmit={event => {
      event.preventDefault();
      if (disabled || !ready || !template) return;
      const instanceId = InstanceId.parse(crypto.randomUUID());
      const rootSessionId = SessionId.parse(crypto.randomUUID());
      const requestId = RequestId.parse(crypto.randomUUID());
      setPending(true);
      void store.send({ type: 'workflow.start', requestId, instanceId, rootSessionId, workflowId: template.id, workflowRevision: template.revision, title: title.trim(),
        ...(work.trim() ? { workFolder: work.trim() } : {}), ...(project.trim() ? { projectFolder: project.trim() } : {}), firstMessage, crossToolConsent: consent,
      }).then(outcome => { setReceipt({ result: outcome, requestId, instanceId, rootSessionId }); setPending(false); });
    }}>
      <h1 id="v4-start-heading" tabIndex={-1}>開始 Workflow</h1>
      {!store && <p className="command-warning">示意模式：連接應用程式服務後才能開始。</p>}
      {snapshot.workflows.length === 0 && <p>尚無 Workflow 範本，請先到「模板」儲存範本。</p>}
      <fieldset className="v4-fieldset" {...readOnlyProps(readOnly)} disabled={disabled}>
        <legend className="sr-only">開始設定</legend>
        <section className="v4-card" aria-label="範本">
          <Field label="Workflow 範本"><select aria-label="Workflow 範本" value={template?.id ?? ''} onChange={event => select(snapshot.workflows.find(item => item.id === event.target.value))}>
            {!template && <option value="">選擇範本</option>}
            {template && !snapshot.workflows.some(item => item.id === template.id) && <option value={template.id}>範本已移除</option>}
            {snapshot.workflows.map(item => <option key={item.id} value={item.id}>{item.name} · v{item.revision}</option>)}
          </select></Field>
          {template && <>
            <p className="v4-muted">已審閱版本：{template.name} · v{template.revision} · 返工上限 {template.reworkLimit} · {template.isolation === 'same-folder' ? '同資料夾模式：所有 node 在工作資料夾裡做。' : 'Worktree 模式：每個 task 從專案資料夾開自己的 worktree，合併回專案資料夾。'} {template.description}</p>
            <div className="node-tools" role="region" aria-label="各 node 使用的工具" tabIndex={0}><table><thead><tr><th>Node</th><th>工具</th><th>Model</th></tr></thead><tbody>
              {template.nodes.map(node => <tr key={node.id}><td>{node.label}{node.kind === 'agent' && node.isRoot ? '（root）' : ''}</td><td>{node.kind === 'agent' ? node.model.runtime : 'GUI 合併節點'}</td><td>{node.kind === 'agent' ? node.model.model : '—'}</td></tr>)}
            </tbody></table></div>
          </>}
          {stale && <div role="alert" className="command-warning">範本版本已變更或移除，請重新審閱後再開始。<button type="button" onClick={() => select(snapshot.workflows.find(item => item.id === template?.id))}>載入目前範本</button></div>}
          <Field label="標題"><input aria-label="標題" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：登入功能" /></Field>
        </section>
        <section className="v4-card" aria-label="資料夾">
          <h2>資料夾</h2>
          <div className="v4-two-col">
            <Field label="工作資料夾（可不選）" hint={<>放報告、計畫、紀錄。沒選就在 <code>{workFolderRoot(snapshot)}</code> 自動建立。</>}>
              <div className="v4-inline-field"><input aria-label="工作資料夾" value={work} onChange={event => setWork(event.target.value)} placeholder="自動建立" list="v4-recent-folders" />
                <FolderButton label="選擇…" disabled={disabled} onPick={setWork} /></div>
            </Field>
            <Field label={worktree ? '專案資料夾（必選）' : '專案資料夾（可不選）'} hint={worktree ? '程式碼所在的 git repo；task 的 worktree 從這裡開，合併也回到這裡。' : '同資料夾模式：選了，其他 node 就在這個資料夾裡做；不選就在工作資料夾裡做。'}>
              <div className="v4-inline-field"><input aria-label="專案資料夾" aria-required={worktree} value={project} onChange={event => setProject(event.target.value)} placeholder={worktree ? '選擇 git repo' : '不使用'} list="v4-recent-folders" />
                <FolderButton label="選擇…" disabled={disabled} onPick={setProject} /></div>
            </Field>
          </div>
          <datalist id="v4-recent-folders">{recent.map(path => <option key={path} value={path} />)}</datalist>
        </section>
        <section className="v4-card" aria-label="開始">
          <Field label="第一則訊息（給 root）"><textarea aria-label="第一則訊息" rows={4} value={firstMessage} onChange={event => setFirstMessage(event.target.value)} placeholder="說明要做什麼、驗收條件…" /></Field>
          {crossTool && <label className="v4-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我同意此版本、此執行群組內的跨工具交接（handoff、send_message、report_to_root）。</label>}
          <p className="v4-muted">手動更換工具或傳給群組外的 session，仍需另行確認。</p>
          <div className="v4-card-actions"><span className="v4-muted">{worktree && !project.trim() ? '還沒選專案資料夾' : ''}</span>
            <button {...readOnlyProps(readOnly)} className="primary" type="submit" disabled={!ready}>開始</button></div>
        </section>
      </fieldset>
      {pending && <p role="status">正在開始…</p>}
      {blocked && !pending && !confirmed && <div className="command-warning">
        <p>開始結果待核對，最新資料尚未出現本次執行群組。可在此重新讀取資料，畫面會依執行群組 ID 自動核對；請勿重複開始。</p>
        {attempt && <p>待核對的執行群組：{attempt.instanceId}</p>}
        <button type="button" disabled={!store || ipcState?.connection === 'loading'} onClick={() => void store?.reconnect()}>重新讀取資料並核對</button>
        {ipcState?.connection === 'loading' && <p role="status">正在重新讀取資料…</p>}
        {ipcState?.connection === 'error' && <p role="alert">資料同步失敗，請重新讀取資料並核對。</p>}
      </div>}
      {attempt && (result || confirmed) && <div role={result?.ok || confirmed ? 'status' : 'alert'}>
        {result?.ok || confirmed ? <><p>{confirmed ? '已核對：執行群組已開始。' : '開始指令已接受。'}執行群組：{attempt.instanceId}</p><button type="button" disabled={!snapshot.sessions.some(session => session.id === attempt.rootSessionId)} onClick={() => onOpen(attempt.rootSessionId)}>開啟 root session</button></> : result && <p className="command-warning">{commandFeedback(result)}（{result.code}）</p>}
      </div>}
    </form>
  </section>;
}

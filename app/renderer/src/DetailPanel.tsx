import type { LogicalSession, NativeTask, SessionId, Snapshot, WorkflowInstance } from '../../../contracts';
import { detailPanels } from './workbench-state';
import type { DetailTab } from './workbench-state';
import { Empty, formatTime, observedModelText, Status } from './ui';
import { RequestId } from '../../../contracts';
import type { RendererStore } from './renderer-store';

interface DetailProps {
  snapshot: Snapshot;
  session: LogicalSession;
  viewId: string;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onOpen: (id: SessionId) => void;
  onNotice: (text: string) => void;
  store?: RendererStore | undefined;
}

export function WorkflowSummary({ snapshot, instance }: { snapshot: Snapshot; instance: WorkflowInstance }) {
  const template = snapshot.workflows.find(workflow => workflow.id === instance.workflowId && workflow.revision === instance.workflowRevision);
  return <section aria-label="Workflow 群組摘要">
    <h3>{instance.title}</h3><Status value={instance.state} />
    <p className="muted">範本 revision {instance.workflowRevision} · 各 task 目前節點</p>
    {instance.tasks.map(task => <article className="detail-card" key={task.id}>
      <strong>{task.title}</strong><Status value={task.status} />
      <p>{task.currentNodeId ? (template?.nodes.find(node => node.id === task.currentNodeId)?.label ?? task.currentNodeId) : '尚未進入節點'}</p>
      {task.dependsOn.length > 0 && <p className="muted">依賴：{task.dependsOn.map(id => instance.tasks.find(other => other.id === id)?.title ?? id).join('、')}</p>}
      <small>返工 {task.reworkCount} 次</small>
    </article>)}
    <h4>交接紀錄</h4>
    {snapshot.handoffs.filter(handoff => handoff.instanceId === instance.id).map(handoff => <article className="detail-card" key={handoff.id}>
      <p>{template?.nodes.find(node => node.id === handoff.fromNodeId)?.label ?? handoff.fromNodeId} → {handoff.toNodeId ? (template?.nodes.find(node => node.id === handoff.toNodeId)?.label ?? handoff.toNodeId) : 'root'}</p>
      <p>{handoff.payload}</p><Status value={handoff.delivery.state} />
      {handoff.outcome && <p>操作結果：<Status value={handoff.outcome.kind} /> {handoff.outcome.detail}</p>}
    </article>)}
  </section>;
}

function NativeTasks({ snapshot, session, onNotice, store }: Pick<DetailProps, 'snapshot' | 'session' | 'onNotice' | 'store'>) {
  const tasks = snapshot.nativeTasks.filter(task => task.sessionId === session.id);
  const renderTask = (task: NativeTask) => {
    const children = tasks.filter(child => child.parentTaskId === task.id);
    return <li key={`${task.runtime}:${task.sessionId}:${task.id}`}>
      <article className="detail-card">
        <strong>{task.label}</strong><Status value={task.state} />
        <p className="muted">{task.runtime} · {task.agentType ?? '子 agent'}{task.background ? ' · 背景工作' : ''}</p>
        <p>父項：{task.parentTaskId ? (tasks.find(parent => parent.id === task.parentTaskId)?.label ?? `未知（${task.parentTaskId}）`) : session.title}</p>
        <p>最新活動：{task.lastActivity ?? '未回報'}</p>
        <p>結果：{task.summary ?? '尚未回報'}</p>
        <details><summary>查看觀察紀錄</summary>
          <p className="mono">parentRef: {task.parentRef}<br />nativeRef: {task.nativeRef}</p>
          {snapshot.messages.filter(message => message.sessionId === session.id && message.nativeTaskId === task.id).map(message => <p key={message.id}>{message.text}</p>)}
          {snapshot.items.filter(item => item.sessionId === session.id && item.nativeTaskId === task.id).map(item => <p key={item.id}>{item.kind === 'command' ? item.command : item.kind === 'toolCall' ? `${item.tool} · ${item.summary}` : item.changes.map(change => change.path).join('、')} · {item.state}</p>)}
        </details>
        {task.state === 'running' && <button className="danger-button" disabled={store?.isBlocked('nativeTask.stop', `nativeTask:${JSON.stringify([session.id, task.id])}`)} onClick={() => {
          if (store) void store.send({ type: 'nativeTask.stop', requestId: RequestId.parse(crypto.randomUUID()), sessionId: session.id, nativeTaskId: task.id });
          else onNotice(`示意操作：停止「${task.label}」（${session.title}）。尚未連接 runtime，未送出停止指令。`);
        }}>停止這個子 agent</button>}
      </article>
      {children.length > 0 && <ul>{children.map(renderTask)}</ul>}
    </li>;
  };
  return <section aria-label="原生子 agent 樹"><h3>原生子 agent</h3><p className="muted">父 session：{session.title}</p>
    {tasks.length ? <ul className="native-tree">{tasks.filter(task => !task.parentTaskId || !tasks.some(parent => parent.id === task.parentTaskId)).map(renderTask)}</ul> : <Empty>尚無可觀察到的原生子任務。</Empty>}
  </section>;
}

function Files({ snapshot, session }: Pick<DetailProps, 'snapshot' | 'session'>) {
  const artifacts = snapshot.artifacts.filter(artifact => artifact.sessionId === session.id);
  return <>{(['input', 'output'] as const).map(section => <section key={section}>
    <h3>{section === 'input' ? '輸入附件' : '已發布成果'}</h3>
    {artifacts.filter(artifact => artifact.section === section).map(artifact => <article className="detail-card" key={artifact.id}>
      <div className="card-title"><span className="file-symbol" aria-hidden="true">{artifact.kind === 'folder' ? '▤' : '▧'}</span><strong>{artifact.name}</strong></div>
      <p className="mono">{artifact.path}</p><Status value={artifact.access} />
      <dl className="compact-info">
        <dt>來源</dt><dd>{artifact.source === 'user-attachment' ? '使用者附件' : artifact.source === 'agent' ? 'Agent' : 'GUI'}</dd>
        <dt>類型</dt><dd>{artifact.mimeType ?? artifact.kind}</dd>
        <dt>大小</dt><dd>{artifact.sizeBytes === undefined ? '未提供' : `${artifact.sizeBytes.toLocaleString('zh-TW')} bytes`}</dd>
        <dt>Revision</dt><dd>{artifact.revision}</dd>
      </dl>
    </article>)}
    {!artifacts.some(artifact => artifact.section === section) && <Empty>{section === 'input' ? '此 session 尚無輸入附件。' : '此 session 尚無已發布成果。'}</Empty>}
  </section>)}</>;
}

function SessionInfo({ snapshot, session }: Pick<DetailProps, 'snapshot' | 'session'>) {
  const agent = snapshot.agents.find(candidate => candidate.id === session.agent.id && candidate.revision === session.agent.revision);
  return <section><h3>Session 資訊</h3><dl className="session-info">
    <dt>GUI session</dt><dd className="mono">{session.id}</dd>
    <dt>Agent</dt><dd>{agent?.name ?? session.agent.id} · revision {session.agent.revision}</dd>
    <dt>要求的 Model</dt><dd>{session.requestedModel.model} · {session.requestedModel.effort ?? '未指定 effort'}</dd>
    <dt>模型觀察</dt><dd>{observedModelText(session)}</dd>
    <dt>Runtime</dt><dd>{session.requestedModel.runtime}</dd>
    <dt>工作資料夾</dt><dd className="mono">{session.cwd}</dd>
    <dt>有效資料夾範圍</dt><dd>
      <dl className="folder-scope">
        <dt>範圍來源</dt><dd>{session.folderScope.source === 'task-worktree' ? 'Task worktree' : 'Session 工作資料夾'}</dd>
        <dt>工作區根目錄</dt><dd className="mono">{session.folderScope.workspaceRoot}</dd>
        <dt>可寫入目錄</dt><dd>{session.folderScope.writableRoots.length ? <ul>{session.folderScope.writableRoots.map(path => <li className="mono" key={path}>{path}</li>)}</ul> : '無可寫入目錄'}</dd>
        <dt>額外可讀取目錄</dt><dd>{session.folderScope.readableRoots.length ? <ul>{session.folderScope.readableRoots.map(path => <li className="mono" key={path}>{path}</li>)}</ul> : '無額外可讀取目錄'}</dd>
      </dl><p className="muted">附件不會擴大寫入或執行權限。</p>
    </dd>
    <dt>活動狀態</dt><dd><Status value={session.activity} /></dd>
    <dt>狀態來源</dt><dd>示意快照 · seq {snapshot.seq}<br />Session 更新於 <time dateTime={session.updatedAt}>{formatTime(session.updatedAt)}</time></dd>
    {session.derivedFromSessionId && <><dt>轉交來源</dt><dd>{snapshot.sessions.find(source => source.id === session.derivedFromSessionId)?.title ?? session.derivedFromSessionId}</dd></>}
    <dt>Token 用量</dt><dd>{session.tokenUsage ? <>
      {session.tokenUsage.latest && <div>最近回報：{session.tokenUsage.latest.total.toLocaleString('zh-TW')}</div>}
      {session.tokenUsage.cumulative && <div>累計：{session.tokenUsage.cumulative.total.toLocaleString('zh-TW')}</div>}
      {session.tokenUsage.contextWindow && <div>Context window：{session.tokenUsage.contextWindow.toLocaleString('zh-TW')}</div>}
      <small>回報時間 {formatTime(session.tokenUsage.at)}</small>
    </> : '尚無用量回報'}</dd>
  </dl></section>;
}

export function DetailPanel(props: DetailProps) {
  const { snapshot, session, tab, viewId, onTab, onOpen } = props;
  const instance = session.kind === 'workflow' ? snapshot.instances.find(item => item.id === session.workflow.instanceId) : undefined;
  const peers = snapshot.peerMessages.filter(message => message.fromSessionId === session.id || message.toSessionId === session.id);
  return <aside className="detail-panel" aria-label={`${session.title} 細節`}>
    <div className="detail-tabs" role="tablist" aria-label="細節分頁" onKeyDown={event => {
      const index = detailPanels.findIndex(panel => panel.id === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % detailPanels.length : event.key === 'ArrowLeft' ? (index - 1 + detailPanels.length) % detailPanels.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailPanels.length - 1 : -1;
      const panel = detailPanels[next];
      if (panel) { event.preventDefault(); onTab(panel.id); document.getElementById(`${viewId}-tab-${panel.id}`)?.focus(); }
    }}>{detailPanels.map(panel => <button key={panel.id} id={`${viewId}-tab-${panel.id}`} role="tab" aria-selected={panel.id === tab} aria-controls={`${viewId}-detail-content`} tabIndex={panel.id === tab ? 0 : -1} onClick={() => onTab(panel.id)}>{panel.label}</button>)}</div>
    <div className="detail-content" role="tabpanel" id={`${viewId}-detail-content`} aria-labelledby={`${viewId}-tab-${tab}`} tabIndex={0}>
      {tab === 'files' && <Files {...props} />}
      {tab === 'tasks' && <>
        {session.kind === 'workflow' && (instance ? <WorkflowSummary snapshot={snapshot} instance={instance} /> : <Empty>找不到此 session 的 Workflow 執行群組。</Empty>)}
        <NativeTasks {...props} />
      </>}
      {tab === 'messages' && <section><h3>跨 session 訊息</h3>
        {peers.length === 0 && <Empty>此 session 尚無跨 session 訊息。</Empty>}
        {peers.map(message => <article className="detail-card" key={message.id}>
          <div className="peer-route"><button onClick={() => onOpen(message.fromSessionId)}>{snapshot.sessions.find(source => source.id === message.fromSessionId)?.title ?? message.fromSessionId}</button><span>→</span><button onClick={() => onOpen(message.toSessionId)}>{snapshot.sessions.find(target => target.id === message.toSessionId)?.title ?? message.toSessionId}</button></div>
          <p>{message.text}</p><Status value={message.delivery.state} /><p className="muted"><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></p>
          {message.outcome && <p>操作結果：<Status value={message.outcome.kind} /> {message.outcome.detail}</p>}
        </article>)}
      </section>}
      {tab === 'info' && <SessionInfo {...props} />}
    </div>
  </aside>;
}

import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { AgentDefinition, AgentId, LogicalSession, ModelOption, ModelSelection, SessionId, Snapshot } from '../../../contracts';
import type { SessionViewContext, WorkspaceView } from './workbench-state';
import { contextFor } from './workbench-state';
import { DetailPanel } from './DetailPanel';
import { Empty, formatTime, Menu, observedModelText, Status } from './ui';
import { MessageId, RequestId } from '../../../contracts';
import { commandFeedback } from './command-feedback';
import type { RendererStore, RendererState } from './renderer-store';
import { sessionBlocksSend, sessionCanInterrupt } from './renderer-store';
import { EscalationPanel, openEscalations } from './EscalationPanel';

export interface Selection { agentId: AgentId; model: ModelSelection }
export interface WorkspaceProps {
  snapshot: Snapshot;
  store?: RendererStore | undefined;
  ipcState?: RendererState | undefined;
  agentOptions: readonly AgentDefinition[];
  view: WorkspaceView;
  active: boolean;
  visible: boolean;
  selection: Selection | undefined;
  onFocus: () => void;
  onClose: () => void;
  onContext: (patch: Partial<SessionViewContext>) => void;
  onOpen: (id: SessionId) => void;
  onAgent: (id: AgentId) => void;
  onModel: (model: ModelOption) => void;
  onTransfer: () => void;
  onProgress: (instanceId: string) => void;
  onNotice: (message: string) => void;
}

function Transcript({ snapshot, session, view, visible, onContext, store, ipcState, pendingPanel }: Pick<WorkspaceProps, 'snapshot' | 'view' | 'visible' | 'onContext' | 'store' | 'ipcState'> & { session: LogicalSession; pendingPanel: RefObject<HTMLDetailsElement | null> }) {
  const scroll = useRef<HTMLDivElement>(null);
  const context = contextFor(view);
  // display:none can reset DOM scrollTop; restore when the page/pane reappears.
  useLayoutEffect(() => {
    if (visible && scroll.current) scroll.current.scrollTop = context.scrollTop;
  }, [session.id, context.scrollTop, visible]);
  const messages = snapshot.messages.filter(message => message.sessionId === session.id && !message.nativeTaskId);
  return <div className="transcript" ref={scroll} aria-label={`${session.title} 對話`} onScroll={event => {
    if (visible) onContext({ scrollTop: event.currentTarget.scrollTop });
  }}>
    <div className="transcript-heading"><span>對話紀錄</span><span>{store ? '目前快照' : '示意快照'}</span></div>
    {openEscalations(snapshot, session.id).length > 0 && <details className="pending-panel" id={`${view.id}-pending`} ref={pendingPanel} key={session.id}>
      <summary>展開／收合待處理項目</summary>
      <div className="pending-panel-scroll"><EscalationPanel snapshot={snapshot} sessionId={session.id} store={store} ipcState={ipcState} /></div>
    </details>}
    {messages.length === 0 && <Empty>這個 session 尚無主對話訊息。</Empty>}
    {messages.map(message => <article className={`message message-${message.role} origin-${message.origin.kind}`} key={message.id}>
      <div className="message-meta"><strong>{message.origin.kind === 'peer' || message.origin.kind === 'handoff' || message.origin.kind === 'transfer'
        ? `${message.origin.kind === 'transfer' ? '轉交自' : '來自'} ${snapshot.sessions.find(source => 'fromSessionId' in message.origin && source.id === message.origin.fromSessionId)?.title ?? message.origin.fromSessionId}`
        : message.role === 'user' ? '你' : message.role === 'system' ? '系統' : 'Agent'}
      </strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
      <p>{message.text}</p>
      {message.observedModel && session.requestedModel.runtime === 'claude' && <small className="muted">訊息回報 · {message.observedModel}</small>}
      {message.attachments.length > 0 && <div className="attachment-chips">{message.attachments.map(attachment => <span key={`${attachment.kind}:${attachment.path}`}>{attachment.name}</span>)}</div>}
    </article>)}
    {Object.values(ipcState?.messageStreams ?? {}).filter(stream => stream.sessionId === session.id && !stream.nativeTaskId).map(stream => <article className="message" key={stream.messageId}><small>接收中 · 訊息尚未完整</small><p>{stream.delta}</p></article>)}
  </div>;
}

export function SessionWorkspace(props: WorkspaceProps) {
  const { snapshot, view, active, selection, onFocus, onClose, onContext, onOpen, onAgent, onModel, onProgress, onNotice } = props;
  const latestDraft = useRef({ sessionId: view.sessionId, text: contextFor(view).draft });
  const pendingPanel = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => { latestDraft.current = { sessionId: view.sessionId, text: contextFor(view).draft }; }, [view]);
  const session = snapshot.sessions.find(candidate => candidate.id === view.sessionId);
  if (!session) return <section className="workspace"><Empty>找不到 session：{view.sessionId}</Empty><button onClick={onClose}>關閉工作區</button></section>;
  const context = contextFor(view);
  const pendingCount = openEscalations(snapshot, session.id).length;
  const chosen = selection ?? { agentId: session.agent.id, model: session.requestedModel };
  const instance = session.kind === 'workflow' ? snapshot.instances.find(candidate => candidate.id === session.workflow.instanceId) : undefined;
  const activeTurn = sessionBlocksSend(snapshot, session.id);
  const canInterrupt = sessionCanInterrupt(snapshot, session.id);
  const creating = Object.values(props.ipcState?.blockedCommands ?? {}).some(item => item.command.type === 'session.create' && item.command.sessionId === session.id && !item.result);
  const blocked = !!props.store && (props.ipcState?.connection !== 'ready' || snapshot.app.status === 'damaged' || props.store.isBlocked('session.send', `session:${session.id}`) || creating);
  const interruptBlocked = props.store?.isBlocked('session.interrupt', `session:${session.id}`) ?? false;
  const interrupt = Object.values(props.ipcState?.blockedCommands ?? {}).find(item => item.command.type === 'session.interrupt' && item.command.sessionId === session.id);
  const lastInterrupt = Object.values(props.ipcState?.commands ?? {}).filter(item => item.command.type === 'session.interrupt' && item.command.sessionId === session.id).at(-1);
  const staleSend = Object.values(props.ipcState?.blockedCommands ?? {}).find(item => item.command.type === 'session.send' && item.command.sessionId === session.id && item.result && !item.result.ok && item.result.code === 'stale_revision' && !item.result.mayHaveSideEffects);
  const activity = Object.values(props.ipcState?.commands ?? {}).filter(item => 'sessionId' in item.command && item.command.sessionId === session.id).at(-1);
  const attach = (kind: 'files' | 'folder') => onNotice(`附件目標：${session.title}。${kind === 'files' ? '檔案／照片' : '資料夾'}選擇器尚未接入；未讀取檔案，也未新增附件。`);
  return <section className={`workspace ${active ? 'active-workspace' : ''}`} data-workspace={view.id} data-active={active} aria-label={`工作區 ${view.id}`} onFocusCapture={onFocus} onPointerDown={onFocus}>
    <header className="workspace-header">
      <div className="workspace-heading"><span className="eyebrow">{session.kind === 'workflow' ? 'Workflow session' : '一般 session'}</span><h2 id={`${view.id}-heading`} tabIndex={-1}>{session.title}</h2></div>
      {pendingCount > 0 && <button className="pending-badge" aria-controls={`${view.id}-pending`} onClick={() => {
        const panel = pendingPanel.current;
        if (!panel) return;
        panel.open = true;
        const transcript = panel.closest('.transcript');
        if (transcript) transcript.scrollTop = 0;
        panel.querySelector('summary')?.focus({ preventScroll: true });
      }}><span aria-live="polite">待處理 {pendingCount} 件</span></button>}
      <button className="icon-button" aria-label={`關閉工作區 ${view.id}`} title="只關閉工作區視圖" onClick={onClose}>×</button>
    </header>
    <div className="session-toolbar"><Status value={session.activity} />{session.kind === 'ordinary' && <button data-transfer-trigger onClick={props.onTransfer}>換到另一個工具</button>}<button aria-expanded={context.detailsVisible} onClick={() => onContext({ detailsVisible: !context.detailsVisible })}>{context.detailsVisible ? '收合細節' : '展開細節'}</button></div>
    {session.kind === 'workflow' && <div className="workflow-owner"><span>所屬 Workflow · {instance?.title ?? session.workflow.instanceId}</span><Menu label="所屬 Workflow 選單" className="owner-menu" actions={[{ label: '查看流程進度', onSelect: () => onProgress(session.workflow.instanceId) }]}>⋯</Menu></div>}
    <div className={`workspace-body ${context.detailsVisible ? '' : 'details-hidden'}`}>
      <div className="chat-panel">
        <div className="transcript-frame"><Transcript snapshot={snapshot} session={session} view={view} visible={props.visible} onContext={onContext} store={props.store} ipcState={props.ipcState} pendingPanel={pendingPanel} /></div>
        <form className="composer" onSubmit={event => {
          event.preventDefault();
          if (!props.store) { onNotice(`「${session.title}」尚未連接 runtime，草稿已保留，未送出訊息。`); return; }
          if (blocked || activeTurn || !context.draft.trim()) return;
          const current = props.store.getSnapshot().snapshot;
          const latestSession = current?.sessions.find(item => item.id === session.id);
          if (!latestSession || !current || sessionBlocksSend(current, session.id)) return;
          const text = context.draft;
          void props.store.send({ type: 'session.send', requestId: RequestId.parse(crypto.randomUUID()), sessionId: session.id, messageId: MessageId.parse(crypto.randomUUID()), expectedRevision: latestSession.revision, text, attachments: [] }).then(result => {
            if (result.ok && latestDraft.current.sessionId === session.id && latestDraft.current.text === text) onContext({ draft: '' });
          });
        }}>
          <div className="selectors">
            <label>{session.kind === 'workflow' ? 'Agent · 已鎖定' : 'Agent'}<select aria-label="Agent" aria-describedby={session.kind === 'workflow' ? `${view.id}-agent-lock` : undefined} value={chosen.agentId} disabled={session.kind === 'workflow' || props.store?.isBlocked('session.setAgent', `session:${session.id}`)} onChange={event => {
              const agent = props.agentOptions.find(candidate => candidate.id === event.target.value);
              if (agent) onAgent(agent.id);
            }}>{(session.kind === 'workflow' ? snapshot.agents : props.agentOptions).map(agent => <option key={`${agent.id}:${agent.revision}`} value={agent.id}>{agent.name}</option>)}</select></label>
            <label>Model<select aria-label="Model" aria-describedby={session.kind === 'workflow' ? `${view.id}-model-lock` : undefined} disabled={props.store?.isBlocked('session.setModel', `session:${session.id}`)} value={`${chosen.model.runtime}:${chosen.model.model}`} onChange={event => {
              const model = snapshot.modelOptions.find(candidate => `${candidate.runtime}:${candidate.model}` === event.target.value);
              if (model) onModel(model);
            }}>{snapshot.modelOptions.filter(model => !model.hidden).map(model => {
              const crossToolLocked = session.kind === 'workflow' && model.runtime !== session.requestedModel.runtime;
              return <option key={`${model.runtime}:${model.model}`} value={`${model.runtime}:${model.model}`} disabled={crossToolLocked}>{model.displayName} · {model.runtime}{crossToolLocked ? '（workflow 的 node 不能換工具）' : ''}</option>;
            })}</select></label>
          </div>
          {session.kind === 'workflow' && <p id={`${view.id}-agent-lock`} className="composer-note">Workflow Agent 已鎖定；更換 Agent 請建立新 Workflow，由轉接 Agent 協助接手。</p>}
          {session.kind === 'workflow' && <p id={`${view.id}-model-lock`} className="composer-note">workflow 的 node 不能換工具；僅能選擇同一工具的 Model。</p>}
          <p className="composer-note">{selection ? '示意選擇，尚未套用。' : observedModelText(session)} {chosen.model.runtime === 'codex' ? 'Model 於下一個 turn 生效。' : 'Model 於下一次模型呼叫生效。'}</p>
          <label className="sr-only" htmlFor={`${view.id}-draft`}>傳訊息給 {session.title}</label>
          <textarea id={`${view.id}-draft`} value={context.draft} onChange={event => onContext({ draft: event.target.value })} placeholder={`傳訊息給 ${session.title}…`} rows={3} />
          <div className="composer-actions"><Menu label="新增附件" shortcut actions={[{ label: 'Add files or photos', hint: 'Ctrl+U', onSelect: () => attach('files') }, { label: 'Add folder', onSelect: () => attach('folder') }]}>＋</Menu>
            <span className="composer-target">附件／訊息目標：{session.title}</span>
            {canInterrupt && <button type="button" disabled={!props.store || props.ipcState?.connection !== 'ready' || snapshot.app.status === 'damaged' || interruptBlocked} onClick={() => {
              if (!props.store || interruptBlocked) return;
              void props.store.send({ type: 'session.interrupt', requestId: RequestId.parse(crypto.randomUUID()), sessionId: session.id });
            }}>{interrupt?.result && !interrupt.result.ok ? '中斷結果待核對' : interruptBlocked ? '中斷中…' : '中斷'}</button>}
            <button type="submit" className="primary" disabled={!context.draft.trim() || activeTurn || blocked}>送出</button>
          </div>
          {activeTurn && <p className="composer-note">此 session 有執行中的 turn；可編輯草稿，暫不送出。</p>}
          {creating && <p role="status">Session 建立中；完成後才能送出，草稿已保留。</p>}
          {props.store && props.ipcState?.connection !== 'ready' && <p role="status">資料尚未同步完成；完成後才能送出，草稿已保留。</p>}
          {interrupt && <p role="status">{interrupt.result && !interrupt.result.ok ? commandFeedback(interrupt.result) : '已請求中斷，等待服務回報停止狀態。'}</p>}
          {canInterrupt && !interruptBlocked && lastInterrupt?.interruptRetryReady && <p role="status">中斷已接受，但 10 秒內仍未收到停止狀態；可重新讀取資料或再次按「中斷」。</p>}
          {staleSend && <p role="status">草稿已保留；等待新的 session revision 後可自行重送。<button type="button" disabled={props.ipcState?.connection === 'loading'} onClick={() => void props.store?.reconnect()}>重新讀取 session 資料</button></p>}
          {activity && <p className={activity.result && !activity.result.ok ? activity.result.code === 'unknown_outcome' ? 'command-warning' : 'field-error' : undefined}
            role={activity.result && !activity.result.ok && activity.result.code !== 'unknown_outcome' ? 'alert' : 'status'}>{!activity.result ? '處理中…' : activity.result.ok ? '操作已接受' : commandFeedback(activity.result, activity.command.type)}</p>}
          {props.ipcState?.runtimeExits[session.requestedModel.runtime]?.sessionIds.includes(session.id) && <p role="status">Runtime 曾回報結束，請核對最新 session 狀態；訊息送達結果另列。</p>}
        </form>
      </div>
      {context.detailsVisible && <DetailPanel snapshot={snapshot} session={session} store={props.store} viewId={view.id} tab={context.detailTab} onTab={detailTab => onContext({ detailTab })} onOpen={onOpen} onNotice={onNotice} />}
    </div>
  </section>;
}

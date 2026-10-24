import { useLayoutEffect, useRef } from 'react';
import type { AgentId, LogicalSession, ModelOption, ModelSelection, SessionId, Snapshot } from '../../../contracts';
import type { SessionViewContext, WorkspaceView } from './workbench-state';
import { contextFor } from './workbench-state';
import { DetailPanel } from './DetailPanel';
import { Empty, formatTime, Menu, observedModelText, Status } from './ui';

export interface Selection { agentId: AgentId; model: ModelSelection }
export interface WorkspaceProps {
  snapshot: Snapshot;
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
  onProgress: (instanceId: string) => void;
  onNotice: (message: string) => void;
}

function Transcript({ snapshot, session, view, visible, onContext }: Pick<WorkspaceProps, 'snapshot' | 'view' | 'visible' | 'onContext'> & { session: LogicalSession }) {
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
    <div className="transcript-heading"><span>對話紀錄</span><span>示意快照</span></div>
    {messages.length === 0 && <Empty>這個 session 尚無主對話訊息。</Empty>}
    {messages.map(message => <article className={`message message-${message.role} origin-${message.origin.kind}`} key={message.id}>
      <div className="message-meta"><strong>{message.origin.kind === 'peer' || message.origin.kind === 'handoff'
        ? `來自 ${snapshot.sessions.find(source => 'fromSessionId' in message.origin && source.id === message.origin.fromSessionId)?.title ?? message.origin.fromSessionId}`
        : message.role === 'user' ? '你' : message.role === 'system' ? '系統' : 'Agent'}
      </strong><time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time></div>
      <p>{message.text}</p>
      {message.observedModel && session.requestedModel.runtime === 'claude' && <small className="muted">訊息回報 · {message.observedModel}</small>}
      {message.attachments.length > 0 && <div className="attachment-chips">{message.attachments.map(attachment => <span key={`${attachment.kind}:${attachment.path}`}>{attachment.name}</span>)}</div>}
    </article>)}
  </div>;
}

export function SessionWorkspace(props: WorkspaceProps) {
  const { snapshot, view, active, selection, onFocus, onClose, onContext, onOpen, onAgent, onModel, onProgress, onNotice } = props;
  const session = snapshot.sessions.find(candidate => candidate.id === view.sessionId);
  if (!session) return <section className="workspace"><Empty>找不到 session：{view.sessionId}</Empty><button onClick={onClose}>關閉工作區</button></section>;
  const context = contextFor(view);
  const chosen = selection ?? { agentId: session.agent.id, model: session.requestedModel };
  const instance = session.kind === 'workflow' ? snapshot.instances.find(candidate => candidate.id === session.workflow.instanceId) : undefined;
  const activeTurn = snapshot.turns.some(turn => turn.sessionId === session.id && turn.state === 'running') || session.activity === 'running';
  const attach = (kind: 'files' | 'folder') => onNotice(`附件目標：${session.title}。${kind === 'files' ? '檔案／照片' : '資料夾'}選擇器尚未接入；未讀取檔案，也未新增附件。`);
  return <section className={`workspace ${active ? 'active-workspace' : ''}`} data-workspace={view.id} data-active={active} aria-label={`工作區 ${view.id}`} onFocusCapture={onFocus} onPointerDown={onFocus}>
    <header className="workspace-header">
      <div className="workspace-heading"><span className="eyebrow">{session.kind === 'workflow' ? 'Workflow session' : '一般 session'}</span><h2 id={`${view.id}-heading`} tabIndex={-1}>{session.title}</h2></div>
      <button className="icon-button" aria-label={`關閉工作區 ${view.id}`} title="只關閉工作區視圖" onClick={onClose}>×</button>
    </header>
    <div className="session-toolbar"><Status value={session.activity} /><button aria-expanded={context.detailsVisible} onClick={() => onContext({ detailsVisible: !context.detailsVisible })}>{context.detailsVisible ? '收合細節' : '展開細節'}</button></div>
    {session.kind === 'workflow' && <div className="workflow-owner"><span>所屬 Workflow · {instance?.title ?? session.workflow.instanceId}</span><Menu label="所屬 Workflow 選單" className="owner-menu" actions={[{ label: '查看流程進度', onSelect: () => onProgress(session.workflow.instanceId) }]}>⋯</Menu></div>}
    <div className={`workspace-body ${context.detailsVisible ? '' : 'details-hidden'}`}>
      <div className="chat-panel">
        <Transcript snapshot={snapshot} session={session} view={view} visible={props.visible} onContext={onContext} />
        <form className="composer" onSubmit={event => { event.preventDefault(); onNotice(`「${session.title}」尚未連接 runtime，草稿已保留，未送出訊息。`); }}>
          <div className="selectors">
            <label>{session.kind === 'workflow' ? 'Agent · 已鎖定' : 'Agent'}<select aria-label="Agent" aria-describedby={session.kind === 'workflow' ? `${view.id}-agent-lock` : undefined} value={chosen.agentId} disabled={session.kind === 'workflow'} onChange={event => {
              const agent = snapshot.agents.find(candidate => candidate.id === event.target.value);
              if (agent) onAgent(agent.id);
            }}>{snapshot.agents.map(agent => <option key={`${agent.id}:${agent.revision}`} value={agent.id}>{agent.name}</option>)}</select></label>
            <label>Model<select aria-label="Model" value={`${chosen.model.runtime}:${chosen.model.model}`} onChange={event => {
              const model = snapshot.modelOptions.find(candidate => `${candidate.runtime}:${candidate.model}` === event.target.value);
              if (model) onModel(model);
            }}>{snapshot.modelOptions.filter(model => !model.hidden).map(model => <option key={`${model.runtime}:${model.model}`} value={`${model.runtime}:${model.model}`}>{model.displayName} · {model.runtime}</option>)}</select></label>
          </div>
          {session.kind === 'workflow' && <p id={`${view.id}-agent-lock`} className="composer-note">Workflow Agent 已鎖定；更換 Agent 請建立新 Workflow，由轉接 Agent 協助接手。</p>}
          <p className="composer-note">{selection ? '示意選擇，尚未套用。' : observedModelText(session)} {chosen.model.runtime === 'codex' ? 'Model 於下一個 turn 生效。' : 'Model 於下一次模型呼叫生效。'}</p>
          <label className="sr-only" htmlFor={`${view.id}-draft`}>傳訊息給 {session.title}</label>
          <textarea id={`${view.id}-draft`} value={context.draft} onChange={event => onContext({ draft: event.target.value })} placeholder={`傳訊息給 ${session.title}…`} rows={3} />
          <div className="composer-actions"><Menu label="新增附件" shortcut actions={[{ label: 'Add files or photos', hint: 'Ctrl+U', onSelect: () => attach('files') }, { label: 'Add folder', onSelect: () => attach('folder') }]}>＋</Menu>
            <span className="composer-target">附件／訊息目標：{session.title}</span>
            <button type="submit" className="primary" disabled={!context.draft.trim() || activeTurn}>送出</button>
          </div>
          {activeTurn && <p className="composer-note">此 session 有執行中的 turn；可編輯草稿，暫不送出。</p>}
        </form>
      </div>
      {context.detailsVisible && <DetailPanel snapshot={snapshot} session={session} viewId={view.id} tab={context.detailTab} onTab={detailTab => onContext({ detailTab })} onOpen={onOpen} onNotice={onNotice} />}
    </div>
  </section>;
}

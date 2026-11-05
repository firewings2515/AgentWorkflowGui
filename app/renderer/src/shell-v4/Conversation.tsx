// One conversation pane of the v0.4 shell (T047 layout). It carries everything the old workspace did (send with the
// latest revision, interrupt, stale revisions, creation and sync states, lock waits, history pages, streaming text,
// release causes, runtime exits) in the Claude-like frame: title bar, centred column, composer, optional details.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, LogicalSession, NativeTask, SessionId, Snapshot } from '../../../../contracts';
import { RequestId } from '../../../../contracts';
import { commandFeedback } from '../command-feedback';
import { DetailPanel } from '../DetailPanel';
import { EscalationPanel, runEscalations } from '../EscalationPanel';
import { LockWaits } from '../LockWaits';
import { readOnlyProps } from '../read-only';
import type { RendererState, RendererStore } from '../renderer-store';
import { sessionBlocksSend, sessionCanInterrupt } from '../renderer-store';
import { Status, statusLabel } from '../ui';
import { VirtualMessages } from '../VirtualMessages';
import { Composer } from './Composer';
import type { ComposerChoice } from './Composer';
import { HoverMenu } from './MenuList';
import { contextOf } from './pane-state';
import type { Pane, SessionContext } from './pane-state';

function TaskList({ tasks }: { tasks: NativeTask[] }) {
  if (!tasks.length) return null;
  const done = tasks.filter(task => task.state === 'completed').length;
  return <section className="v4-task-list" aria-label="子任務">
    <h3>子任務 · {done}/{tasks.length} 完成</h3>
    <ul>{tasks.map(task => <li key={`${task.runtime}:${task.id}`} data-state={task.state}><span className="v4-task-mark" aria-hidden="true">{task.state === 'completed' ? '✓' : task.state === 'running' ? '◐' : '○'}</span>
      <span>{task.label}</span><span className="v4-muted">{statusLabel(task.state)}{task.summary ? ` · ${task.summary}` : ''}</span></li>)}</ul>
  </section>;
}

/** The transcript: lock waits and history control on top, the virtual timeline, then streaming text, sub-tasks and escalations. */
function Transcript({ snapshot, session, pane, store, historyStore, ipcState, onContext, onOpen }: {
  snapshot: Snapshot; session: LogicalSession; pane: Pane; store: RendererStore | undefined; historyStore: RendererStore | undefined; ipcState: RendererState | undefined;
  onContext: (patch: Partial<SessionContext>) => void; onOpen: (id: SessionId) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const context = contextOf(pane);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const cursor = snapshot.historyPages.find(info => info.sessionId === session.id)?.olderCursor;
  const load = () => {
    if (!cursor || pending.current || !historyStore) return;
    pending.current = true; setLoading(true); setError('');
    void historyStore.loadHistory(session.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '載入歷史失敗。')).finally(() => { pending.current = false; setLoading(false); });
  };
  const messages = useMemo(() => snapshot.messages.filter(message => message.sessionId === session.id && !message.nativeTaskId), [snapshot.messages, session.id]);
  const items = useMemo(() => snapshot.items.filter(item => item.sessionId === session.id && !item.nativeTaskId), [snapshot.items, session.id]);
  const tasks = useMemo(() => snapshot.nativeTasks.filter(task => task.sessionId === session.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [snapshot.nativeTasks, session.id]);
  const forRun = runEscalations(snapshot, session.id);
  const streams = Object.values(ipcState?.messageStreams ?? {}).filter(stream => stream.sessionId === session.id && !stream.nativeTaskId);
  return <div className="v4-transcript" data-scroll-root ref={scroll} role="region" aria-label={`${session.title} 對話內容`} tabIndex={0} onScroll={event => {
    if (event.currentTarget.scrollTop <= 48 && !error) load();
  }}>
    <div className="v4-column">
      <LockWaits snapshot={snapshot} sessionId={session.id} onOpen={onOpen} />
      <div className="v4-history">{cursor ? <button type="button" disabled={loading || !historyStore} onClick={load}>{loading ? '正在載入更早的對話…' : '載入更早的對話'}</button>
        : messages.length > 0 && <span className="v4-muted">已到最早</span>}
        {error && <p role="alert">{error} <button type="button" onClick={load}>重試</button></p>}</div>
      {messages.length === 0 && items.length === 0 && <p className="v4-muted v4-empty-chat">這個 session 還沒有訊息。</p>}
      <VirtualMessages messages={messages} items={items} sessions={snapshot.sessions} runtime={session.requestedModel.runtime} scroll={scroll} visible
        initialPosition={context.reading} onPosition={reading => onContext({ reading })} />
      {streams.map(stream => <article className="v4-message v4-assistant v4-streaming" key={stream.messageId}><p className="v4-origin">接收中 · 訊息尚未完整</p><p className="v4-text">{stream.delta}</p></article>)}
      <TaskList tasks={tasks} />
      <EscalationPanel snapshot={snapshot} sessionId={session.id} store={store} ipcState={ipcState} compact />
      {forRun.length > 0 && <section className="v4-run-escalations" aria-label="這次執行的其他待處理項目">
        <h3>這次執行的其他待處理（{forRun.length}）</h3>
        <ul>{forRun.map(item => {
          const from = snapshot.sessions.find(candidate => candidate.id === item.fromSessionId);
          return <li key={item.id}><span className="v4-alert" aria-hidden="true" /><span className="v4-run-escalation-title">{item.title}</span>
            <span className="v4-muted">來自 {from?.title ?? item.fromSessionId}</span>
            <button type="button" disabled={!from} onClick={() => onOpen(item.fromSessionId)} aria-label={`前往 ${from?.title ?? item.fromSessionId} 處理「${item.title}」`}>前往</button></li>;
        })}</ul>
      </section>}
    </div>
  </div>;
}

export interface ConversationProps {
  snapshot: Snapshot; store: RendererStore | undefined; historyStore: RendererStore | undefined; ipcState: RendererState | undefined;
  pane: Pane; title: string; active: boolean; split: boolean;
  /** The owning run's title (after a rename in the demo). */
  runTitle?: string | undefined;
  agents: readonly AgentDefinition[]; choice: ComposerChoice; editTitle: number;
  /** A session opened after an uncertain create was found: its first message has not been sent (REVISION §3.4, Q-d). */
  firstNotSent: boolean;
  onContext: (patch: Partial<SessionContext>) => void; onChoice: (choice: ComposerChoice) => void;
  onSend: (text: string) => void; onRename: (title: string) => void; onClose: () => void; onFocus: () => void;
  onOpen: (id: SessionId) => void; onProgress: (instanceId: string) => void; onNotice: (text: string) => void;
  /**
   * U4 (T060): set when this session is in an archived conversation or run. The banner's 取消封存 is the shell's (it
   * sends the top session's or the run's id); `reason` disables it. Sending a message works as always: the backend
   * unarchives in the same command.
   */
  archive?: { kind: 'session' | 'run'; reason: string | undefined; onUnarchive: () => void } | undefined;
}

/** Commands whose result shows elsewhere (a notice), not on the composer's last-result line. */
const elsewhere = new Set(['session.rename', 'session.archive', 'session.unarchive']);

export function Conversation(props: ConversationProps) {
  const { snapshot, store, ipcState, pane, title, active, split, onContext, onNotice } = props;
  const session = snapshot.sessions.find(item => item.id === pane.sessionId);
  const context = contextOf(pane);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  const titleButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const readOnly = snapshot.app.status === 'read-only';
  // A rename from the sidebar menu arrives as a new request number; only a new number starts editing.
  const [seenEdit, setSeenEdit] = useState(0);
  if (props.editTitle !== seenEdit) {
    setSeenEdit(props.editTitle);
    if (props.editTitle && !readOnly) { setName(title); setEditing(true); }
  }
  useEffect(() => { if (editing) titleInput.current?.select(); }, [editing]);
  if (!session) return <section className="v4-pane" aria-label={`對話：${pane.sessionId}`} data-pane={pane.id}><div className="v4-pane-main v4-missing">
    <p>找不到 session：{pane.sessionId}</p>{split && <button type="button" onClick={props.onClose}>關閉這一側</button>}
  </div></section>;

  const instance = session.kind === 'workflow' ? snapshot.instances.find(item => item.id === session.workflow.instanceId) : undefined;
  const agent = snapshot.agents.find(item => item.id === session.agent?.id);
  const activeTurn = sessionBlocksSend(snapshot, session.id);
  const canInterrupt = sessionCanInterrupt(snapshot, session.id);
  const commands = Object.values(ipcState?.commands ?? {});
  const blockedCommands = Object.values(ipcState?.blockedCommands ?? {});
  const creating = blockedCommands.some(item => item.command.type === 'session.create' && item.command.sessionId === session.id && !item.result);
  const notReady = !!store && ipcState?.connection !== 'ready';
  const blocked = readOnly || !!store && (notReady || snapshot.app.status === 'damaged' || store.isBlocked('session.send', `session:${session.id}`) || creating);
  const interruptBlocked = store?.isBlocked('session.interrupt', `session:${session.id}`) ?? false;
  const interrupt = blockedCommands.find(item => item.command.type === 'session.interrupt' && item.command.sessionId === session.id);
  const lastInterrupt = commands.filter(item => item.command.type === 'session.interrupt' && item.command.sessionId === session.id).at(-1);
  const staleSend = blockedCommands.find(item => item.command.type === 'session.send' && item.command.sessionId === session.id && item.result && !item.result.ok && item.result.code === 'stale_revision' && !item.result.mayHaveSideEffects);
  const activity = commands.filter(item => 'sessionId' in item.command && item.command.sessionId === session.id && !elsewhere.has(item.command.type)).at(-1);
  const choiceBlocked = !!store && (notReady || snapshot.app.status !== 'ready' || store.isBlocked('session.setModel', `session:${session.id}`) || store.isBlocked('session.setAgent', `session:${session.id}`));
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && name.trim() && name.trim() !== title) props.onRename(name.trim());
    requestAnimationFrame(() => titleButton.current?.focus());
  };
  const closeCause = ipcState?.closeCauses?.[session.id];
  const exited = ipcState?.runtimeExits[session.requestedModel.runtime]?.sessionIds.includes(session.id);
  return <section className={`v4-pane ${active ? 'v4-pane-active' : ''}`} aria-label={`對話：${title}`} data-pane={pane.id} data-workspace={pane.id} onFocusCapture={props.onFocus} onPointerDown={props.onFocus}>
    <div className="v4-pane-main">
      <header className="v4-titlebar">
        {editing ? <input ref={titleInput} className="v4-title-input" aria-label="Session 標題" value={name} maxLength={200} onChange={event => setName(event.target.value)}
          onBlur={() => finish(true)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finish(true); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
          }} />
          : <button ref={titleButton} type="button" className="v4-title" title={readOnly ? readOnlyProps(true).title : '點一下改名'} aria-describedby={readOnly ? 'read-only-reason' : undefined}
            onClick={() => { if (readOnly) return; setName(title); setEditing(true); }}><h2 id={`${pane.id}-heading`} tabIndex={-1}>{title}</h2><span className="v4-edit-mark" aria-hidden="true">✎</span></button>}
        {session.kind === 'workflow' && <HoverMenu label="所屬 Workflow 選單" items={[
          { label: '查看流程進度', onSelect: () => props.onProgress(session.workflow.instanceId) },
          ...(instance && instance.rootSessionId !== session.id ? [{ label: '開啟 root session', onSelect: () => props.onOpen(instance.rootSessionId) }] : []),
        ]}>Workflow：{props.runTitle ?? instance?.title ?? session.workflow.instanceId} <span aria-hidden="true">⋯</span></HoverMenu>}
        <span className="v4-titlebar-spacer" />
        <Status value={session.activity} />
        <button type="button" className="v4-icon" aria-pressed={context.details} aria-label={context.details ? '關閉細節窗格' : '開啟細節窗格'} title="細節" onClick={() => onContext({ details: !context.details })}>◫</button>
        {split && <button type="button" className="v4-icon" aria-label={`關閉分割畫面：${title}`} title="只關閉這一側的畫面" onClick={props.onClose}>×</button>}
      </header>
      {props.archive && <div className="v4-archived-banner" role="status">
        <span className="v4-archived-badge">已封存</span>
        <span>{props.archive.kind === 'run' ? '這次執行已封存。' : '這個對話已封存。'}送出訊息會自動取消封存。</span>
        <button type="button" disabled={!!props.archive.reason} title={props.archive.reason} aria-describedby={readOnly ? 'read-only-reason' : undefined}
          onClick={props.archive.onUnarchive}>{props.archive.reason === '正在取消封存…' ? '正在取消封存…' : '取消封存'}</button>
      </div>}
      {(closeCause || exited || session.activity === 'error') && <div className="v4-session-notes">
        {closeCause && <p className="v4-muted">{closeCause === 'idle' ? '閒置自動釋放' : '超過程序上限而釋放'}</p>}
        {exited && <p role="status">Runtime 曾回報結束，請核對最新 session 狀態；訊息送達結果另列。</p>}
        {session.activity === 'error' && <p role="status" className="command-warning" data-session-error>此 session 處於錯誤狀態，可能接不回來，新的訊息不一定送得出去。可以另開一個新的 session 繼續。</p>}
      </div>}
      <div className="v4-transcript-frame"><Transcript key={session.id} snapshot={snapshot} session={session} pane={pane} store={store} historyStore={props.historyStore} ipcState={ipcState} onContext={onContext} onOpen={props.onOpen} /></div>
      <div className="v4-composer-dock"><div className="v4-column">
        <Composer draft={context.draft} onDraft={draft => onContext({ draft })} choice={props.choice} onChoice={props.onChoice} agents={props.agents} models={snapshot.modelOptions}
          placeholder={`回覆 ${title}…`} attachTarget={title} folderFixed={session.cwd} readOnly={readOnly} sendDisabled={blocked || activeTurn} choiceDisabled={choiceBlocked}
          {...(session.kind === 'workflow' ? { locked: session.requestedModel.runtime, lockedAgent: agent?.name ?? session.agent.id } : { transferFrom: session.requestedModel.runtime })}
          onNotice={onNotice} onSend={() => {
            if (!store) { onNotice(`示意模式：「${title}」尚未連接 runtime，草稿已保留，未送出訊息。`); return; }
            if (blocked || activeTurn || !context.draft.trim()) return;
            props.onSend(context.draft);
          }}>
          {canInterrupt && <button type="button" className="v4-interrupt" {...readOnlyProps(readOnly)} disabled={readOnly || !store || notReady || snapshot.app.status === 'damaged' || interruptBlocked} onClick={() => {
            if (!store || interruptBlocked) return;
            void store.send({ type: 'session.interrupt', requestId: RequestId.parse(crypto.randomUUID()), sessionId: session.id });
          }}>{interrupt?.result && !interrupt.result.ok ? '中斷結果待核對' : interruptBlocked ? '中斷中…' : '中斷'}</button>}
          {props.firstNotSent && <p role="status" className="command-warning">第一句還沒送出：建立結果曾經不明，核對後才找到這個對話。確認草稿後再按送出。</p>}
          {activeTurn && <p className="v4-muted">此 session 有執行中的 turn；可編輯草稿，暫不送出。</p>}
          {creating && <p role="status">Session 建立中；完成後才能送出，草稿已保留。</p>}
          {notReady && <p role="status">資料尚未同步完成；完成後才能送出，草稿已保留。</p>}
          {interrupt && <p role="status">{interrupt.result && !interrupt.result.ok ? commandFeedback(interrupt.result) : '已請求中斷，等待服務回報停止狀態。'}</p>}
          {canInterrupt && !interruptBlocked && lastInterrupt?.interruptRetryReady && <p role="status">中斷已接受，但 10 秒內仍未收到停止狀態；可重新讀取資料或再次按「中斷」。</p>}
          {staleSend && <p role="status">草稿已保留；等待新的 session revision 後可自行重送。<button type="button" disabled={ipcState?.connection === 'loading'} onClick={() => void store?.reconnect()}>重新讀取 session 資料</button></p>}
          {activity && <p className={activity.result && !activity.result.ok ? activity.result.code === 'unknown_outcome' ? 'command-warning' : 'field-error' : 'v4-muted'}
            role={activity.result && !activity.result.ok && activity.result.code !== 'unknown_outcome' ? 'alert' : 'status'}>{!activity.result ? '處理中…' : activity.result.ok ? '操作已接受' : commandFeedback(activity.result, activity.command.type)}</p>}
        </Composer>
      </div></div>
    </div>
    {context.details && <aside className="v4-details" aria-label="細節窗格">
      <header><strong>細節</strong><button type="button" className="v4-icon" aria-label="關閉細節窗格" onClick={() => onContext({ details: false })}>×</button></header>
      <DetailPanel snapshot={snapshot} session={session} store={store} viewId={pane.id} tab={context.tab} onTab={tab => onContext({ tab })} onOpen={props.onOpen} onNotice={onNotice} />
    </aside>}
  </section>;
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentDefinition, Escalation, LogicalSession, Message, NativeTask, SessionId, SessionItem, Snapshot } from '../../../../contracts';
import { DetailPanel } from '../DetailPanel';
import { formatTime, Status, statusLabel } from '../ui';
import { Composer } from './Composer';
import type { ComposerChoice } from './Composer';
import type { V4Pane } from './demo-data';
import { HoverMenu } from './MenuList';

type Entry = { kind: 'message'; at: string; message: Message } | { kind: 'tools'; at: string; items: SessionItem[] } | { kind: 'escalation'; at: string; escalation: Escalation };

/** Main-conversation messages and tool calls in time order; consecutive tool calls fold into one group. */
function timeline(snapshot: Snapshot, session: LogicalSession, escalations: Escalation[]): Entry[] {
  const entries: Entry[] = [
    ...snapshot.messages.filter(message => message.sessionId === session.id && !message.nativeTaskId).map(message => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...snapshot.items.filter(item => item.sessionId === session.id && !item.nativeTaskId).map(item => ({ kind: 'tools' as const, at: item.startedAt, items: [item] })),
    ...escalations.map(escalation => ({ kind: 'escalation' as const, at: escalation.createdAt, escalation })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return entries.reduce<Entry[]>((result, entry) => {
    const last = result.at(-1);
    if (entry.kind === 'tools' && last?.kind === 'tools') last.items.push(...entry.items); else result.push(entry);
    return result;
  }, []);
}

function toolTitle(item: SessionItem) {
  switch (item.kind) {
    case 'command': return `執行 ${item.command}`;
    case 'fileChange': return `修改 ${item.changes.length} 個檔案`;
    case 'toolCall': return `${item.tool} · ${item.summary}`;
  }
}

function ToolGroup({ items }: { items: SessionItem[] }) {
  return <details className="v4-tools">
    <summary><span aria-hidden="true">⚙</span> {items.length === 1 ? toolTitle(items[0]!) : `使用了 ${items.length} 個工具`}</summary>
    <ul>{items.map(item => <li key={item.id}><details className="v4-tool">
      <summary>{toolTitle(item)} <Status value={item.state} /></summary>
      {item.kind === 'command' && <><p className="v4-tool-meta">資料夾 <code>{item.cwd}</code>{item.exitCode !== undefined && <> · 結束碼 {item.exitCode}</>}</p>{item.output && <pre>{item.output}</pre>}</>}
      {item.kind === 'fileChange' && <ul className="v4-files">{item.changes.map(change => <li key={change.path}><span className={`v4-change v4-change-${change.change}`}>{change.change === 'add' ? '新增' : change.change === 'delete' ? '刪除' : '修改'}</span> <code>{change.path}</code></li>)}</ul>}
      {item.kind === 'toolCall' && <p className="v4-tool-meta">{item.server ? `${item.server} · ` : ''}{item.summary}</p>}
    </details></li>)}</ul>
  </details>;
}

function EscalationCard({ escalation, snapshot, decided, onDecide }: { escalation: Escalation; snapshot: Snapshot; decided: string | undefined; onDecide: (decision: 'approve' | 'reject') => void }) {
  const from = snapshot.sessions.find(session => session.id === escalation.fromSessionId);
  return <article className="v4-escalation" aria-label={`待處理：${escalation.title}`}>
    <header><span className="v4-escalation-icon" aria-hidden="true">!</span><strong>{escalation.title}</strong>{from && <span className="v4-muted">來自 {from.title}</span>}</header>
    {escalation.detail && <pre>{escalation.detail}</pre>}
    {escalation.rule && <p className="v4-muted">符合規則：<code>{escalation.rule}</code>（自動核准之外的項目，要你決定）</p>}
    {decided ? <p role="status" className="v4-decided">示意：已{decided === 'approve' ? '核准' : '拒絕'}，未送出指令。</p>
      : <div className="v4-escalation-actions"><button type="button" className="primary" onClick={() => onDecide('approve')}>核准</button><button type="button" onClick={() => onDecide('reject')}>拒絕</button></div>}
  </article>;
}

function TaskList({ tasks }: { tasks: NativeTask[] }) {
  if (!tasks.length) return null;
  const done = tasks.filter(task => task.state === 'completed').length;
  return <section className="v4-task-list" aria-label="子任務">
    <h3>子任務 · {done}/{tasks.length} 完成</h3>
    <ul>{tasks.map(task => <li key={task.id} data-state={task.state}><span className="v4-task-mark" aria-hidden="true">{task.state === 'completed' ? '✓' : task.state === 'running' ? '◐' : '○'}</span>
      <span>{task.label}</span><span className="v4-muted">{statusLabel(task.state)}{task.summary ? ` · ${task.summary}` : ''}</span></li>)}</ul>
  </section>;
}

export interface ConversationProps {
  snapshot: Snapshot; pane: V4Pane; title: string; active: boolean; split: boolean;
  agents: readonly AgentDefinition[]; draft: string; choice: ComposerChoice; editTitle: number;
  onDraft: (text: string) => void; onChoice: (choice: ComposerChoice) => void;
  onPane: (patch: Partial<V4Pane>) => void; onRename: (title: string) => void; onClose: () => void; onFocus: () => void;
  onOpen: (id: SessionId) => void; onProgress: (instanceId: string) => void; onNotice: (text: string) => void;
}

export function Conversation(props: ConversationProps) {
  const { snapshot, pane, title, active, split, onPane, onNotice } = props;
  const session = snapshot.sessions.find(item => item.id === pane.sessionId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const titleButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  // Like a chat app, opening a conversation shows its latest part.
  useLayoutEffect(() => { const box = transcript.current; if (box) box.scrollTop = box.scrollHeight; }, [pane.sessionId]);
  // A rename from the sidebar menu arrives as a new request number; only a new number starts editing.
  const [seenEdit, setSeenEdit] = useState(0);
  if (props.editTitle !== seenEdit) {
    setSeenEdit(props.editTitle);
    if (props.editTitle) { setName(title); setEditing(true); }
  }
  useEffect(() => { if (editing) titleInput.current?.select(); }, [editing]);
  if (!session) return <section className="v4-pane"><p>找不到 session：{pane.sessionId}</p></section>;
  const instance = session.kind === 'workflow' ? snapshot.instances.find(item => item.id === session.workflow.instanceId) : undefined;
  const escalations = snapshot.escalations.filter(item => item.state === 'open' && (item.fromSessionId === session.id || item.rootSessionId === session.id));
  const entries = timeline(snapshot, session, escalations);
  const tasks = snapshot.nativeTasks.filter(task => task.sessionId === session.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const agent = snapshot.agents.find(item => item.id === session.agent.id);
  const finish = (save: boolean) => {
    setEditing(false);
    if (save && name.trim() && name.trim() !== title) props.onRename(name.trim());
    requestAnimationFrame(() => titleButton.current?.focus());
  };
  return <section className={`v4-pane ${active ? 'v4-pane-active' : ''}`} aria-label={`對話：${title}`} data-pane={pane.id} onFocusCapture={props.onFocus} onPointerDown={props.onFocus}>
    <div className="v4-pane-main">
      <header className="v4-titlebar">
        {editing ? <input ref={titleInput} className="v4-title-input" aria-label="Session 標題" value={name} onChange={event => setName(event.target.value)}
          onBlur={() => finish(true)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); finish(true); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
          }} />
          : <button ref={titleButton} type="button" className="v4-title" title="點一下改名" onClick={() => { setName(title); setEditing(true); }}><h2 id={`${pane.id}-heading`}>{title}</h2><span className="v4-edit-mark" aria-hidden="true">✎</span></button>}
        {session.kind === 'workflow' && <HoverMenu label="所屬 Workflow 選單" items={[
          { label: '查看流程進度', onSelect: () => props.onProgress(session.workflow.instanceId) },
          ...(instance && instance.rootSessionId !== session.id ? [{ label: '開啟 root session', onSelect: () => props.onOpen(instance.rootSessionId) }] : []),
        ]}>Workflow：{instance?.title ?? session.workflow.instanceId} <span aria-hidden="true">⋯</span></HoverMenu>}
        <span className="v4-titlebar-spacer" />
        <Status value={session.activity} />
        <button type="button" className="v4-icon" aria-pressed={pane.details} aria-label={pane.details ? '關閉細節窗格' : '開啟細節窗格'} title="細節" onClick={() => onPane({ details: !pane.details })}>◫</button>
        {split && <button type="button" className="v4-icon" aria-label={`關閉分割畫面：${title}`} title="關閉這一側" onClick={props.onClose}>×</button>}
      </header>
      <div className="v4-transcript" ref={transcript} role="region" aria-label={`${title} 對話內容`} tabIndex={0}>
        <div className="v4-column">
          {entries.length === 0 && <p className="v4-muted v4-empty-chat">這個 session 還沒有訊息。</p>}
          {entries.map((entry, index) => {
            const last = index === entries.length - 1 || entries.slice(index + 1).every(next => next.kind !== 'message');
            if (entry.kind === 'tools') return <ToolGroup key={entry.items[0]!.id} items={entry.items} />;
            if (entry.kind === 'escalation') return <EscalationCard key={entry.escalation.id} escalation={entry.escalation} snapshot={snapshot} decided={decisions[entry.escalation.id]}
              onDecide={decision => { setDecisions(previous => ({ ...previous, [entry.escalation.id]: decision })); onNotice(`示意模式：${decision === 'approve' ? '核准' : '拒絕'}「${entry.escalation.title}」沒有送出；U2 會送 escalation.respond。`); }} />;
            const message = entry.message;
            const fromUser = message.role === 'user' && message.origin.kind === 'user';
            return <div key={message.id}>
              <article className={`v4-message v4-${message.role} ${fromUser ? 'v4-from-user' : ''}`}>
                {!fromUser && message.role === 'user' && <p className="v4-origin">{message.origin.kind === 'handoff' ? '交接' : message.origin.kind === 'peer' ? '跨 session 訊息' : '訊息'}</p>}
                <p className="v4-text">{message.text}</p>
                {message.attachments.length > 0 && <ul className="v4-attachments">{message.attachments.map(item => <li key={item.path}><span aria-hidden="true">{item.kind === 'folder' ? '▤' : '▧'}</span> {item.name}</li>)}</ul>}
                <time className="v4-time" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </article>
              {last && <TaskList tasks={tasks} />}
            </div>;
          })}
          {!entries.some(entry => entry.kind === 'message') && <TaskList tasks={tasks} />}
        </div>
      </div>
      <div className="v4-composer-dock"><div className="v4-column">
        <Composer draft={props.draft} onDraft={props.onDraft} autoFolder="" choice={props.choice} onChoice={props.onChoice} agents={props.agents} models={snapshot.modelOptions}
          placeholder={`回覆 ${title}…`} folderFixed={session.cwd} {...(session.kind === 'workflow' ? { locked: session.requestedModel.runtime, lockedAgent: agent?.name ?? session.agent.id } : {})}
          onNotice={onNotice} onSend={() => onNotice(`示意模式：「${title}」尚未連接 runtime，草稿已保留，未送出訊息。`)} />
      </div></div>
    </div>
    {pane.details && <aside className="v4-details" aria-label="細節窗格">
      <header><strong>細節</strong><button type="button" className="v4-icon" aria-label="關閉細節窗格" onClick={() => onPane({ details: false })}>×</button></header>
      <DetailPanel snapshot={snapshot} session={session} viewId={pane.id} tab={pane.tab} onTab={tab => onPane({ tab })} onOpen={props.onOpen} onNotice={onNotice} />
    </aside>}
  </section>;
}

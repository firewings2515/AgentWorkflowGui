import { useEffect, useRef, useState } from 'react';
import { RequestId, SessionId } from '../../../contracts';
import type { Command, CommandResult, Snapshot } from '../../../contracts';
import { blocksResubmit, commandFeedback } from './command-feedback';
import { FolderButton } from './FolderButton';
import type { RendererState, RendererStore } from './renderer-store';

type CreateCommand = Extract<Command, { type: 'session.create' }>;
export interface SessionCreateDraft { agentId: string; modelKey: string; cwd: string; parentId: string }
export function SessionCreate({ snapshot, store, ipcState, draft, onDraft, onOpen }: {
  snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined; onOpen: (id: SessionId) => void;
  draft: SessionCreateDraft; onDraft: (draft: SessionCreateDraft) => void;
}) {
  const { agentId, modelKey, cwd, parentId } = draft;
  const [receipt, setReceipt] = useState<{ command: CreateCommand; result: CommandResult }>();
  const pending = useRef(false);
  const opened = useRef('');
  const unresolved = Object.values(ipcState?.blockedCommands ?? {}).find(a => a.command.type === 'session.create');
  const currentReceipt = receipt && !ipcState?.commands[receipt.command.requestId]?.reviewed ? receipt : undefined;
  const attempt = currentReceipt?.command ?? (unresolved?.command.type === 'session.create' ? unresolved.command : undefined);
  const result = currentReceipt ? ipcState?.commands[currentReceipt.command.requestId]?.result ?? currentReceipt.result : unresolved?.result;
  const confirmed = attempt && snapshot.sessions.find(session => session.id === attempt.sessionId);
  const agent = snapshot.agents.find(item => item.id === agentId);
  const model = snapshot.modelOptions.find(item => !item.hidden && `${item.runtime}:${item.model}` === modelKey);
  const parent = snapshot.sessions.find(item => item.id === parentId);
  const disabled = !store || ipcState?.connection !== 'ready' || snapshot.app.status === 'damaged' || !!unresolved || !!result?.ok || !!confirmed || !!(result && blocksResubmit(result));
  // A create receipt alone is not a usable session. Wait for the authoritative read/revision.
  useEffect(() => {
    if ((!result?.ok && unresolved?.createCheck !== 'found') || !confirmed || ipcState?.connection !== 'ready' || opened.current === confirmed.id) return;
    opened.current = confirmed.id;
    store?.acknowledge('session.create', `session:${confirmed.id}`);
    onOpen(confirmed.id);
  }, [result, confirmed, unresolved?.createCheck, ipcState?.connection, store, onOpen]);
  return <section className="workflow-start session-create" aria-label="新增 session">
    <p>選擇 Agent、Model 與工作資料夾，建立獨立對話。</p>
    {!store && <p className="command-warning">示意模式：連接應用程式服務後才能建立。</p>}
    {snapshot.agents.length === 0 && <p>尚無 Agent，請先到 Agent 管理建立。</p>}
    {snapshot.modelOptions.every(item => item.hidden) && <p>尚無可用 Model，請重新讀取資料。</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (disabled || pending.current || !agent || !model || !cwd.trim() || (parentId && !parent)) return;
      const command: CreateCommand = { type: 'session.create', requestId: RequestId.parse(crypto.randomUUID()), sessionId: SessionId.parse(crypto.randomUUID()),
        kind: 'ordinary', agentId: agent.id, model: { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) },
        cwd: cwd.trim(), ...(parent ? { parentId: parent.id } : {}),
      };
      setReceipt(undefined);
      pending.current = true;
      void store.send(command).then(result => { setReceipt({ command, result }); pending.current = false; });
    }}>
      <fieldset disabled={disabled}>
        <legend>Session 設定</legend>
        <label>Agent<select required value={agentId} onChange={event => onDraft({ ...draft, agentId: event.target.value })}>
          <option value="">選擇 Agent</option>
          {agentId && !agent && <option value={agentId}>Agent 已移除，請重新選擇</option>}
          {snapshot.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Model<select required value={modelKey} onChange={event => onDraft({ ...draft, modelKey: event.target.value })}>
          <option value="">選擇 Model</option>
          {modelKey && !model && <option value={modelKey}>Model 已不可用，請重新選擇</option>}
          {snapshot.modelOptions.filter(item => !item.hidden).map(item => <option key={`${item.runtime}:${item.model}`} value={`${item.runtime}:${item.model}`}>{item.displayName} · {item.runtime}</option>)}
        </select></label>
        <label>工作資料夾<input required value={cwd} onChange={event => onDraft({ ...draft, cwd: event.target.value })} placeholder="輸入完整資料夾路徑" /></label>
        <FolderButton disabled={disabled} onPick={cwd => onDraft({ ...draft, cwd })} />
        <label>上層 session（可選）<select value={parentId} onChange={event => onDraft({ ...draft, parentId: event.target.value })}>
          <option value="">無上層 session</option>
          {parentId && !parent && <option value={parentId}>上層 session 已不存在</option>}
          {snapshot.sessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select></label>
        <button className="primary" type="submit" disabled={!agent || !model || !cwd.trim() || (!!parentId && !parent)}>建立 session</button>
      </fieldset>
    </form>
    {attempt && <p className="mono">本次 session：{attempt.sessionId}</p>}
    {unresolved && !result && <p role="status">正在建立 session…</p>}
    {result && !result.ok && <p role="alert" className="command-warning">{commandFeedback(result)}（{result.code}）</p>}
    {attempt && (result?.ok || (result && blocksResubmit(result)) || confirmed) && <div>
      <p role="status">{confirmed ? '目前 session 資料中已有本次 ID；等待建立回覆或 Snapshot 核對完成。' : result?.ok ? '建立指令已接受，等待最新 session 資料。' : '建立結果待核對；未找到 session 不代表建立失敗，請勿重複建立。'}</p>
      <button disabled={!store || ipcState?.connection === 'loading'} onClick={() => void store?.reconnect()}>重新讀取資料並核對</button>
      {!confirmed && unresolved?.createCheck === 'missing' && <button disabled={ipcState?.connection !== 'ready'} onClick={() => {
        store?.acknowledge('session.create', `session:${attempt.sessionId}`);
      }}>我已確認沒有建立，重新填寫</button>}
    </div>}
  </section>;
}

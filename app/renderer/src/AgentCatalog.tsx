import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentId, CONTRACTS_VERSION } from '../../../contracts';
import type { AgentDefinition } from '../../../contracts';
import { agentSaveCommand } from './agent-repository';
import type { AgentRepository } from './agent-repository';
import type { AgentDemoControls } from './agent-demo';

interface Draft {
  agent: AgentDefinition;
  expectedRevision: number | null;
  attempted: boolean;
  pending: boolean;
  error: string;
  failNext: boolean;
}
const editDraft = (agent: AgentDefinition, expectedRevision: number | null): Draft => ({
  agent: { ...agent }, expectedRevision, attempted: false, pending: false, error: '', failNext: false,
});

export function DeleteConfirmation({ agent, onClose }: { agent: AgentDefinition; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector('button')?.focus();
    return () => { element?.close?.(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="agent-delete-heading" aria-describedby="agent-delete-description" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector('button')?.focus(); }
  }}>
    <span className="eyebrow">示意模式 · 刪除前確認</span>
    <h2 id="agent-delete-heading">刪除「{agent.name}」？</h2>
    <p id="agent-delete-description">目標：{agent.name} · revision {agent.revision}</p>
    <p className="mono">{agent.id}</p>
    <p>目前尚未提供刪除介面，無法確認刪除；此 Agent 仍會保留。</p>
    <div className="agent-actions"><button onClick={onClose}>取消</button><button disabled>確認刪除（尚未提供）</button></div>
  </dialog>;
}

export function AgentCatalog({ repository, demo, selectedId, visible, onSelect }: {
  repository: AgentRepository; demo?: AgentDemoControls; selectedId: string; visible: boolean; onSelect: (id: string) => void;
}) {
  const agents = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<AgentDefinition | null>(null);
  // Clear the modal with the visibility change, while retaining per-agent drafts.
  if (!visible && deleteTarget) setDeleteTarget(null);
  const id = selectedId || agents[0]?.id || '';
  const saved = agents.find(agent => agent.id === id);
  const draft = drafts[id];
  const agent = draft?.agent ?? saved;
  const stale = draft?.expectedRevision != null && saved?.revision !== draft.expectedRevision;
  const nameError = draft?.attempted && !draft.agent.name.trim();
  const instructionsError = draft?.attempted && !draft.agent.instructions.trim();
  const heading = useRef<HTMLHeadingElement>(null);
  const editor = useRef<HTMLElement>(null);
  const agentList = useRef<HTMLElement>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const editing = !!draft;
  const pending = draft?.pending;
  const error = draft?.error;
  useLayoutEffect(() => {
    if (!visible || pending) return;
    const target = (error || stale
      ? editor.current?.querySelector<HTMLElement>('[data-agent-feedback]')
      : editor.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?? (editing ? editor.current?.querySelector<HTMLElement>('#agent-name') : heading.current));
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [id, visible, editing, pending, error, stale, validationAttempt]);
  useEffect(() => {
    if (visible) agentList.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [id, visible]);

  const updateDraft = (target: string, patch: Partial<Draft>) => setDrafts(previous => {
    const existing = previous[target];
    return existing ? { ...previous, [target]: { ...existing, ...patch } } : previous;
  });
  const removeDraft = (target: string) => setDrafts(previous => {
    const next = { ...previous }; delete next[target]; return next;
  });
  const beginNew = (source?: AgentDefinition) => {
    const newAgent: AgentDefinition = {
      schemaVersion: CONTRACTS_VERSION, id: AgentId.parse(crypto.randomUUID()), revision: 0,
      name: source ? `${source.name}（複本）` : '', description: source?.description ?? '',
      instructions: source?.instructions ?? '', updatedAt: new Date().toISOString(),
    };
    setDrafts(previous => ({ ...previous, [newAgent.id]: editDraft(newAgent, null) }));
    onSelect(newAgent.id);
  };
  const save = async () => {
    if (!draft || draft.pending || stale) return;
    const target = draft.agent.id;
    updateDraft(target, { attempted: true, error: '' });
    if (!draft.agent.name.trim() || !draft.agent.instructions.trim()) { setValidationAttempt(attempt => attempt + 1); return; }
    const command = agentSaveCommand({ ...draft.agent, name: draft.agent.name.trim() }, draft.expectedRevision);
    updateDraft(target, { pending: true, failNext: false });
    try {
      const result = await repository.save(command);
      if (result.requestId !== command.requestId) {
        updateDraft(target, { pending: false, error: '無法核對儲存回覆，請保留草稿並重新確認狀態。' });
      } else if (result.ok) {
        removeDraft(target);
        setMessages(previous => ({ ...previous, [target]: `示意模式 · 已儲存「${command.agent.name}」，revision ${result.revision ?? '未回報'}。僅保留於本次開啟期間。` }));
      } else {
        updateDraft(target, { pending: false, error: result.message });
      }
    } catch {
      updateDraft(target, { pending: false, error: '儲存服務無法回應，草稿仍保留。' });
    }
  };

  const simulateExternalUpdate = async () => {
    if (!saved || !draft || draft.pending || stale) return;
    const target = saved.id;
    // Save the current fixture/user record again; the repository advances its revision.
    // Keep the editor's captured expectedRevision so the real conflict UI is exercised.
    updateDraft(target, { pending: true, error: '', failNext: false });
    demo?.setSaveFailure(target, false);
    try {
      const command = agentSaveCommand(saved, saved.revision);
      const result = await repository.save(command);
      updateDraft(target, { pending: false, error: result.requestId !== command.requestId
        ? '無法核對模擬更新回覆，請保留草稿並重新確認狀態。' : result.ok ? '' : result.message });
    } catch {
      updateDraft(target, { pending: false, error: '模擬更新無法完成，草稿仍保留。' });
    }
  };

  return <section className="agent-catalog" hidden={!visible} aria-label="Agent 管理內容">
    <header className="agent-catalog-header"><div><span className="eyebrow">設定 / Agents</span><h2>Agent 定義</h2><p className="muted">示意模式 · 變更僅保留於本次開啟期間</p></div><button className="primary" onClick={() => beginNew()}>＋ 建立 Agent</button></header>
    <div className="agent-catalog-body">
      <nav ref={agentList} className="agent-list" aria-label="Agent 清單"><h3>已設定 Agents <span className="count">{agents.length}</span></h3>
        {agents.length === 0 && <p className="empty-note">尚未建立 Agent，請新增工作角色。</p>}
        {agents.map(item => <button key={item.id} aria-current={id === item.id ? 'true' : undefined} onClick={() => onSelect(item.id)}><strong>{item.name}</strong><span>{item.description || '未填寫說明'}</span><small>revision {item.revision}{drafts[item.id] ? ' · 有未儲存草稿' : ''}</small></button>)}
        {Object.values(drafts).filter(item => item.expectedRevision === null).map(item => <button key={item.agent.id} aria-current={id === item.agent.id ? 'true' : undefined} onClick={() => onSelect(item.agent.id)}><strong>{item.agent.name || '未命名 Agent'}</strong><small>新增草稿 · 尚未儲存</small></button>)}
      </nav>
      <section ref={editor} className="agent-editor" aria-label="Agent 定義內容">
        {!agent ? <><h2 ref={heading} tabIndex={-1}>{id ? '找不到指定的 Agent' : '建立第一個 Agent'}</h2><p>{id ? `Agent ID：${id}` : '新增名稱、說明與指示，定義可重用的工作角色。'}</p></> : <>
          <div className="agent-editor-header"><div><h2 ref={heading} tabIndex={-1}>{draft ? (draft.expectedRevision === null ? '新增 Agent' : '編輯 Agent 定義') : agent.name}</h2><p className="muted">{draft ? '尚未儲存' : `revision ${agent.revision}`}</p></div>
            {!draft && <div className="agent-actions"><button onClick={() => { setDrafts(previous => ({ ...previous, [agent.id]: editDraft(agent, agent.revision) })); setMessages(previous => ({ ...previous, [agent.id]: '' })); }}>編輯</button><button onClick={() => beginNew(agent)}>複製</button><button onClick={() => setDeleteTarget(agent)}>刪除</button></div>}
          </div>
          {messages[id] && !draft && <p className="agent-feedback" role="status">{messages[id]}</p>}
          {draft ? <form noValidate aria-label="Agent 編輯表單" aria-busy={draft.pending} onSubmit={event => { event.preventDefault(); void save(); }}>
            {stale && <div className="agent-feedback" data-agent-feedback tabIndex={-1} role="alert"><p>版本已變更：草稿基於 revision {draft.expectedRevision}，目前為 {saved?.revision ?? '不存在'}。草稿未被覆蓋，請比對後再處理。</p>{saved && <><details><summary>比對目前已儲存版本</summary><dl className="agent-definition"><dt>名稱</dt><dd>{saved.name}</dd><dt>說明</dt><dd>{saved.description || '未填寫說明'}</dd><dt>指示</dt><dd>{saved.instructions}</dd></dl></details><button type="button" disabled={draft.pending} onClick={() => updateDraft(id, { agent: { ...agent, revision: saved.revision }, expectedRevision: saved.revision, error: '' })}>已比對，保留草稿並以 revision {saved.revision} 重新編輯</button></>}</div>}
            {draft.error && <p className="field-error" data-agent-feedback tabIndex={-1} role="alert">示意模式 · {draft.error}</p>}
            <fieldset disabled={draft.pending}>
              <label htmlFor="agent-name">名稱（必填）</label><input id="agent-name" value={agent.name} aria-invalid={!!nameError} aria-describedby={nameError ? 'agent-name-error' : undefined} onChange={event => updateDraft(id, { agent: { ...agent, name: event.target.value } })} />
              {nameError && <p id="agent-name-error" className="field-error" role="alert">請填寫名稱。</p>}
              <label htmlFor="agent-description">說明</label><textarea id="agent-description" rows={2} value={agent.description} onChange={event => updateDraft(id, { agent: { ...agent, description: event.target.value } })} />
              <label htmlFor="agent-instructions">指示（必填）</label><textarea id="agent-instructions" rows={7} value={agent.instructions} aria-invalid={!!instructionsError} aria-describedby={instructionsError ? 'agent-instructions-error' : undefined} onChange={event => updateDraft(id, { agent: { ...agent, instructions: event.target.value } })} />
              {instructionsError && <p id="agent-instructions-error" className="field-error" role="alert">請填寫指示。</p>}
            </fieldset>
            <p className="agent-boundary-note">Model 由 Workflow 節點或 session 的獨立選擇器指定。</p>
            <details className="agent-demo-controls"><summary>示意模式測試</summary>{demo && <label><input type="checkbox" checked={draft.failNext} disabled={draft.pending} onChange={event => { demo.setSaveFailure(id, event.target.checked); updateDraft(id, { failNext: event.target.checked }); }} />下次儲存模擬失敗</label>}{saved && <button type="button" disabled={draft.pending || stale} onClick={() => { void simulateExternalUpdate(); }}>模擬他人已更新此 Agent</button>}</details>
            <div className="agent-actions agent-form-actions"><span role="status">{draft.pending ? '示意模式 · 儲存中…' : '草稿尚未儲存'}</span><button type="button" disabled={draft.pending} onClick={() => { demo?.setSaveFailure(id, false); removeDraft(id); if (!saved) onSelect(''); }}>取消編輯</button><button type="submit" className="primary" disabled={draft.pending || stale}>儲存</button></div>
          </form> : <><dl className="agent-definition"><dt>名稱</dt><dd>{agent.name}</dd><dt>說明</dt><dd>{agent.description || '未填寫說明'}</dd><dt>指示</dt><dd>{agent.instructions}</dd></dl><p className="agent-boundary-note">Model 由 Workflow 節點或 session 的獨立選擇器指定。</p><p className="muted">更新時間：<time dateTime={agent.updatedAt}>{new Date(agent.updatedAt).toLocaleString('zh-TW', { hour12: false })}</time></p></>}
        </>}
      </section>
    </div>
    {deleteTarget && visible && <DeleteConfirmation agent={deleteTarget} onClose={() => setDeleteTarget(null)} />}
  </section>;
}

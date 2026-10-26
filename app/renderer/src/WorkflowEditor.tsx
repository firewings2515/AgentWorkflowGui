import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NodeId } from '../../../contracts';
import type { AgentDefinition, ModelOption, WorkflowNode, WorkflowTemplate } from '../../../contracts';
import type { WorkflowRepository } from './workflow-repository';
import { workflowSaveCommand } from './workflow-repository';
import type { WorkflowDemoControls } from './workflow-demo';
import { connectNodes, isolationLabels, removeGraphSelection, replaceNode, setRoot, updateDraftGraph, workflowIssues } from './workflow-editor-state';
import type { GraphSelection, WorkflowIssue } from './workflow-editor-state';
import { workflowIssueLabel } from './workflow-validation';
import { WorkflowInspector, WorkflowSettings, workflowFieldId } from './WorkflowInspector';
import { NODE_DRAG_TYPE, WorkflowCanvas } from './workflow-canvas/WorkflowCanvas';
import './workflow-editor.css';

interface Draft {
  workflow: WorkflowTemplate; expectedRevision: number; dirty: boolean; selection: GraphSelection;
  pending: boolean; error: string; message: string; attempted: boolean; failNext: boolean; conflict: boolean;
  automaticEdges: string[];
  deletedEdges: string[]; connectionTarget: string;
}
const newDraft = (workflow: WorkflowTemplate): Draft => ({
  workflow: structuredClone(workflow), expectedRevision: workflow.revision, dirty: false, selection: null,
  pending: false, error: '', message: '', attempted: false, failNext: false, conflict: false,
  automaticEdges: [], deletedEdges: [], connectionTarget: '',
});

function DeleteGraphDialog({ workflow, selection, onCancel, onConfirm }: {
  workflow: WorkflowTemplate; selection: NonNullable<GraphSelection>; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const after = removeGraphSelection(workflow, selection);
  const removedRules = workflow.nodes.flatMap(node => node.outputRules.filter(rule => rule.target.kind === 'node' &&
    (selection.kind === 'node' ? rule.target.nodeId === selection.id && node.id !== selection.id : node.id === selection.source && rule.target.nodeId === selection.target))
    .map(rule => `${node.label}：${rule.condition || '未填條件'}`));
  const node = selection.kind === 'node' ? workflow.nodes.find(node => node.id === selection.id) : undefined;
  const name = (id: string) => workflow.nodes.find(node => node.id === id)?.label ?? id;
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector('button')?.focus();
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="workflow-delete-title" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(dialog.current?.querySelectorAll('button') ?? []);
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <h2 id="workflow-delete-title">刪除{selection.kind === 'node' ? `節點「${node?.label ?? selection.id}」` : `連線「${name(selection.source)} → ${name(selection.target)}」`}？</h2>
    <p>將移除 {workflow.nodes.length - after.nodes.length} 個節點、{workflow.edges.length - after.edges.length} 條連線。節點本身的規則會一併移除。</p>
    {removedRules.length > 0 && <><p>以下指向此目的地的 Output 規則也將移除：</p><ul>{removedRules.map((rule, index) => <li key={index}>{rule}</li>)}</ul></>}
    {node?.kind === 'agent' && node.isRoot && <p className="field-error">這是 root；刪除後須在範本設定指定另一個 Agent 節點才能儲存。</p>}
    <div className="workflow-actions"><button onClick={onCancel}>取消刪除</button><button onClick={onConfirm}>確認刪除</button></div>
  </dialog>;
}

export function WorkflowEditor({ repository, demo, agents, models, selectedId, visible, onSelect }: {
  repository: WorkflowRepository; demo?: WorkflowDemoControls; agents: readonly AgentDefinition[]; models: readonly ModelOption[];
  selectedId: string; visible: boolean; onSelect: (id: string) => void;
}) {
  const workflows = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<GraphSelection>(null);
  const [renderedId, setRenderedId] = useState(selectedId);
  const [focusRequest, setFocusRequest] = useState<{ id: string; field: string; sequence: number } | null>(null);
  const consumedFocus = useRef(0);
  const shell = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  const locks = useRef(new Set<string>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saved = workflows.find(workflow => workflow.id === selectedId);
  if (renderedId !== selectedId) { setRenderedId(selectedId); setDeleteTarget(null); }
  let draft = drafts[selectedId];
  if (saved && !draft) {
    const initialized = newDraft(saved);
    draft = initialized;
    setDrafts(previous => ({ ...previous, [selectedId]: initialized }));
  }
  if ((!visible || (deleteTarget && !draft)) && deleteTarget) setDeleteTarget(null);
  const workflow = draft?.workflow;
  const selection = draft?.selection ?? null;
  const selectedNode = selection?.kind === 'node' ? workflow?.nodes.find(node => node.id === selection.id) : undefined;
  const stale = !!draft && (draft.conflict || saved?.revision !== draft.expectedRevision);
  const issues = draft?.attempted && workflow ? workflowIssues(workflow) : [];
  const pending = draft?.pending ?? false;
  const error = draft?.error;

  useLayoutEffect(() => { if (visible) heading.current?.focus(); }, [visible, selectedId]);
  useLayoutEffect(() => {
    if (!visible || pending || (!stale && !error)) return;
    shell.current?.querySelector<HTMLElement>('[data-workflow-feedback]')?.focus();
  }, [visible, selectedId, pending, stale, error]);
  useLayoutEffect(() => {
    if (!focusRequest || consumedFocus.current === focusRequest.sequence) return;
    consumedFocus.current = focusRequest.sequence;
    if (!visible || focusRequest.id !== selectedId) return;
    let path = focusRequest.field;
    let target = path.startsWith('graph:')
      ? Array.from(shell.current?.querySelectorAll<HTMLElement>('[data-graph-key]') ?? []).find(element => element.dataset.graphKey === path.slice(6)) ?? null
      : document.getElementById(workflowFieldId(path));
    while (!target && path.includes('.')) { path = path.slice(0, path.lastIndexOf('.')); target = document.getElementById(workflowFieldId(path)); }
    (target ?? inspectorHeading.current)?.focus();
    (target ?? inspectorHeading.current)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusRequest, selectedId, visible]);

  const patch = (id: string, value: Partial<Draft>) => setDrafts(previous => {
    const current = previous[id];
    return current ? { ...previous, [id]: { ...current, ...value } } : previous;
  });
  const change = (value: WorkflowTemplate, manualEdge?: { source: string; target: string }) => {
    if (!pending && draft && workflow) patch(selectedId, { ...updateDraftGraph(workflow, value, draft.automaticEdges, saved?.edges ?? [], manualEdge, draft.deletedEdges), dirty: true, message: '', error: '' });
  };
  const connect = (source: string, target: string) => { if (workflow) change(connectNodes(workflow, source, target), { source, target }); };
  const select = (value: GraphSelection) => { patch(selectedId, { selection: value, connectionTarget: '' }); setDeleteTarget(null); };
  const requestFocus = (field: string) => setFocusRequest(previous => ({ id: selectedId, field, sequence: (previous?.sequence ?? 0) + 1 }));
  const jumpToIssue = (issue: WorkflowIssue) => {
    const edge = issue.path.startsWith('edges.') ? workflow?.edges[Number(issue.path.split('.')[1])] : undefined;
    select(issue.nodeId ? { kind: 'node', id: issue.nodeId } : edge ? { kind: 'edge', ...edge } : null);
    requestFocus(issue.path || 'nodes');
  };
  const save = async (externalUpdate = false) => {
    if (!draft || !workflow || pending || stale || locks.current.has(selectedId)) return;
    if (!externalUpdate) {
      const errors = workflowIssues(workflow);
      patch(selectedId, { attempted: true });
      if (errors[0]) { jumpToIssue(errors[0]); return; }
    }
    const target = selectedId;
    const command = workflowSaveCommand(externalUpdate && saved ? saved : workflow, draft.expectedRevision);
    locks.current.add(target);
    patch(target, { pending: true, error: '', message: '' });
    if (externalUpdate) { demo?.setSaveFailure(target, false); patch(target, { failNext: false }); }
    try {
      const result = await repository.save(command);
      if (!mounted.current) return;
      if (result.requestId !== command.requestId) patch(target, { pending: false, error: '無法核對儲存回覆，草稿仍保留，請重新確認狀態。' });
      else if (!result.ok) patch(target, { pending: false, error: result.message, conflict: result.code === 'stale_revision' });
      else if (externalUpdate) patch(target, { pending: false });
      else {
        const record = repository.getSnapshot().find(item => item.id === target);
        if (result.revision === undefined) patch(target, { pending: false, error: '儲存回覆缺少 revision，草稿仍保留，請重新確認狀態。' });
        else patch(target, {
          workflow: record?.revision === result.revision ? structuredClone(record) : { ...command.workflow, revision: result.revision },
          expectedRevision: result.revision, pending: false, dirty: false, attempted: false, conflict: false,
          automaticEdges: [], deletedEdges: [], connectionTarget: '',
          message: `示意模式 · 已儲存「${command.workflow.name}」，revision ${result.revision}。僅保留於本次開啟期間。`,
        });
      }
    } catch { if (mounted.current) patch(target, { pending: false, error: '儲存服務無法回應，草稿仍保留。' }); }
    finally { locks.current.delete(target); if (mounted.current && demo) patch(target, { failNext: demo.hasSaveFailure(target) }); }
  };

  const defaultModel = models.find(model => !model.hidden && model.isDefault) ?? models.find(model => !model.hidden);
  const addNode = (kind: WorkflowNode['kind'], position?: WorkflowNode['position']) => {
    if (!workflow || pending) return;
    const base = {
      id: NodeId.parse(crypto.randomUUID()), label: kind === 'agent' ? '新增 Agent' : '新增合併',
      writePolicy: 'write' as const, concurrency: 1, inputRules: [], outputRules: [],
      position: position ?? { x: 80 + workflow.nodes.length * 40, y: 320 },
    };
    let node: WorkflowNode;
    if (kind === 'agent') {
      const agent = agents[0];
      if (!agent || !defaultModel) return;
      node = { ...base, kind, agentId: agent.id, isRoot: !workflow.nodes.some(node => node.kind === 'agent' && node.isRoot), model: {
        runtime: defaultModel.runtime, model: defaultModel.model, ...(defaultModel.defaultEffort ? { effort: defaultModel.defaultEffort } : {}),
      } };
    } else node = { ...base, kind };
    change({ ...workflow, nodes: [...workflow.nodes, node] });
    select({ kind: 'node', id: node.id });
    requestFocus(`nodes.${workflow.nodes.length}.label`);
  };

  return <section ref={shell} className="workflow-editor" hidden={!visible} aria-label="Workflow 編輯內容">
    <header className="workflow-toolbar"><div><span className="eyebrow">設定 / Workflow</span><h2 ref={heading} tabIndex={-1}>{workflow?.name || (workflow ? '未命名 Workflow' : '找不到指定的 Workflow 範本')}</h2>
      <p className="muted">{workflow ? `revision ${draft?.expectedRevision} · ${draft?.dirty ? '有未儲存草稿' : '已載入範本'}` : workflows.length ? `範本 ID：${selectedId}` : '尚無 Workflow 範本'}</p></div>
      <div className="workflow-actions"><label>範本<select aria-label="Workflow 範本" value={saved?.id ?? ''} onChange={event => { setDeleteTarget(null); onSelect(event.target.value); }}><option disabled value="">選取範本</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}{drafts[item.id]?.dirty ? ' · 草稿' : ''}</option>)}</select></label>
        {workflow && <button className="primary" disabled={pending || stale} onClick={() => { void save(); }}>{pending ? '儲存中…' : '儲存 Workflow'}</button>}
      </div>
    </header>
    {draft && workflow && <>
      <div className="workflow-feedback-area">
        {draft.message && <p role="status">{draft.message}</p>}
        {stale && <div className="workflow-feedback" data-workflow-feedback role="alert" tabIndex={-1}>
          <p>版本已變更：草稿基於 revision {draft.expectedRevision}，目前為 {saved?.revision ?? '不存在'}。草稿未被覆蓋，請比對後再處理。</p>
          {saved && <><details><summary>比對草稿與目前已儲存版本</summary><div className="workflow-comparison"><div><h3>你的草稿</h3><pre>{JSON.stringify(workflow, null, 2)}</pre></div><div><h3>目前已儲存版本</h3><pre>{JSON.stringify(saved, null, 2)}</pre></div></div></details>
            <button disabled={pending || saved.revision === draft.expectedRevision} onClick={() => { patch(selectedId, { workflow: { ...workflow, revision: saved.revision }, expectedRevision: saved.revision, dirty: true, error: '', conflict: false }); requestFocus('name'); }}>已比對，保留草稿並以 revision {saved.revision} 重新編輯</button>
            <button disabled={pending} onClick={() => { demo?.setSaveFailure(selectedId, false); patch(selectedId, newDraft(saved)); setDeleteTarget(null); requestFocus('name'); }}>捨棄草稿、改用已儲存版本</button></>}
        </div>}
        {error && <p className="field-error" data-workflow-feedback role="alert" tabIndex={-1}>{error}</p>}
        {issues.length > 0 && <div className="workflow-validation" role="alert"><strong>請修正 {issues.length} 項驗證錯誤：</strong>{issues.map((issue, index) => <button key={index} onClick={() => jumpToIssue(issue)}>{workflowIssueLabel(workflow, issue)}：{issue.message}</button>)}</div>}
      </div>
      <div className="workflow-body">
        <div className="workflow-graph-panel">
          <div className="workflow-palette" aria-label="新增節點"><span>拖入畫布或按鈕新增</span>{(['agent', 'merge'] as const).map(kind => <button key={kind} disabled={pending || (kind === 'agent' && (!agents.length || !defaultModel))} draggable={!pending} onDragStart={event => { event.dataTransfer.setData(NODE_DRAG_TYPE, kind); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addNode(kind)}>＋ {kind === 'agent' ? 'Agent 節點' : '合併節點'}</button>)}
            {(!agents.length || !defaultModel) && <small>新增 Agent 節點需要 Agent 與 Model 選項。</small>}
          </div>
          <p className="workflow-legend">{isolationLabels[workflow.isolation]} · root 為升級對象 · 箭頭代表允許交接 · 拖曳空白處平移</p>
          {visible && <WorkflowCanvas key={selectedId} workflow={workflow} selection={selection} disabled={pending} onChange={change} onSelect={select}
            onConnect={connect} onAdd={addNode} onDelete={setDeleteTarget} />}
          <nav className="workflow-graph-list" aria-label="圖形選取"><button id={workflowFieldId('graph-settings')} aria-pressed={!selection} onClick={() => { select(null); requestFocus('name'); }}>範本設定</button>
            {workflow.nodes.map(node => <button key={node.id} data-graph-key={JSON.stringify({ kind: 'node', id: node.id })} aria-pressed={selection?.kind === 'node' && selection.id === node.id} onClick={() => { select({ kind: 'node', id: node.id }); requestFocus(`nodes.${workflow.nodes.indexOf(node)}.label`); }} onKeyDown={event => { if (!pending && event.key === 'Delete') { event.preventDefault(); setDeleteTarget({ kind: 'node', id: node.id }); } }}>{node.label || '未命名節點'}{node.kind === 'agent' && node.isRoot ? ' · root' : ''}</button>)}
            <details open={selection?.kind === 'edge' || undefined}><summary>連線（{workflow.edges.length}）</summary>{workflow.edges.map(edge => <button key={JSON.stringify([edge.source, edge.target])} data-graph-key={JSON.stringify({ kind: 'edge', ...edge })} aria-pressed={selection?.kind === 'edge' && selection.source === edge.source && selection.target === edge.target} onClick={() => { select({ kind: 'edge', ...edge }); requestFocus('edge'); }} onKeyDown={event => { if (!pending && event.key === 'Delete') { event.preventDefault(); setDeleteTarget({ kind: 'edge', ...edge }); } }}>{workflow.nodes.find(node => node.id === edge.source)?.label} → {workflow.nodes.find(node => node.id === edge.target)?.label}</button>)}</details>
          </nav>
        </div>
        <aside className="workflow-inspector" aria-label="Workflow 屬性檢視器"><h3 ref={inspectorHeading} tabIndex={-1}>{selectedNode ? `節點：${selectedNode.label}` : selection?.kind === 'edge' ? '連線設定' : '範本設定'}</h3>
          <fieldset className="workflow-inspector-fields" disabled={pending}>
            {selectedNode ? <WorkflowInspector key={selectedNode.id} workflow={workflow} node={selectedNode} agents={agents} models={models} issues={issues} onChange={(node, applyDestination = false) => change(replaceNode(workflow, node, applyDestination))} />
              : selection?.kind === 'edge' ? <>
                <p>此連線允許兩個節點交接。條件、內容及目的地請在來源節點的 Output 規則設定。</p>
                <h4>經過此連線的 Output 規則</h4>
                {workflow.nodes.find(node => node.id === selection.source)?.outputRules.some(rule => rule.target.kind === 'node' && rule.target.nodeId === selection.target)
                  ? <ul>{workflow.nodes.flatMap((node, nodeIndex) => node.id !== selection.source ? [] : node.outputRules.flatMap((rule, ruleIndex) => rule.target.kind !== 'node' || rule.target.nodeId !== selection.target ? [] : <li key={rule.id}>
                    <button onClick={() => { select({ kind: 'node', id: node.id }); requestFocus(`nodes.${nodeIndex}.outputRules.${ruleIndex}.condition`); }}>{node.label} · Output {ruleIndex + 1}：{rule.condition || '未填條件'}</button>
                    <p>送出：{rule.payload || '未填內容'}</p><p>{rule.requiresUserConfirmation ? '經 root 請使用者確認' : '不需使用者確認'}</p>
                  </li>))}</ul> : <p>目前沒有 Output 規則使用此連線。</p>}
              </>
                : <WorkflowSettings workflow={workflow} issues={issues} onChange={change} onRoot={id => change(setRoot(workflow, id))} />}
            {selectedNode && <div className="workflow-keyboard-connect"><h4>新增連線</h4><label htmlFor="workflow-connect-target">連接到節點</label><select id="workflow-connect-target" value={draft.connectionTarget} onChange={event => patch(selectedId, { connectionTarget: event.target.value })}><option value="">選取目的地</option>{workflow.nodes.filter(node => node.id !== selectedNode.id).map(node => <option key={node.id} value={node.id}>{node.label}{workflow.edges.some(edge => edge.source === selectedNode.id && edge.target === node.id) ? '（已連線，可保留為手動連線）' : '（保留手動連線）'}</option>)}</select>
              <button type="button" disabled={!draft.connectionTarget} onClick={() => { connect(selectedNode.id, draft.connectionTarget); patch(selectedId, { connectionTarget: '' }); }}>新增連線</button><p className="muted">選好目的地後按「新增連線」。也可在畫布從右側圓點拉線到另一節點左側。</p></div>}
            {selection && <button className="workflow-delete" onClick={() => setDeleteTarget(selection)}>刪除所選{selection.kind === 'node' ? '節點' : '連線'}</button>}
          </fieldset>
          {demo && <details className="workflow-demo"><summary>示意模式測試</summary><label className="workflow-check"><input type="checkbox" disabled={pending} checked={draft.failNext} onChange={event => { demo.setSaveFailure(selectedId, event.target.checked); patch(selectedId, { failNext: event.target.checked }); }} />下次儲存模擬失敗</label><button disabled={pending || stale} onClick={() => { void save(true); }}>模擬他人已更新此 Workflow</button></details>}
          <p className="muted workflow-help">Tab 移動焦點；畫布節點可按 Enter 選取、方向鍵移動、Delete 刪除。Model 只作新 session 的初始設定。</p>
        </aside>
      </div>
    </>}
    {visible && workflow && deleteTarget && <DeleteGraphDialog workflow={workflow} selection={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={() => {
      const after = removeGraphSelection(workflow, deleteTarget);
      let next: GraphSelection = null;
      if (deleteTarget.kind === 'edge') {
        const index = workflow.edges.findIndex(edge => edge.source === deleteTarget.source && edge.target === deleteTarget.target);
        const edge = after.edges[Math.min(index, after.edges.length - 1)];
        if (edge) next = { kind: 'edge', ...edge };
      }
      if (!next) {
        const index = deleteTarget.kind === 'node' ? workflow.nodes.findIndex(node => node.id === deleteTarget.id) : 0;
        const node = after.nodes[Math.min(index, after.nodes.length - 1)];
        if (node) next = { kind: 'node', id: node.id };
      }
      change(after); select(next); requestFocus(next ? `graph:${JSON.stringify(next)}` : 'graph-settings');
    }} />}
  </section>;
}

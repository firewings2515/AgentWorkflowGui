import { readOnlyProps } from './read-only';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NodeId } from '../../../contracts';
import type { AgentDefinition, BuiltinTemplateKey, ModelOption, RuntimeStatus, WorkflowInstance, WorkflowNode, WorkflowTemplate } from '../../../contracts';
import type { WorkflowRepository } from './workflow-repository';
import { addStarterCommand, workflowDeleteCommand, workflowSaveCommand } from './workflow-repository';
import type { WorkflowDemoControls } from './workflow-demo';
import { blocksResubmit, commandFeedback, unknownResult } from './command-feedback';
import { connectNodes, copyWorkflowDraft, createWorkflowDraft, defaultModelOption, destinationKey, destinationValue, isolationLabels, needsAgent, removeGraphSelection, replaceNode, setRoot, updateDraftGraph, workflowIssues } from './workflow-editor-state';
import type { GraphSelection, WorkflowIssue } from './workflow-editor-state';
import { workflowIssueLabel } from './workflow-validation';
import { WorkflowInspector, WorkflowSettings, workflowFieldId } from './WorkflowInspector';
import { NODE_DRAG_TYPE, WorkflowCanvas } from './workflow-canvas/WorkflowCanvas';
import { TEMPLATE_LIBRARY, type LibraryEntry } from './template-library';
import './workflow-editor.css';

interface Draft {
  /** null: a new template (T063), saved with `expectedRevision: null`. */
  workflow: WorkflowTemplate; expectedRevision: number | null; dirty: boolean; selection: GraphSelection;
  pending: boolean; error: string; message: string; attempted: boolean; failNext: boolean; conflict: boolean;
  automaticEdges: string[];
  deletedEdges: string[]; connectionTarget: string;
  destinationChoices: Record<string, string>; destinationPrompt: boolean;
  blocked: boolean;
  warning: boolean;
}
const newDraft = (workflow: WorkflowTemplate): Draft => ({
  workflow: structuredClone(workflow), expectedRevision: workflow.revision, dirty: false, selection: null,
  pending: false, error: '', message: '', attempted: false, failNext: false, conflict: false,
  automaticEdges: [], deletedEdges: [], connectionTarget: '',
  destinationChoices: {}, destinationPrompt: false, blocked: false, warning: false,
});
/** A new or copied template (T063): a draft only, counted once saved. */
const unsavedDraft = (workflow: WorkflowTemplate): Draft => ({ ...newDraft(workflow), expectedRevision: null, dirty: true });

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

/** T063: deleting a whole template, as the node dialog does it. Runs not ended are listed; they keep the template. */
function DeleteTemplateDialog({ workflow, dirty, running, onCancel, onConfirm }: {
  workflow: WorkflowTemplate; dirty: boolean; running: readonly WorkflowInstance[]; onCancel: () => void; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector('button')?.focus();
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="workflow-template-delete-title" onCancel={event => { event.preventDefault(); onCancel(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <h2 id="workflow-template-delete-title">刪除範本「{workflow.name}」？</h2>
    <p>範本會從清單移除，無法復原。已結束的執行會保留，仍可打開查看。</p>
    {dirty && <p>這個範本的未儲存草稿也會一併捨棄。</p>}
    {running.length > 0 && <div className="field-error" role="alert"><p>有 {running.length} 個還沒結束的執行使用這個範本，請先完成或取消後再刪除：</p><ul>{running.map(run => <li key={run.id}>{run.title}</li>)}</ul></div>}
    <div className="workflow-actions"><button onClick={onCancel}>取消</button><button className="workflow-danger" disabled={running.length > 0} onClick={onConfirm}>確認刪除範本</button></div>
  </dialog>;
}

/**
 * T070: the template library. The starter template and the eight built-in ones, each with what it suits, its node flow
 * and whether it needs a git repository; one not in the list yet is added (its own Agents with it), one there already is
 * opened. Read-only data: nothing is added, opening still works.
 */
function TemplateLibraryDialog({ workflows, readOnly, pending, errors, onAdd, onOpen, onClose }: {
  workflows: readonly WorkflowTemplate[]; readOnly: boolean; pending: BuiltinTemplateKey | null; errors: Partial<Record<BuiltinTemplateKey, string>>;
  onAdd: (entry: LibraryEntry) => void; onOpen: (entry: LibraryEntry) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => { element?.close?.(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const writeProps = readOnlyProps(readOnly);
  return <dialog ref={dialog} className="workflow-library" aria-labelledby="workflow-library-title" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  }}>
    <h2 id="workflow-library-title">範本庫</h2>
    <p>內建範本不綁專案。加入後會放進範本清單，連同它用到的 Agent，之後可以自己修改。</p>
    {readOnly && <p className="storage-banner" role="status">唯讀模式：無法加入範本。</p>}
    <ul className="workflow-library-list">
      {TEMPLATE_LIBRARY.map(entry => {
        const added = workflows.some(item => item.id === entry.workflowId);
        const error = errors[entry.key];
        return <li key={entry.key} aria-labelledby={`workflow-library-${entry.key}`}>
          <div className="workflow-library-head"><h3 id={`workflow-library-${entry.key}`}>{entry.name}</h3>{entry.needsGit && <span className="workflow-library-tag">需要 git repo</span>}</div>
          <p className="muted">{entry.summary}</p>
          <div className="workflow-actions">
            {added ? <><span className="workflow-library-added">已加入</span><button type="button" aria-label={`打開「${entry.name}」`} onClick={() => onOpen(entry)}>打開</button></>
              : <button type="button" {...writeProps} aria-label={`加入「${entry.name}」`} disabled={readOnly || pending !== null} onClick={() => onAdd(entry)}>{pending === entry.key ? '加入中…' : '加入'}</button>}
          </div>
          {error && <p className="field-error" role="alert">{error}</p>}
        </li>;
      })}
    </ul>
    <div className="workflow-actions"><button type="button" onClick={onClose}>關閉</button></div>
  </dialog>;
}

export function WorkflowEditor({ repository, demo, agents, models, runtimes = [], selectedId, visible, onSelect, readOnly = false, instances = [], onOpenAgents, newTemplateRequest = 0 }: {
  readOnly?: boolean; repository: WorkflowRepository; demo?: WorkflowDemoControls | undefined; agents: readonly AgentDefinition[]; models: readonly ModelOption[]; runtimes?: readonly RuntimeStatus[];
  selectedId: string; visible: boolean; onSelect: (id: string) => void;
  /** T063: the runs, to tell which ones still use a template before it is deleted. */
  instances?: readonly WorkflowInstance[];
  /** T063: opens the Agent page (a new template needs an Agent). */
  onOpenAgents?: () => void;
  /** T063: a new value asks for a new template (「開始 Workflow」's 「新增範本」). */
  newTemplateRequest?: number;
}) {
  const workflows = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
  const isDemo = repository.mode === 'demo';
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [deleteTarget, setDeleteTarget] = useState<GraphSelection>(null);
  const [deleteTemplate, setDeleteTemplate] = useState(false);
  const [notice, setNotice] = useState('');
  const [library, setLibrary] = useState<{ open: boolean; pending: BuiltinTemplateKey | null; errors: Partial<Record<BuiltinTemplateKey, string>> }>({ open: false, pending: null, errors: {} });
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
  if (renderedId !== selectedId) { setRenderedId(selectedId); setDeleteTarget(null); setDeleteTemplate(false); }
  let draft = drafts[selectedId];
  if (saved && !draft) {
    const initialized = newDraft(saved);
    draft = initialized;
    setDrafts(previous => ({ ...previous, [selectedId]: initialized }));
  }
  if ((!visible || (deleteTarget && !draft)) && deleteTarget) setDeleteTarget(null);
  if ((!visible || !saved) && deleteTemplate) setDeleteTemplate(false);
  const workflow = draft?.workflow;
  const selection = draft?.selection ?? null;
  const selectedNode = selection?.kind === 'node' ? workflow?.nodes.find(node => node.id === selection.id) : undefined;
  const isNew = draft?.expectedRevision === null;
  // A new template is stale only when its save says so (its ID was taken meanwhile).
  const stale = !!draft && (draft.conflict || (!isNew && saved?.revision !== draft.expectedRevision));
  const issues = draft?.attempted && workflow ? workflowIssues(workflow) : [];
  const pending = draft?.pending ?? false;
  const error = draft?.error;
  const unapplied = workflow?.nodes.flatMap((node, nodeIndex) => node.outputRules.flatMap((rule, ruleIndex) => {
    const key = destinationKey(node.id, rule.id);
    const value = draft?.destinationChoices[key];
    return value && value !== destinationValue(rule.target) ? [{ key, value, node, rule, nodeIndex, ruleIndex }] : [];
  })) ?? [];

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
  /** T063: a new or copied template, as a draft that counts only once saved. */
  const startDraft = (value: WorkflowTemplate) => {
    if (readOnly) return;
    setDrafts(previous => ({ ...previous, [value.id]: unsavedDraft(value) }));
    setNotice('');
    onSelect(value.id);
  };
  const createNew = () => startDraft(createWorkflowDraft(agents, models));
  const createNewRef = useRef(createNew);
  useEffect(() => { createNewRef.current = createNew; });
  const handledRequest = useRef(newTemplateRequest);
  useEffect(() => {
    if (newTemplateRequest === handledRequest.current) return;
    handledRequest.current = newTemplateRequest;
    createNewRef.current();
  }, [newTemplateRequest]);
  const forget = (id: string) => setDrafts(previous => { const next = { ...previous }; delete next[id]; return next; });
  const discardNew = () => { forget(selectedId); onSelect(workflows[0]?.id ?? ''); };
  const removeTemplate = async () => {
    if (readOnly || !saved || !draft || pending || locks.current.has(selectedId)) return;
    const target = selectedId;
    const command = workflowDeleteCommand(saved);
    setDeleteTemplate(false);
    locks.current.add(target);
    patch(target, { pending: true, error: '', message: '' });
    try {
      const result = await repository.delete(command);
      if (!mounted.current) return;
      // Gone already (a repeat, or deleted elsewhere): nothing is left to keep.
      if (result.ok || result.code === 'not_found') {
        forget(target);
        setNotice(result.ok ? `已刪除範本「${saved.name}」。` : `範本「${saved.name}」已不存在。`);
        onSelect(repository.getSnapshot().find(item => item.id !== target)?.id ?? '');
      } else patch(target, { pending: false, blocked: blocksResubmit(result), warning: result.code === 'unknown_outcome', error: isDemo ? result.message : commandFeedback(result, 'workflow.delete') });
    } catch { if (mounted.current) patch(target, { pending: false, error: '刪除服務無法回應，範本仍保留。' }); }
    finally { locks.current.delete(target); }
  };
  // T070: the template library (T063's starter button became its entry). Absent in the demo, which has no core to make them.
  const libraryAvailable = !!repository.addStarter;
  const addFromLibrary = async (entry: LibraryEntry) => {
    if (readOnly || !repository.addStarter || library.pending !== null) return;
    setLibrary(previous => ({ ...previous, pending: entry.key, errors: { ...previous.errors, [entry.key]: '' } }));
    try {
      const result = await repository.addStarter(addStarterCommand(entry.key));
      if (!mounted.current) return;
      if (!result.ok) { setLibrary(previous => ({ ...previous, pending: null, errors: { ...previous.errors, [entry.key]: commandFeedback(result) } })); return; }
      setLibrary({ open: false, pending: null, errors: {} });
      setNotice(`已加入範本「${entry.name}」。`);
      onSelect(entry.workflowId);
    } catch { if (mounted.current) setLibrary(previous => ({ ...previous, pending: null, errors: { ...previous.errors, [entry.key]: '服務無法回應，範本沒有加入。' } })); }
  };
  const openFromLibrary = (entry: LibraryEntry) => {
    setLibrary({ open: false, pending: null, errors: {} });
    setNotice('');
    onSelect(entry.workflowId);
  };
  const running = saved ? instances.filter(run => run.workflowId === saved.id && run.state !== 'completed' && run.state !== 'cancelled') : [];
  const writeProps = readOnlyProps(readOnly);
  const libraryButton = libraryAvailable && <button type="button" aria-haspopup="dialog" onClick={() => setLibrary(previous => ({ ...previous, open: true }))}>範本庫</button>;
  const change = (value: WorkflowTemplate, manualEdge?: { source: string; target: string }) => {
    if (!pending && draft && workflow) {
      const destinationChoices = Object.fromEntries(value.nodes.flatMap(node => node.outputRules.flatMap(rule => {
        const key = destinationKey(node.id, rule.id);
        const choice = draft.destinationChoices[key];
        return choice && choice !== destinationValue(rule.target) ? [[key, choice]] : [];
      })));
      patch(selectedId, { ...updateDraftGraph(workflow, value, draft.automaticEdges, saved?.edges ?? [], manualEdge, draft.deletedEdges), destinationChoices, dirty: true, message: '', error: '' });
    }
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
    if (readOnly) return;
    if (!draft || !workflow || pending || draft.blocked || repository.isBlocked?.(selectedId) || stale || locks.current.has(selectedId)) return;
    if (!externalUpdate) {
      if (unapplied.length) {
        patch(selectedId, { destinationPrompt: true, message: '' });
        requestFocus('pending-destinations');
        return;
      }
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
      if (result.requestId !== null && result.requestId !== command.requestId) patch(target, { pending: false, blocked: true, warning: true, error: '無法核對儲存回覆。' + commandFeedback(unknownResult(command.requestId)) });
      else if (!result.ok) patch(target, { pending: false, blocked: blocksResubmit(result), warning: result.code === 'unknown_outcome', error: isDemo ? result.message : commandFeedback(result), conflict: result.code === 'stale_revision' });
      else if (externalUpdate) patch(target, { pending: false });
      else {
        const record = repository.getSnapshot().find(item => item.id === target);
        if (result.revision === undefined || (!isDemo && record?.revision !== result.revision)) patch(target, { pending: false, blocked: true, warning: true, error: '操作已接受，但尚未取得儲存後的版本。草稿保留，請重新讀取並核對資料。' });
        else patch(target, {
          workflow: record?.revision === result.revision ? structuredClone(record) : { ...command.workflow, revision: result.revision },
          expectedRevision: result.revision, pending: false, dirty: false, attempted: false, conflict: false,
          automaticEdges: [], deletedEdges: [], connectionTarget: '',
          destinationChoices: {}, destinationPrompt: false,
          message: `${isDemo ? '示意模式 · ' : ''}已${command.expectedRevision === null ? '建立' : '儲存'}「${command.workflow.name}」，revision ${result.revision}。${isDemo ? '僅保留於本次開啟期間。' : ''}`,
        });
      }
    } catch { if (mounted.current) patch(target, { pending: false, error: '儲存服務無法回應，草稿仍保留。' }); }
    finally { locks.current.delete(target); if (mounted.current && demo) patch(target, { failNext: demo.hasSaveFailure(target) }); }
  };

  const defaultModel = defaultModelOption(models);
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
    {readOnly && <p className="storage-banner">唯讀模式：可查看或編輯草稿，無法儲存 Workflow。</p>}
    <header className="workflow-toolbar"><div><span className="eyebrow">設定 / Workflow</span><h2 ref={heading} tabIndex={-1}>{workflow?.name || (workflow ? '未命名 Workflow' : workflows.length ? '找不到指定的 Workflow 範本' : 'Workflow 範本')}</h2>
      <p className="muted">{workflow ? (isNew ? '新範本 · 尚未儲存' : `revision ${draft?.expectedRevision} · ${draft?.dirty ? '有未儲存草稿' : '已載入範本'}`) : workflows.length ? `範本 ID：${selectedId}` : '尚無 Workflow 範本'}</p></div>
      <div className="workflow-actions"><label>範本<select aria-label="Workflow 範本" value={draft ? selectedId : ''} onChange={event => { setDeleteTarget(null); setNotice(''); onSelect(event.target.value); }}><option disabled value="">選取範本</option>{workflows.map(item => <option key={item.id} value={item.id}>{item.name}{drafts[item.id]?.dirty ? ' · 草稿' : ''}</option>)}
          {Object.values(drafts).filter(item => item.expectedRevision === null && !workflows.some(known => known.id === item.workflow.id)).map(item => <option key={item.workflow.id} value={item.workflow.id}>{item.workflow.name || '未命名 Workflow'} · 未儲存</option>)}</select></label>
        {draft && <button type="button" {...writeProps} disabled={readOnly} onClick={createNew}>新增範本</button>}
        {saved && <button type="button" {...writeProps} disabled={readOnly} onClick={() => startDraft(copyWorkflowDraft(saved))}>複製</button>}
        {saved && <button type="button" className="workflow-danger" {...writeProps} disabled={readOnly || pending || draft?.blocked} onClick={() => setDeleteTemplate(true)}>刪除範本</button>}
        {isNew && <button type="button" disabled={pending} onClick={discardNew}>捨棄新範本</button>}
        {draft && libraryButton}
        {workflow && <button id={workflowFieldId('save')} className="primary" {...writeProps} disabled={readOnly || pending || draft?.blocked || repository.isBlocked?.(selectedId) || stale} onClick={() => { void save(); }}>{pending ? '儲存中…' : '儲存 Workflow'}</button>}
      </div>
    </header>
    {notice && <p className="workflow-notice" role="status">{notice}</p>}
    {!draft && <div className="workflow-empty">
      {!workflows.length && <h3>還沒有 Workflow 範本</h3>}
      <p className="muted">範本決定 Workflow 有哪些節點、各用哪個 Agent 和 Model，以及節點之間怎麼交接。</p>
      <div className="workflow-actions">
        <button type="button" className="primary" {...writeProps} disabled={readOnly} onClick={createNew}>新增範本</button>
        {libraryButton}
      </div>
      {libraryAvailable && <p className="muted">也可以從範本庫加入內建範本，例如「規劃 → 實作 → 審查」。</p>}
    </div>}
    {draft && workflow && <>
      <div className="workflow-feedback-area">
        {!pending && (draft.blocked || repository.isBlocked?.(selectedId)) && <button onClick={() => {
          repository.acknowledge?.(selectedId);
          patch(selectedId, { blocked: false, warning: false, error: '' });
        }}>已核對結果，保留草稿</button>}
        {!pending && !draft.error && repository.isBlocked?.(selectedId) && <p role="status">此 Workflow 有處理中或結果未知的操作，請查看操作結果並核對資料。</p>}
        {unapplied.length > 0 && <p className="muted">有 {unapplied.length} 項 Output 目的地尚未套用。</p>}
        {draft.destinationPrompt && unapplied.length > 0 && <div className="workflow-validation" role="alert" tabIndex={-1} id={workflowFieldId('pending-destinations')}>
          <strong>尚未儲存：請先套用或放棄以下目的地選擇，再按「儲存 Workflow」。</strong>
          <ul>{unapplied.map(item => <li key={item.key}><button onClick={() => { select({ kind: 'node', id: item.node.id }); requestFocus(`nodes.${item.nodeIndex}.outputRules.${item.ruleIndex}.target`); }}>
            {item.node.label} · Output {item.ruleIndex + 1}：{item.rule.condition || '未填條件'} → {item.value === 'root' ? '回報 root' : item.value === 'tasks' ? '拆分 task' : workflow.nodes.find(node => `node:${node.id}` === item.value)?.label ?? '目的地節點已不存在，請重新選取'}
          </button></li>)}</ul>
          <button disabled={pending} onClick={() => {
            const invalid = unapplied.find(item => item.value === 'tasks' && !(item.node.kind === 'agent' && item.node.isRoot));
            if (invalid) {
              patch(selectedId, { message: '只有 root 能拆分 task，請重新選擇此規則的目的地。' });
              select({ kind: 'node', id: invalid.node.id }); requestFocus(`nodes.${invalid.nodeIndex}.outputRules.${invalid.ruleIndex}.target`); return;
            }
            let next = workflow;
            for (const item of unapplied) {
              const node = next.nodes.find(node => node.id === item.node.id)!;
              next = replaceNode(next, { ...node, outputRules: node.outputRules.map(rule => rule.id === item.rule.id ? { ...rule, target: item.value === 'root' ? { kind: 'root' } : item.value === 'tasks' ? { kind: 'tasks' } : { kind: 'node', nodeId: NodeId.parse(item.value.slice(5)) } } : rule) });
            }
            change(next); requestFocus('save');
          }}>套用所有目的地</button>
          <button disabled={pending} onClick={() => { patch(selectedId, { destinationChoices: {}, destinationPrompt: false }); requestFocus('save'); }}>放棄所有目的地選擇</button>
        </div>}
        {draft.message && <p role="status">{draft.message}</p>}
        {needsAgent(workflow) && <div className="workflow-validation" role="alert"><strong>需要 Agent：{agents.length ? '有節點還沒選 Agent，請在節點設定選一個。' : '還沒有任何 Agent，請先新增 Agent，再回來選。'}</strong>
          {!agents.length && onOpenAgents && <button type="button" onClick={onOpenAgents}>前往 Agent 頁</button>}</div>}
        {stale && <div className="workflow-feedback" data-workflow-feedback role="alert" tabIndex={-1}>
          <p>版本已變更：草稿基於 revision {draft.expectedRevision}，目前為 {saved?.revision ?? '不存在'}。草稿未被覆蓋，請比對後再處理。</p>
          {saved && <><details><summary>比對草稿與目前已儲存版本</summary><div className="workflow-comparison"><div><h3>你的草稿</h3><pre>{JSON.stringify(workflow, null, 2)}</pre></div><div><h3>目前已儲存版本</h3><pre>{JSON.stringify(saved, null, 2)}</pre></div></div></details>
            <button disabled={pending || saved.revision === draft.expectedRevision} onClick={() => { patch(selectedId, { workflow: { ...workflow, revision: saved.revision }, expectedRevision: saved.revision, dirty: true, error: '', conflict: false }); requestFocus('name'); }}>已比對，保留草稿並以 revision {saved.revision} 重新編輯</button>
            <button disabled={pending} onClick={() => { demo?.setSaveFailure(selectedId, false); patch(selectedId, newDraft(saved)); setDeleteTarget(null); requestFocus('name'); }}>捨棄草稿、改用已儲存版本</button></>}
        </div>}
        {error && <p className={draft.warning ? 'command-warning' : 'field-error'} data-workflow-feedback role={draft.warning ? 'status' : 'alert'} tabIndex={-1}>{error}</p>}
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
            {selectedNode ? <WorkflowInspector key={selectedNode.id} workflow={workflow} node={selectedNode} agents={agents} models={models} runtimes={runtimes} issues={issues} destinationChoices={draft.destinationChoices} onDestinationChoice={(ruleId, value) => {
              const destinationChoices = { ...draft.destinationChoices, [destinationKey(selectedNode.id, ruleId)]: value };
              if (value === destinationValue(selectedNode.outputRules.find(rule => rule.id === ruleId)!.target)) delete destinationChoices[destinationKey(selectedNode.id, ruleId)];
              patch(selectedId, { destinationChoices, message: '' });
            }} onChange={(node, applyDestination = false) => change(replaceNode(workflow, node, applyDestination))} />
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
              <button type="button" disabled={!draft.connectionTarget} onClick={() => { connect(selectedNode.id, draft.connectionTarget); patch(selectedId, { connectionTarget: '' }); document.getElementById('workflow-connect-target')?.focus(); }}>新增連線</button><p className="muted">選好目的地後按「新增連線」。也可在畫布從右側圓點拉線到另一節點左側。</p></div>}
            {selection && <button className="workflow-delete" onClick={() => setDeleteTarget(selection)}>刪除所選{selection.kind === 'node' ? '節點' : '連線'}</button>}
          </fieldset>
          {demo && !readOnly && <details className="workflow-demo"><summary>示意模式測試</summary><label className="workflow-check"><input type="checkbox" disabled={pending} checked={draft.failNext} onChange={event => { demo.setSaveFailure(selectedId, event.target.checked); patch(selectedId, { failNext: event.target.checked }); }} />下次儲存模擬失敗</label><button disabled={pending || stale} onClick={() => { void save(true); }}>模擬他人已更新此 Workflow</button></details>}
          <p className="muted workflow-help">Tab 移動焦點；畫布節點可按 Enter 選取、方向鍵移動、Delete 刪除。Model 只作新 session 的初始設定。</p>
        </aside>
      </div>
    </>}
    {visible && library.open && <TemplateLibraryDialog workflows={workflows} readOnly={readOnly} pending={library.pending} errors={library.errors}
      onAdd={entry => { void addFromLibrary(entry); }} onOpen={openFromLibrary} onClose={() => { if (library.pending === null) setLibrary({ open: false, pending: null, errors: {} }); }} />}
    {visible && saved && draft && deleteTemplate && <DeleteTemplateDialog workflow={saved} dirty={draft.dirty} running={running} onCancel={() => setDeleteTemplate(false)} onConfirm={() => { void removeTemplate(); }} />}
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

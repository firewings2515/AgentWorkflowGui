import { useState } from 'react';
import type { ReactNode } from 'react';
import { AgentId, NodeId } from '../../../contracts';
import type { AgentDefinition, InputRule, ModelOption, OutputRule, WorkflowNode, WorkflowTemplate } from '../../../contracts';
import { isolationLabels, writePolicyLabels } from './workflow-editor-state';
import type { WorkflowIssue } from './workflow-editor-state';

export const workflowFieldId = (path: string) => `workflow-field-${path}`;
function OutputDestination({ workflow, node, rule, ruleIndex, inputProps, onApply }: {
  workflow: WorkflowTemplate; node: WorkflowNode; rule: OutputRule; ruleIndex: number;
  inputProps: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined };
  onApply: (target: OutputRule['target']) => void;
}) {
  const current = rule.target.kind === 'root' ? 'root' : `node:${rule.target.nodeId}`;
  const [choice, setChoice] = useState({ current, value: current });
  if (choice.current !== current) setChoice({ current, value: current });
  const value = choice.current === current ? choice.value : current;
  return <>
    <select {...inputProps} value={value} onChange={event => setChoice({ current, value: event.target.value })}>
      <option value="root">回報 root</option>{workflow.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={`node:${item.id}`}>{item.label}{workflow.edges.some(edge => edge.source === node.id && edge.target === item.id) ? '（已連線）' : '（套用時自動連線）'}</option>)}
    </select>
    <button type="button" onClick={() => onApply(value === 'root' ? { kind: 'root' } : { kind: 'node', nodeId: NodeId.parse(value.slice(5)) })}>套用 Output {ruleIndex + 1} 目的地</button>
    {value !== current && <p className="muted">目的地尚未套用，儲存仍使用原目的地。</p>}
  </>;
}
export function WorkflowField({ path, label, issues, children }: {
  path: string; label: string; issues: WorkflowIssue[];
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
}) {
  const errors = issues.filter(issue => issue.path === path || issue.path.startsWith(`${path}.`));
  const id = workflowFieldId(path);
  return <div className="workflow-field"><label htmlFor={id}>{label}</label>
    {children({ id, 'aria-invalid': !!errors.length, 'aria-describedby': errors.length ? `${id}-error` : undefined })}
    {!!errors.length && <p id={`${id}-error`} className="field-error">{errors.map(issue => issue.message).join('；')}</p>}
  </div>;
}

export function WorkflowSettings({ workflow, issues, onChange, onRoot }: {
  workflow: WorkflowTemplate; issues: WorkflowIssue[]; onChange: (value: WorkflowTemplate) => void; onRoot: (id: NodeId) => void;
}) {
  return <>
    <WorkflowField path="name" label="範本名稱" issues={issues}>{props => <input {...props} value={workflow.name} onChange={event => onChange({ ...workflow, name: event.target.value })} />}</WorkflowField>
    <WorkflowField path="description" label="範本說明" issues={issues}>{props => <textarea {...props} rows={2} value={workflow.description} onChange={event => onChange({ ...workflow, description: event.target.value })} />}</WorkflowField>
    <WorkflowField path="nodes" label="Root 節點（升級對象）" issues={issues.filter(issue => issue.path === 'nodes')}>{props => <select {...props} value={workflow.nodes.find(node => node.kind === 'agent' && node.isRoot)?.id ?? ''} onChange={event => onRoot(NodeId.parse(event.target.value))}>
      <option value="" disabled>請指定一個 Agent 節點</option>{workflow.nodes.filter(node => node.kind === 'agent').map(node => <option key={node.id} value={node.id}>{node.label}</option>)}
    </select>}</WorkflowField>
    <WorkflowField path="isolation" label="Task 隔離" issues={issues}>{props => <select {...props} value={workflow.isolation} onChange={event => onChange({ ...workflow, isolation: event.target.value === 'worktree' ? 'worktree' : 'same-folder' })}>
      {Object.entries(isolationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>}</WorkflowField>
    <WorkflowField path="reworkLimit" label="返工上限" issues={issues}>{props => <input {...props} type="number" min={0} step={1} value={Number.isNaN(workflow.reworkLimit) ? '' : workflow.reworkLimit} onChange={event => onChange({ ...workflow, reworkLimit: event.target.valueAsNumber })} />}</WorkflowField>
  </>;
}

export function WorkflowInspector({ workflow, node, agents, models, issues, onChange }: {
  workflow: WorkflowTemplate; node: WorkflowNode; agents: readonly AgentDefinition[]; models: readonly ModelOption[];
  issues: WorkflowIssue[]; onChange: (node: WorkflowNode, applyDestination?: boolean) => void;
}) {
  const index = workflow.nodes.findIndex(item => item.id === node.id);
  const path = `nodes.${index}`;
  const field = (suffix: string, label: string, children: Parameters<typeof WorkflowField>[0]['children']) => <WorkflowField path={`${path}.${suffix}`} label={label} issues={issues}>{children}</WorkflowField>;
  const updateInput = (id: string, rule: InputRule) => onChange({ ...node, inputRules: node.inputRules.map(item => item.id === id ? rule : item) });
  const updateOutput = (id: string, rule: OutputRule, applyDestination = false) => onChange({ ...node, outputRules: node.outputRules.map(item => item.id === id ? rule : item) }, applyDestination);
  const modelKey = (model: { runtime: string; model: string }) => JSON.stringify([model.runtime, model.model]);
  const availableModels = models.filter(model => !model.hidden || (node.kind === 'agent' && modelKey(model) === modelKey(node.model)));
  const selectedModel = node.kind === 'agent' ? models.find(model => modelKey(model) === modelKey(node.model)) : undefined;
  const focusAdd = (kind: 'input' | 'output') => document.getElementById(`workflow-add-${kind}`)?.focus();
  return <>
    {field('label', '節點名稱', props => <input {...props} value={node.label} onChange={event => onChange({ ...node, label: event.target.value })} />)}
    {node.kind === 'agent' ? <>
      {field('agentId', 'Agent', props => <select {...props} value={node.agentId} onChange={event => onChange({ ...node, agentId: AgentId.parse(event.target.value) })}>
        {!agents.some(agent => agent.id === node.agentId) && <option value={node.agentId}>未提供的 Agent：{node.agentId}</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>)}
      {field('model', 'Model', props => <select {...props} value={modelKey(node.model)} onChange={event => {
        const model = availableModels.find(item => modelKey(item) === event.target.value);
        if (model) onChange({ ...node, model: { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) } });
      }}>
        {!selectedModel && <option value={modelKey(node.model)}>未提供的 Model：{node.model.model}</option>}
        {availableModels.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.runtime} · {model.displayName}</option>)}
      </select>)}
      {field('model.effort', '推理強度', props => <select {...props} value={node.model.effort ?? ''} onChange={event => {
        const model = { runtime: node.model.runtime, model: node.model.model };
        onChange({ ...node, model: { ...model, ...(event.target.value ? { effort: event.target.value } : {}) } });
      }}><option value="">工具預設</option>{node.model.effort && !selectedModel?.efforts.includes(node.model.effort) && <option value={node.model.effort}>{node.model.effort}（目前設定）</option>}{selectedModel?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select>)}
    </> : <p className="muted">系統合併節點：GUI 在整合 worktree 合併並測試，通過後更新目標分支；一次處理一個 task。</p>}
    {field('writePolicy', '寫入權限', props => <select {...props} disabled={node.kind === 'merge'} value={node.writePolicy} onChange={event => {
      const value = event.target.value;
      if (value === 'write' || value === 'read-only' || value === 'exec-only') onChange({ ...node, writePolicy: value });
    }}>{Object.entries(writePolicyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>)}
    {field('concurrency', '並行 task 數', props => <input {...props} type="number" min={1} step={1} disabled={node.kind === 'merge'} value={Number.isNaN(node.concurrency) ? '' : node.concurrency} onChange={event => onChange({ ...node, concurrency: event.target.valueAsNumber })} />)}
    <h4>Input 規則</h4><p className="muted">接收上限按同一 task 計數；等待只計入同一輪實際送出的上游。</p>
    {node.inputRules.map((rule, ruleIndex) => <fieldset className="workflow-rule" key={rule.id}><legend>Input {ruleIndex + 1}</legend>
      {field(`inputRules.${ruleIndex}.condition`, `Input ${ruleIndex + 1} 收到什麼／如何處理`, props => <textarea {...props} rows={2} value={rule.condition} onChange={event => updateInput(rule.id, { ...rule, condition: event.target.value })} />)}
      {field(`inputRules.${ruleIndex}.acceptanceLimit`, `Input ${ruleIndex + 1} 接收上限（空白為不限）`, props => <input {...props} type="number" min={1} step={1} value={rule.acceptanceLimit === undefined || Number.isNaN(rule.acceptanceLimit) ? '' : rule.acceptanceLimit} onChange={event => {
        const rest = { id: rule.id, condition: rule.condition, waitForAllUpstream: rule.waitForAllUpstream };
        updateInput(rule.id, { ...rest, ...(event.target.value ? { acceptanceLimit: event.target.valueAsNumber } : {}) });
      }} />)}
      <label className="workflow-check"><input type="checkbox" checked={rule.waitForAllUpstream} onChange={event => updateInput(rule.id, { ...rule, waitForAllUpstream: event.target.checked })} />Input {ruleIndex + 1} 等所有上游到齊</label>
      <button type="button" onClick={() => { onChange({ ...node, inputRules: node.inputRules.filter(item => item.id !== rule.id) }); focusAdd('input'); }}>移除 Input {ruleIndex + 1}</button>
    </fieldset>)}
    <button type="button" id="workflow-add-input" onClick={() => onChange({ ...node, inputRules: [...node.inputRules, { id: crypto.randomUUID(), condition: '', waitForAllUpstream: false }] })}>＋ 新增 Input 規則</button>
    <h4>Output 規則</h4><p className="muted">選好目的地後按「套用」，才會更新規則並自動建立連線。本次草稿自動建立且已無規則使用的連線會移除；未刪過的已存連線及手動建立的連線會保留。連線只代表允許交接；語意條件由 AI 判斷。</p>
    {node.outputRules.map((rule, ruleIndex) => <fieldset className="workflow-rule" key={rule.id}><legend>Output {ruleIndex + 1}</legend>
      {field(`outputRules.${ruleIndex}.condition`, `Output ${ruleIndex + 1} 什麼情況`, props => <textarea {...props} rows={2} value={rule.condition} onChange={event => updateOutput(rule.id, { ...rule, condition: event.target.value })} />)}
      {field(`outputRules.${ruleIndex}.payload`, `Output ${ruleIndex + 1} 送什麼`, props => <textarea {...props} rows={2} value={rule.payload} onChange={event => updateOutput(rule.id, { ...rule, payload: event.target.value })} />)}
      {field(`outputRules.${ruleIndex}.target`, `Output ${ruleIndex + 1} 目的地`, props => <OutputDestination workflow={workflow} node={node} rule={rule} ruleIndex={ruleIndex} inputProps={props} onApply={target => updateOutput(rule.id, { ...rule, target }, true)} />)}
      <label className="workflow-check"><input type="checkbox" checked={rule.requiresUserConfirmation} onChange={event => updateOutput(rule.id, { ...rule, requiresUserConfirmation: event.target.checked })} />Output {ruleIndex + 1} 經 root 請使用者確認</label>
      <button type="button" onClick={() => { onChange({ ...node, outputRules: node.outputRules.filter(item => item.id !== rule.id) }); focusAdd('output'); }}>移除 Output {ruleIndex + 1}</button>
    </fieldset>)}
    <button type="button" id="workflow-add-output" onClick={() => onChange({ ...node, outputRules: [...node.outputRules, { id: crypto.randomUUID(), condition: '', payload: '', target: { kind: 'root' }, requiresUserConfirmation: false }] })}>＋ 新增 Output 規則</button>
  </>;
}

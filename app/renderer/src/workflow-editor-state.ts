import { AgentId, CONTRACTS_VERSION, NodeId, WorkflowId } from '../../../contracts';
import type { AgentDefinition, ModelOption, ModelSelection, OutputRule, WorkflowEdge, WorkflowNode, WorkflowTemplate } from '../../../contracts';
export { workflowIssues } from './workflow-validation';
export type { WorkflowIssue } from './workflow-validation';

export type GraphSelection = { kind: 'node'; id: string } | { kind: 'edge'; source: string; target: string } | null;
export const destinationKey = (nodeId: string, ruleId: string) => JSON.stringify([nodeId, ruleId]);
export const destinationValue = (target: OutputRule['target']) => target.kind === 'node' ? `node:${target.nodeId}` : target.kind;
export const writePolicyLabels = { write: '可寫', 'read-only': '唯讀', 'exec-only': '只能執行指令' };
export const isolationLabels = { worktree: '每個 task 獨立 worktree', 'same-folder': '共用資料夾 · 寫入鎖定' };

export function connectNodes(workflow: WorkflowTemplate, source: string, target: string): WorkflowTemplate {
  const from = workflow.nodes.find(node => node.id === source);
  const to = workflow.nodes.find(node => node.id === target);
  if (!from || !to || source === target || workflow.edges.some(edge => edge.source === source && edge.target === target)) return workflow;
  return { ...workflow, edges: [...workflow.edges, { source: from.id, target: to.id }] };
}

export function replaceNode(workflow: WorkflowTemplate, node: WorkflowNode, connectOutputs = true): WorkflowTemplate {
  let next = { ...workflow, nodes: workflow.nodes.map(item => item.id === node.id ? node : item) };
  // Preserve manually drawn edges; applying an output destination adds the missing edge.
  if (connectOutputs) for (const rule of node.outputRules) if (rule.target.kind === 'node') next = connectNodes(next, node.id, rule.target.nodeId);
  return next;
}

const connectionKey = (edge: { source: string; target: string }) => JSON.stringify([edge.source, edge.target]);
// Provenance belongs to the draft, never to the persisted workflow contract.
export function updateDraftGraph(previous: WorkflowTemplate, next: WorkflowTemplate, automaticEdges: readonly string[], savedEdges: readonly WorkflowEdge[], manualEdge?: { source: string; target: string }, deletedEdges: readonly string[] = []) {
  const deleted = new Set(deletedEdges);
  const incoming = new Set(next.edges.map(connectionKey));
  for (const edge of previous.edges) if (!incoming.has(connectionKey(edge))) deleted.add(connectionKey(edge));
  const saved = new Set(savedEdges.map(connectionKey).filter(key => !deleted.has(key)));
  const existing = new Set(previous.edges.map(connectionKey));
  const automatic = new Set(automaticEdges);
  const manual = manualEdge && connectionKey(manualEdge);
  if (manual) automatic.delete(manual);
  for (const edge of next.edges) {
    const key = connectionKey(edge);
    if (!existing.has(key) && !saved.has(key) && key !== manual) automatic.add(key);
  }
  const used = new Set(next.nodes.flatMap(node => node.outputRules.flatMap(rule => rule.target.kind === 'node'
    ? [connectionKey({ source: node.id, target: rule.target.nodeId })] : [])));
  const edges = next.edges.filter(edge => !automatic.has(connectionKey(edge)) || saved.has(connectionKey(edge)) || used.has(connectionKey(edge)));
  const kept = new Set(edges.map(connectionKey));
  return { workflow: edges.length === next.edges.length ? next : { ...next, edges }, automaticEdges: [...automatic].filter(key => kept.has(key) && !saved.has(key)), deletedEdges: [...deleted] };
}

export function setRoot(workflow: WorkflowTemplate, id: NodeId): WorkflowTemplate {
  return { ...workflow, nodes: workflow.nodes.map(node => node.kind === 'agent' ? { ...node, isRoot: node.id === id } : node) };
}

export function removeGraphSelection(workflow: WorkflowTemplate, selection: GraphSelection): WorkflowTemplate {
  if (!selection) return workflow;
  const removesEdge = (edge: WorkflowEdge) => selection.kind === 'node'
    ? edge.source === selection.id || edge.target === selection.id
    : edge.source === selection.source && edge.target === selection.target;
  return {
    ...workflow,
    nodes: workflow.nodes.filter(node => selection.kind !== 'node' || node.id !== selection.id).map(node => ({
      ...node, outputRules: node.outputRules.filter(rule => rule.target.kind !== 'node' || !removesEdge({ source: node.id, target: rule.target.nodeId })),
    })),
    edges: workflow.edges.filter(edge => !removesEdge(edge)),
  };
}

/** The model a new node starts with: the first default the runtimes listed (not hidden), else any listed one. */
export const defaultModelOption = (models: readonly ModelOption[]) => models.find(model => !model.hidden && model.isDefault) ?? models.find(model => !model.hidden);
/** Before any runtime listed a model (T063): what the starter set falls back to for Claude. */
const FALLBACK_MODEL: ModelSelection = { runtime: 'claude', model: 'sonnet' };
const selectionOf = (model: ModelOption | undefined): ModelSelection => model
  ? { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) } : { ...FALLBACK_MODEL };

/**
 * A new template (T063): 「未命名 Workflow」, same-folder, one root node on the first Agent and the default model. Without
 * any Agent the root's Agent is empty: the editor says it needs one and the contract refuses to save it.
 */
export function createWorkflowDraft(agents: readonly AgentDefinition[], models: readonly ModelOption[], now = new Date().toISOString()): WorkflowTemplate {
  return {
    schemaVersion: CONTRACTS_VERSION, id: WorkflowId.parse(crypto.randomUUID()), revision: 0, name: '未命名 Workflow', description: '',
    reworkLimit: 2, isolation: 'same-folder', edges: [], updatedAt: now,
    nodes: [{
      kind: 'agent', id: NodeId.parse(crypto.randomUUID()), label: 'Root', agentId: agents[0]?.id ?? ('' as AgentId), model: selectionOf(defaultModelOption(models)),
      isRoot: true, writePolicy: 'write', concurrency: 1, inputRules: [], outputRules: [], position: { x: 80, y: 160 },
    }],
  };
}

/**
 * A copy of a saved template (T063): a new ID, 「名稱（副本）」 and revision 0; every node gets a new ID, and the edges and
 * output rules follow it. Everything else is copied as it is.
 */
export function copyWorkflowDraft(saved: WorkflowTemplate, now = new Date().toISOString()): WorkflowTemplate {
  const ids = new Map(saved.nodes.map(node => [node.id as string, NodeId.parse(crypto.randomUUID())]));
  const idOf = (id: NodeId) => ids.get(id) ?? id;
  const copy = structuredClone(saved);
  return {
    ...copy, id: WorkflowId.parse(crypto.randomUUID()), revision: 0, name: `${saved.name}（副本）`, updatedAt: now,
    nodes: copy.nodes.map(node => ({ ...node, id: idOf(node.id), outputRules: node.outputRules.map(rule => rule.target.kind === 'node' ? { ...rule, target: { kind: 'node' as const, nodeId: idOf(rule.target.nodeId) } } : rule) })),
    edges: copy.edges.map(edge => ({ source: idOf(edge.source), target: idOf(edge.target) })),
  };
}

/** Whether an Agent node names no Agent (T063: a new template made before any Agent existed). */
export const needsAgent = (workflow: WorkflowTemplate) => workflow.nodes.some(node => node.kind === 'agent' && !node.agentId);

import { describe, expect, it } from 'vitest';
import { NodeId, WorkflowTemplate } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { connectNodes, removeGraphSelection, replaceNode, setRoot, updateDraftGraph, workflowIssues } from './workflow-editor-state';
import { workflowIssueLabel, workflowIssueMessage, workflowRuleMessages } from './workflow-validation';
import { fromCanvas, toCanvas } from './workflow-canvas/graph-adapter';
import { createWorkflowRepository, workflowSaveCommand } from './workflow-repository';
import { createWorkflowDemo } from './workflow-demo';

const template = fixtureSnapshot.workflows[0]!;
describe('T019 domain / canvas boundary', () => {
  it('round trips all contract fields, including rules, merge, root and positions without mutating fixtures', () => {
    const before = JSON.stringify(template);
    const graph = toCanvas(template, { kind: 'node', id: template.nodes[0]!.id });
    expect(fromCanvas(template, graph.nodes, graph.edges)).toEqual(template);
    expect(WorkflowTemplate.safeParse(fromCanvas(template, graph.nodes, graph.edges)).success).toBe(true);
    const canvasNode = graph.nodes[0]!;
    canvasNode.position = { x: -75.5, y: 420 };
    canvasNode.selected = true;
    canvasNode.measured = { width: 220, height: 140 };
    canvasNode.data.node.label = '使用者編輯';
    const restored = fromCanvas(template, graph.nodes, graph.edges);
    expect(restored.nodes[0]).toMatchObject({ label: template.nodes[0]!.label, position: { x: -75.5, y: 420 } });
    expect(Object.keys(restored.nodes[0]!).sort()).toEqual(Object.keys(template.nodes[0]!).sort());
    expect(Object.keys(restored.edges[0]!).sort()).toEqual(['source', 'target']);
    expect(JSON.stringify(template)).toBe(before);
  });

  it('keeps edge IDs unambiguous and rejects dangling canvas endpoints', () => {
    const graph = toCanvas(template);
    expect(new Set(graph.edges.map(edge => edge.id)).size).toBe(template.edges.length);
    expect(() => fromCanvas(template, graph.nodes, [{ id: 'bad', source: 'missing', target: template.nodes[0]!.id }])).toThrow();
  });

  it('adds manual edges once and automatically connects an output destination, preserving manual edges', () => {
    const node = template.nodes[0]!;
    const target = template.nodes.at(-1)!;
    const connected = connectNodes(template, node.id, target.id);
    expect(connected.edges).toHaveLength(template.edges.length + 1);
    expect(connectNodes(connected, node.id, target.id)).toBe(connected);
    expect(connectNodes(template, node.id, node.id)).toBe(template);
    expect(connectNodes(template, 'missing', target.id)).toBe(template);
    const withRule = replaceNode(template, { ...node, outputRules: [...node.outputRules, { id: 'user-rule', condition: '準備合併', payload: '結果', target: { kind: 'node', nodeId: target.id }, requiresUserConfirmation: false }] });
    expect(withRule.edges).toEqual(connected.edges);
    expect(replaceNode(withRule, node).edges).toEqual(connected.edges);
    expect(WorkflowTemplate.safeParse(withRule).success).toBe(true);
  });

  it('deletes a connection and its referring rules, and deletes nodes without dangling endpoints', () => {
    const edge = template.edges[0]!;
    const withoutEdge = removeGraphSelection(template, { kind: 'edge', ...edge });
    expect(withoutEdge.nodes[0]!.outputRules).toHaveLength(0);
    expect(WorkflowTemplate.safeParse(withoutEdge).success).toBe(true);
    const withoutNode = removeGraphSelection(template, { kind: 'node', id: 'n-build' });
    expect(withoutNode.edges.every(edge => edge.source !== 'n-build' && edge.target !== 'n-build')).toBe(true);
    expect(WorkflowTemplate.safeParse(withoutNode).success).toBe(true);
  });

  it('allows an incomplete root draft, then restores exactly one root through the selector', () => {
    const withoutRoot = removeGraphSelection(template, { kind: 'node', id: 'n-plan' });
    expect(workflowIssues(withoutRoot)).toContainEqual(expect.objectContaining({ path: 'nodes', rule: 'workflow.one-root' }));
    const restored = setRoot(withoutRoot, NodeId.parse('n-build'));
    expect(WorkflowTemplate.safeParse(restored).success).toBe(true);
    expect(restored.nodes.filter(node => node.kind === 'agent' && node.isRoot)).toHaveLength(1);
  });

  it('routes schema issues by path without interpreting the message', () => {
    const invalid = structuredClone(template);
    invalid.nodes[1]!.inputRules[0]!.condition = '';
    invalid.nodes[1]!.concurrency = 0;
    const errors = workflowIssues(invalid);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'nodes.1.inputRules.0.condition', nodeId: 'n-build' }),
      expect.objectContaining({ path: 'nodes.1.concurrency', nodeId: 'n-build' }),
    ]));
    expect(errors.every(issue => /[\u4e00-\u9fff]/u.test(issue.message))).toBe(true);
  });

  it('prunes only unused draft automatic edges across successive output destinations', () => {
    let draft = { workflow: structuredClone(template), automaticEdges: [] as string[] };
    const destination = (id: string) => {
      const node = draft.workflow.nodes[0]!;
      const outputRules = node.outputRules.map(rule => ({ ...rule, target: id === 'root' ? { kind: 'root' as const } : { kind: 'node' as const, nodeId: NodeId.parse(id) } }));
      draft = updateDraftGraph(draft.workflow, replaceNode(draft.workflow, { ...node, outputRules }), draft.automaticEdges, template.edges);
    };
    destination('n-review');
    expect(draft.workflow.edges).toHaveLength(template.edges.length + 1);
    destination('n-merge');
    expect(draft.workflow.edges).toHaveLength(template.edges.length + 1);
    expect(draft.workflow.edges).not.toContainEqual({ source: 'n-plan', target: 'n-review' });
    destination('root');
    expect(draft.workflow.edges).toEqual(template.edges);
    expect(draft.automaticEdges).toEqual([]);
    destination('n-review');
    // A second rule still needs this edge when the first changes.
    const node = draft.workflow.nodes[0]!;
    const shared = replaceNode(draft.workflow, { ...node, outputRules: [...node.outputRules, { ...node.outputRules[0]!, id: 'shared' }] });
    draft = updateDraftGraph(draft.workflow, shared, draft.automaticEdges, template.edges);
    const oneChanged = replaceNode(draft.workflow, { ...shared.nodes[0]!, outputRules: shared.nodes[0]!.outputRules.map((rule, index) => index ? rule : { ...rule, target: { kind: 'root' } }) });
    draft = updateDraftGraph(draft.workflow, oneChanged, draft.automaticEdges, template.edges);
    expect(draft.workflow.edges).toContainEqual({ source: 'n-plan', target: 'n-review' });
    // Drawing the same edge explicitly promotes it to a manual edge.
    draft = updateDraftGraph(draft.workflow, draft.workflow, draft.automaticEdges, template.edges, { source: 'n-plan', target: 'n-review' });
    destination('root');
    expect(draft.workflow.edges).toContainEqual({ source: 'n-plan', target: 'n-review' });
    expect(draft.automaticEdges).toEqual([]);
  });

  it('retains saved auto edges, but removes unused new auto edges when their rules are deleted', () => {
    const node = template.nodes[0]!;
    const next = replaceNode(template, { ...node, outputRules: [{ ...node.outputRules[0]!, target: { kind: 'node', nodeId: NodeId.parse('n-review') } }] });
    const draft = updateDraftGraph(template, next, [], template.edges);
    const removed = replaceNode(next, { ...next.nodes[0]!, outputRules: [] });
    expect(updateDraftGraph(next, removed, draft.automaticEdges, template.edges).workflow.edges).toEqual(template.edges);
    expect(updateDraftGraph(next, removed, draft.automaticEdges, next.edges).workflow.edges).toEqual(next.edges);
    const manual = updateDraftGraph(template, connectNodes(template, 'n-plan', 'n-review'), [], template.edges, { source: 'n-plan', target: 'n-review' });
    expect(manual.workflow.edges).toContainEqual({ source: 'n-plan', target: 'n-review' });
    expect(manual.automaticEdges).toEqual([]);
  });

  it('remembers deleted saved edges across edits and preserves only explicitly restored manual edges', () => {
    const edge = template.edges[0]!;
    const removed = removeGraphSelection(template, { kind: 'edge', ...edge });
    let draft = updateDraftGraph(template, removed, [], template.edges);
    const update = (next: WorkflowTemplate, manualEdge?: typeof edge) => {
      draft = updateDraftGraph(draft.workflow, next, draft.automaticEdges, template.edges, manualEdge, draft.deletedEdges);
    };
    update({ ...draft.workflow, name: '其他修改' });
    const node = draft.workflow.nodes.find(node => node.id === edge.source)!;
    const restored = { ...node, outputRules: template.nodes.find(node => node.id === edge.source)!.outputRules };
    update(replaceNode(draft.workflow, restored));
    expect(draft.automaticEdges).toContain(JSON.stringify([edge.source, edge.target]));
    update(replaceNode(draft.workflow, { ...restored, outputRules: [] }));
    expect(draft.workflow.edges).not.toContainEqual(edge);
    update(replaceNode(draft.workflow, restored));
    update(draft.workflow, edge);
    update(replaceNode(draft.workflow, { ...restored, outputRules: [] }));
    expect(draft.workflow.edges).toContainEqual(edge);
    expect(draft.automaticEdges).toEqual([]);
    expect(draft.deletedEdges).toContain(JSON.stringify([edge.source, edge.target]));
  });

  it('uses readable labels for nested rule, edge and workflow issues', () => {
    const label = (path: string) => workflowIssueLabel(template, { path, message: '' });
    expect(label('nodes.1.outputRules.0.target.nodeId')).toBe('實作 · Output 1 · 目的地');
    expect(label('nodes.1.model.effort')).toBe('實作 · 推理強度');
    expect(label('edges.0')).toBe('規劃 → 實作 · 連線');
    expect(label('nodes')).toBe('Root 節點（升級對象）');
    expect(label('reworkLimit')).toBe('返工上限');
    expect(label('unknown.field')).toBe('整體流程');
  });

  it('localizes every 0.4 workflow rule without reading issue messages', () => {
    for (const [rule, message] of Object.entries(workflowRuleMessages)) {
      expect(workflowIssueMessage({ code: 'custom', path: [], params: { rule }, message: 'unrelated English text' })).toBe(message);
    }
    const invalid = structuredClone(template);
    invalid.nodes.push(structuredClone(invalid.nodes[0]!));
    invalid.edges.push({ source: NodeId.parse('missing'), target: NodeId.parse('n-plan') });
    invalid.edges = invalid.edges.filter(edge => edge.source !== 'n-plan');
    const issues = workflowIssues(invalid);
    expect(new Set(issues.map(issue => issue.rule))).toEqual(new Set(Object.keys(workflowRuleMessages)));
    expect(issues).toContainEqual({ path: 'nodes', rule: 'workflow.node-id-unique', message: '節點 ID 不可重複。' });
    expect(issues).toContainEqual({ path: 'nodes', rule: 'workflow.one-root', message: '請指定且只指定一個 Agent 節點作為 root。' });
    expect(issues).toContainEqual({ path: `edges.${invalid.edges.length - 1}`, rule: 'workflow.edge-missing-node', message: '連線的來源或目的地節點不存在，請移除此連線或補回節點。' });
    expect(issues).toContainEqual({ path: 'nodes.0.outputRules.0.target', nodeId: 'n-plan', rule: 'workflow.output-needs-edge', message: 'Output 目的地缺少連線，請重新選取目的地或建立連線。' });
  });
});

describe('T019 workflow repository', () => {
  it('only accepts one concurrent save with the same expectedRevision and preserves fixture data', async () => {
    const before = JSON.stringify(template);
    const repository = createWorkflowRepository([template]);
    const first = workflowSaveCommand({ ...template, name: '第一份' }, template.revision);
    const second = workflowSaveCommand({ ...template, name: '第二份' }, template.revision);
    expect(await Promise.all([repository.save(first), repository.save(second)])).toEqual([
      expect.objectContaining({ ok: true, requestId: first.requestId, revision: template.revision + 1 }),
      expect.objectContaining({ ok: false, requestId: second.requestId, code: 'stale_revision' }),
    ]);
    expect(repository.getSnapshot()[0]?.name).toBe('第一份');
    expect(JSON.stringify(template)).toBe(before);
  });

  it('rejects invalid drafts, duplicate creates and missing edits without writing', async () => {
    const repository = createWorkflowRepository([template]);
    const before = repository.getSnapshot();
    expect(await repository.save(workflowSaveCommand({ ...template, nodes: [] }, template.revision))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await repository.save(workflowSaveCommand(template, null))).toMatchObject({ ok: false, code: 'already_exists' });
    expect(repository.getSnapshot()).toBe(before);
    expect(await createWorkflowRepository([]).save(workflowSaveCommand(template, template.revision))).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('injects a one-shot failure, notifies on success and accepts new records with null revision', async () => {
    const { repository, controls } = createWorkflowDemo([]);
    let notifications = 0;
    const unsubscribe = repository.subscribe(() => { notifications++; });
    controls.setSaveFailure(template.id, true);
    const command = workflowSaveCommand(template, null);
    expect(await repository.save(command)).toMatchObject({ ok: false, code: 'storage_failed', retryable: true });
    expect(repository.getSnapshot()).toHaveLength(0);
    expect(notifications).toBe(0);
    expect(await repository.save(command)).toMatchObject({ ok: true, revision: 1 });
    expect(notifications).toBe(1);
    unsubscribe();
    await repository.save(workflowSaveCommand(repository.getSnapshot()[0]!, 1));
    expect(notifications).toBe(1);
  });

  it('keeps the demo failure armed when validation or revision checks reject first', async () => {
    const { repository, controls } = createWorkflowDemo([template]);
    controls.setSaveFailure(template.id, true);
    await repository.save(workflowSaveCommand({ ...template, nodes: [] }, template.revision));
    expect(controls.hasSaveFailure(template.id)).toBe(true);
    await repository.save(workflowSaveCommand(template, template.revision + 1));
    expect(controls.hasSaveFailure(template.id)).toBe(true);
    expect(await repository.save(workflowSaveCommand(template, template.revision))).toMatchObject({ ok: false, code: 'storage_failed' });
    expect(controls.hasSaveFailure(template.id)).toBe(false);
  });
});

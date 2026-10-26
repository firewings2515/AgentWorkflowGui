import type { Edge, Node } from '@xyflow/react';
import type { WorkflowNode, WorkflowTemplate } from '../../../../contracts';
import type { GraphSelection } from '../workflow-editor-state';

export type CanvasNode = Node<{ node: WorkflowNode; isolation: WorkflowTemplate['isolation'] }, 'workflow'>;
export const edgeKey = (source: string, target: string) => JSON.stringify([source, target]);

export interface CanvasGraph { nodes: CanvasNode[]; edges: Edge[] }
export function toCanvas(workflow: WorkflowTemplate, selection: GraphSelection = null, previous?: CanvasGraph): CanvasGraph {
  const previousNodes = new Map(previous?.nodes.map(node => [node.id, node]));
  const nodes = workflow.nodes.map(node => {
    const old = previousNodes.get(node.id);
    const selected = selection?.kind === 'node' && selection.id === node.id;
    const sameData = old?.data.isolation === workflow.isolation && JSON.stringify(old.data.node) === JSON.stringify(node);
    const samePosition = old?.position.x === node.position.x && old.position.y === node.position.y;
    if (old && sameData && samePosition && old.selected === selected) return old;
    return {
      ...old, id: node.id, type: 'workflow' as const, position: samePosition && old ? old.position : { ...node.position },
      data: sameData && old ? old.data : { node: structuredClone(node), isolation: workflow.isolation },
      selected,
      ariaLabel: `${node.label}${node.kind === 'agent' && node.isRoot ? ' · root' : ''}`,
    };
  });
  let returnLane = 0;
  return {
    nodes,
    edges: workflow.edges.map(edge => {
      const returns = (nodes.find(node => node.id === edge.target)?.position.x ?? 0) <= (nodes.find(node => node.id === edge.source)?.position.x ?? 0);
      const label = `${workflow.nodes.find(node => node.id === edge.source)?.label ?? edge.source} → ${workflow.nodes.find(node => node.id === edge.target)?.label ?? edge.target}`;
      return {
        id: edgeKey(edge.source, edge.target), source: edge.source, target: edge.target,
        type: returns ? 'return' : 'default',
        data: { laneY: Math.min(...nodes.map(node => node.position.y)) - 32 - (returns ? returnLane++ : 0) * 28, label },
        selected: selection?.kind === 'edge' && selection.source === edge.source && selection.target === edge.target,
        ariaLabel: label,
      };
    }),
  };
}

// Only positions and edge endpoints cross back; base owns canonical node content.
// React Flow selection, dimensions, handles and viewport are presentation-only.
export function fromCanvas(base: WorkflowTemplate, nodes: CanvasNode[], edges: Edge[]): WorkflowTemplate {
  const domainNodes = base.nodes.map(node => {
    const item = nodes.find(item => item.id === node.id);
    return item && (item.position.x !== node.position.x || item.position.y !== node.position.y)
      ? { ...node, position: { ...item.position } } : node;
  });
  const ids = new Map(domainNodes.map(node => [node.id as string, node.id]));
  return {
    ...base, nodes: domainNodes,
    edges: edges.map(edge => {
      const source = ids.get(edge.source);
      const target = ids.get(edge.target);
      if (!source || !target) throw new Error('Canvas edge references a missing domain node');
      return { source, target };
    }),
  };
}

import { useMemo } from 'react';
import { Background, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import type { WorkflowInstance } from '../../../contracts';
import { statusLabel } from './ui';
import { ProgressFit, progressFitOptions, PROGRESS_MIN_ZOOM } from './workflow-canvas/ProgressFit';

export function TaskDependencies({ instance, selected, onSelect }: { instance: WorkflowInstance; selected: string; onSelect: (id: string) => void }) {
  const graph = useMemo(() => {
    const levels = new Map<string, number>();
    const level = (id: string, visiting = new Set<string>()): number => {
      if (visiting.has(id)) return 0;
      const known = levels.get(id); if (known !== undefined) return known;
      const task = instance.tasks.find(t => t.id === id);
      const next = new Set(visiting).add(id);
      const value = Math.max(0, ...(task?.dependsOn.map(dep => level(dep, next) + 1) ?? []));
      levels.set(id, value); return value;
    };
    const rows = new Map<number, number>();
    const nodes = instance.tasks.map(task => {
      const column = level(task.id); const row = rows.get(column) ?? 0; rows.set(column, row + 1);
      return { id: task.id, position: { x: column * 250, y: row * 110 }, data: { label: `${task.title} · ${statusLabel(task.status)}` }, selected: task.id === selected, ariaLabel: `選取 task：${task.title}` };
    });
    const edges = instance.tasks.flatMap(task => task.dependsOn.map(dep => ({ id: JSON.stringify([dep, task.id]), source: dep, target: task.id, markerEnd: { type: MarkerType.ArrowClosed } })));
    return { nodes, edges };
  }, [instance, selected]);
  return <div className="dependency-canvas workflow-canvas" role="region" aria-label="Task 依賴關係圖" onKeyDown={event => {
    const id = event.target instanceof Element ? event.target.closest('.react-flow__node')?.getAttribute('data-id') : undefined;
    if (event.key === 'Enter' && id) onSelect(id);
  }}>
    <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView fitViewOptions={progressFitOptions} minZoom={PROGRESS_MIN_ZOOM}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      onNodeClick={(_event, node) => onSelect(node.id)}
      ariaLabelConfig={{ 'controls.fitView.ariaLabel': '符合依賴圖大小', 'controls.zoomIn.ariaLabel': '放大依賴圖', 'controls.zoomOut.ariaLabel': '縮小依賴圖' }}>
      <Background /><Controls showInteractive={false} /><ProgressFit />
    </ReactFlow>
  </div>;
}

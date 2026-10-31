import { useMemo } from 'react';
import { Background, Controls, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { WorkflowInstance } from '../../../contracts';
import { statusLabel } from './ui';
import { ProgressFit } from './workflow-canvas/ProgressFit';

export const dependencyFitOptions = { minZoom: 0.8, maxZoom: 1, padding: 0.12 };

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
    const counts = new Map<number, number>();
    for (const task of instance.tasks) {
      const depth = level(task.id);
      counts.set(depth, (counts.get(depth) ?? 0) + 1);
    }
    // Keep each dependency depth to the right of all its predecessors, but wrap
    // large independent groups into columns of three instead of a tall thin list.
    const columns = new Map<number, number>();
    let nextColumn = 0;
    for (const depth of [...counts.keys()].sort((a, b) => a - b)) {
      columns.set(depth, nextColumn);
      nextColumn += Math.ceil(counts.get(depth)! / 3);
    }
    const rows = new Map<number, number>();
    const nodes = instance.tasks.map(task => {
      const depth = level(task.id); const index = rows.get(depth) ?? 0; rows.set(depth, index + 1);
      const column = columns.get(depth)! + Math.ceil(counts.get(depth)! / 3) - 1 - Math.floor(index / 3);
      return { id: task.id, position: { x: column * 290, y: (index % 3) * 110 },
        sourcePosition: Position.Right, targetPosition: Position.Left, className: 'task-dependency-node',
        data: { label: `${task.title} · ${statusLabel(task.status)}` }, selected: task.id === selected, ariaLabel: `選取 task：${task.title}` };
    });
    const edges = instance.tasks.flatMap(task => task.dependsOn.map(dep => ({ id: JSON.stringify([dep, task.id]), source: dep, target: task.id,
      type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24 },
      ariaLabel: `${instance.tasks.find(t => t.id === dep)?.title ?? dep} → ${task.title}` })));
    return { nodes, edges };
  }, [instance, selected]);
  return <><p className="muted">箭頭由前置 task 指向依賴它的 task；可拖曳平移查看，點選 task 查看進度。</p>
  <div className="dependency-canvas workflow-canvas" role="region" aria-label="Task 依賴關係圖" onKeyDown={event => {
    const id = event.target instanceof Element ? event.target.closest('.react-flow__node')?.getAttribute('data-id') : undefined;
    if (event.key === 'Enter' && id) onSelect(id);
  }}>
    <ReactFlow nodes={graph.nodes} edges={graph.edges} minZoom={dependencyFitOptions.minZoom}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      onNodeClick={(_event, node) => onSelect(node.id)}
      ariaLabelConfig={{ 'controls.fitView.ariaLabel': '符合依賴圖大小', 'controls.zoomIn.ariaLabel': '放大依賴圖', 'controls.zoomOut.ariaLabel': '縮小依賴圖' }}>
      <Background /><Controls showInteractive={false} fitViewOptions={dependencyFitOptions} /><ProgressFit options={dependencyFitOptions} />
    </ReactFlow>
  </div></>;
}

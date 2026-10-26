import { useCallback, useEffect, useRef, useState } from 'react';
import { applyNodeChanges, Background, BaseEdge, ControlButton, Controls, EdgeText, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import type { EdgeProps, NodeProps } from '@xyflow/react';
import type { WorkflowNode, WorkflowTemplate } from '../../../../contracts';
import { isolationLabels, writePolicyLabels } from '../workflow-editor-state';
import type { GraphSelection } from '../workflow-editor-state';
import { fromCanvas, toCanvas } from './graph-adapter';
import type { CanvasNode } from './graph-adapter';
import { fitWorkflowViewport, MIN_CANVAS_ZOOM } from './fit-viewport';
import '@xyflow/react/dist/style.css';
import './workflow-canvas.css';

export const NODE_DRAG_TYPE = 'application/x-awg-workflow-node';
function NodeCard({ data }: NodeProps<CanvasNode>) {
  const node = data.node;
  return <div className={`workflow-node-card ${node.kind}`}>
    <Handle type="target" position={Position.Left} />
    <div className="workflow-node-title"><strong>{node.label || '未命名節點'}</strong>{node.kind === 'agent' && node.isRoot && <span className="badge">root</span>}</div>
    <span>{node.kind === 'merge' ? '合併節點' : `${node.model.runtime} · ${node.model.model}`}</span>
    <span>{node.kind === 'merge' ? 'GUI 執行 · 一次一個 task' : `${writePolicyLabels[node.writePolicy]} · 並行 ${node.concurrency}`}</span>
    <small>{isolationLabels[data.isolation]}</small>
    {node.inputRules.some(rule => rule.waitForAllUpstream) && <small className="workflow-wait">等所有上游到齊（同 task／輪次）</small>}
    <Handle type="source" position={Position.Right} />
  </div>;
}
const nodeTypes = { workflow: NodeCard };
function ReturnEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, data }: EdgeProps) {
  const laneY = typeof data?.laneY === 'number' ? data.laneY : Math.min(sourceY, targetY) - 100;
  const path = `M ${sourceX} ${sourceY} H ${sourceX + 10} V ${laneY} H ${targetX - 10} V ${targetY} H ${targetX}`;
  return <><BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} /><EdgeText x={(sourceX + targetX) / 2} y={laneY} label={typeof data?.label === 'string' ? data.label : '返回'} /></>;
}
const edgeTypes = { return: ReturnEdge };
interface Props {
  workflow: WorkflowTemplate; selection: GraphSelection; disabled: boolean;
  onChange: (workflow: WorkflowTemplate) => void;
  onSelect: (selection: GraphSelection) => void;
  onConnect: (source: string, target: string) => void;
  onAdd: (kind: WorkflowNode['kind'], position: WorkflowNode['position']) => void;
  onDelete: (selection: GraphSelection) => void;
}
function Canvas(props: Props) {
  const { workflow, selection, disabled, onChange, onSelect, onConnect, onAdd, onDelete } = props;
  const [state, setState] = useState(() => ({ workflow, selection, graph: toCanvas(workflow, selection) }));
  let graph = state.graph;
  if (state.workflow !== workflow || state.selection !== selection) {
    graph = toCanvas(workflow, selection, graph);
    setState({ workflow, selection, graph });
  }
  const { screenToFlowPosition, getNodes, getNodesBounds, setViewport } = useReactFlow<CanvasNode>();
  const initialized = useNodesInitialized();
  const container = useRef<HTMLDivElement>(null);
  const userViewport = useRef(false);
  const fitView = useCallback(() => {
    const element = container.current;
    const nodes = getNodes();
    if (!element || !nodes.length || !element.clientWidth || !element.clientHeight) return;
    const root = nodes.find(node => node.data.node.kind === 'agent' && node.data.node.isRoot);
    void setViewport(fitWorkflowViewport(getNodesBounds(nodes), root ? getNodesBounds([root]) : undefined, element.clientWidth, element.clientHeight));
  }, [getNodes, getNodesBounds, setViewport]);
  useEffect(() => {
    if (!initialized || !container.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (!userViewport.current) fitView(); });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitView, initialized]);
  return <div ref={container} className="workflow-canvas" role="region" tabIndex={-1} aria-label="Workflow 畫布" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
    onDrop={event => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(NODE_DRAG_TYPE);
      if (!disabled && (kind === 'agent' || kind === 'merge')) onAdd(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }} onKeyDown={event => {
      if (disabled || !(event.target instanceof Element) || !event.target.matches('.react-flow__node, .react-flow__edge')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const id = event.target.getAttribute('data-id');
        const edge = graph.edges.find(edge => edge.id === id);
        if (event.target.matches('.react-flow__node') && id) onDelete({ kind: 'node', id });
        else if (edge) onDelete({ kind: 'edge', source: edge.source, target: edge.target });
      }
    }}>
    <ReactFlow<CanvasNode> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} minZoom={MIN_CANVAS_ZOOM} maxZoom={2}
      nodesDraggable={!disabled} nodesConnectable={!disabled} deleteKeyCode={null} multiSelectionKeyCode={null}
      defaultMarkerColor="var(--muted)" defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24 } }}
      onMoveStart={event => { if (event) userViewport.current = true; }}
      onNodesChange={changes => {
        const allowed = changes.filter(change => change.type === 'dimensions' || change.type === 'select' || (!disabled && change.type === 'position'));
        const nodes = applyNodeChanges(allowed, graph.nodes);
        setState({ workflow, selection, graph: { ...graph, nodes } });
        if (!disabled && changes.some(change => change.type === 'position' && change.position)) {
          onChange(fromCanvas(workflow, nodes, graph.edges));
        }
        const selected = changes.find(change => change.type === 'select' && change.selected);
        if (selected?.type === 'select') onSelect({ kind: 'node', id: selected.id });
        else if (selection?.kind === 'node' && changes.some(change => change.type === 'select' && !change.selected && change.id === selection.id)) onSelect(null);
      }}
      onEdgesChange={changes => {
        const selected = changes.find(change => change.type === 'select' && change.selected);
        const edge = selected?.type === 'select' && graph.edges.find(edge => edge.id === selected.id);
        if (edge) onSelect({ kind: 'edge', source: edge.source, target: edge.target });
        else if (selection?.kind === 'edge' && changes.some(change => change.type === 'select' && !change.selected && graph.edges.some(edge => edge.id === change.id && edge.source === selection.source && edge.target === selection.target))) onSelect(null);
      }}
      onNodeClick={(event, node) => { (event.target as Element).closest<HTMLElement>('.react-flow__node')?.focus(); onSelect({ kind: 'node', id: node.id }); }}
      onEdgeClick={(event, edge) => { (event.target as Element).closest<SVGElement>('.react-flow__edge')?.focus(); onSelect({ kind: 'edge', source: edge.source, target: edge.target }); }}
      onPaneClick={() => { container.current?.focus(); onSelect(null); }}
      isValidConnection={connection => connection.source !== connection.target}
      onConnect={connection => { if (!disabled) onConnect(connection.source, connection.target); }}
      ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大畫布', 'controls.zoomOut.ariaLabel': '縮小畫布', 'controls.fitView.ariaLabel': '符合畫布大小', 'node.a11yDescription.default': '按 Enter 選取節點、方向鍵移動、Delete 刪除、Tab 移動焦點。', 'edge.a11yDescription.default': '按 Enter 選取連線、Delete 刪除。' }}>
      <Background /><Controls showInteractive={false} showFitView={false}
        onZoomIn={() => { userViewport.current = true; }} onZoomOut={() => { userViewport.current = true; }}>
        <ControlButton title="符合畫布大小" aria-label="符合畫布大小" onClick={() => { userViewport.current = false; fitView(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6" /></svg>
        </ControlButton>
      </Controls>
    </ReactFlow>
  </div>;
}
export function WorkflowCanvas(props: Props) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }

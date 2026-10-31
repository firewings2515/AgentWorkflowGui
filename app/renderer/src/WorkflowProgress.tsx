import { useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { LogicalSession, SessionId, Snapshot, WorkflowInstance, WorkflowNode, WorkflowTask } from '../../../contracts';
import { toCanvas } from './workflow-canvas/graph-adapter';
import { ReturnEdge } from './workflow-canvas/ReturnEdge';
import { ProgressFit, progressFitOptions, PROGRESS_MIN_ZOOM } from './workflow-canvas/ProgressFit';
import { TaskDependencies } from './TaskDependencies';
import { MergeQueue, RoundDetails, TaskFacts, nodeLabel } from './PipelineDetails';
import { PipelineActions } from './PipelineActions';
import type { PipelineControlProps } from './PipelineActions';
import { FolderButton } from './FolderButton';
import { LockWaits } from './LockWaits';
import { Empty, Status } from './ui';
import '@xyflow/react/dist/style.css';
import './workflow-canvas/workflow-canvas.css';

// A node's activity is an observed session fact, never inferred from a handoff's delivery.
export function nodeSessions(snapshot: Pick<Snapshot, 'sessions'>, instance: WorkflowInstance, task: WorkflowTask, node: WorkflowNode): LogicalSession[] {
  return snapshot.sessions.filter(s => s.kind === 'workflow' && s.workflow.instanceId === instance.id && s.workflow.nodeId === node.id &&
    (s.workflow.taskId === task.id || (s.id === instance.rootSessionId && s.workflow.taskId === undefined)));
}
function missingSessionText(snapshot: Pick<Snapshot, 'handoffs'>, instance: WorkflowInstance, task: WorkflowTask, node: WorkflowNode) {
  const hasHandoff = snapshot.handoffs.some(h => h.instanceId === instance.id && h.taskId === task.id && (h.fromNodeId === node.id || h.toNodeId === node.id));
  return hasHandoff ? '已有交接紀錄，尚無 session 資料' : task.currentNodeId === node.id ? '尚無 session 狀態' : '尚未進入（未建立 session）';
}
type ProgressNode = Node<{ node: WorkflowNode; sessions: LogicalSession[]; emptyText: string; current: boolean; task: WorkflowTask; instance: WorkflowInstance; onOpen: (id: SessionId) => void }, 'progress'>;
function NodeCard({ data }: NodeProps<ProgressNode>) {
  return <div className="workflow-node-card progress-node" data-current={data.current}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <strong>{data.node.label}{data.node.kind === 'agent' && data.node.isRoot ? ' · root' : ''}</strong>
    {data.current && <span className="current-node">目前節點 · <Status value={data.task.status} /></span>}
    {data.instance.rounds.filter(r => r.taskId === data.task.id && r.nodeId === data.node.id).map(r => <small key={r.round}>第 {r.round} 輪 · {r.state === 'blocked' ? '受阻' : r.state === 'ready' ? '已到齊' : '等待上游'} · {r.arrived.length}/{r.expectedUpstream.length} 到達</small>)}
    {data.sessions.length ? data.sessions.map(s => <button className="nodrag" key={s.id} onClick={() => data.onOpen(s.id)} aria-label={`開啟 ${data.node.label} 的 session：${s.title}`}><Status value={s.activity} /><span>查看 session／日誌</span></button>) : <span>{data.emptyText}</span>}
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
}
const nodeTypes = { progress: NodeCard };
const edgeTypes = { return: ReturnEdge };
const timestamp = (value: string) => new Date(value).toLocaleString('zh-TW', { hour12: false });

export function WorkflowProgress({ snapshot, instanceId, onOpen, onBack, store, ipcState }: PipelineControlProps & {
  snapshot: Snapshot; instanceId: string; onOpen: (id: SessionId) => void; onBack: () => void;
}) {
  const instance = snapshot.instances.find(i => i.id === instanceId);
  return <section className="workflow-progress" aria-label="Workflow 執行進度">
    <header className="progress-header"><div><span className="eyebrow">指定執行群組 · 流程圖唯讀</span><h2>{instance?.title ?? '找不到指定的 Workflow 執行群組'}</h2><p className="muted">{instanceId}</p></div><button onClick={onBack}>返回工作台</button></header>
    {!instance ? <Empty>無法取得指定執行群組，請確認 ID 與資料同步狀態。</Empty> : <>
      <p>群組狀態：<Status value={instance.state} /> · 啟動時範本：{instance.template.name} · v{instance.workflowRevision}</p>
      {instance.projectId && <div>專案：{snapshot.projects.find(p => p.id === instance.projectId)?.name ?? instance.projectId} <FolderButton target={{ kind: 'project', projectId: instance.projectId }} /></div>}
      {['running', 'blocked'].includes(instance.state) && <PipelineActions instance={instance} store={store} ipcState={ipcState} />}
      <GroupProgress key={instance.id} snapshot={snapshot} instance={instance} onOpen={onOpen} store={store} ipcState={ipcState} />
    </>}
  </section>;
}

function GroupProgress({ snapshot, instance, onOpen, store, ipcState }: PipelineControlProps & { snapshot: Snapshot; instance: WorkflowInstance; onOpen: (id: SessionId) => void }) {
  const [selected, setSelected] = useState<string>(instance.tasks[0]?.id ?? '');
  const task = instance.tasks.length === 1 ? instance.tasks[0] : instance.tasks.find(t => t.id === selected);
  return <>
    {instance.tasks.length > 1 && <section aria-label="群組 task 清單"><h3>Task（{instance.tasks.length}）· 同時執行上限 {instance.taskLimit}</h3>
      <ul className="task-list">{instance.tasks.map(item => <li key={item.id}><button aria-pressed={item.id === selected} onClick={() => setSelected(item.id)}>{item.title} · {item.id}</button><Status value={item.status} />
        <p>目前節點：{item.currentNodeId ? nodeLabel(instance, item.currentNodeId) : '尚未指定'} · 依賴：{item.dependsOn.map(id => instance.tasks.find(t => t.id === id)?.title ?? id).join('、') || '無'}</p>
        <p>Worktree：<code>{item.worktree?.path ?? (instance.template.isolation === 'same-folder' ? '共用資料夾' : '尚未建立')}</code>{item.worktree?.cleanup === 'pending-cleanup' && ' · 待清理'}</p>
      </li>)}</ul><TaskDependencies instance={instance} selected={selected} onSelect={setSelected} />
    </section>}
    {task ? <SingleTaskProgress key={task.id} snapshot={snapshot} instance={instance} task={task} onOpen={onOpen} store={store} ipcState={ipcState} /> : <Empty>{instance.tasks.length ? '請選擇 task 查看進度。' : '尚無 task 資料；不代表已完成。'}</Empty>}
    <MergeQueue instance={instance} store={store} ipcState={ipcState} />
  </>;
}

function SingleTaskProgress({ snapshot, instance, task, onOpen, store, ipcState }: PipelineControlProps & { snapshot: Snapshot; instance: WorkflowInstance; task: WorkflowTask; onOpen: (id: SessionId) => void }) {
  const { sessions, handoffs: snapshotHandoffs } = snapshot;
  const graph = useMemo(() => {
    const base = toCanvas(instance.template);
    const nodes: ProgressNode[] = base.nodes.map(n => ({ id: n.id, position: n.position, type: 'progress', draggable: false, connectable: false,
      ariaLabel: n.data.node.label, data: { node: n.data.node, sessions: nodeSessions({ sessions }, instance, task, n.data.node), emptyText: missingSessionText({ handoffs: snapshotHandoffs }, instance, task, n.data.node), current: task.currentNodeId === n.id, task, instance, onOpen } }));
    return { nodes, edges: base.edges };
  }, [sessions, snapshotHandoffs, instance, task, onOpen]);
  const handoffs = snapshot.handoffs.filter(h => h.instanceId === instance.id && h.taskId === task.id).toSorted((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
  const label = (id: string) => instance.template.nodes.find(n => n.id === id)?.label ?? id;
  return <>
    <div className="progress-task"><h3>{task.title}</h3><Status value={task.status} /><p>目前節點：{task.currentNodeId ? label(task.currentNodeId) : '尚未指定'} · 返工 {task.reworkCount} 次／上限 {instance.template.reworkLimit} 次</p></div>
    <TaskFacts instance={instance} task={task} store={store} ipcState={ipcState} />
    {instance.rounds.filter(r => r.taskId === task.id).map(round => <RoundDetails key={`${round.nodeId}:${round.round}`} instance={instance} round={round} />)}
    <p className="muted">框線標示目前節點；各節點顯示 session 活動。已送達、閒置均不代表工作完成或驗收通過。</p>
    <div className="progress-layout">
      <div className="workflow-canvas progress-canvas" role="region" aria-label="唯讀流程圖">
        <ReactFlow<ProgressNode> nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={progressFitOptions} minZoom={PROGRESS_MIN_ZOOM} maxZoom={2}
          nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false} deleteKeyCode={null} zoomOnDoubleClick={false}
          onNodeClick={(event, node) => {
            if (!(event.target as Element).closest('button') && node.data.sessions.length === 1 && node.data.sessions[0]) onOpen(node.data.sessions[0].id);
          }}
          defaultMarkerColor="var(--muted)" defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed, width: 24, height: 24 } }}
          ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大進度圖', 'controls.zoomOut.ariaLabel': '縮小進度圖', 'controls.fitView.ariaLabel': '符合進度圖大小' }}>
          <Background /><Controls showInteractive={false} /><ProgressFit />
        </ReactFlow>
      </div>
      <section className="progress-logs" aria-label="各 node 的 session 與日誌"><h3>節點與工作日誌</h3>
        {instance.template.nodes.map(node => {
          const sessions = nodeSessions(snapshot, instance, task, node);
          return <article className="detail-card" key={node.id} data-current={task.currentNodeId === node.id}>
            <h4>{node.label}{task.currentNodeId === node.id ? ' · 目前節點' : ''}</h4>
            {sessions.length === 0 && <p>{missingSessionText(snapshot, instance, task, node)}</p>}
            {sessions.map(session => <div key={session.id}><Status value={session.activity} /><button onClick={() => onOpen(session.id)}>開啟 {session.title}</button>
              <LockWaits snapshot={snapshot} sessionId={session.id} onOpen={onOpen} />
              <details><summary>{session.title} · 觀察日誌</summary>
                <p className="muted">Session 更新：{timestamp(session.updatedAt)}</p>
                {snapshot.messages.filter(m => m.sessionId === session.id && !m.nativeTaskId).map(m => <article key={m.id}><time dateTime={m.createdAt}>{timestamp(m.createdAt)}</time><pre>{m.text}</pre></article>)}
                {snapshot.items.filter(i => i.sessionId === session.id && !i.nativeTaskId).map(i => <article key={i.id}><Status value={i.state} /><pre>{i.kind === 'command' ? `${i.command}\n${i.output}` : i.kind === 'toolCall' ? `${i.tool}\n${i.summary}` : i.changes.map(c => c.path).join('\n')}</pre></article>)}
                {!snapshot.messages.some(m => m.sessionId === session.id && !m.nativeTaskId) && !snapshot.items.some(i => i.sessionId === session.id && !i.nativeTaskId) && <Empty>尚無主 session 日誌。</Empty>}
              </details>
            </div>)}
          </article>;
        })}
      </section>
    </div>
    <section aria-label="交接紀錄"><h3>交接紀錄</h3>
      {handoffs.length === 0 ? <Empty>尚無交接紀錄。</Empty> : <div className="handoff-table" role="region" aria-label="交接紀錄表格" tabIndex={0}><table><thead><tr><th>接納時間</th><th>來源 → 目標</th><th>規則／返工</th><th>送達狀態</th><th>操作結果</th><th>內容</th></tr></thead><tbody>
        {handoffs.map(h => {
          const rule = instance.template.nodes.find(n => n.id === h.fromNodeId)?.outputRules.find(r => r.id === h.ruleId);
          return <tr key={h.id}><td><time dateTime={h.acceptedAt}>{timestamp(h.acceptedAt)}</time></td><td>{label(h.fromNodeId)} → {label(h.toNodeId)}</td>
            <td>{h.ruleId}{rule && <p>{rule.condition}</p>}<p>{h.rework ? '返工交接' : '一般交接'}</p></td>
            <td><Status value={h.delivery.state} /></td><td>{h.outcome ? <><Status value={h.outcome.kind} /><p>{h.outcome.detail}</p></> : '尚無操作結果'}</td>
            <td><details><summary>查看交接內容</summary><pre>{h.payload}</pre></details></td></tr>;
        })}
      </tbody></table></div>}
    </section>
  </>;
}

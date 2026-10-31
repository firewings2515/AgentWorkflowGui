import { useState } from 'react';
import { RequestId } from '../../../contracts';
import type { WorkflowInstance, WorkflowTask } from '../../../contracts';
import { blocksResubmit, commandFeedback } from './command-feedback';
import { commandTarget } from './renderer-store';
import type { RendererState, RendererStore } from './renderer-store';

export interface PipelineControlProps { store?: RendererStore | undefined; ipcState?: RendererState | undefined }
export function PipelineActions({ instance, task, store, ipcState }: PipelineControlProps & { instance: WorkflowInstance; task?: WorkflowTask }) {
  const [pending, setPending] = useState<{ type: 'workflow.complete' | 'workflow.cancel'; instanceId: string; revision: number }>();
  const confirmation = pending?.instanceId === instance.id && pending.revision === instance.revision && !task ? pending : undefined;
  const types = task ? ['task.retryCleanup'] as const : ['workflow.complete', 'workflow.cancel'] as const;
  const target = task ? `task:${JSON.stringify([instance.id, task.id])}` : `instance:${instance.id}`;
  const activities = Object.values(ipcState?.commands ?? {}).filter(a => types.some(type => type === a.command.type) && commandTarget(a.command) === target);
  const last = activities.at(-1);
  const blocked = !store || ipcState?.connection !== 'ready' || ipcState.snapshot?.app.status === 'damaged'
    || types.some(type => store.isBlocked(type, target)) || activities.some(a => a.result?.ok || (a.result && blocksResubmit(a.result)));
  return <div className="pipeline-actions">
    {types.map(type => <button key={type} disabled={blocked} onClick={() => {
      if (blocked) return;
      if (type === 'task.retryCleanup' && task) void store.send({ type, requestId: RequestId.parse(crypto.randomUUID()), instanceId: instance.id, taskId: task.id });
      else if (type !== 'task.retryCleanup') setPending({ type, instanceId: instance.id, revision: instance.revision });
    }}>{type === 'task.retryCleanup' ? '重試清理' : type === 'workflow.complete' ? '結束群組為已完成' : '取消執行群組'}</button>)}
    {confirmation && <section aria-label="確認群組操作">
      <p>{confirmation.type === 'workflow.complete'
        ? `確定結束「${instance.title}」為已完成？未完成的 task 將視為已完成，不再合併。`
        : `確定取消「${instance.title}」？取消執行群組後無法復原，此操作不可逆。`}</p>
      <button type="button" onClick={() => setPending(undefined)}>返回，不送出</button>
      <button type="button" disabled={blocked} onClick={() => {
        if (blocked) return;
        setPending(undefined);
        void store.send({ type: confirmation.type, requestId: RequestId.parse(crypto.randomUUID()), instanceId: instance.id, expectedRevision: instance.revision });
      }}>{confirmation.type === 'workflow.complete' ? '確認結束為已完成' : '確認取消執行群組'}</button>
    </section>}
    {last && <p role={last.result && !last.result.ok ? 'alert' : 'status'}>{!last.result ? '正在送出…' : last.result.ok ? '操作已接受，請核對最新狀態。' : `${commandFeedback(last.result)}（${last.result.code}）`}</p>}
  </div>;
}

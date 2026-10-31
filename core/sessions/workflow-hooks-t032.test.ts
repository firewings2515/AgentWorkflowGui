// T032 (G-1, the main session's ruling): the session service hands `workflow.complete`, `workflow.cancel` and
// `task.retryCleanup` to the workflow engine, asks it before a user message to a workflow session, and closes a
// workflow session's runtime for the pipeline. Ordinary sessions, and a service without workflow hooks, behave
// as before.
import { describe, expect, it } from 'vitest';
import { type Escalation, EscalationId, HandoffId, InstanceId, MessageId, OperationId, TaskId } from '../../contracts';
import { createTasks, pipelineTemplate, project } from '../pipeline/testing/t032-cases';
import type { WorkflowHooks } from './service';
import { ROOT, started, world as workflowWorld } from '../workflow/testing/harness';
import { created, rid, session, settle, world } from './testing/harness';

const ending = (type: 'workflow.complete' | 'workflow.cancel' | 'task.retryCleanup') =>
  type === 'task.retryCleanup'
    ? { type, requestId: rid(), instanceId: InstanceId.parse('run-x'), taskId: TaskId.parse('task-x') }
    : { type, requestId: rid(), instanceId: InstanceId.parse('run-x'), expectedRevision: 0 };

/** Hooks that take nothing (an engine without the pipeline): only what T032 added is looked at. */
const idleHooks = (extra: Partial<WorkflowHooks> = {}): WorkflowHooks => ({
  start: () => Promise.reject(new Error('not used')),
  respond: () => Promise.resolve(undefined),
  turnEnded: () => undefined,
  briefing: () => Promise.resolve(undefined),
  mayDeliver: () => Promise.resolve(true),
  userMessageFate: () => Promise.resolve('deliver'),
  ...extra,
});

describe('T032 workflow hooks of the session service', () => {
  it('without workflow hooks, or hooks that do not take them, the three commands stay unsupported', async () => {
    const w = await world();
    for (const type of ['workflow.complete', 'workflow.cancel', 'task.retryCleanup'] as const) {
      expect(await w.run(ending(type))).toMatchObject({ ok: false, code: 'unsupported' });
    }
    w.service.attachWorkflow(idleHooks({ execute: () => undefined }));
    for (const type of ['workflow.complete', 'workflow.cancel', 'task.retryCleanup'] as const) {
      expect(await w.run(ending(type))).toMatchObject({ ok: false, code: 'unsupported' });
    }
  });

  it('the engine answers them when it takes them', async () => {
    const w = await world();
    const seen: string[] = [];
    w.service.attachWorkflow(
      idleHooks({
        execute: (command) => {
          seen.push(command.type);
          return Promise.resolve({ ok: true, requestId: command.requestId, created: [] });
        },
      }),
    );
    expect(await w.run(ending('workflow.cancel'))).toMatchObject({ ok: true });
    expect(seen).toEqual(['workflow.cancel']);
  });

  it('an ordinary session sends as before: the workflow is never asked', async () => {
    const w = await world();
    let asked = 0;
    w.service.attachWorkflow(
      idleHooks({
        sessionAccess: () => {
          asked++;
          return Promise.resolve('never for an ordinary session');
        },
      }),
    );
    const { sessionId } = await created(w);
    const sent = await w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse('m-1'), expectedRevision: (await session(w, sessionId)).revision, text: 'hello', attachments: [] });
    expect(sent).toMatchObject({ ok: true });
    expect(asked).toBe(0);
    expect((await w.store.get(OperationId.parse('user-message:m-1')))?.delivery.state).toBe('sent');
  });

  it('a workflow session the engine keeps read only is refused with its reason, nothing stored or sent', async () => {
    const w = await workflowWorld();
    await started(w);
    const refusing = w.engine;
    const original = refusing.sessionAccess.bind(refusing);
    refusing.sessionAccess = (sessionId) => (sessionId === ROOT ? Promise.resolve('This task was merged; its sessions can only be viewed.') : original(sessionId));
    const root = await w.repositories.sessions.get(ROOT);
    const result = await w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse('m-ro'), expectedRevision: root!.revision, text: 'more', attachments: [] });
    expect(result).toMatchObject({ ok: false, code: 'invalid_transition', message: 'This task was merged; its sessions can only be viewed.' });
    expect(await w.store.get(OperationId.parse('user-message:m-ro'))).toBeUndefined();
  });

  it('a restart keeps a task list waiting for the user open, and still closes other confirmations nobody holds', async () => {
    const w = await workflowWorld(pipelineTemplate({ confirm: true }));
    await w.repositories.projects.save(project(), null);
    await started(w);
    const asked = await createTasks(w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }], 'call-keep');
    if (asked.status !== 'awaiting-confirmation') throw new Error('not asked');
    const stale: Escalation = {
      id: EscalationId.parse('wf-confirm:op-held'),
      instanceId: InstanceId.parse('run-1'),
      rootSessionId: ROOT,
      fromSessionId: ROOT,
      kind: 'confirmation',
      title: 'A handoff waits for your confirmation',
      detail: 'held in memory only',
      ref: { kind: 'handoff', handoffId: HandoffId.parse('handoff-op-held') },
      state: 'open',
      createdAt: '2026-10-29T00:00:00.000Z',
    };
    await w.repositories.escalations.upsert(stale);
    const r = await w.restart();
    expect(await r.repositories.escalations.get(asked.escalationId)).toMatchObject({ state: 'open' });
    expect((await r.repositories.escalations.get(asked.escalationId))?.resolvedAt).toBeUndefined();
    expect(await r.repositories.escalations.get(stale.id)).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
    expect(await r.run({ type: 'escalation.respond', requestId: rid(), escalationId: asked.escalationId, decision: 'approve' })).toMatchObject({ ok: true });
  });

  it('r1 P1-5: a close that hangs ends at its deadline, counted from the call though the session\'s queue is stuck; the runtime is released and onSessionClosed ran first', async () => {
    const w = await workflowWorld();
    await started(w);
    await settle();
    const internals = w.service as unknown as {
      options: { sleep?: (ms: number) => Promise<void>; onSessionClosed?: (sessionId: string) => void };
      runtimes: { isOpen(ref: string): boolean };
      binding(sessionId: string): Promise<string | undefined>;
    };
    const closed: string[] = [];
    const slept: number[] = [];
    internals.options.sleep = (ms) => {
      slept.push(ms);
      return Promise.resolve();
    };
    internals.options.onSessionClosed = (sessionId) => void closed.push(sessionId);
    const ref = await internals.binding(ROOT);
    expect(ref !== undefined && internals.runtimes.isOpen(ref)).toBe(true);
    // The session's queue is held by a dispatch that never returns, and the adapter's own close never ends.
    w.claude.dispatchOnce = () => new Promise(() => undefined);
    w.claude.closeSession = () => new Promise(() => undefined);
    const root = await w.repositories.sessions.get(ROOT);
    void w.run({ type: 'session.send', requestId: rid(), sessionId: ROOT, messageId: MessageId.parse('m-stuck'), expectedRevision: root!.revision, text: 'stuck', attachments: [] });
    await settle();
    await w.service.closeWorkflowRuntime(ROOT, 1234);
    expect(slept).toContain(1234);
    expect(closed).toEqual([ROOT]);
    expect(internals.runtimes.isOpen(ref!)).toBe(false);
  });

  it('r2 P1-3: past the deadline it still waits for the release the graceful close began: it returns only once a slow onSessionClosed has finished', async () => {
    const w = await workflowWorld();
    await started(w);
    await settle();
    const internals = w.service as unknown as {
      options: { sleep?: (ms: number) => Promise<void>; onSessionClosed?: (sessionId: string) => Promise<void> };
      runtimes: { isOpen(ref: string): boolean };
      binding(sessionId: string): Promise<string | undefined>;
    };
    // The deadline passes at once; the adapter's close is quick, the release after it (the Job ending) is slow.
    internals.options.sleep = () => Promise.resolve();
    let finished = false;
    let calls = 0;
    internals.options.onSessionClosed = async () => {
      calls++;
      for (let i = 0; i < 50; i++) await Promise.resolve();
      finished = true;
    };
    const ref = await internals.binding(ROOT);
    await w.service.closeWorkflowRuntime(ROOT, 10);
    expect(finished).toBe(true);
    expect(calls).toBe(1);
    expect(internals.runtimes.isOpen(ref!)).toBe(false);
    // A second close (the pipeline's cleanup after a give-up, say) finds it released and returns at once.
    await w.service.closeWorkflowRuntime(ROOT, 10);
    expect(calls).toBe(1);
  });

  it('closeWorkflowRuntime closes a workflow session gracefully through its adapter, and leaves ordinary sessions alone', async () => {
    const w = await workflowWorld();
    await started(w);
    await settle();
    const ordinary = await w.repositories.sessions.create({ ...(await w.repositories.sessions.get(ROOT))!, id: 'plain' as never, kind: 'ordinary' } as never);
    expect(ordinary).toBe('created');
    const before = w.claude.calls.filter((c) => c === 'closeSession').length;
    await w.service.closeWorkflowRuntime('plain' as never);
    expect(w.claude.calls.filter((c) => c === 'closeSession').length).toBe(before);
    await w.service.closeWorkflowRuntime(ROOT);
    expect(w.claude.calls.filter((c) => c === 'closeSession').length).toBe(before + 1);
    await settle();
    expect((await w.repositories.sessions.get(ROOT))?.activity).toBe('closed');
    // Closed already: nothing more to do.
    await w.service.closeWorkflowRuntime(ROOT);
    expect(w.claude.calls.filter((c) => c === 'closeSession').length).toBe(before + 1);
  });
});

// T032 (G-1, the main session's ruling): the session service hands `workflow.complete`, `workflow.cancel` and
// `task.retryCleanup` to the workflow engine, asks it before a user message to a workflow session, and closes a
// workflow session's runtime for the pipeline. Ordinary sessions, and a service without workflow hooks, behave
// as before.
import { describe, expect, it } from 'vitest';
import { InstanceId, MessageId, OperationId, TaskId } from '../../contracts';
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
    expect((await w.repositories.sessions.get(ROOT))?.activity).toBe('closed');
    // Closed already: nothing more to do.
    await w.service.closeWorkflowRuntime(ROOT);
    expect(w.claude.calls.filter((c) => c === 'closeSession').length).toBe(before + 1);
  });
});

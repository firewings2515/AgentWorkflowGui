// T024 review r3: the reviewer's minimal reproductions as given, run on the memory ports (core) and on the
// SQLite repositories and delivery store (app/main).
import { describe, expect, it } from 'vitest';
import { InstanceId, OperationId, SessionId, WorkflowId, type WorkflowTemplate } from '../../../contracts';
import { CWD, INSTANCE, ROOT, rid, settle, startCommand, template, type World } from './harness';
import { crashOnce } from './r2-cases';

const firstOf = (instanceId: string) => OperationId.parse(`user-message:${instanceId}:first`);

export const r3Cases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`T024 review r3 (${backend})`, () => {
    it('r3-P1-1 a start cut off before its instance refuses the same start under another workflow', async () => {
      // 1. Workflows A and B, both at revision 0, the same root node, agent, model and write policy; B allows 99 reworks.
      const w = await make();
      const B = WorkflowId.parse('wf-b');
      expect(await w.repositories.workflows.save(template({ id: B, reworkLimit: 99 }), null)).toMatchObject({ status: 'saved' });
      // 2. Start A; cut off after the first message, before instances.create.
      crashOnce(w.repositories.instances, 'create');
      const original = startCommand();
      await expect(w.run(original)).rejects.toThrow('crash');
      expect((await w.repositories.conversations.get(ROOT)).messages).toHaveLength(1);
      // 3. Restart; the same command with only the workflow changed to B.
      const after = await w.restart();
      const result = await after.run({ ...original, requestId: rid(), workflowId: B });
      // 4. Refused: no instance on B's graph and limit, no first message sent.
      expect(result).toMatchObject({ ok: false, code: 'already_exists' });
      // Also a workflow C identical to A in everything but its ID: another workflow is another start.
      const C = WorkflowId.parse('wf-c');
      expect(await after.repositories.workflows.save(template({ id: C }), null)).toMatchObject({ status: 'saved' });
      expect(await after.run({ ...original, requestId: rid(), workflowId: C })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(await after.repositories.instances.list()).toEqual([]);
      expect(after.claude.dispatched).toHaveLength(0);
      // The original start still completes, on A.
      expect(await after.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
      expect((await after.repositories.instances.get(INSTANCE))?.template).toMatchObject({ id: 'wf-build', reworkLimit: 2 });
    });

    it("r3-P1-2 an unfinished start's first message never reaches another run's root session", async () => {
      // 1-2. Instance A with root R and "work for A"; cut off after its first message was accepted, before R was created.
      const w = await make();
      const R = ROOT;
      crashOnce(w.service, 'createWorkflowSession');
      const a = startCommand({ firstMessage: '給 A 的工作' });
      await expect(w.run(a)).rejects.toThrow('crash');
      expect(await w.repositories.sessions.get(R)).toBeUndefined();
      // 3. Instance B starts with the same R and "work for B": refused, nothing created.
      const b = startCommand({ instanceId: InstanceId.parse('run-B'), firstMessage: '給 B 的工作' });
      expect(await w.run(b)).toMatchObject({ ok: false, code: 'already_exists', mayHaveSideEffects: false });
      expect(await w.repositories.sessions.list()).toEqual([]);
      expect(await w.repositories.instances.list()).toEqual([]);
      // 4. Restart: A's first message goes nowhere, and stays A's.
      const after = await w.restart();
      await settle();
      expect(after.claude.dispatched).toHaveLength(0);
      expect((await after.store.get(firstOf(INSTANCE)))?.delivery.state).toBe('pending');
      expect(await after.run({ ...b, requestId: rid() })).toMatchObject({ ok: false, code: 'already_exists' });
      // A itself can still finish, and its message reaches its own root.
      expect(await after.run({ ...a, requestId: rid() })).toMatchObject({ ok: true });
      await settle();
      expect(after.claude.dispatched.map((d) => d.text)).toEqual(['給 A 的工作']);
    });

    it("r3-P1-2 a first message whose root ID was taken by another session meanwhile is cancelled, never sent", async () => {
      const w = await make();
      crashOnce(w.service, 'createWorkflowSession');
      const a = startCommand({ firstMessage: '給 A 的工作' });
      await expect(w.run(a)).rejects.toThrow('crash');
      // R is created meanwhile as another (ordinary) session.
      expect(
        await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(ROOT), kind: 'ordinary', agentId: 'agent-planner' as never, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD }),
      ).toMatchObject({ ok: true });
      await settle();
      const after = await w.restart();
      await settle();
      expect(after.claude.dispatched.filter((d) => d.text === '給 A 的工作')).toEqual([]);
      const record = await after.store.get(firstOf(INSTANCE));
      expect(record).toMatchObject({ delivery: { state: 'pending' }, outcome: { kind: 'cancelled' } });
      // A repeat of A is refused rather than finished in someone else's session.
      expect(await after.run({ ...a, requestId: rid() })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(after.claude.dispatched.filter((d) => d.text === '給 A 的工作')).toEqual([]);
    });

    it("r3-P2 a finished start repeated after the root session's model was changed succeeds and redoes nothing", async () => {
      const w = await make();
      const original = startCommand();
      expect(await w.run(original)).toMatchObject({ ok: true });
      await settle();
      const root = await w.repositories.sessions.get(ROOT);
      expect(await w.run({ type: 'session.setModel', requestId: rid(), sessionId: ROOT, expectedRevision: root!.revision, model: { runtime: 'claude', model: 'sonnet' } })).toMatchObject({ ok: true });
      const sessions = await w.repositories.sessions.list();
      const dispatched = w.claude.dispatched.length;
      const started = w.claude.started.length;
      expect(await w.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
      await settle();
      expect(w.claude.dispatched).toHaveLength(dispatched);
      expect(w.claude.started).toHaveLength(started);
      expect((await w.repositories.sessions.list()).length).toBe(sessions.length);
      expect(await w.repositories.sessions.get(ROOT)).toMatchObject({ requestedModel: { model: 'sonnet' } });
    });
  });

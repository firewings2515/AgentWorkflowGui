// T063 (contracts 0.11): workflow.delete and workflow.addStarter through the session service and the engine. A run not
// ended refuses the delete (template-in-use); so does a start under way, or one that begins during the delete's checks;
// an ended run keeps its own copy of the template and still reads; the starter set is added once by its fixed IDs. On
// the memory ports (core/workflow/t063.test.ts) and on SQLite (app/main/workflow-t063.test.ts).
import { describe, expect, it } from 'vitest';
import { type Command, type CommandResult, STARTER_AGENT_IDS, STARTER_WORKFLOW_ID, type WorkflowTemplate, WorkflowTemplate as WorkflowTemplateSchema } from '../../../contracts';
import { STARTER_MARKER } from '../starter';
import { INSTANCE, instanceOf, rid, ROOT, settle, started, startCommand, WORKFLOW, type World } from './harness';

export type MakeWorld = (workflow?: WorkflowTemplate) => Promise<World>;

type Delete = Extract<Command, { type: 'workflow.delete' }>;
const deleteOf = (expectedRevision = 0, extra: Partial<Delete> = {}): Delete => ({ type: 'workflow.delete', requestId: rid(), workflowId: WORKFLOW, expectedRevision, ...extra });
const refusal = (result: CommandResult) => (result.ok ? undefined : { code: result.code, reason: result.reason, retryable: result.retryable });

export const t063WorkflowCases = (backend: string, make: MakeWorld) =>
  describe(`T063 workflow.delete and workflow.addStarter (${backend})`, () => {
    it('deletes a template no run uses; a repeat finds it gone; a stale revision is refused', async () => {
      const w = await make();
      expect(await w.run(deleteOf(3))).toMatchObject({ ok: false, code: 'stale_revision', retryable: true });
      expect(await w.repositories.workflows.get(WORKFLOW)).toBeDefined();
      expect(await w.run(deleteOf(0))).toMatchObject({ ok: true });
      expect(await w.repositories.workflows.get(WORKFLOW)).toBeUndefined();
      expect(await w.run(deleteOf(0))).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('a run not ended refuses it (not retryable); once ended, it goes and the run still reads whole', async () => {
      const w = await make();
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      expect(refusal(await w.run(deleteOf(0)))).toEqual({ code: 'invalid_transition', reason: 'template-in-use', retryable: false });
      expect(await w.repositories.workflows.get(WORKFLOW)).toBeDefined();
      const run = await instanceOf(w);
      expect(await w.run({ type: 'workflow.cancel', requestId: rid(), instanceId: run.id, expectedRevision: run.revision })).toMatchObject({ ok: true });
      await settle();
      expect((await instanceOf(w)).state).toBe('cancelled');
      expect(await w.run(deleteOf(0))).toMatchObject({ ok: true });
      // The ended run keeps its own copy: it opens and shows as before.
      const kept = await instanceOf(w);
      expect(kept.workflowId).toBe(WORKFLOW);
      expect(kept.template).toMatchObject({ id: WORKFLOW, revision: 0 });
      expect(WorkflowTemplateSchema.safeParse(kept.template).success).toBe(true);
      expect((await w.repositories.readSnapshotData()).instances.find((i) => i.id === INSTANCE)?.template.nodes.length).toBe(kept.template.nodes.length);
      expect(await w.repositories.sessions.get(ROOT)).toBeDefined();
    });

    it('a start under way refuses it (retryable); the run it makes keeps refusing it', async () => {
      const w = await make();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      w.dispatchGate = () => held;
      const start = w.run(startCommand());
      await settle();
      expect(w.engine.templateStarts(WORKFLOW)).toMatchObject({ active: 1 });
      expect(refusal(await w.run(deleteOf(0)))).toEqual({ code: 'invalid_transition', reason: 'template-in-use', retryable: true });
      release();
      expect(await start).toMatchObject({ ok: true });
      await settle();
      expect(w.engine.templateStarts(WORKFLOW)).toMatchObject({ active: 0 });
      expect(refusal(await w.run(deleteOf(0)))).toMatchObject({ reason: 'template-in-use', retryable: false });
      expect(await w.repositories.workflows.get(WORKFLOW)).toBeDefined();
    });

    it('a start that begins during the delete\'s checks refuses it; the start goes on with the template', async () => {
      const w = await make();
      const instances = w.repositories.instances;
      const list = instances.list.bind(instances);
      let start: Promise<CommandResult> | undefined;
      // The start begins while the delete reads the runs: after its first look, before its last one.
      instances.list = () => {
        start ??= w.engine.start(startCommand());
        return list();
      };
      expect(refusal(await w.run(deleteOf(0)))).toEqual({ code: 'invalid_transition', reason: 'template-in-use', retryable: true });
      instances.list = list;
      expect(await start).toMatchObject({ ok: true });
      await settle();
      expect(await w.repositories.workflows.get(WORKFLOW)).toBeDefined();
      expect((await instanceOf(w)).state).toBe('running');
    });

    it('a start after the delete, with the revision it saw, finds no template and makes nothing', async () => {
      const w = await make();
      expect(await w.run(deleteOf(0))).toMatchObject({ ok: true });
      expect(await w.run(startCommand({ workflowRevision: 0 }))).toMatchObject({ ok: false, code: 'not_found' });
      await settle();
      expect(await w.repositories.instances.get(INSTANCE)).toBeUndefined();
      expect(w.engine.templateStarts(WORKFLOW)).toEqual({ active: 0, generation: 1 });
    });

    it('a failed start releases its count, so the delete is not held back', async () => {
      const w = await make();
      expect(await w.run(startCommand({ workflowRevision: 5 }))).toMatchObject({ ok: false, code: 'stale_revision' });
      expect(w.engine.templateStarts(WORKFLOW)).toMatchObject({ active: 0 });
      expect(await w.run(deleteOf(0))).toMatchObject({ ok: true });
    });

    it('addStarter adds the three Agents and the template once; a repeat adds nothing; an edited Agent is kept', async () => {
      const w = await make();
      const result = await w.run({ type: 'workflow.addStarter', requestId: rid() });
      expect(result).toMatchObject({ ok: true, revision: 0 });
      const template = await w.repositories.workflows.get(STARTER_WORKFLOW_ID);
      expect(template?.name).toBe('規劃 → 實作 → 審查');
      for (const id of Object.values(STARTER_AGENT_IDS)) expect(await w.repositories.agents.get(id)).toBeDefined();
      expect(await w.repositories.markers.has(STARTER_MARKER)).toBe(true);
      const plan = (await w.repositories.agents.get(STARTER_AGENT_IDS.plan))!;
      expect(await w.repositories.agents.save({ ...plan, instructions: '我自己的規劃說明' }, plan.revision)).toMatchObject({ status: 'saved' });
      expect(await w.run({ type: 'workflow.addStarter', requestId: rid() })).toMatchObject({ ok: true, revision: 0 });
      expect((await w.repositories.agents.get(STARTER_AGENT_IDS.plan))).toMatchObject({ instructions: '我自己的規劃說明', revision: 1 });
      expect((await w.repositories.workflows.list()).filter((t) => t.id === STARTER_WORKFLOW_ID)).toHaveLength(1);
      // Deleted, it comes back when asked again; the Agents it used are still there.
      expect(await w.run({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID, expectedRevision: 0 })).toMatchObject({ ok: true });
      expect(await w.run({ type: 'workflow.addStarter', requestId: rid() })).toMatchObject({ ok: true, revision: 0 });
      expect(await w.repositories.workflows.get(STARTER_WORKFLOW_ID)).toBeDefined();
    });

    it('a run of the starter template starts, root on the 規劃 Agent', async () => {
      const w = await make();
      expect(await w.run({ type: 'workflow.addStarter', requestId: rid() })).toMatchObject({ ok: true });
      expect(await started(w, { workflowId: STARTER_WORKFLOW_ID, workflowRevision: 0 })).toMatchObject({ ok: true });
      const run = await instanceOf(w);
      expect(run.template.id).toBe(STARTER_WORKFLOW_ID);
      expect((await w.repositories.sessions.get(ROOT))).toMatchObject({ kind: 'workflow' });
    });
  });

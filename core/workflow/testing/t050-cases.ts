// T050 (U2, contracts 0.9): workflow.rename. A run's title only, in any state; trimmed, 1 to 200 characters; a
// compare-and-set on its revision announced with instance.updated once written; the same request again changes nothing
// and announces nothing (CR-2); a start sent again after a rename is still that start. On the memory ports
// (core/workflow/t050.test.ts) and on SQLite (app/main/workflow-t050.test.ts).
import { describe, expect, it } from 'vitest';
import { type Command, type WorkflowInstance, type WorkflowTemplate } from '../../../contracts';
import { crashOnce } from './r2-cases';
import { handoff, IMPL, INSTANCE, instanceOf, rid, ROOT, settle, started, startCommand, type World } from './harness';

export type MakeWorld = (workflow?: WorkflowTemplate) => Promise<World>;

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };
type Rename = Extract<Command, { type: 'workflow.rename' }>;
const renameOf = (instance: WorkflowInstance, title: string, extra: Partial<Rename> = {}): Rename => ({
  type: 'workflow.rename',
  requestId: rid(),
  instanceId: instance.id,
  expectedRevision: instance.revision,
  title,
  ...extra,
});
const instanceEvents = (w: World) => w.events.filter((e): e is Extract<typeof e, { type: 'instance.updated' }> => e.type === 'instance.updated' && e.instance.id === INSTANCE);
const withoutTitle = (instance: WorkflowInstance) => Object.fromEntries(Object.entries(instance).filter(([k]) => k !== 'title' && k !== 'revision'));

export const t050WorkflowCases = (backend: string, make: MakeWorld) =>
  describe(`T050 workflow.rename (${backend})`, () => {
    const running = async () => {
      const w = await make();
      expect(await started(w)).toMatchObject({ ok: true });
      await settle();
      return { w, before: await instanceOf(w) };
    };

    it('renames the run: trimmed, revision + 1, announced once with the new title; nothing else changes', async () => {
      const { w, before } = await running();
      const rootBefore = await w.repositories.sessions.get(ROOT);
      expect(rootBefore).toBeDefined();
      const events = instanceEvents(w).length;
      expect(await w.run(renameOf(before, '  Release notes  '))).toMatchObject({ ok: true, revision: before.revision + 1 });
      const after = await instanceOf(w);
      expect(after).toMatchObject({ title: 'Release notes', revision: before.revision + 1, state: before.state });
      expect(withoutTitle(after)).toEqual(withoutTitle(before));
      const announced = instanceEvents(w).slice(events);
      expect(announced).toHaveLength(1);
      expect(announced[0]?.instance).toEqual(after);
      // Only the run: the root session and the task keep the title they started with.
      // Read before the rename and after it (r1 P2): the root session's title and revision are as they were.
      const rootAfter = await w.repositories.sessions.get(ROOT);
      expect(rootAfter?.title).toBe(rootBefore?.title);
      expect(rootAfter?.title).not.toBe('Release notes');
      expect(rootAfter?.revision).toBe(rootBefore?.revision);
      expect(w.events.some((e) => e.type === 'session.updated' && e.session.title === 'Release notes')).toBe(false);
      expect(after.tasks[0]?.title).toBe(before.tasks[0]?.title);
    });

    it('another revision with another title is stale_revision: nothing written, nothing announced', async () => {
      const { w, before } = await running();
      const events = instanceEvents(w).length;
      for (const expectedRevision of [before.revision - 1, before.revision + 1, before.revision + 5]) {
        if (expectedRevision < 0) continue;
        expect(await w.run(renameOf(before, 'Other', { expectedRevision }))).toMatchObject({ ok: false, code: 'stale_revision', retryable: true });
      }
      expect(await instanceOf(w)).toEqual(before);
      expect(instanceEvents(w)).toHaveLength(events);
    });

    it('an empty, blank or too long title is invalid_request; 200 characters (code points) are taken; an unknown run is not_found', async () => {
      const { w, before } = await running();
      const events = instanceEvents(w).length;
      for (const title of ['', '   ', '\t\n', '😀'.repeat(201), 'x'.repeat(201)]) {
        expect(await w.run(renameOf(before, title))).toMatchObject({ ok: false, code: 'invalid_request' });
      }
      expect(await instanceOf(w)).toEqual(before);
      expect(instanceEvents(w)).toHaveLength(events);
      expect(await w.run(renameOf({ ...before, id: 'no-run' as WorkflowInstance['id'] }, 'x'))).toMatchObject({ ok: false, code: 'not_found' });
      expect(await w.run(renameOf(before, '😀'.repeat(200)))).toMatchObject({ ok: true });
      expect((await instanceOf(w)).title).toBe('😀'.repeat(200));
    });

    it('an ended run is renamed too, cancelled or completed: its state, end and tasks stay', async () => {
      for (const end of ['workflow.cancel', 'workflow.complete'] as const) {
        const { w, before } = await running();
        expect(await w.run({ type: end, requestId: rid(), instanceId: INSTANCE, expectedRevision: before.revision })).toMatchObject({ ok: true });
        await settle();
        const ended = await instanceOf(w);
        expect(ended.state).toBe(end === 'workflow.cancel' ? 'cancelled' : 'completed');
        expect(await w.run(renameOf(ended, 'Done and named'))).toMatchObject({ ok: true, revision: ended.revision + 1 });
        const after = await instanceOf(w);
        expect(after).toMatchObject({ title: 'Done and named', state: ended.state, endedAt: ended.endedAt });
        expect(after.tasks).toEqual(ended.tasks);
      }
    });

    it('CR-2: the same request again changes nothing and announces nothing, and succeeds; at once too', async () => {
      const { w, before } = await running();
      const events = instanceEvents(w).length;
      const rename = renameOf(before, 'Release');
      expect(await w.run(rename)).toMatchObject({ ok: true, revision: before.revision + 1 });
      // The answer was lost: the same request, then a new request ID for the same rename.
      expect(await w.run(rename)).toMatchObject({ ok: true, revision: before.revision + 1 });
      expect(await w.run({ ...rename, requestId: rid() })).toMatchObject({ ok: true, revision: before.revision + 1 });
      expect((await instanceOf(w)).revision).toBe(before.revision + 1);
      expect(instanceEvents(w)).toHaveLength(events + 1);
      // Two at once naming the same revision: one write, one event, both succeed.
      const now = await instanceOf(w);
      const twice = renameOf(now, 'Release 2');
      const results = await Promise.all([w.run(twice), w.run({ ...twice, requestId: rid() })]);
      for (const result of results) expect(result).toMatchObject({ ok: true, revision: now.revision + 1 });
      expect(await instanceOf(w)).toMatchObject({ title: 'Release 2', revision: now.revision + 1 });
      expect(instanceEvents(w)).toHaveLength(events + 2);
      // The title it already has, on any revision: nothing written.
      expect(await w.run(renameOf(now, 'Release 2', { expectedRevision: 0 }))).toMatchObject({ ok: true, revision: now.revision + 1 });
      expect(instanceEvents(w)).toHaveLength(events + 2);
    });

    it('a write of the run in between (outside its queue) makes the rename stale; with the new revision it renames and keeps that write', async () => {
      const { w, before } = await running();
      const instances = w.repositories.instances;
      const update = instances.update.bind(instances);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let reached: () => void = () => undefined;
      const atWrite = new Promise<void>((resolve) => (reached = resolve));
      instances.update = async (instance, expectedRevision) => {
        if (instance.title === 'Held') {
          reached();
          await held;
        }
        return update(instance, expectedRevision);
      };
      const renaming = w.run(renameOf(before, 'Held'));
      await atWrite;
      // A task update lands first, as the engine's task updates do (read the newest, compare-and-set).
      const current = await instanceOf(w);
      expect(await update({ ...current, revision: current.revision + 1, tasks: current.tasks.map((t) => ({ ...t, reworkCount: 1 })) }, current.revision)).toMatchObject({ status: 'saved' });
      const events = instanceEvents(w).length;
      release();
      expect(await renaming).toMatchObject({ ok: false, code: 'stale_revision', retryable: true });
      expect(instanceEvents(w)).toHaveLength(events);
      const newer = await instanceOf(w);
      expect(newer.title).toBe(before.title);
      expect(await w.run(renameOf(newer, 'Held again'))).toMatchObject({ ok: true });
      expect(await instanceOf(w)).toMatchObject({ title: 'Held again', tasks: [{ reworkCount: 1 }] });
    });

    it('the engine writing the run after a rename keeps the new title', async () => {
      const { w, before } = await running();
      expect(await w.run(renameOf(before, 'Renamed'))).toMatchObject({ ok: true });
      // Root hands the task to Implement: the task moves on (a write of the run by the engine).
      expect(await handoff(w, ROOT, toImpl)).toMatchObject({ status: 'accepted' });
      await settle();
      const after = await instanceOf(w);
      expect(after.revision).toBeGreaterThan(before.revision + 1);
      expect(after.tasks[0]?.currentNodeId).toBe(IMPL);
      expect(after.title).toBe('Renamed');
      expect(instanceEvents(w).every((e) => e.instance.revision <= before.revision || e.instance.title === 'Renamed')).toBe(true);
    });

    it('the start sent again after a rename is still that start; a start with other details is still refused', async () => {
      const { w } = await running();
      const original = startCommand();
      expect(await w.run(renameOf(await instanceOf(w), 'Renamed'))).toMatchObject({ ok: true });
      expect(await w.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
      await settle();
      expect(w.claude.dispatched.map((d) => d.text)).toEqual(['Plan a login page.']);
      expect((await instanceOf(w)).title).toBe('Renamed');
      for (const other of [{ title: 'Renamed' }, { title: 'Something else' }, { firstMessage: 'Something else.' }, { crossToolConsent: false }, { workFolder: 'E:\\work\\elsewhere' }]) {
        expect(await w.run({ ...original, requestId: rid(), ...other })).toMatchObject({ ok: false, code: 'already_exists' });
      }
      expect((await instanceOf(w)).title).toBe('Renamed');
    });

    it('a start cut off before its first message reached root, renamed, then sent again (at once and after a restart) finishes once', async () => {
      for (const restart of [false, true]) {
        let w = await make();
        crashOnce(w.service, 'deliverWorkflow');
        const original = startCommand();
        await expect(w.run(original)).rejects.toThrow('crash');
        const cut = await instanceOf(w);
        expect(await w.run(renameOf(cut, 'Renamed'))).toMatchObject({ ok: true, revision: cut.revision + 1 });
        if (restart) w = await w.restart();
        expect((await instanceOf(w)).title).toBe('Renamed');
        expect(await w.run({ ...original, requestId: rid() })).toMatchObject({ ok: true });
        await settle();
        expect(w.claude.dispatched.map((d) => d.text)).toEqual(['Plan a login page.']);
        expect(await w.run({ ...original, requestId: rid(), title: 'Renamed' })).toMatchObject({ ok: false, code: 'already_exists' });
        expect((await instanceOf(w)).title).toBe('Renamed');
      }
    });
  });

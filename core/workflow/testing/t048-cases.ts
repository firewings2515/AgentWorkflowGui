// T048 (Q-4, Q-8): a run's two folders. The work folder (root, reports, plans) is made when none is given, once per
// run also when the start is sent again or the app stopped in between; the project folder is where task worktrees
// come from and is required with worktrees; in a same-folder run the other nodes work in it directly. Runs started
// before 0.8 (one folder) go on as before. On the memory ports and folders (core/workflow/t048.test.ts) and on SQLite
// with real work folders in a temporary directory (app/main/workflow-t048.test.ts); the project stays the memory git's.
import { describe, expect, it } from 'vitest';
import { SessionId, type WorkflowTemplate } from '../../../contracts';
import { StorageReadOnlyError, type WorkFolderFs } from '../../ports';
import { hashOf } from '../../delivery/testing/fixtures';
import { taskWorktreeRef } from '../../pipeline/naming';
import { createTasks, pipelineTemplate } from '../../pipeline/testing/t032-cases';
import { joinFolder } from '../../sessions/work-folders';
import { crashOnce } from './r2-cases';
import { CWD, handoff, IMPL, INSTANCE, instanceOf, PLAN, REVIEW, rid, ROOT, settle, startCommand, template, type HarnessExtra, type World } from './harness';

const DAY = '2026-11-04';
const PROJECT = CWD;
const REAL_PROJECT = 'E:\\real\\project';
/** The memory git's folders (E:\\work is a junction to E:\\real, as in the harness). */
export const memoryRealPath = (path: string): string | null => (path.startsWith('E:\\work') ? path.replace('E:\\work', 'E:\\real') : path.startsWith('E:\\real') ? path : null);

/** Where the cases' work folders are: a file system, the default location, a place for given folders. */
export interface WorkflowFolders {
  fs: WorkFolderFs;
  location: string;
  elsewhere: string;
  exists(path: string): boolean;
  makeForeign(path: string): void;
  /** Link resolution for these folders and the memory git's. */
  realPath(path: string): string | null;
}

export type MakeWorld = (workflow: WorkflowTemplate, extra: HarnessExtra) => Promise<World>;

const begin = async (make: MakeWorld, workflow: WorkflowTemplate, folders: WorkflowFolders) => {
  let w = await make(workflow, { workFolders: { fs: folders.fs, defaultRoot: folders.location, day: () => DAY }, realPath: (p) => folders.realPath(p) });
  const restart = async () => {
    w = await w.restart();
    // As the app starts (backend.ts): claims whose session and run never came are dropped.
    await w.service.reconcileWorkFolders((claim) => w.engine.workFolderInUse(claim));
    return w;
  };
  return {
    folders,
    get w() {
      return w;
    },
    restart,
    auto: (seq: string) => joinFolder(folders.location, `${DAY}-${seq}`),
    real: (path: string) => folders.realPath(path),
    madeOn: () => folders.fs.list(folders.location).filter((n) => n.startsWith(`${DAY}-`)).sort(),
  };
};
const start = async (w: World, extra: Parameters<typeof startCommand>[0] = {}) => {
  // Neither folder unless the case gives one (startCommand gives both by default).
  const command = startCommand();
  delete command.workFolder;
  delete command.projectFolder;
  const result = await w.run({ ...command, requestId: rid(), ...extra });
  await settle();
  return result;
};
const sessionAt = async (w: World, id: SessionId) => {
  const s = await w.repositories.sessions.get(id);
  if (s === undefined) throw new Error(`no session ${id}`);
  return s;
};

export const t048WorkflowCases = (backend: string, make: MakeWorld, folders: () => WorkflowFolders) =>
  describe(`T048 a run's work folder and project folder (${backend})`, () => {
    it('Q-8: a run with worktrees needs a project folder; without one nothing is written or made', async () => {
      const t = await begin(make, pipelineTemplate(), folders());
      expect(await start(t.w)).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await t.w.repositories.instances.get(INSTANCE)).toBeUndefined();
      expect(await t.w.repositories.sessions.get(ROOT)).toBeUndefined();
      expect(await t.w.repositories.workFolders.list()).toEqual([]);
      expect(t.folders.exists(t.folders.location)).toBe(false);
      expect(await start(t.w, { projectFolder: 'Z:\\nowhere' })).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(t.folders.exists(t.folders.location)).toBe(false);
    });

    it('Q-4/Q-8 with worktrees: root in a new work folder, reading the project; task worktrees from the project folder', async () => {
      const t = await begin(make, pipelineTemplate(), folders());
      expect(await start(t.w, { projectFolder: PROJECT })).toMatchObject({ ok: true });
      const root = await sessionAt(t.w, ROOT);
      expect(root).toMatchObject({ cwd: t.auto('001'), folderScope: { workspaceRoot: t.real(t.auto('001')), writableRoots: [], readableRoots: [REAL_PROJECT] } });
      expect(t.folders.exists(t.auto('001'))).toBe(true);
      expect(await instanceOf(t.w)).toMatchObject({ workFolder: t.auto('001'), projectFolder: PROJECT });
      const told = root.kind === 'workflow' ? await t.w.engine.briefing(root) : undefined;
      expect(told).toContain(`Work folder of this run: ${t.auto('001')}`);
      expect(told).toContain(`Project folder of this run: ${PROJECT}`);
      // Root splits the work; a task's worktree comes from the project folder, and its session works there.
      const tasks = await createTasks(t.w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }]);
      if (tasks.status !== 'created') throw new Error('no tasks');
      const taskId = tasks.tasks[0]!.taskId;
      expect(await handoff(t.w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId })).toMatchObject({ status: 'accepted' });
      for (let i = 0; i < 20; i++) await settle();
      const task = (await instanceOf(t.w)).tasks.find((x) => x.id === taskId);
      expect(task?.worktree?.path).toBe((await taskWorktreeRef(hashOf, PROJECT, INSTANCE, taskId)).path);
      const impl = await t.w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId });
      expect((await sessionAt(t.w, impl!)).cwd).toBe(task?.worktree?.path);
    });

    it('the same start again makes no second work folder; one naming another folder is another run', async () => {
      const t = await begin(make, template(), folders());
      const first = await start(t.w);
      expect(first).toMatchObject({ ok: true });
      expect(await start(t.w)).toMatchObject({ ok: true });
      expect(t.madeOn()).toEqual([`${DAY}-001`]);
      expect(await start(t.w, { workFolder: 'E:\\work\\other' })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(await start(t.w, { projectFolder: PROJECT })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(t.madeOn()).toEqual([`${DAY}-001`]);
    });

    it('stopped after the work folder was made and before the start was written: the next start drops the claim, the folder stays; the start makes another', async () => {
      const t = await begin(make, template(), folders());
      // The app stops while the start is being written.
      const store: Pick<typeof t.w.store, 'accept'> = t.w.store;
      const accept = store.accept;
      store.accept = () => new Promise(() => undefined);
      void start(t.w);
      for (let i = 0; i < 20 && !t.folders.exists(t.auto('001')); i++) await settle();
      expect(t.folders.exists(t.auto('001'))).toBe(true);
      store.accept = accept;
      const next = await t.restart();
      expect(await next.repositories.workFolders.list()).toEqual([]);
      expect(t.folders.exists(t.auto('001'))).toBe(true);
      expect(await start(next)).toMatchObject({ ok: true });
      expect((await sessionAt(next, ROOT)).cwd).toBe(t.auto('002'));
      expect(t.madeOn()).toEqual([`${DAY}-001`, `${DAY}-002`]);
    });

    it('stopped after the start was written and before root was made: the next start keeps the folder; the repeat goes on in it', async () => {
      const t = await begin(make, template(), folders());
      crashOnce(t.w.repositories.sessions, 'create');
      await expect(start(t.w)).rejects.toThrow('crash');
      const next = await t.restart();
      expect((await next.repositories.workFolders.list()).map((c) => [c.sessionId, c.instanceId, c.path])).toEqual([[ROOT, INSTANCE, t.auto('001')]]);
      expect(t.folders.exists(t.auto('001'))).toBe(true);
      expect(await start(next)).toMatchObject({ ok: true });
      expect((await sessionAt(next, ROOT)).cwd).toBe(t.auto('001'));
      expect(t.madeOn()).toEqual([`${DAY}-001`]);
    });

    it('a same-folder run without a project folder: every node in the work folder, as one folder before', async () => {
      const t = await begin(make, template(), folders());
      expect(await start(t.w)).toMatchObject({ ok: true });
      expect(await handoff(t.w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL } })).toMatchObject({ status: 'accepted' });
      await settle();
      const impl = await t.w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId: (await instanceOf(t.w)).tasks[0]!.id });
      const s = await sessionAt(t.w, impl!);
      expect(s).toMatchObject({ cwd: t.auto('001'), folderScope: { writableRoots: [t.real(t.auto('001'))], readableRoots: [] } });
      expect((await sessionAt(t.w, ROOT)).folderScope.readableRoots).toEqual([]);
    });

    it('Q-8 a same-folder run with a project folder: root in the work folder, the other nodes change the project in place and may use the work folder', async () => {
      const t = await begin(make, template(), folders());
      const work = joinFolder(t.folders.elsewhere, 'reports');
      t.folders.makeForeign(work);
      expect(await start(t.w, { workFolder: work, projectFolder: PROJECT })).toMatchObject({ ok: true });
      // A folder was given: none made.
      expect(t.madeOn()).toEqual([]);
      expect(await sessionAt(t.w, ROOT)).toMatchObject({ cwd: work, folderScope: { workspaceRoot: t.real(work), writableRoots: [t.real(work)], readableRoots: [REAL_PROJECT] } });
      const taskId = (await instanceOf(t.w)).tasks[0]!.id;
      expect(await handoff(t.w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL } })).toMatchObject({ status: 'accepted' });
      await settle();
      const impl = await t.w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: IMPL, taskId });
      expect(await sessionAt(t.w, impl!)).toMatchObject({ cwd: PROJECT, folderScope: { workspaceRoot: REAL_PROJECT, writableRoots: [REAL_PROJECT, t.real(work)], readableRoots: [] } });
      // A read-only node reads the work folder and writes nothing.
      expect(await handoff(t.w, impl!, { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, taskId })).toMatchObject({ status: 'accepted' });
      await settle();
      const review = await t.w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId: REVIEW, taskId });
      expect(await sessionAt(t.w, review!)).toMatchObject({ cwd: PROJECT, folderScope: { writableRoots: [], readableRoots: [t.real(work)] } });
      const root = await sessionAt(t.w, ROOT);
      const told = root.kind === 'workflow' ? await t.w.engine.briefing(root) : undefined;
      expect(told).toContain(`Work folder of this run: ${work}`);
      expect(told).toContain('the repository the other nodes change in place');
    });

    it('a run started before 0.8 (one folder, no work or project folder recorded): its tasks still come from root\'s folder', async () => {
      const t = await begin(make, pipelineTemplate(), folders());
      expect(await start(t.w, { workFolder: PROJECT, projectFolder: PROJECT })).toMatchObject({ ok: true });
      // As 0.7 stored it.
      const stored = await instanceOf(t.w);
      const old = { ...stored };
      delete old.workFolder;
      delete old.projectFolder;
      expect((await t.w.repositories.instances.update(old, stored.revision)).status).toBe('saved');
      expect((await instanceOf(t.w)).projectFolder).toBeUndefined();
      const root = await sessionAt(t.w, ROOT);
      const told = root.kind === 'workflow' ? await t.w.engine.briefing(root) : undefined;
      expect(told).not.toContain('Work folder of this run');
      const tasks = await createTasks(t.w, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }]);
      if (tasks.status !== 'created') throw new Error('no tasks');
      const taskId = tasks.tasks[0]!.taskId;
      expect(await handoff(t.w, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId })).toMatchObject({ status: 'accepted' });
      for (let i = 0; i < 20; i++) await settle();
      expect((await instanceOf(t.w)).tasks[0]?.worktree?.path).toBe((await taskWorktreeRef(hashOf, PROJECT, INSTANCE, taskId)).path);
    });

    it('two runs started at once under the same root session ID: one gets the folder, the other is refused and takes nothing back', async () => {
      const t = await begin(make, template(), folders());
      const [a, b] = await Promise.all([start(t.w), start(t.w, { instanceId: 'run-2' as typeof INSTANCE })]);
      expect([a, b].map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['already_exists', 'ok']);
      expect(t.madeOn()).toEqual([`${DAY}-001`]);
      expect((await t.w.repositories.workFolders.list()).map((c) => [c.sessionId, c.instanceId])).toEqual([[ROOT, a.ok ? INSTANCE : 'run-2']]);
      expect((await sessionAt(t.w, ROOT)).cwd).toBe(t.auto('001'));
      // An ordinary session under that ID is refused too, and leaves the run's folder alone.
      expect(await t.w.run({ type: 'session.create', requestId: rid(), sessionId: ROOT, kind: 'ordinary', model: { runtime: 'claude', model: 'haiku' } })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(t.folders.exists(t.auto('001'))).toBe(true);
    });

    it('r1 P1-3: the start write refused (read-only data) after the work folder was made: its claim goes, the folder stays (r2)', async () => {
      const t = await begin(make, template(), folders());
      const store: Pick<typeof t.w.store, 'accept'> = t.w.store;
      const accept = store.accept;
      store.accept = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      await expect(start(t.w)).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(t.folders.exists(t.auto('001'))).toBe(true);
      expect(await t.w.repositories.workFolders.list()).toEqual([]);
      store.accept = accept;
      expect(await start(t.w)).toMatchObject({ ok: true });
      expect((await sessionAt(t.w, ROOT)).cwd).toBe(t.auto('002'));
    });

    it('r1 P1-5: a worktree start written before 0.8 (one folder) is finished by its repeat, with or without that folder named', async () => {
      const t = await begin(make, pipelineTemplate(), folders());
      // As 0.7 wrote it: the identity without its folders part, root's folder the repository; then the app stopped.
      const store: Pick<typeof t.w.store, 'accept'> = t.w.store;
      const accept = store.accept.bind(t.w.store);
      store.accept = (input) => {
        const ref = input.sourceCallRef;
        if (ref === undefined) return accept(input);
        const prefix = 'workflow.start:';
        return accept({ ...input, sourceCallRef: `${prefix}${JSON.stringify((JSON.parse(ref.slice(prefix.length)) as unknown[]).slice(0, 6))}` });
      };
      crashOnce(t.w.repositories.sessions, 'create');
      await expect(start(t.w, { workFolder: PROJECT, projectFolder: PROJECT })).rejects.toThrow('crash');
      store.accept = accept;
      const next = await t.restart();
      // Another project folder is another run; none, or the one folder, is this one.
      expect(await start(next, { projectFolder: 'E:\\work\\other' })).toMatchObject({ ok: false, code: 'already_exists' });
      expect(await start(next)).toMatchObject({ ok: true });
      expect(await start(next, { workFolder: PROJECT, projectFolder: PROJECT })).toMatchObject({ ok: true });
      expect((await sessionAt(next, ROOT)).cwd).toBe(PROJECT);
      const run = await instanceOf(next);
      expect(run.workFolder).toBeUndefined();
      expect(run.projectFolder).toBeUndefined();
      // Its tasks come from root's folder, as before 0.8.
      const tasks = await createTasks(next, [{ key: 'a', title: 'A', dependsOn: [], dependsOnExisting: [] }]);
      if (tasks.status !== 'created') throw new Error('no tasks');
      const taskId = tasks.tasks[0]!.taskId;
      expect(await handoff(next, ROOT, { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, taskId })).toMatchObject({ status: 'accepted' });
      for (let i = 0; i < 20; i++) await settle();
      expect((await instanceOf(next)).tasks[0]?.worktree?.path).toBe((await taskWorktreeRef(hashOf, PROJECT, INSTANCE, taskId)).path);
      expect(t.madeOn()).toEqual([]);
    });

    it('a workflow session keeps its Agent: setAgent to none is refused', async () => {
      const t = await begin(make, template(), folders());
      expect(await start(t.w)).toMatchObject({ ok: true });
      const root = await sessionAt(t.w, ROOT);
      expect(await t.w.run({ type: 'session.setAgent', requestId: rid(), sessionId: ROOT, expectedRevision: root.revision, agentId: null })).toMatchObject({ ok: false, code: 'invalid_transition' });
      expect((await sessionAt(t.w, ROOT)).agent).toBeDefined();
      expect(root.title).toBe('Plan');
      void PLAN;
    });
  });

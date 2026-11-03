// T048 (U-01, U-02): sessions without an Agent or a folder. One set of cases on the memory ports and folders
// (core/sessions/t048.test.ts) and on the SQLite repositories with real folders (app/main/t048-sqlite.test.ts):
// numbering, the same session asked again, sessions made at once, a folder appearing in between, a write that fails
// or is refused, a stop between the claim and the session, the first message naming the session, rename, and
// sessions stored before 0.8.
import { describe, expect, it } from 'vitest';
import { type Command, type CommandResult, DEFAULT_SESSION_TITLE, LogicalSession, SessionId } from '../../../contracts';
import { type AppRepositories, type DeliveryStore, StorageReadOnlyError, type WorkFolderFs } from '../../ports';
import { joinFolder } from '../work-folders';
import { AGENT, rid, settle, type World, worldOn } from './harness';

export const DAY = '2026-11-04';

/** The folders of one run of the cases: a file system, where new folders go, and how links resolve there. */
export interface FolderHost {
  fs: WorkFolderFs;
  location: string;
  exists(path: string): boolean;
  /** Puts a file in a folder, as the user would. */
  putFile(folder: string, name: string): void;
  /** Makes a folder outside the GUI (the user's own, another program's). */
  makeForeign(path: string): void;
  realPath(path: string): string | null;
  /** Puts a link (a junction) to `target`, a folder made for it, where the folder `path` was. */
  relink(path: string, target: string): void;
  /** A location elsewhere that does not exist yet (preferences). */
  elsewhere: string;
}

export type T048Storage = () => { repositories: AppRepositories; store: DeliveryStore; folders: FolderHost };

interface Env {
  w: World;
  folders: FolderHost;
  /** Runs before each folder is made (a test makes the same name first). */
  hooks: { onMake?: (path: string) => void };
  day: { value: string };
  restart(): Promise<World>;
}

const setup = async (storage: T048Storage): Promise<Env> => {
  const { repositories, store, folders } = storage();
  const hooks: Env['hooks'] = {};
  const day = { value: DAY };
  const fs: WorkFolderFs = {
    list: (folder) => folders.fs.list(folder),
    makeTree: (folder) => folders.fs.makeTree(folder),
    make: (folder) => {
      hooks.onMake?.(folder);
      return folders.fs.make(folder);
    },
  };
  const w = await worldOn(repositories, store, { workFolders: { fs, defaultRoot: folders.location, day: () => day.value }, realPath: (p) => folders.realPath(p) });
  const env: Env = {
    w,
    folders,
    hooks,
    day,
    restart: async () => {
      // As the app starts (backend.ts): recovery, then the claims whose session never came.
      const next = env.w.restart();
      await next.service.start();
      await next.service.reconcileWorkFolders();
      env.w = next;
      return next;
    },
  };
  return env;
};

const model = { runtime: 'codex' as const, model: 'gpt-6-luna' };
const create = (w: World, id: string, extra: Partial<Extract<Command, { type: 'session.create' }>> = {}): Promise<CommandResult> =>
  w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', model, ...extra });
const get = async (w: World, id: string) => {
  const s = await w.repositories.sessions.get(SessionId.parse(id));
  if (s === undefined) throw new Error(`no session ${id}`);
  return s;
};
const send = async (w: World, id: string, text: string, messageId: string) => {
  const s = await get(w, id);
  return w.run({ type: 'session.send', requestId: rid(), sessionId: s.id, messageId: messageId as never, expectedRevision: s.revision, text, attachments: [] });
};
const folderOf = (env: Env, seq: string, day = DAY) => joinFolder(env.folders.location, `${day}-${seq}`);
/** The folders of `day` in the location. */
const madeOn = (env: Env, day = DAY) =>
  env.folders.fs
    .list(env.folders.location)
    .filter((n) => n.startsWith(`${day}-`))
    .sort();

export const t048SessionCases = (name: string, storage: T048Storage) =>
  describe(`T048 sessions without an Agent or a folder (${name})`, () => {
    it('U-01/U-02: no Agent and no folder: a new YYYY-MM-DD-001 folder, its real path in the scope, no instructions, named by the first message', async () => {
      const env = await setup(storage);
      const { w } = env;
      expect(await create(w, 's-1')).toMatchObject({ ok: true, created: [{ kind: 'session', id: 's-1' }] });
      await settle();
      const s = await get(w, 's-1');
      expect(LogicalSession.parse(s)).toBeTruthy();
      const cwd = folderOf(env, '001');
      const real = env.folders.realPath(cwd);
      expect(s).toMatchObject({ kind: 'ordinary', title: DEFAULT_SESSION_TITLE, autoTitle: true, cwd, folderScope: { source: 'session-cwd', workspaceRoot: real, writableRoots: [real] } });
      expect(s.agent).toBeUndefined();
      expect(env.folders.exists(cwd)).toBe(true);
      // No instructions of ours: the runtime's and the model's own behaviour.
      const started = w.codex.get('s-1')?.started[0];
      expect(started).toMatchObject({ cwd });
      expect(started?.instructions).toBeUndefined();
      expect(await send(w, 's-1', '  Plan the login page  \nwith two steps', 'm-1')).toMatchObject({ ok: true });
      const named = await get(w, 's-1');
      expect(named.title).toBe('Plan the login page');
      expect(named.autoTitle).toBeUndefined();
      expect(w.events.some((e) => e.type === 'session.updated' && e.session.id === 's-1' && e.session.title === 'Plan the login page')).toBe(true);
      await settle();
      expect(await send(w, 's-1', 'Something else', 'm-2')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).title).toBe('Plan the login page');
    });

    it('Q-2: numbered per day past 999 without a limit; names that are not ours do not count; another day starts at 001', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      for (const n of [`${DAY}-998`, `${DAY}-07`, `${DAY}-abc`, `${DAY}-0998x`, '2026-11-03-500']) folders.makeForeign(joinFolder(folders.location, n));
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect(await create(w, 's-2')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(folderOf(env, '999'));
      expect((await get(w, 's-2')).cwd).toBe(folderOf(env, '1000'));
      env.day.value = '2026-11-05';
      expect(await create(w, 's-3')).toMatchObject({ ok: true });
      expect((await get(w, 's-3')).cwd).toBe(folderOf(env, '001', '2026-11-05'));
    });

    it('a long or blank first line: cut to 40 characters (whole characters), blank lines skipped', async () => {
      const env = await setup(storage);
      const { w } = env;
      await create(w, 's-1');
      await create(w, 's-2');
      await settle();
      const long = `${'規劃'.repeat(15)}😀😀😀 and more`;
      expect(await send(w, 's-1', long, 'm-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).title).toBe(Array.from(long).slice(0, 40).join('').trimEnd());
      expect(await send(w, 's-2', '\n   \n\t Real title \n', 'm-2')).toMatchObject({ ok: true });
      expect((await get(w, 's-2')).title).toBe('Real title');
    });

    it('with an Agent and a folder of its own: its instructions, its folder, and still named by the first message', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const own = joinFolder(folders.elsewhere, 'mine');
      folders.makeForeign(own);
      expect(await create(w, 's-1', { agentId: AGENT, cwd: own })).toMatchObject({ ok: true });
      await settle();
      expect(await get(w, 's-1')).toMatchObject({ agent: { id: AGENT }, cwd: own, title: DEFAULT_SESSION_TITLE, autoTitle: true });
      expect(w.codex.get('s-1')?.started[0]?.instructions).toBe('Review carefully.');
      // Nothing was made in the location for it.
      expect(madeOn(env)).toEqual([]);
      expect(await send(w, 's-1', 'Review the plan', 'm-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).title).toBe('Review the plan');
    });

    it('session.rename: compare-and-set, trimmed, 1 to 200 characters; afterwards the first message does not rename it', async () => {
      const env = await setup(storage);
      const { w } = env;
      await create(w, 's-1');
      await settle();
      const s = await get(w, 's-1');
      const rename = (title: string, expectedRevision = s.revision) => w.run({ type: 'session.rename', requestId: rid(), sessionId: s.id, expectedRevision, title });
      expect(await rename('Mine', s.revision + 5)).toMatchObject({ ok: false, code: 'stale_revision' });
      expect(await rename('   ')).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await rename('x'.repeat(201))).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(await w.run({ type: 'session.rename', requestId: rid(), sessionId: SessionId.parse('nobody'), expectedRevision: 0, title: 'x' })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await rename('  My plan  ')).toMatchObject({ ok: true, revision: s.revision + 1 });
      expect(await get(w, 's-1')).toMatchObject({ title: 'My plan' });
      expect((await get(w, 's-1')).autoTitle).toBeUndefined();
      expect(await send(w, 's-1', 'First message', 'm-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).title).toBe('My plan');
    });

    it('session.setAgent: null leaves an ordinary session without an Agent; an Agent can be given again', async () => {
      const env = await setup(storage);
      const { w } = env;
      await create(w, 's-1', { agentId: AGENT });
      await settle();
      const s = await get(w, 's-1');
      expect(await w.run({ type: 'session.setAgent', requestId: rid(), sessionId: s.id, expectedRevision: s.revision, agentId: null })).toMatchObject({ ok: true });
      const cleared = await get(w, 's-1');
      expect(cleared.agent).toBeUndefined();
      expect(LogicalSession.parse(cleared)).toBeTruthy();
      expect(await w.run({ type: 'session.setAgent', requestId: rid(), sessionId: s.id, expectedRevision: cleared.revision, agentId: AGENT })).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).agent).toMatchObject({ id: AGENT });
      // An Agent no session uses any more can be deleted; one in use cannot.
      const agent = await w.repositories.agents.get(AGENT);
      expect(await w.run({ type: 'agent.delete', requestId: rid(), agentId: AGENT, expectedRevision: agent!.revision })).toMatchObject({ ok: false, code: 'invalid_transition' });
    });

    it('CR-2: the same session ID again is already_exists and makes no second folder, one after the other or at once', async () => {
      const env = await setup(storage);
      const { w } = env;
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect(await create(w, 's-1')).toMatchObject({ ok: false, code: 'already_exists' });
      const both = await Promise.all([create(w, 's-2'), create(w, 's-2')]);
      expect(both.map((r) => (r.ok ? 'ok' : r.code)).sort()).toEqual(['already_exists', 'ok']);
      expect(madeOn(env)).toEqual([`${DAY}-001`, `${DAY}-002`]);
      expect((await w.repositories.workFolders.list()).map((c) => c.sessionId).sort()).toEqual(['s-1', 's-2']);
    });

    it('sessions created at once get a folder each, never the same one', async () => {
      const env = await setup(storage);
      const { w } = env;
      const ids = ['s-1', 's-2', 's-3', 's-4', 's-5'];
      const results = await Promise.all(ids.map((id) => create(w, id)));
      expect(results.every((r) => r.ok)).toBe(true);
      const cwds = await Promise.all(ids.map(async (id) => (await get(w, id)).cwd));
      expect(new Set(cwds).size).toBe(5);
      expect(cwds.sort()).toEqual(['001', '002', '003', '004', '005'].map((n) => folderOf(env, n)));
      for (const cwd of cwds) expect(env.folders.exists(cwd)).toBe(true);
    });

    it('a folder made by someone else between the claim and the make is not taken over: the next number', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const first = folderOf(env, '001');
      env.hooks.onMake = (path) => {
        if (path !== first) return;
        folders.makeForeign(path);
        folders.putFile(path, 'theirs.txt');
      };
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(folderOf(env, '002'));
      expect(folders.fs.list(first)).toEqual(['theirs.txt']);
      expect((await w.repositories.workFolders.get(SessionId.parse('s-1')))?.path).toBe(folderOf(env, '002'));
    });

    it('storing the session fails: no session and no claim are left, the folder stays (r2); the same ID then gets the next one', async () => {
      const env = await setup(storage);
      const { w } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create' | 'get'> = w.repositories.sessions;
      const original = sessions.create.bind(sessions);
      let failOnce = true;
      sessions.create = (session) => {
        if (!failOnce) return original(session);
        failOnce = false;
        return Promise.reject(new Error('disk'));
      };
      await expect(create(w, 's-1')).rejects.toThrow('disk');
      expect(await sessions.get(SessionId.parse('s-1'))).toBeUndefined();
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toBeUndefined();
      expect(env.folders.exists(folderOf(env, '001'))).toBe(true);
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(folderOf(env, '002'));
    });

    it('stopped after the folder was made and before the session was stored: the next start removes the claim and leaves the folder', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      // The app stops while the session is being written: nothing after the folder runs.
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const original = sessions.create;
      sessions.create = () => new Promise<'created' | 'exists'>(() => undefined);
      void create(w, 's-1');
      void create(w, 's-2');
      for (let i = 0; i < 20 && !folders.exists(folderOf(env, '002')); i++) await settle();
      // s-2 waits behind s-1's allocation only, not behind its write: both folders are there now.
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.exists(folderOf(env, '002'))).toBe(true);
      folders.putFile(folderOf(env, '002'), 'notes.txt');
      // The next start: the same storage, written by nothing of the stopped one.
      sessions.create = original;
      const next = await env.restart();
      expect(await next.repositories.workFolders.list()).toEqual([]);
      // Nothing removed: the empty one and the one with something in it are both there.
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.fs.list(folderOf(env, '002'))).toEqual(['notes.txt']);
      expect(next.logs.some((l) => l.includes('its folder') && l.includes('is left as it is'))).toBe(true);
      // The same ID sent again after the start: a new folder for it, never the one left.
      expect(await create(next, 's-1')).toMatchObject({ ok: true });
      expect((await get(next, 's-1')).cwd).toBe(folderOf(env, '003'));
      expect(madeOn(env)).toEqual([`${DAY}-001`, `${DAY}-002`, `${DAY}-003`]);
    });

    it('a claim written before its folder was made: the next start removes it; a stored session keeps its claim and folder', async () => {
      const env = await setup(storage);
      const { w } = env;
      expect(await create(w, 's-kept')).toMatchObject({ ok: true });
      const kept = (await get(w, 's-kept')).cwd;
      expect(await w.repositories.workFolders.claim({ sessionId: SessionId.parse('s-lost'), path: folderOf(env, '002'), day: DAY, seq: 2, state: 'claimed', createdAt: '2026-11-04T01:00:00.000Z' })).toBe('claimed');
      const next = await env.restart();
      expect((await next.repositories.workFolders.list()).map((c) => c.sessionId)).toEqual(['s-kept']);
      expect(env.folders.exists(kept)).toBe(true);
      expect(await create(next, 's-lost')).toMatchObject({ ok: true });
      expect((await get(next, 's-lost')).cwd).toBe(folderOf(env, '002'));
    });

    it('C-29: a write refused (the data turned read-only) makes no folder, not even the location', async () => {
      const env = await setup(storage);
      const { w } = env;
      w.repositories.workFolders.claim = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      await expect(create(w, 's-1')).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(env.folders.exists(env.folders.location)).toBe(false);
      expect(await w.repositories.sessions.get(SessionId.parse('s-1'))).toBeUndefined();
    });

    it('a session stored before 0.8 (with an Agent, its name as title) reads and keeps its title', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const own = joinFolder(folders.elsewhere, 'old');
      folders.makeForeign(own);
      const real = folders.realPath(own)!;
      const old = LogicalSession.parse({
        id: 's-old', revision: 0, kind: 'ordinary', title: 'Reviewer', agent: { id: AGENT, revision: 0 }, requestedModel: model, observedModel: { source: 'unknown' },
        activity: 'closed', cwd: own, folderScope: { source: 'session-cwd', workspaceRoot: real, writableRoots: [real], readableRoots: [] },
        createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
      });
      expect(await w.repositories.sessions.create(old)).toBe('created');
      expect(await send(w, 's-old', 'Hello', 'm-1')).toMatchObject({ ok: true });
      expect(await get(w, 's-old')).toMatchObject({ title: 'Reviewer', agent: { id: AGENT } });
    });

    it('Q-1: preferences name another location: checked, not made (r1 P1-4); its first folder makes it; one that is not a full path is refused', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const prefs = await w.repositories.preferences.get();
      const other = joinFolder(folders.elsewhere, 'Nested');
      expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs, workFolderRoot: 'relative\\folder' } })).toMatchObject({ ok: false, code: 'invalid_request' });
      expect((await w.repositories.preferences.get()).workFolderRoot).toBeUndefined();
      expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs, workFolderRoot: other } })).toMatchObject({ ok: true });
      expect(folders.exists(other)).toBe(false);
      expect(w.events.some((e) => e.type === 'preferences.updated' && e.preferences.workFolderRoot === other)).toBe(true);
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(joinFolder(other, `${DAY}-001`));
      expect(folders.exists(joinFolder(other, `${DAY}-001`))).toBe(true);
      // Saving the same location again (the theme changed) does not check or make it again.
      expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs, theme: 'light', workFolderRoot: other } })).toMatchObject({ ok: true });
      // Back to the default location.
      expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs } })).toMatchObject({ ok: true });
      expect(await create(w, 's-2')).toMatchObject({ ok: true });
      expect((await get(w, 's-2')).cwd).toBe(folderOf(env, '001'));
    });
    // ---- review r1 ----------------------------------------------------------------------------------------------

    it('r1 P1-1: a claim whose folder our make never created: a folder someone made at that name is neither reused nor removed', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const lost = SessionId.parse('s-lost');
      // Claimed, then the app stopped before its make; the user made an empty folder of that name.
      expect(await w.repositories.workFolders.claim({ sessionId: lost, path: folderOf(env, '001'), day: DAY, seq: 1, state: 'claimed', createdAt: '2026-11-04T01:00:00.000Z' })).toBe('claimed');
      folders.makeForeign(folderOf(env, '001'));
      // The same session asking again: not that folder, a new one.
      expect(await create(w, 's-lost')).toMatchObject({ ok: true });
      expect((await get(w, 's-lost')).cwd).toBe(folderOf(env, '002'));
      expect(await w.repositories.workFolders.get(lost)).toMatchObject({ path: folderOf(env, '002'), state: 'made' });
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      // And at the next start, a claim left so is dropped without touching the folder.
      expect(await w.repositories.workFolders.claim({ sessionId: SessionId.parse('s-other'), path: folderOf(env, '003'), day: DAY, seq: 3, state: 'claimed', createdAt: '2026-11-04T01:00:00.000Z' })).toBe('claimed');
      folders.makeForeign(folderOf(env, '003'));
      const next = await env.restart();
      expect((await next.repositories.workFolders.list()).map((c) => c.sessionId)).toEqual(['s-lost']);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.exists(folderOf(env, '003'))).toBe(true);
    });

    it('r1 P1-1: a link put in place of a folder we made: not reused, not removed, the claim only', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const original = sessions.create;
      sessions.create = () => new Promise<'created' | 'exists'>(() => undefined);
      void create(w, 's-1');
      for (let i = 0; i < 20 && !folders.exists(folderOf(env, '001')); i++) await settle();
      // While the app is down, the folder becomes a link to another (empty) folder.
      const target = joinFolder(folders.elsewhere, 'target');
      folders.relink(folderOf(env, '001'), target);
      sessions.create = original;
      const next = await env.restart();
      expect(await next.repositories.workFolders.list()).toEqual([]);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.exists(target)).toBe(true);
      expect(next.logs.some((l) => l.includes('is left as it is'))).toBe(true);
    });

    it('r1 P1-1: a link put in place of a folder we made is not reused when the same session asks again', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const id = SessionId.parse('s-x');
      const path = folderOf(env, '001');
      // As our make left it (made, with its real path), its session not stored yet.
      expect(await w.repositories.workFolders.claim({ sessionId: id, path, day: DAY, seq: 1, state: 'claimed', createdAt: '2026-11-04T01:00:00.000Z' })).toBe('claimed');
      folders.makeForeign(path);
      await w.repositories.workFolders.markMade(id, folders.realPath(path)!);
      folders.relink(path, joinFolder(folders.elsewhere, 'target'));
      expect(await create(w, 's-x')).toMatchObject({ ok: true });
      expect((await get(w, 's-x')).cwd).toBe(folderOf(env, '002'));
      expect(folders.exists(path)).toBe(true);
      expect(w.logs.some((l) => l.includes('was not made by this program'))).toBe(true);
    });

    it('r1 P1-2: a folder another session uses is never removed when its claim is taken back (a failed write, the next start)', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const original = sessions.create.bind(sessions);
      let fail: (() => void) | undefined;
      sessions.create = (session) =>
        session.id === 's-1' ? new Promise<'created' | 'exists'>((_resolve, reject) => (fail = () => reject(new Error('disk')))) : original(session);
      const first = create(w, 's-1');
      for (let i = 0; i < 20 && fail === undefined; i++) await settle();
      // s-2 is given s-1's folder while s-1 is being written.
      expect(await create(w, 's-2', { cwd: folderOf(env, '001') })).toMatchObject({ ok: true });
      fail!();
      await expect(first).rejects.toThrow('disk');
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toBeUndefined();
      // The same at the next start: s-3 stopped before its session was stored; s-4 uses its folder.
      sessions.create = (session) => (session.id === 's-3' ? new Promise<'created' | 'exists'>(() => undefined) : original(session));
      void create(w, 's-3');
      for (let i = 0; i < 20 && !folders.exists(folderOf(env, '002')); i++) await settle();
      expect(await create(w, 's-4', { cwd: folderOf(env, '002') })).toMatchObject({ ok: true });
      sessions.create = original;
      const next = await env.restart();
      expect(await next.repositories.workFolders.get(SessionId.parse('s-3'))).toBeUndefined();
      expect(folders.exists(folderOf(env, '002'))).toBe(true);
    });

    it('r1 P1-3: the session write refused after the folder was made: the claim is released, the folder stays; the next start drops the claim', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const claims: Pick<AppRepositories['workFolders'], 'remove'> = w.repositories.workFolders;
      const [create0, remove0] = [sessions.create, claims.remove];
      // The data turned read-only: this write and every later one are refused.
      sessions.create = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      claims.remove = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      await expect(create(w, 's-1')).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      // Its removal refused, the claim is released: never to be reused.
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toMatchObject({ state: 'released' });
      [sessions.create, claims.remove] = [create0, remove0];
      const next = await env.restart();
      expect(await next.repositories.workFolders.list()).toEqual([]);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
    });

    it('r1 P1-3: refused right after the make (marking the claim made): the folder and the location stay, the claim never becomes ours', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const claims: Pick<AppRepositories['workFolders'], 'markMade'> = w.repositories.workFolders;
      const markMade = claims.markMade;
      claims.markMade = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      await expect(create(w, 's-1')).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.exists(folders.location)).toBe(true);
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toMatchObject({ state: 'claimed' });
      claims.markMade = markMade;
      // Asked again: claimed only, so the folder there is not taken as ours; a new one.
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(folderOf(env, '002'));
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
    });

    // ---- review r2: taking back never removes a folder -----------------------------------------------------------

    it('r2 ①: a session given the folder while its claim is being taken back keeps it', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const claims: Pick<AppRepositories['workFolders'], 'remove'> = w.repositories.workFolders;
      const [create0, remove0] = [sessions.create.bind(sessions), claims.remove.bind(claims)];
      sessions.create = (session) => (session.id === 's-1' ? Promise.reject(new Error('disk')) : create0(session));
      // The take-back pauses at its claim's removal: the window in which s-2 is given the folder.
      let resume: (() => void) | undefined;
      claims.remove = (sessionId) => new Promise<void>((resolve) => (resume = () => resolve(remove0(sessionId))));
      const first = create(w, 's-1');
      for (let i = 0; i < 20 && resume === undefined; i++) await settle();
      claims.remove = remove0;
      expect(await create(w, 's-2', { cwd: folderOf(env, '001') })).toMatchObject({ ok: true });
      resume!();
      await expect(first).rejects.toThrow('disk');
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(await get(w, 's-2')).toMatchObject({ cwd: folderOf(env, '001') });
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toBeUndefined();
    });

    it('r2 ②: marking the claim made refused while another session was given the folder: the folder and the location stay', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const claims: Pick<AppRepositories['workFolders'], 'markMade'> = w.repositories.workFolders;
      const markMade = claims.markMade;
      let refuse: (() => void) | undefined;
      claims.markMade = () => new Promise<void>((_resolve, reject) => (refuse = () => reject(new StorageReadOnlyError('disk-full'))));
      const first = create(w, 's-1');
      for (let i = 0; i < 20 && refuse === undefined; i++) await settle();
      claims.markMade = markMade;
      expect(await create(w, 's-2', { cwd: folderOf(env, '001') })).toMatchObject({ ok: true });
      refuse!();
      await expect(first).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      expect(folders.exists(folders.location)).toBe(true);
      expect(await get(w, 's-2')).toMatchObject({ cwd: folderOf(env, '001') });
    });

    it('r2 ③: a claim taken back but not removable is never reused, also when storage still says made; the next start drops it', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const sessions: Pick<AppRepositories['sessions'], 'create'> = w.repositories.sessions;
      const claims: Pick<AppRepositories['workFolders'], 'remove' | 'markReleased'> = w.repositories.workFolders;
      const [create0, remove0, released0] = [sessions.create.bind(sessions), claims.remove.bind(claims), claims.markReleased.bind(claims)];
      let refusing = true;
      sessions.create = (session) => (refusing ? Promise.reject(new StorageReadOnlyError('disk-full')) : create0(session));
      claims.remove = (sessionId) => (refusing ? Promise.reject(new StorageReadOnlyError('disk-full')) : remove0(sessionId));
      claims.markReleased = (sessionId) => (refusing ? Promise.reject(new StorageReadOnlyError('disk-full')) : released0(sessionId));
      await expect(create(w, 's-1')).rejects.toBeInstanceOf(StorageReadOnlyError);
      // Storage still says made (its release was refused too), and the folder is still there.
      expect(await w.repositories.workFolders.get(SessionId.parse('s-1'))).toMatchObject({ state: 'made', path: folderOf(env, '001') });
      expect(folders.exists(folderOf(env, '001'))).toBe(true);
      // Writable again: the same ID asked again does not get that folder back.
      refusing = false;
      expect(await create(w, 's-1')).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).cwd).toBe(folderOf(env, '002'));
      // And a stopped one: storage says made, its session never came; the next start drops it, the folder stays.
      refusing = true;
      await expect(create(w, 's-3')).rejects.toBeInstanceOf(StorageReadOnlyError);
      refusing = false;
      const next = await env.restart();
      expect((await next.repositories.workFolders.list()).map((c) => c.sessionId)).toEqual(['s-1']);
      expect(folders.exists(folderOf(env, '003'))).toBe(true);
      expect(await create(next, 's-3')).toMatchObject({ ok: true });
      expect((await get(next, 's-3')).cwd).toBe(folderOf(env, '004'));
    });

    it('r1 P1-4: a preferences save refused (read-only data) makes no folder', async () => {
      const env = await setup(storage);
      const { w, folders } = env;
      const other = joinFolder(folders.elsewhere, 'Refused');
      const preferences: Pick<AppRepositories['preferences'], 'set'> = w.repositories.preferences;
      preferences.set = () => Promise.reject(new StorageReadOnlyError('disk-full'));
      const prefs = await w.repositories.preferences.get();
      await expect(w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...prefs, workFolderRoot: other } })).rejects.toBeInstanceOf(StorageReadOnlyError);
      expect(folders.exists(other)).toBe(false);
      expect(folders.exists(folders.elsewhere)).toBe(false);
    });

    it('the first message names the session only once it went: one saved and waiting for its runtime keeps the placeholder', async () => {
      const env = await setup(storage);
      const { w } = env;
      await create(w, 's-1');
      await settle();
      // Its runtime closed while idle; resuming it fails for now (the runtime cannot be used): the message waits.
      expect(await w.service.closeIdle(SessionId.parse('s-1'), () => Promise.resolve(true), 1000)).toBe('closed');
      w.unavailable.add('codex');
      const resend = async () =>
        w.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('s-1'), messageId: 'm-1' as never, expectedRevision: (await get(w, 's-1')).revision, text: 'Plan the page', attachments: [] });
      expect(await resend()).toMatchObject({ ok: false, code: 'runtime_unavailable' });
      // Saved and waiting, not sent: not named yet.
      expect(await get(w, 's-1')).toMatchObject({ title: DEFAULT_SESSION_TITLE, autoTitle: true });
      w.unavailable.delete('codex');
      // Sent now: named.
      expect(await resend()).toMatchObject({ ok: true });
      expect((await get(w, 's-1')).title).toBe('Plan the page');
    });
  });

// T050 (U2, contracts 0.9): the sidebar's pinned lists in the preferences, and session.rename sent again. One set of
// cases on the memory ports (core/sessions/t050.test.ts) and on the SQLite repositories (app/main/t050-sqlite.test.ts).
import { describe, expect, it } from 'vitest';
import { InstanceId, type PinnedLists, pinnedOf, SessionId, type UiPreferences } from '../../../contracts';
import type { AppRepositories, DeliveryStore } from '../../ports';
import { CWD, rid, settle, type World, worldOn } from './harness';

export type T050Storage = () => { repositories: AppRepositories; store: DeliveryStore };

const model = { runtime: 'codex' as const, model: 'gpt-6-luna' };
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
// The workflow list holds runs and node sessions alike (WB-11); the cases put either kind in it.
const lists = (chat: string[], workflow: string[]): PinnedLists => ({ chat: chat.map((id) => SessionId.parse(id)), workflow: workflow.map((id) => InstanceId.parse(id)) });
const setPrefs = (w: World, preferences: UiPreferences) => w.run({ type: 'preferences.set', requestId: rid(), preferences });
const prefEvents = (w: World) => w.events.filter((e) => e.type === 'preferences.updated');
const sessionEvents = (w: World, id: string) => w.events.filter((e) => e.type === 'session.updated' && e.session.id === id);
const get = async (w: World, id: string) => {
  const s = await w.repositories.sessions.get(SessionId.parse(id));
  if (s === undefined) throw new Error(`no session ${id}`);
  return s;
};

export const t050SessionCases = (backend: string, storage: T050Storage) =>
  describe(`T050 pinned lists and renaming again (${backend})`, () => {
    const begin = async () => {
      const { repositories, store } = storage();
      return worldOn(repositories, store);
    };

    it('pinned lists are saved, announced and read back in order; a new save replaces them whole', async () => {
      const w = await begin();
      const base = await w.repositories.preferences.get();
      expect(pinnedOf(base)).toEqual({ chat: [], workflow: [] });
      const first = lists(['s-2', 's-1'], ['run-1']);
      expect(await setPrefs(w, { ...base, pinned: first })).toMatchObject({ ok: true });
      expect((await w.repositories.preferences.get()).pinned).toEqual(first);
      expect(prefEvents(w).at(-1)).toMatchObject({ preferences: { pinned: first } });
      const second = lists(['s-1'], []);
      expect(await setPrefs(w, { ...(await w.repositories.preferences.get()), pinned: second })).toMatchObject({ ok: true });
      expect((await w.repositories.preferences.get()).pinned).toEqual(second);
      // The other fields stay as sent.
      expect(await w.repositories.preferences.get()).toMatchObject({ theme: base.theme, supervisor: base.supervisor });
    });

    it('50 per list are saved; a 51st or a repeated ID is refused, nothing is saved or announced', async () => {
      const w = await begin();
      const base = await w.repositories.preferences.get();
      const full = lists(ids('s', 50), ids('i', 50));
      expect(await setPrefs(w, { ...base, pinned: full })).toMatchObject({ ok: true });
      const before = prefEvents(w).length;
      for (const pinned of [lists(ids('s', 51), []), lists([], ids('i', 51)), lists(['s-1', 's-2', 's-1'], []), lists([], ['i-1', 'i-1'])]) {
        expect(await setPrefs(w, { ...base, pinned })).toMatchObject({ ok: false, code: 'invalid_request' });
      }
      expect((await w.repositories.preferences.get()).pinned).toEqual(full);
      expect(prefEvents(w)).toHaveLength(before);
    });

    it('IDs that name no session or run are kept: the renderer skips them, a session may load later; the workflow list takes session IDs too (WB-11)', async () => {
      const w = await begin();
      expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('s-1'), kind: 'ordinary', model, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      const pinned = lists(['nobody', 's-1'], ['no-run', 's-1']);
      expect(await setPrefs(w, { ...(await w.repositories.preferences.get()), pinned })).toMatchObject({ ok: true });
      expect((await w.repositories.preferences.get()).pinned).toEqual(pinned);
      // A restart reads them as saved.
      const again = w.restart();
      expect((await again.repositories.preferences.get()).pinned).toEqual(pinned);
    });

    it('pinning with an unchanged work folder location does not check the location again', async () => {
      const w = await begin();
      const location = 'E:\\work\\Mine';
      const base = await w.repositories.preferences.get();
      expect(await setPrefs(w, { ...base, workFolderRoot: location })).toMatchObject({ ok: true });
      // The location can no longer be resolved (a drive gone): pinning still saves.
      w.realPath = () => null;
      const pinned = lists(['s-1'], []);
      expect(await setPrefs(w, { ...(await w.repositories.preferences.get()), pinned })).toMatchObject({ ok: true });
      expect(await w.repositories.preferences.get()).toMatchObject({ workFolderRoot: location, pinned });
    });

    it('preferences saved before 0.9 read with no pinned lists; a save without them leaves none (the record is replaced whole)', async () => {
      const w = await begin();
      await w.repositories.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 } });
      const old = await w.repositories.preferences.get();
      expect(old.pinned).toBeUndefined();
      expect(pinnedOf(old)).toEqual({ chat: [], workflow: [] });
      expect(await setPrefs(w, { ...old, pinned: lists(['s-1'], []) })).toMatchObject({ ok: true });
      // Known (T050 ★F): preferences.set replaces the record, so a sender that leaves the lists out clears them.
      expect(await setPrefs(w, { theme: 'dark', supervisor: old.supervisor })).toMatchObject({ ok: true });
      expect((await w.repositories.preferences.get()).pinned).toBeUndefined();
    });

    it('CR-2 session.rename sent again: one change, one event, both succeed; at once too', async () => {
      const w = await begin();
      expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('s-1'), kind: 'ordinary', model, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      const s = await get(w, 's-1');
      const rename = { type: 'session.rename' as const, requestId: rid(), sessionId: s.id, expectedRevision: s.revision, title: '  Plan  ' };
      const events = sessionEvents(w, 's-1').length;
      expect(await w.run(rename)).toMatchObject({ ok: true, revision: s.revision + 1 });
      // The answer was lost; the same request again.
      expect(await w.run(rename)).toMatchObject({ ok: true, revision: s.revision + 1 });
      expect(await get(w, 's-1')).toMatchObject({ title: 'Plan', revision: s.revision + 1 });
      expect(sessionEvents(w, 's-1').filter((e) => e.type === 'session.updated' && e.session.title === 'Plan')).toHaveLength(1);
      expect(sessionEvents(w, 's-1')).toHaveLength(events + 1);
      // Two at once, naming the same revision: the second finds the title given.
      const now = await get(w, 's-1');
      const at = { ...rename, requestId: rid(), expectedRevision: now.revision, title: 'Plan B' };
      const [a, b] = await Promise.all([w.run(at), w.run({ ...at, requestId: rid() })]);
      expect(a).toMatchObject({ ok: true, revision: now.revision + 1 });
      expect(b).toMatchObject({ ok: true, revision: now.revision + 1 });
      expect(sessionEvents(w, 's-1')).toHaveLength(events + 2);
      // Another title on an old revision is still refused.
      expect(await w.run({ ...rename, requestId: rid(), title: 'Other' })).toMatchObject({ ok: false, code: 'stale_revision' });
      expect((await get(w, 's-1')).title).toBe('Plan B');
    });

    it('session.rename to the placeholder title of a session still waiting for its first message ends the wait', async () => {
      const w = await begin();
      expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('s-1'), kind: 'ordinary', model, cwd: CWD })).toMatchObject({ ok: true });
      await settle();
      const s = await get(w, 's-1');
      expect(s.autoTitle).toBe(true);
      expect(await w.run({ type: 'session.rename', requestId: rid(), sessionId: s.id, expectedRevision: s.revision, title: s.title })).toMatchObject({ ok: true, revision: s.revision + 1 });
      const renamed = await get(w, 's-1');
      expect(renamed.autoTitle).toBeUndefined();
      expect(renamed.title).toBe(s.title);
      // Now the same title again writes nothing.
      expect(await w.run({ type: 'session.rename', requestId: rid(), sessionId: s.id, expectedRevision: s.revision, title: s.title })).toMatchObject({ ok: true, revision: renamed.revision });
      expect((await get(w, 's-1')).revision).toBe(renamed.revision);
    });
  });

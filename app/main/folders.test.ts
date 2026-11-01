import { describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { type FolderDeps, handleFolderRequest } from './folders';

const deps = (extra: Partial<FolderDeps> = {}): FolderDeps & { opened: string[] } => {
  const opened: string[] = [];
  return {
    opened,
    snapshot: () => fixtureSnapshot,
    dataFolder: 'C:/Users/me/AppData/Roaming/awg',
    pickFolder: vi.fn(() => Promise.resolve('E:/picked')),
    openPath: (path) => {
      opened.push(path);
      return Promise.resolve('');
    },
    realFolder: (path) => path,
    ...extra,
  };
};

describe('folder requests (C-24)', () => {
  it('picks a folder and returns only what the user chose, or null when cancelled', async () => {
    expect(await handleFolderRequest({ type: 'folder.pick', requestId: 'r1', title: '工作資料夾' }, deps())).toEqual({ ok: true, requestId: 'r1', path: 'E:/picked' });
    const cancelled = deps({ pickFolder: () => Promise.resolve(null) });
    expect(await handleFolderRequest({ type: 'folder.pick', requestId: 'r2' }, cancelled)).toEqual({ ok: true, requestId: 'r2', path: null });
  });

  it('opens a known folder by what it belongs to', async () => {
    const d = deps();
    const session = fixtureSnapshot.sessions[0]!;
    const login = fixtureSnapshot.instances[0]!;
    const project = fixtureSnapshot.projects[0]!;
    for (const target of [
      { kind: 'session-cwd', sessionId: session.id },
      { kind: 'task-worktree', instanceId: login.id, taskId: 'task-a' },
      { kind: 'project', projectId: project.id },
      { kind: 'app-data' },
    ]) {
      expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target }, d)).toEqual({ ok: true, requestId: 'r' });
    }
    expect(d.opened).toEqual([session.cwd, login.tasks[0]!.worktree!.path, project.rootPath, 'C:/Users/me/AppData/Roaming/awg']);
  });

  it('never opens a path from the renderer, an unknown target or a folder that is gone', async () => {
    const d = deps();
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'path', path: 'C:/Windows' } }, d)).toMatchObject({ ok: false, requestId: 'r', code: 'invalid_request' });
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', path: 'C:/Windows', target: { kind: 'app-data' } }, d)).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'session-cwd', sessionId: 'nobody' } }, d)).toMatchObject({ ok: false, code: 'not_found' });
    // task-c has no worktree yet.
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'task-worktree', instanceId: 'inst-login', taskId: 'task-c' } }, d)).toMatchObject({ ok: false, code: 'not_found' });
    const gone = deps({ realFolder: () => undefined });
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'app-data' } }, gone)).toMatchObject({ ok: false, code: 'not_found' });
    expect(d.opened).toEqual([]);
    expect(await handleFolderRequest('nonsense', d)).toMatchObject({ ok: false, requestId: null, code: 'invalid_request' });
  });

  it('opens the real folder that was checked, not the path as stored (T042 r1-P1-3)', async () => {
    const d = deps({ realFolder: () => 'D:/real/target' });
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'app-data' } }, d)).toEqual({ ok: true, requestId: 'r' });
    expect(d.opened).toEqual(['D:/real/target']);
  });

  it('turns a failing dialog or explorer into internal_error without throwing', async () => {
    const broken = deps({ pickFolder: () => Promise.reject(new Error('dialog')), openPath: () => Promise.resolve('access denied') });
    expect(await handleFolderRequest({ type: 'folder.pick', requestId: 'r' }, broken)).toMatchObject({ ok: false, requestId: 'r', code: 'internal_error' });
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r', target: { kind: 'app-data' } }, broken)).toMatchObject({ ok: false, code: 'internal_error' });
  });
});

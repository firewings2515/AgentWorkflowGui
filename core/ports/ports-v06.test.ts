// Ports of contracts 0.6 (T028): the git port and the file lock table can be implemented against the port
// alone, expected git outcomes are results (never exceptions), and session settings can say exec-only.
import { describe, expect, it } from 'vitest';
import type { FileLock, SessionId } from '../../contracts';
import type { FileLockTable, GitPort, SessionSettings, WorktreeRef } from './index';

const worktree: WorktreeRef = { repo: 'E:/work', path: 'E:/work/.awg/wt/t1', branch: 'task/t1' };

describe('git port (C-18)', () => {
  it('reports conflicts, a moved branch and a failed cleanup as results', async () => {
    const git: GitPort = {
      resolveBranch: () => Promise.resolve('3f9a1c2'),
      createWorktree: () => Promise.resolve({ status: 'created', baseCommit: '3f9a1c2' }),
      commitAll: () => Promise.resolve({ status: 'nothing', commit: '3f9a1c2' }),
      merge: () => Promise.resolve({ status: 'conflict', files: ['src/a.ts'] }),
      abortMerge: () => Promise.resolve({ status: 'aborted' }),
      advanceBranch: () => Promise.resolve({ status: 'moved', current: '8d2e4b1' }),
      status: () => Promise.resolve({ head: '3f9a1c2', branch: 'task/t1', dirty: false, merging: true, conflictFiles: ['src/a.ts'] }),
      removeWorktree: () => Promise.resolve({ status: 'pending-cleanup', detail: 'a process holds a file' }),
      retryCleanup: () => Promise.resolve({ status: 'removed' }),
    };
    expect(await git.merge(worktree, 'task/t2', 'Merge task/t2')).toEqual({ status: 'conflict', files: ['src/a.ts'] });
    expect((await git.advanceBranch('E:/work', 'main', '3f9a1c2', 'c71f0a9')).status).toBe('moved');
    expect((await git.removeWorktree(worktree, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(await git.retryCleanup(worktree, { deleteBranch: true })).toEqual({ status: 'removed' });
  });
});

describe('file lock table (C-19)', () => {
  it('answers synchronously, so nothing slips between a check and its change', () => {
    const locks: FileLock[] = [];
    const holder = 's-research' as SessionId;
    const table: FileLockTable = {
      acquire: (request) => {
        const lock: FileLock = { path: request.path, holderSessionId: holder, acquiredAt: request.at, waitingForBackground: false, writing: 1, waiters: [] };
        if (request.sessionId !== holder) return { status: 'held', lock };
        locks.push(lock);
        return { status: 'acquired', lock };
      },
      wait: () => Promise.resolve({ status: 'timeout' }),
      writeEnded: () => undefined,
      recordRead: () => undefined,
      turnEnded: () => undefined,
      backgroundCommands: () => undefined,
      releaseAll: () => locks.splice(0),
      fileChanged: () => true,
      list: () => locks,
      subscribe: () => () => undefined,
    };
    const at = '2026-10-31T16:00:00+08:00';
    expect(table.acquire({ path: 'e:/work/a.md', sessionId: holder, at }, undefined).status).toBe('acquired');
    expect(table.acquire({ path: 'e:/work/a.md', sessionId: 's-other' as SessionId, at }, undefined)).toMatchObject({ status: 'held', lock: { holderSessionId: holder } });
    table.releaseAll(holder, 'runtime-exited');
    expect(table.list()).toEqual([]);
  });
});

describe('session settings (C-23)', () => {
  it('can say exec-only next to readOnly; settings stored before 0.6 have only readOnly', () => {
    const execOnly: SessionSettings = { model: { runtime: 'claude', model: 'claude-sonnet-5-5' }, readOnly: true, writePolicy: 'exec-only' };
    const stored: SessionSettings = { model: { runtime: 'codex', model: 'gpt-6-astra' }, readOnly: true };
    expect([execOnly.writePolicy, stored.writePolicy]).toEqual(['exec-only', undefined]);
  });
});

// GitAdapter against real git in throw-away repositories (T030): worktrees, commits, the no-ff merge and its
// conflicts, the fast-forward of a target branch, long paths (SP-07 G6) and a worktree held by a process
// (SP-07 G1). Every repository is made with mkdtemp and the folder is deleted by its explicit path at the end.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorktreeRef } from '../../core/ports/git';
import { worktreePath } from './adapter';
import { createSandbox, type Sandbox } from './testing/sandbox';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let sandbox: Sandbox;
beforeAll(() => {
  sandbox = createSandbox();
});
afterAll(() => {
  sandbox.dispose();
});

const lines = (text: string): string[] => text.split('\n').filter((line) => line !== '');
const listed = async (repo: string): Promise<string[]> =>
  lines(await sandbox.git(repo, 'worktree', 'list', '--porcelain'))
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replaceAll('/', '\\').toLowerCase());
const isListed = async (repo: string, path: string): Promise<boolean> => (await listed(repo)).includes(path.replaceAll('/', '\\').toLowerCase());

/** An integration worktree on its own branch, from `main`. */
const integration = async (repo: string, name = 'int'): Promise<WorktreeRef> => {
  const ref = sandbox.task(repo, name);
  const base = await sandbox.adapter.resolveBranch(repo, 'main');
  expect((await sandbox.adapter.createWorktree(ref, base ?? '')).status).toBe('created');
  return ref;
};

/** A task worktree with one committed change. */
const taskWith = async (repo: string, name: string, file: string, content: string): Promise<WorktreeRef> => {
  const ref = sandbox.task(repo, name);
  const base = await sandbox.adapter.resolveBranch(repo, 'main');
  expect((await sandbox.adapter.createWorktree(ref, base ?? '')).status).toBe('created');
  sandbox.write(ref.path, file, content);
  expect((await sandbox.adapter.commitAll(ref, `task ${name}`, [])).status).toBe('committed');
  return ref;
};

/** A process whose working directory is `cwd`, which keeps that folder from being deleted. */
const holdFolder = async (cwd: string) => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('up'); setInterval(() => {}, 1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  sandbox.children.push(child);
  await once(child.stdout, 'data');
  return {
    pid: child.pid,
    async release() {
      const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
      child.kill();
      await exited;
    },
  };
};

describe.concurrent('every git command carries core.longpaths', () => {
  it('starts each command with -c core.longpaths=true, whatever the operation', async () => {
    const repo = await sandbox.newRepo();
    const before = sandbox.calls.length;
    const ref = await taskWith(repo, 'spy', 'a.txt', 'a\n');
    const int = await integration(repo, 'spy-int');
    await sandbox.adapter.merge(int, ref.branch, 'merge');
    await sandbox.adapter.status(int);
    await sandbox.adapter.advanceBranch(repo, 'main', await sandbox.git(repo, 'rev-parse', 'main').then((s) => s.trim()), (await sandbox.adapter.status(int)).head);
    await sandbox.adapter.removeWorktree(ref, { deleteBranch: true });
    const mine = sandbox.calls.slice(before);
    expect(mine.length).toBeGreaterThan(20);
    for (const args of mine) expect(args.slice(0, 2)).toEqual(['-c', 'core.longpaths=true']);
  });
});

describe.concurrent('long paths (SP-07 G6)', () => {
  it('commits a file whose path is over 260 characters and checks it out in another worktree', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'long');
    expect((await sandbox.adapter.createWorktree(ref, 'main')).status).toBe('created');
    const folders = Array.from({ length: 6 }, (_, i) => `${'d'.repeat(48)}${String(i)}`);
    const relative = join(...folders, 'deep.txt');
    const file = sandbox.write(ref.path, relative, 'deep\n');
    expect(file.length).toBeGreaterThan(260);

    const committed = await sandbox.adapter.commitAll(ref, 'deep file', []);
    expect(committed.status).toBe('committed');
    const tracked = lines(await sandbox.git(ref.path, 'ls-tree', '-r', '--name-only', 'HEAD'));
    expect(tracked).toContain(relative.replaceAll('\\', '/'));

    // The merge has to write it into the integration worktree too.
    const int = await integration(repo, 'long-int');
    expect((await sandbox.adapter.merge(int, ref.branch, 'merge deep')).status).toBe('merged');
    expect(existsOnLongPath(join(int.path, relative))).toBe(true);

    // Cleanup of a long tree: removed now, or pending and then removed by retryCleanup (rmSync handles long paths).
    let result = await sandbox.adapter.removeWorktree(ref, { deleteBranch: true });
    if (result.status !== 'removed') result = await sandbox.adapter.retryCleanup(ref, { deleteBranch: true });
    expect(result).toEqual({ status: 'removed' });
    expect(existsSync(ref.path)).toBe(false);
  });
});

const existsOnLongPath = (path: string): boolean => {
  try {
    return readFileSync(path, 'utf8') === 'deep\n';
  } catch {
    return false;
  }
};

describe.concurrent('createWorktree', () => {
  it('creates a short worktree on a new branch at the base commit, and says exists the second time', async () => {
    const repo = await sandbox.newRepo();
    const tip = (await sandbox.git(repo, 'rev-parse', 'HEAD')).trim();
    const ref = sandbox.task(repo, 't1');
    expect(ref.path).toBe(join(repo, '.awg', 'wt', 't1'));

    expect(await sandbox.adapter.createWorktree(ref, 'main')).toEqual({ status: 'created', baseCommit: tip });
    expect(existsSync(join(ref.path, 'README.md'))).toBe(true);
    expect(await sandbox.adapter.resolveBranch(repo, 'task/t1')).toBe(tip);
    expect((await sandbox.adapter.status(ref)).branch).toBe('task/t1');

    expect(await sandbox.adapter.createWorktree(ref, 'main')).toEqual({ status: 'exists', baseCommit: tip });
    expect(await sandbox.adapter.createWorktree(ref, tip)).toEqual({ status: 'exists', baseCommit: tip });
  });

  it('keeps .awg out of the repository status', async () => {
    const repo = await sandbox.newRepo();
    await sandbox.adapter.createWorktree(sandbox.task(repo, 'quiet'), 'main');
    expect(await sandbox.git(repo, 'status', '--porcelain')).toBe('');
  });

  it('fails, changing nothing, for a taken path, a taken branch, a missing base, or a path that is not the pipeline’s', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 't2');
    await sandbox.adapter.createWorktree(ref, 'main');
    expect((await sandbox.adapter.createWorktree({ ...ref, branch: 'task/other' }, 'main')).status).toBe('failed');
    expect(await sandbox.adapter.resolveBranch(repo, 'task/other')).toBeUndefined();
    expect((await sandbox.adapter.createWorktree({ ...ref, path: worktreePath(repo, 't2b') }, 'main')).status).toBe('failed');
    expect((await sandbox.adapter.createWorktree(sandbox.task(repo, 't2c'), 'no-such-base')).status).toBe('failed');
    expect((await sandbox.adapter.createWorktree(sandbox.task(repo, 't2d'), '--orphan')).status).toBe('failed');
    expect((await sandbox.adapter.createWorktree({ repo, path: repo, branch: 'task/self' }, 'main')).status).toBe('failed');
    expect((await sandbox.adapter.createWorktree({ repo, path: 'relative', branch: 'task/rel' }, 'main')).status).toBe('failed');
    expect((await sandbox.adapter.createWorktree({ repo, path: worktreePath(repo, 'x'), branch: '-bad..name' }, 'main')).status).toBe('failed');
  });

  it('resolveBranch is undefined for a branch that does not exist', async () => {
    const repo = await sandbox.newRepo();
    expect(await sandbox.adapter.resolveBranch(repo, 'nope')).toBeUndefined();
    expect(await sandbox.adapter.resolveBranch(repo, 'bad..name')).toBeUndefined();
  });
});

describe.concurrent('commitAll', () => {
  it('commits what changed, leaves out the excluded paths, and says nothing when nothing is left', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'c1');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'src/a.txt', 'a\n');
    sandbox.write(ref.path, 'out/setup.bin', 'built\n');
    sandbox.write(ref.path, 'run.log', 'noise\n');

    const first = await sandbox.adapter.commitAll(ref, 'handoff', ['out', '*.log']);
    expect(first.status).toBe('committed');
    expect(lines(await sandbox.git(ref.path, 'ls-tree', '-r', '--name-only', 'HEAD')).sort()).toEqual(['README.md', 'src/a.txt']);
    expect((await sandbox.adapter.status(ref)).dirty).toBe(true); // the excluded files are still there, uncommitted

    const again = await sandbox.adapter.commitAll(ref, 'handoff', ['out', '*.log']);
    expect(again).toEqual({ status: 'nothing', commit: first.status === 'committed' ? first.commit : '' });
  });

  it('does not commit ignored files and keeps a multi-line message with # lines and non-ASCII text', async () => {
    const repo = await sandbox.newRepo();
    await sandbox.commitFile(repo, '.gitignore', 'node_modules/\n');
    const ref = sandbox.task(repo, 'c2');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'node_modules/x/index.js', 'x\n');
    expect((await sandbox.adapter.commitAll(ref, 'nothing', [])).status).toBe('nothing');

    sandbox.write(ref.path, 'f.txt', 'f\n');
    const message = 'task c2: 完成\n\n# not a comment\n- line two';
    expect((await sandbox.adapter.commitAll(ref, message, [])).status).toBe('committed');
    expect((await sandbox.git(ref.path, 'log', '-1', '--format=%B')).trim()).toBe(message);
  });

  it('commits with its own identity when git has none', async () => {
    const repo = await sandbox.newRepo();
    const anonymous = sandbox.anonymousAdapter();
    const ref = sandbox.task(repo, 'c3');
    expect((await anonymous.createWorktree(ref, 'main')).status).toBe('created');
    sandbox.write(ref.path, 'f.txt', 'f\n');
    expect((await anonymous.commitAll(ref, 'who am i', [])).status).toBe('committed');
    expect((await sandbox.git(ref.path, 'log', '-1', '--format=%an <%ae>')).trim()).toBe('AgentWorkflowGui <agent-workflow-gui@localhost>');
  });

  it('fails for an empty message, a magic pathspec, or a worktree on another branch', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'c4');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'f.txt', 'f\n');
    expect((await sandbox.adapter.commitAll(ref, '  ', [])).status).toBe('failed');
    expect((await sandbox.adapter.commitAll(ref, 'm', [':(top)x'])).status).toBe('failed');
    expect((await sandbox.adapter.commitAll({ ...ref, branch: 'task/else' }, 'm', [])).status).toBe('failed');
    expect(await sandbox.git(ref.path, 'log', '--oneline')).not.toContain(' m');
  });
});

describe.concurrent('merge and abortMerge', () => {
  it('merges task branches with --no-ff into the integration worktree and leaves the target alone', async () => {
    const repo = await sandbox.newRepo();
    const mainBefore = (await sandbox.git(repo, 'rev-parse', 'main')).trim();
    const one = await taskWith(repo, 'm1', 'one.txt', '1\n');
    const two = await taskWith(repo, 'm2', 'two.txt', '2\n');
    const int = await integration(repo);

    const first = await sandbox.adapter.merge(int, one.branch, 'merge m1');
    const second = await sandbox.adapter.merge(int, two.branch, 'merge m2');
    expect(first.status).toBe('merged');
    expect(second.status).toBe('merged');
    if (second.status !== 'merged') return;
    // Two parents: a merge commit even though m1 could have been fast-forwarded.
    expect(lines((await sandbox.git(int.path, 'rev-list', '--parents', '-n', '1', 'HEAD')).replaceAll(' ', '\n'))).toHaveLength(3);
    expect((await sandbox.git(int.path, 'log', '-1', '--format=%s')).trim()).toBe('merge m2');
    expect(existsSync(join(int.path, 'one.txt')) && existsSync(join(int.path, 'two.txt'))).toBe(true);
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(mainBefore);

    // Merging what is already in changes nothing.
    expect(await sandbox.adapter.merge(int, one.branch, 'again')).toEqual({ status: 'merged', commit: second.commit });
  });

  it('reports the conflicting files, leaves the merge in progress, and abort puts everything back', async () => {
    const repo = await sandbox.newRepo();
    await sandbox.commitFile(repo, 'shared.txt', 'base\n');
    const a = await taskWith(repo, 'k1', 'shared.txt', 'from k1\n');
    const b = await taskWith(repo, 'k2', 'shared.txt', 'from k2\n');
    await sandbox.adapter.commitAll(b, 'k2 more', []);
    sandbox.write(b.path, 'other.txt', 'other\n');
    await sandbox.adapter.commitAll(b, 'k2 other', []);
    const int = await integration(repo);
    expect((await sandbox.adapter.merge(int, a.branch, 'merge k1')).status).toBe('merged');
    const headBefore = (await sandbox.adapter.status(int)).head;
    const treeBefore = (await sandbox.git(int.path, 'ls-files', '-s')).trim();

    expect(await sandbox.adapter.merge(int, b.branch, 'merge k2')).toEqual({ status: 'conflict', files: ['shared.txt'] });
    const during = await sandbox.adapter.status(int);
    expect(during).toMatchObject({ merging: true, dirty: true, conflictFiles: ['shared.txt'] });
    expect(readFileSync(join(int.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
    // A second merge, or a commit of the unresolved files, is refused.
    expect((await sandbox.adapter.merge(int, b.branch, 'again')).status).toBe('failed');
    expect((await sandbox.adapter.commitAll(int, 'too early', [])).status).toBe('failed');

    expect(await sandbox.adapter.abortMerge(int)).toEqual({ status: 'aborted' });
    expect(await sandbox.adapter.status(int)).toEqual({ head: headBefore, branch: 'task/int', dirty: false, merging: false, conflictFiles: [] });
    expect((await sandbox.git(int.path, 'ls-files', '-s')).trim()).toBe(treeBefore);
    expect(readFileSync(join(int.path, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('from k1\n');
    expect(existsSync(join(int.path, 'other.txt'))).toBe(false);
    expect((await sandbox.adapter.abortMerge(int)).status).toBe('failed'); // nothing to abort
  });

  it('commitAll concludes a merge whose conflicts an agent resolved', async () => {
    const repo = await sandbox.newRepo();
    await sandbox.commitFile(repo, 'shared.txt', 'base\n');
    const a = await taskWith(repo, 'r1', 'shared.txt', 'from r1\n');
    const b = await taskWith(repo, 'r2', 'shared.txt', 'from r2\n');
    const int = await integration(repo);
    await sandbox.adapter.merge(int, a.branch, 'merge r1');
    expect((await sandbox.adapter.merge(int, b.branch, 'merge r2')).status).toBe('conflict');

    sandbox.write(int.path, 'shared.txt', 'resolved\n');
    const done = await sandbox.adapter.commitAll(int, 'merge r2 (resolved)', []);
    expect(done.status).toBe('committed');
    expect(await sandbox.adapter.status(int)).toMatchObject({ merging: false, dirty: false, conflictFiles: [] });
    expect(lines((await sandbox.git(int.path, 'rev-list', '--parents', '-n', '1', 'HEAD')).replaceAll(' ', '\n'))).toHaveLength(3);
  });

  it('fails without a merge in progress for a missing branch, uncommitted changes, or the wrong branch', async () => {
    const repo = await sandbox.newRepo();
    const one = await taskWith(repo, 'f1', 'one.txt', '1\n');
    const int = await integration(repo);
    expect((await sandbox.adapter.merge(int, 'no-such-branch', 'm')).status).toBe('failed');
    sandbox.write(int.path, 'README.md', 'edited\n');
    expect(await sandbox.adapter.merge(int, one.branch, 'm')).toMatchObject({ status: 'failed', detail: expect.stringContaining('uncommitted') as unknown });
    expect((await sandbox.adapter.merge({ ...int, branch: 'main' }, one.branch, 'm')).status).toBe('failed');
    expect((await sandbox.adapter.status(int)).merging).toBe(false);
  });
});

describe.concurrent('advanceBranch', () => {
  /** main plus an integration branch one merge ahead of it. */
  const ahead = async () => {
    const repo = await sandbox.newRepo();
    const one = await taskWith(repo, 'a1', 'one.txt', '1\n');
    const int = await integration(repo);
    await sandbox.adapter.merge(int, one.branch, 'merge a1');
    const expected = (await sandbox.git(repo, 'rev-parse', 'main')).trim();
    const to = (await sandbox.adapter.status(int)).head;
    return { repo, int, expected, to };
  };

  it('fast-forwards a branch that is checked out in the main checkout, files and index included', async () => {
    const { repo, expected, to } = await ahead();
    sandbox.write(repo, 'untracked.txt', 'mine\n'); // untracked files do not stand in the way
    expect(await sandbox.adapter.advanceBranch(repo, 'main', expected, to)).toEqual({ status: 'advanced' });
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(to);
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(await sandbox.git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // History is kept: the old tip is an ancestor of the new one.
    await sandbox.git(repo, 'merge-base', '--is-ancestor', expected, to);
  });

  it('refuses a checked-out branch whose checkout has local changes, and changes nothing', async () => {
    const { repo, expected, to } = await ahead();
    sandbox.write(repo, 'README.md', 'my edit\n');
    const result = await sandbox.adapter.advanceBranch(repo, 'main', expected, to);
    expect(result.status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(expected);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('my edit\n');
    // Staged changes count too.
    writeFileSync(join(repo, 'README.md'), 'staged edit\n');
    await sandbox.git(repo, 'add', 'README.md');
    expect((await sandbox.adapter.advanceBranch(repo, 'main', expected, to)).status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(expected);
  });

  it('refuses while a merge or rebase is in progress in the checkout', async () => {
    const { repo, expected, to } = await ahead();
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${expected}\n`);
    const result = await sandbox.adapter.advanceBranch(repo, 'main', expected, to);
    rmSync(join(repo, '.git', 'MERGE_HEAD'));
    expect(result.status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(expected);
  });

  it('says moved, with the current commit, when someone else updated the branch', async () => {
    const { repo, expected, to } = await ahead();
    const other = await sandbox.commitFile(repo, 'someone.txt', 'else\n');
    expect(await sandbox.adapter.advanceBranch(repo, 'main', expected, to)).toEqual({ status: 'moved', current: other });
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(other);
    expect(existsSync(join(repo, 'one.txt'))).toBe(false);
  });

  it('refuses what is not a fast-forward', async () => {
    const { repo, expected } = await ahead();
    const other = await sandbox.commitFile(repo, 'diverged.txt', 'd\n');
    await sandbox.git(repo, 'branch', 'side', expected);
    const sideTip = await sandbox.git(repo, 'rev-parse', 'side').then((s) => s.trim());
    // main is at `other`; moving it to its own ancestor, or to a sibling, is not a fast-forward.
    expect((await sandbox.adapter.advanceBranch(repo, 'main', other, sideTip)).status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(other);
  });

  it('moves the ref of a branch that is checked out nowhere, only from the expected value', async () => {
    const { repo, expected, to } = await ahead();
    await sandbox.git(repo, 'branch', 'release', expected);
    expect(await sandbox.adapter.advanceBranch(repo, 'release', expected, to)).toEqual({ status: 'advanced' });
    expect((await sandbox.git(repo, 'rev-parse', 'release')).trim()).toBe(to);
    expect(await sandbox.adapter.advanceBranch(repo, 'release', expected, to)).toEqual({ status: 'moved', current: to });
    expect((await sandbox.adapter.advanceBranch(repo, 'no-such-branch', expected, to)).status).toBe('failed');
    expect((await sandbox.adapter.advanceBranch(repo, 'release', to, 'not-a-commit')).status).toBe('failed');
  });

  it('fast-forwards the checkout in a linked worktree, and refuses when that one has local changes', async () => {
    const { repo, expected, to } = await ahead();
    await sandbox.git(repo, 'branch', 'release', expected);
    const linked = join(sandbox.root, 'linked-release');
    await sandbox.git(repo, 'worktree', 'add', '-q', linked, 'release');
    writeFileSync(join(linked, 'README.md'), 'local\n');
    expect((await sandbox.adapter.advanceBranch(repo, 'release', expected, to)).status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'release')).trim()).toBe(expected);

    writeFileSync(join(linked, 'README.md'), 'start\n');
    await sandbox.git(linked, 'checkout', '--', 'README.md');
    expect(await sandbox.adapter.advanceBranch(repo, 'release', expected, to)).toEqual({ status: 'advanced' });
    expect(existsSync(join(linked, 'one.txt'))).toBe(true);
    expect(await sandbox.git(linked, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('never pushes or contacts a remote', async () => {
    const { repo } = await ahead();
    expect(await sandbox.git(repo, 'remote')).toBe('');
    expect(sandbox.calls.flat().filter((arg) => ['push', 'fetch', 'pull', 'remote', 'reset', 'rebase'].includes(arg))).toEqual([]);
  });
});

describe.concurrent('status', () => {
  it('reports head, branch, dirty (untracked counts) and a detached head', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 's1');
    await sandbox.adapter.createWorktree(ref, 'main');
    const tip = (await sandbox.git(repo, 'rev-parse', 'main')).trim();
    expect(await sandbox.adapter.status(ref)).toEqual({ head: tip, branch: 'task/s1', dirty: false, merging: false, conflictFiles: [] });
    sandbox.write(ref.path, 'new.txt', 'n\n');
    expect((await sandbox.adapter.status(ref)).dirty).toBe(true);
    await sandbox.git(ref.path, 'checkout', '-q', '--detach');
    const detached = await sandbox.adapter.status(ref);
    expect(detached.branch).toBeUndefined();
    expect(detached.head).toBe(tip);
  });
});

describe.concurrent('removeWorktree and retryCleanup', () => {
  it('removes the worktree, keeps the branch unless asked, and is repeatable', async () => {
    const repo = await sandbox.newRepo();
    const keep = await taskWith(repo, 'x1', 'x.txt', 'x\n');
    const drop = await taskWith(repo, 'x2', 'x.txt', 'x\n');

    expect(await sandbox.adapter.removeWorktree(keep, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(existsSync(keep.path)).toBe(false);
    expect(await isListed(repo, keep.path)).toBe(false);
    expect(await sandbox.adapter.resolveBranch(repo, keep.branch)).toBeDefined();

    expect(await sandbox.adapter.removeWorktree(drop, { deleteBranch: true })).toEqual({ status: 'removed' });
    expect(await sandbox.adapter.resolveBranch(repo, drop.branch)).toBeUndefined();
    // Again: nothing left to do, still removed; and the branch kept earlier can go now.
    expect(await sandbox.adapter.removeWorktree(drop, { deleteBranch: true })).toEqual({ status: 'removed' });
    expect(await sandbox.adapter.removeWorktree(keep, { deleteBranch: true })).toEqual({ status: 'removed' });
    expect(await sandbox.adapter.resolveBranch(repo, keep.branch)).toBeUndefined();
  });

  it('removes a dirty worktree (the GUI ended its processes first)', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'x3', 'x.txt', 'x\n');
    sandbox.write(ref.path, 'uncommitted.txt', 'u\n');
    expect(await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(existsSync(ref.path)).toBe(false);
  });

  it('reports pending-cleanup while a process holds the folder, and retryCleanup finishes it once the process ends (SP-07 G1)', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'h1', 'h.txt', 'h\n');
    const holder = await holdFolder(ref.path);

    const first = await sandbox.adapter.removeWorktree(ref, { deleteBranch: true });
    expect(first.status).toBe('pending-cleanup');
    expect(existsSync(ref.path)).toBe(true); // git left the half-deleted folder
    expect(await isListed(repo, ref.path)).toBe(false); // ...but already unregistered
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined(); // the branch waits for the folder

    expect((await sandbox.adapter.retryCleanup(ref, { deleteBranch: true })).status).toBe('pending-cleanup'); // still held
    expect(existsSync(ref.path)).toBe(true);

    await holder.release();
    expect(await sandbox.adapter.retryCleanup(ref, { deleteBranch: true })).toEqual({ status: 'removed' });
    expect(existsSync(ref.path)).toBe(false);
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeUndefined();
    expect(await sandbox.adapter.retryCleanup(ref, { deleteBranch: true })).toEqual({ status: 'removed' });
  });

  it('finishes a held worktree outside .awg too, because its own removal left the folder', async () => {
    const repo = await sandbox.newRepo();
    const ref: WorktreeRef = { repo, path: join(sandbox.root, 'elsewhere', 'w1'), branch: 'task/w1' };
    expect((await sandbox.adapter.createWorktree(ref, 'main')).status).toBe('created');
    const holder = await holdFolder(ref.path);
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    await holder.release();
    expect(await sandbox.adapter.retryCleanup(ref, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(existsSync(ref.path)).toBe(false);
  });

  it('unregisters a worktree whose folder is gone without pruning other worktrees', async () => {
    const repo = await sandbox.newRepo();
    const ours = await taskWith(repo, 'p1', 'p.txt', 'p\n');
    const foreign = await taskWith(repo, 'p2', 'q.txt', 'q\n');
    rmSync(ours.path, { recursive: true, force: true });
    rmSync(foreign.path, { recursive: true, force: true });

    expect(await sandbox.adapter.retryCleanup(ours, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(await isListed(repo, ours.path)).toBe(false);
    expect(await isListed(repo, foreign.path)).toBe(true); // somebody else's registration is left alone
    expect(await sandbox.adapter.removeWorktree(foreign, { deleteBranch: false })).toEqual({ status: 'removed' });
  });

  it('refuses to delete what is not the pipeline’s: the repository, an unregistered folder, another branch’s worktree', async () => {
    const repo = await sandbox.newRepo();
    expect((await sandbox.adapter.removeWorktree({ repo, path: repo, branch: 'main' }, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect((await sandbox.adapter.retryCleanup({ repo, path: join(repo, '.git'), branch: 'main' }, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect((await sandbox.adapter.retryCleanup({ repo, path: sandbox.root, branch: 'main' }, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(existsSync(join(repo, '.git', 'HEAD'))).toBe(true);
    expect(await sandbox.adapter.resolveBranch(repo, 'main')).toBeDefined();

    const stranger = join(sandbox.root, 'not-ours');
    mkdirSync(stranger);
    writeFileSync(join(stranger, 'precious.txt'), 'keep\n');
    const result = await sandbox.adapter.retryCleanup({ repo, path: stranger, branch: 'task/stranger' }, { deleteBranch: false });
    expect(result.status).toBe('pending-cleanup');
    expect(existsSync(join(stranger, 'precious.txt'))).toBe(true);

    const ref = await taskWith(repo, 'g1', 'g.txt', 'g\n');
    const wrongBranch = { ...ref, branch: 'task/other-branch' };
    expect((await sandbox.adapter.removeWorktree(wrongBranch, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(existsSync(ref.path)).toBe(true);
    expect(await isListed(repo, ref.path)).toBe(true);
  });
});

// GitAdapter against real git in throw-away repositories (T030): worktrees, commits, the no-ff merge and its
// conflicts, the fast-forward of a target branch, long paths (SP-07 G6) and a worktree held by a process
// (SP-07 G1). Every repository is made with mkdtemp and the folder is deleted by its explicit path at the end.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('accepts git pathspec magic in exclude (glob, top, short form) and keeps the caller’s meaning', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'c5');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'out/a.bin', 'a\n');
    sandbox.write(ref.path, 'out/deep/b.bin', 'b\n');
    sandbox.write(ref.path, 'package-lock.json', '{}\n');
    sandbox.write(ref.path, 'sub/keep.txt', 'k\n');
    sandbox.write(ref.path, 'sub/lock.txt', 'l\n');
    sandbox.write(ref.path, 'src/x.ts', 'x\n');

    const result = await sandbox.adapter.commitAll(ref, 'magic', [':(glob)out/**', ':(top)package-lock.json', ':/sub/lock.txt']);
    expect(result.status).toBe('committed');
    expect(lines(await sandbox.git(ref.path, 'ls-tree', '-r', '--name-only', 'HEAD')).sort()).toEqual(['README.md', 'src/x.ts', 'sub/keep.txt']);
  });

  it('refuses an exclude that is already an exclusion, or empty: wrapped again it would mean the opposite', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'c6');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'f.txt', 'f\n');
    for (const bad of [':(exclude)f.txt', ':!f.txt', ':^f.txt', ':(glob,exclude)f.txt', '', '  ', ':', ':(top']) {
      expect(await sandbox.adapter.commitAll(ref, 'm', [bad]), bad).toMatchObject({ status: 'failed' });
    }
    expect((await sandbox.adapter.status(ref)).head).toBe((await sandbox.git(repo, 'rev-parse', 'main')).trim());
  });

  it('fails for an empty message, or a worktree on another branch', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'c4');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'f.txt', 'f\n');
    expect((await sandbox.adapter.commitAll(ref, '  ', [])).status).toBe('failed');
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

describe.concurrent('unresolved conflict markers are never committed', () => {
  /** An integration worktree in the middle of a conflicting merge of `shared.txt`. */
  const conflicting = async (attributes?: string) => {
    const repo = await sandbox.newRepo();
    if (attributes !== undefined) await sandbox.commitFile(repo, '.gitattributes', attributes);
    await sandbox.commitFile(repo, 'shared.txt', 'base\n');
    const a = await taskWith(repo, 'k1', 'shared.txt', 'from k1\n');
    const b = await taskWith(repo, 'k2', 'shared.txt', 'from k2\n');
    const int = await integration(repo);
    await sandbox.adapter.merge(int, a.branch, 'merge k1');
    expect((await sandbox.adapter.merge(int, b.branch, 'merge k2')).status).toBe('conflict');
    return { repo, int };
  };

  it('refuses a conflict that was `git add`ed unresolved, then commits it once the markers are gone', async () => {
    const { int } = await conflicting();
    await sandbox.git(int.path, 'add', 'shared.txt'); // git no longer lists it as unmerged
    expect((await sandbox.adapter.status(int)).conflictFiles).toEqual([]);
    const refused = await sandbox.adapter.commitAll(int, 'oops', []);
    expect(refused).toMatchObject({ status: 'failed', detail: expect.stringContaining('shared.txt') as unknown });
    expect((await sandbox.adapter.status(int)).merging).toBe(true);

    sandbox.write(int.path, 'shared.txt', 'resolved\n');
    expect((await sandbox.adapter.commitAll(int, 'merge k2', [])).status).toBe('committed');
    expect(await sandbox.adapter.status(int)).toMatchObject({ merging: false, dirty: false });
  });

  it('knows the marker length from conflict-marker-size, which a fixed 7-character test would miss', async () => {
    const { int } = await conflicting('shared.txt conflict-marker-size=8\n');
    expect(readFileSync(join(int.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<<');
    expect((await sandbox.adapter.commitAll(int, 'oops', [])).status).toBe('failed');
    sandbox.write(int.path, 'shared.txt', 'resolved\n');
    expect((await sandbox.adapter.commitAll(int, 'merge k2', [])).status).toBe('committed');
  });

  it('keeps resolved text that happens to start with <<<<<<<, and text about markers in other files', async () => {
    const { int } = await conflicting();
    sandbox.write(int.path, 'shared.txt', 'resolved, with an example line:\n<<<<<<< example\n');
    sandbox.write(int.path, 'docs.md', '<<<<<<< ours\n=======\n>>>>>>> theirs\n'); // not a conflicted file
    const result = await sandbox.adapter.commitAll(int, 'merge k2', []);
    expect(result.status).toBe('committed');
    expect(lines(await sandbox.git(int.path, 'ls-tree', '-r', '--name-only', 'HEAD'))).toContain('docs.md');
  });

  it('does not look at files outside a merge: a handoff may contain such text', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'doc');
    await sandbox.adapter.createWorktree(ref, 'main');
    sandbox.write(ref.path, 'docs.md', '<<<<<<< ours\n=======\n>>>>>>> theirs\n');
    expect((await sandbox.adapter.commitAll(ref, 'docs about conflicts', [])).status).toBe('committed');
  });

  it('judges the staged content: a conflict staged unresolved, the working file fixed by hand, and the file left out of the add', async () => {
    const { int } = await conflicting();
    await sandbox.git(int.path, 'add', 'shared.txt'); // the index now holds the full conflict markers
    sandbox.write(int.path, 'shared.txt', 'resolved in the working file only\n');
    const result = await sandbox.adapter.commitAll(int, 'merge k2', ['shared.txt']); // excluded: the index is what would be committed
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringContaining('shared.txt') as unknown });
    expect((await sandbox.git(int.path, 'show', ':shared.txt')).includes('<<<<<<<')).toBe(true);
    expect((await sandbox.adapter.status(int)).merging).toBe(true);
    // Without the exclude the fixed file is added, and the commit goes through.
    expect((await sandbox.adapter.commitAll(int, 'merge k2', [])).status).toBe('committed');
  });

  it('pins the known trade-offs: a half-resolved file with one kind of marker is committed, a document showing both kinds is refused', async () => {
    const half = await conflicting();
    sandbox.write(half.int.path, 'shared.txt', 'mostly resolved\n<<<<<<< ours\n'); // the start marker was forgotten
    expect((await sandbox.adapter.commitAll(half.int, 'merge k2', [])).status).toBe('committed'); // known miss

    const doc = await conflicting();
    sandbox.write(doc.int.path, 'shared.txt', 'How a conflict looks:\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n');
    expect((await sandbox.adapter.commitAll(doc.int, 'merge k2', [])).status).toBe('failed'); // known false alarm

    const sized = await conflicting('shared.txt conflict-marker-size=9\n');
    sandbox.write(sized.int.path, 'shared.txt', 'How a conflict looks:\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n');
    expect((await sandbox.adapter.commitAll(sized.int, 'merge k2', [])).status).toBe('committed'); // the way out: a larger size
  });

  it('forgets the noted conflicts at abort, so a later merge is not judged by an old one', async () => {
    const { int } = await conflicting();
    expect((await sandbox.adapter.abortMerge(int)).status).toBe('aborted');
    sandbox.write(int.path, 'plain.txt', 'p\n');
    expect((await sandbox.adapter.commitAll(int, 'plain', [])).status).toBe('committed');
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

  it('says moved, not advanced, when the branch is moved past `to` just before the fast-forward (A→C asked as A→B)', async () => {
    const { repo, expected, to } = await ahead();
    // C is a child of B (`to`), made without touching any checkout.
    const later = (await sandbox.git(repo, 'commit-tree', `${to}^{tree}`, '-p', to, '-m', 'C')).trim();
    let moved = false;
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'merge' && args.includes('--ff-only') && !moved) {
        moved = true;
        await sandbox.git(repo, 'update-ref', 'refs/heads/main', later);
      }
    });
    expect(await racing.advanceBranch(repo, 'main', expected, to)).toEqual({ status: 'moved', current: later });
    expect(moved).toBe(true);
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(later);
  });

  it('reports a branch that was checked out between the look and the move, when that checkout was left behind', async () => {
    const { repo, expected, to } = await ahead();
    await sandbox.git(repo, 'branch', 'release', expected);
    const linked = join(sandbox.root, 'raced-release');
    let raced = false;
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'update-ref' && !raced) {
        raced = true;
        await sandbox.git(repo, 'worktree', 'add', '-q', linked, 'release'); // checked out at the old commit
      }
    });
    const result = await racing.advanceBranch(repo, 'release', expected, to);
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringContaining('raced-release') as unknown });
    expect((await sandbox.git(repo, 'rev-parse', 'release')).trim()).toBe(to); // the move itself cannot be undone safely
  });

  it('reports failed for any checkout found after the move, even one that came after it and is in step', async () => {
    const { repo, expected, to } = await ahead();
    await sandbox.git(repo, 'branch', 'release', expected);
    const linked = join(sandbox.root, 'late-release');
    let lists = 0;
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'list' && ++lists === 2) await sandbox.git(repo, 'worktree', 'add', '-q', linked, 'release');
    });
    expect(await racing.advanceBranch(repo, 'release', expected, to)).toMatchObject({ status: 'failed', detail: expect.stringContaining('late-release') as unknown });
    expect(existsSync(join(linked, 'one.txt'))).toBe(true); // that checkout is in step; the result still goes to root
  });

  it('does not call it an advance when only the ref was moved to `to` from outside and the checkout stayed behind', async () => {
    const { repo, expected, to } = await ahead();
    let moved = false;
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'merge' && args.includes('--ff-only') && !moved) {
        moved = true;
        await sandbox.git(repo, 'update-ref', 'refs/heads/main', to); // the ref only: index and files stay at `expected`
      }
    });
    const result = await racing.advanceBranch(repo, 'main', expected, to);
    expect(result).toMatchObject({ status: 'failed', detail: expect.stringContaining('checkout') as unknown });
    expect(moved).toBe(true);
  });

  it('leaves an untracked file alone: a fast-forward that would overwrite it is refused by git, nothing moves', async () => {
    const { repo, expected, to } = await ahead();
    writeFileSync(join(repo, 'one.txt'), 'my own one.txt\n'); // the commit being fast-forwarded to adds one.txt
    const result = await sandbox.adapter.advanceBranch(repo, 'main', expected, to);
    expect(result.status).toBe('refused');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(expected);
    expect(readFileSync(join(repo, 'one.txt'), 'utf8')).toBe('my own one.txt\n');
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

/** The merged task: its branch merged into main, as the pipeline's merge node leaves it. */
const mergeIntoMain = async (repo: string, ref: WorktreeRef): Promise<void> => {
  await sandbox.git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${ref.branch}`, ref.branch);
};

describe.concurrent('removeWorktree and retryCleanup', () => {
  it('removes the worktree, keeps the branch unless asked, and is repeatable', async () => {
    const repo = await sandbox.newRepo();
    const keep = await taskWith(repo, 'x1', 'x.txt', 'x\n');
    const drop = await taskWith(repo, 'x2', 'y.txt', 'y\n');
    await mergeIntoMain(repo, keep);
    await mergeIntoMain(repo, drop);

    expect(await sandbox.adapter.removeWorktree(keep, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(existsSync(keep.path)).toBe(false);
    expect(await isListed(repo, keep.path)).toBe(false);
    expect(await sandbox.adapter.resolveBranch(repo, keep.branch)).toBeDefined();

    expect(await sandbox.adapter.removeWorktree(drop, { deleteBranch: true })).toEqual({ status: 'removed' });
    expect(await sandbox.adapter.resolveBranch(repo, drop.branch)).toBeUndefined();
    await expect(sandbox.git(repo, 'config', '--get-regexp', `branch\\.${drop.branch}\\.`)).rejects.toThrow(); // the records go with the branch
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
    await mergeIntoMain(repo, ref);
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

  it('never deletes a branch the pipeline did not make for this worktree, whatever path is given (a never-created path, main)', async () => {
    const repo = await sandbox.newRepo();
    await sandbox.git(repo, 'checkout', '-q', '-b', 'other'); // main is now checked out nowhere, so git itself would delete it
    const before = (await sandbox.git(repo, 'rev-parse', 'main')).trim();

    const never: WorktreeRef = { repo, path: join(repo, 'never-created'), branch: 'main' };
    expect((await sandbox.adapter.removeWorktree(never, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect((await sandbox.adapter.retryCleanup(never, { deleteBranch: true })).status).toBe('pending-cleanup');
    const inAwg: WorktreeRef = { repo, path: worktreePath(repo, 'never-created'), branch: 'main' };
    expect((await sandbox.adapter.retryCleanup(inAwg, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect((await sandbox.git(repo, 'rev-parse', 'main')).trim()).toBe(before);

    // A branch someone made by hand, with a worktree by hand on the pipeline's path: not the pipeline's either.
    await sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'task/by-hand', worktreePath(repo, 'by-hand'), 'main');
    const byHand = sandbox.task(repo, 'by-hand');
    expect((await sandbox.adapter.removeWorktree(byHand, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(existsSync(byHand.path)).toBe(true);
    expect(await sandbox.adapter.resolveBranch(repo, 'task/by-hand')).toBeDefined();
  });

  it('refuses to delete the branch of a task whose commits are in no other branch, and keeps the worktree removal', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'u1', 'u.txt', 'u\n'); // never merged
    const result = await sandbox.adapter.removeWorktree(ref, { deleteBranch: true });
    expect(result).toMatchObject({ status: 'pending-cleanup', detail: expect.stringContaining('lose') as unknown });
    expect(existsSync(ref.path)).toBe(false); // the worktree itself is gone
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined();
    await mergeIntoMain(repo, ref);
    expect(await sandbox.adapter.removeWorktree(ref, { deleteBranch: true })).toEqual({ status: 'removed' });
  });

  describe('T043 G-6: the integration branch of an ended attempt', () => {
    /** A task branch with a commit and an integration branch that holds only the merge of it (a failed attempt). */
    const mergedAttempt = async (repo: string, name: string) => {
      const task = await taskWith(repo, `${name}t`, `${name}.txt`, `${name}\n`);
      const integ = await integration(repo, `${name}m`);
      expect((await sandbox.adapter.merge(integ, task.branch, `merge ${name}`)).status).toBe('merged');
      return { task, integ };
    };

    it('deletes a GUI-made branch whose only own commits are merge commits; the task branch and its commit stay', async () => {
      const repo = await sandbox.newRepo();
      const { task, integ } = await mergedAttempt(repo, 'g6a');
      const taskTip = (await sandbox.git(repo, 'rev-parse', task.branch)).trim();
      expect(await sandbox.adapter.removeWorktree(integ, { deleteBranch: true })).toEqual({ status: 'removed' });
      expect(existsSync(integ.path)).toBe(false);
      expect(await sandbox.adapter.resolveBranch(repo, integ.branch)).toBeUndefined();
      expect(await sandbox.adapter.resolveBranch(repo, task.branch)).toBe(taskTip);
      await expect(sandbox.git(repo, 'config', '--get-regexp', `branch\\.${integ.branch}\\.`)).rejects.toThrow(); // its records went with it
    });

    it('also when a conflict was resolved and committed in it', async () => {
      const repo = await sandbox.newRepo();
      const a = await taskWith(repo, 'g6ca', 'c.txt', 'a side\n');
      const b = await taskWith(repo, 'g6cb', 'c.txt', 'b side\n');
      const integ = await integration(repo, 'g6cm');
      expect((await sandbox.adapter.merge(integ, a.branch, 'merge a')).status).toBe('merged');
      expect((await sandbox.adapter.merge(integ, b.branch, 'merge b')).status).toBe('conflict');
      sandbox.write(integ.path, 'c.txt', 'both\n');
      expect((await sandbox.adapter.commitAll(integ, 'resolved', [])).status).toBe('committed');
      expect(await sandbox.adapter.removeWorktree(integ, { deleteBranch: true })).toEqual({ status: 'removed' });
      expect(await sandbox.adapter.resolveBranch(repo, integ.branch)).toBeUndefined();
      expect(await sandbox.adapter.resolveBranch(repo, a.branch)).toBeDefined();
      expect(await sandbox.adapter.resolveBranch(repo, b.branch)).toBeDefined();
    });

    it('keeps it when a commit of someone’s own work is on it alone, and when the worktree is held (pending, retry deletes it)', async () => {
      const repo = await sandbox.newRepo();
      const { integ } = await mergedAttempt(repo, 'g6b');
      sandbox.write(integ.path, 'hand.txt', 'by hand\n');
      expect((await sandbox.adapter.commitAll(integ, 'by hand', [])).status).toBe('committed'); // a plain commit on top
      const result = await sandbox.adapter.removeWorktree(integ, { deleteBranch: true });
      expect(result).toMatchObject({ status: 'pending-cleanup', detail: expect.stringContaining('lose') as unknown });
      expect(await sandbox.adapter.resolveBranch(repo, integ.branch)).toBeDefined();

      const held = await mergedAttempt(repo, 'g6h');
      const holder = await holdFolder(held.integ.path);
      expect((await sandbox.adapter.removeWorktree(held.integ, { deleteBranch: true })).status).toBe('pending-cleanup');
      expect(await sandbox.adapter.resolveBranch(repo, held.integ.branch)).toBeDefined();
      await holder.release();
      expect(await sandbox.adapter.retryCleanup(held.integ, { deleteBranch: true })).toEqual({ status: 'removed' });
      expect(await sandbox.adapter.resolveBranch(repo, held.integ.branch)).toBeUndefined();
    });

    it('never touches a branch the pipeline did not make, however much it looks like one', async () => {
      const repo = await sandbox.newRepo();
      const task = await taskWith(repo, 'g6ut', 'u.txt', 'u\n');
      // A user's branch, made by hand with a merge commit of its own, in a worktree of the pipeline's naming.
      await sandbox.git(repo, 'worktree', 'add', '-q', '-b', 'awg/m-user', worktreePath(repo, 'g6u'), 'main');
      await sandbox.git(worktreePath(repo, 'g6u'), 'merge', '--no-ff', '-q', '-m', 'users merge', task.branch);
      const mine = { repo, path: worktreePath(repo, 'g6u'), branch: 'awg/m-user' };
      expect((await sandbox.adapter.removeWorktree(mine, { deleteBranch: true })).status).toBe('pending-cleanup');
      expect(existsSync(mine.path)).toBe(true);
      expect(await sandbox.adapter.resolveBranch(repo, 'awg/m-user')).toBeDefined();
      // Nor a branch that exists with no worktree made by the adapter at all.
      await sandbox.git(repo, 'branch', 'awg/m-bare', task.branch);
      const bare = { repo, path: worktreePath(repo, 'g6bare'), branch: 'awg/m-bare' };
      expect((await sandbox.adapter.retryCleanup(bare, { deleteBranch: true })).status).toBe('pending-cleanup');
      expect(await sandbox.adapter.resolveBranch(repo, 'awg/m-bare')).toBeDefined();
    });
  });

  it('T043 G-8: a checkout that appears while the branch is being deleted gets the branch back', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'g8', 'g.txt', 'g\n');
    await mergeIntoMain(repo, ref);
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).status).toBe('removed');
    const tip = (await sandbox.git(repo, 'rev-parse', ref.branch)).trim();
    const elsewhere = join(sandbox.root, 'elsewhere-g8');
    let seen = 0;
    // The checkout happens right after the first look and before the delete: the delete's own look afterwards sees it.
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'update-ref' && args[1] === '-d') {
        seen += 1;
        await sandbox.git(repo, 'worktree', 'add', '-q', elsewhere, ref.branch);
      }
    });
    const result = await racing.retryCleanup(ref, { deleteBranch: true });
    expect(seen).toBe(1);
    expect(result).toMatchObject({ status: 'pending-cleanup', detail: expect.stringContaining('checked out') as unknown });
    expect((await sandbox.git(repo, 'rev-parse', ref.branch)).trim()).toBe(tip); // put back
    expect((await sandbox.git(elsewhere, 'rev-parse', 'HEAD')).trim()).toBe(tip);
    expect((await sandbox.git(repo, 'config', '--get', `branch.${ref.branch}.awgBranch`)).trim()).not.toBe(''); // still the pipeline's own
  });

  it('deletes nothing but one worktree folder: .awg\\wt itself, its other worktrees, or a path with extra parts are refused', async () => {
    const repo = await sandbox.newRepo();
    const a = await taskWith(repo, 'a', 'a.txt', 'a\n');
    const b = await taskWith(repo, 'b', 'b.txt', 'b\n');
    const parent = join(repo, '.awg', 'wt');
    for (const path of [parent, join(repo, '.awg'), join(parent, 'a', 'src'), join(parent, '..', 'wt'), join(parent, 'a', '..', 'b')]) {
      for (const run of [sandbox.adapter.retryCleanup.bind(sandbox.adapter), sandbox.adapter.removeWorktree.bind(sandbox.adapter)]) {
        expect((await run({ repo, path, branch: a.branch }, { deleteBranch: true })).status, path).toBe('pending-cleanup');
      }
    }
    expect(existsSync(join(a.path, 'a.txt')) && existsSync(join(b.path, 'b.txt'))).toBe(true);
    expect((await sandbox.adapter.createWorktree({ repo, path: join(parent, 'x', 'y'), branch: 'task/xy' }, 'main')).status).toBe('failed');
    expect(() => worktreePath(repo, '..')).toThrow();
    expect(() => worktreePath(repo, 'a/b')).toThrow();
    expect(() => worktreePath(repo, 'a\\b')).toThrow();
    expect(() => worktreePath(repo, 'nul')).toThrow();
    expect(() => worktreePath(repo, '')).toThrow();
  });

  it('does not follow a link standing where a left-over folder was', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'j1', 'j.txt', 'j\n');
    rmSync(ref.path, { recursive: true, force: true });
    await sandbox.git(repo, 'worktree', 'prune');
    const outside = join(sandbox.root, 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'precious.txt'), 'keep\n');
    symlinkSync(outside, ref.path, 'junction');

    const result = await sandbox.adapter.retryCleanup(ref, { deleteBranch: false });
    expect(result.status).toBe('pending-cleanup');
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep\n');
  });

  it('withdraws the permission to touch the folder once it is gone: what appears there later is never deleted', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'w2', 'w.txt', 'w\n');
    expect(await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).toEqual({ status: 'removed' });
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined(); // the branch stays, with its own record

    mkdirSync(ref.path, { recursive: true }); // the user's own folder, same path
    writeFileSync(join(ref.path, 'mine.txt'), 'user data\n');
    for (const run of [sandbox.adapter.retryCleanup.bind(sandbox.adapter), sandbox.adapter.removeWorktree.bind(sandbox.adapter)]) {
      expect((await run(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    }
    expect(readFileSync(join(ref.path, 'mine.txt'), 'utf8')).toBe('user data\n');

    rmSync(ref.path, { recursive: true, force: true }); // with the folder gone again the branch can still be dealt with
    await mergeIntoMain(repo, ref);
    expect(await sandbox.adapter.removeWorktree(ref, { deleteBranch: true })).toEqual({ status: 'removed' });
  });

  it('records the folder’s identity before asking git to remove it, and drops the record when the folder is gone', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'w3', 'w.txt', 'w\n');
    const holder = await holdFolder(ref.path);
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    expect((await sandbox.git(repo, 'config', '--get', `branch.${ref.branch}.awgLeftover`)).trim()).toMatch(/^\d+:\d+$/);
    await holder.release();
    expect(await sandbox.adapter.retryCleanup(ref, { deleteBranch: false })).toEqual({ status: 'removed' });
    await expect(sandbox.git(repo, 'config', '--get', `branch.${ref.branch}.awgLeftover`)).rejects.toThrow();
  });

  it('never deletes a folder made later at the path of a removed worktree, even when the step after the removal failed (r3 P1-1)', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'w4', 'w.txt', 'w\n');
    // The removal succeeds, then withdrawing the record fails: the record is still there when the user comes.
    const failing = sandbox.hooked(
      () => Promise.resolve(),
      (args, result) => (args.includes('--unset-all') && args.some((a) => a.endsWith('.awgLeftover')) ? { ...result, code: 1, stderr: 'config is locked' } : undefined),
    );
    expect((await failing.removeWorktree(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    expect(existsSync(ref.path)).toBe(false);

    mkdirSync(ref.path, { recursive: true });
    writeFileSync(join(ref.path, 'mine.txt'), 'user data\n');
    expect((await sandbox.adapter.retryCleanup(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    expect(readFileSync(join(ref.path, 'mine.txt'), 'utf8')).toBe('user data\n');

    // Also when the folder the record named was held, then replaced by the user's own.
    const held = await taskWith(repo, 'w5', 'w.txt', 'w\n');
    const holder = await holdFolder(held.path);
    expect((await sandbox.adapter.removeWorktree(held, { deleteBranch: false })).status).toBe('pending-cleanup');
    await holder.release();
    rmSync(held.path, { recursive: true, force: true });
    mkdirSync(held.path, { recursive: true });
    writeFileSync(join(held.path, 'mine.txt'), 'user data 2\n');
    expect((await sandbox.adapter.retryCleanup(held, { deleteBranch: false })).status).toBe('pending-cleanup');
    expect(readFileSync(join(held.path, 'mine.txt'), 'utf8')).toBe('user data 2\n');
  });

  it('keeps a branch that was moved to an unmerged commit after it was checked, instead of deleting it', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'd1', 'd.txt', 'd\n');
    await mergeIntoMain(repo, ref);
    const tip = (await sandbox.git(repo, 'rev-parse', ref.branch)).trim();
    const extra = (await sandbox.git(repo, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'unmerged work')).trim();
    let moved = false;
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'update-ref' && args[1] === '-d' && !moved) {
        moved = true;
        await sandbox.git(repo, 'update-ref', `refs/heads/${ref.branch}`, extra);
      }
    });
    const result = await racing.removeWorktree(ref, { deleteBranch: true });
    expect(result).toMatchObject({ status: 'pending-cleanup', detail: expect.stringContaining('kept') as unknown });
    expect(moved).toBe(true);
    expect((await sandbox.git(repo, 'rev-parse', ref.branch)).trim()).toBe(extra);
  });

  it('refuses to delete a branch that is checked out in another worktree', async () => {
    const repo = await sandbox.newRepo();
    const ref = await taskWith(repo, 'd2', 'd.txt', 'd\n');
    await mergeIntoMain(repo, ref);
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).status).toBe('removed');
    await sandbox.git(repo, 'worktree', 'add', '-q', join(sandbox.root, 'elsewhere-d2'), ref.branch);
    const result = await sandbox.adapter.removeWorktree(ref, { deleteBranch: true });
    expect(result).toMatchObject({ status: 'pending-cleanup', detail: expect.stringContaining('checked out') as unknown });
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined();
  });
});

describe.concurrent('createWorktree: intent, ownership and interruptions', () => {
  it('takes up again a worktree it made (its token is in the worktree’s admin folder), and can clean it up', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr1');
    const tip = (await sandbox.git(repo, 'rev-parse', 'main')).trim();
    expect(await sandbox.adapter.createWorktree(ref, 'main')).toEqual({ status: 'created', baseCommit: tip });
    expect(await sandbox.adapter.createWorktree(ref, 'main')).toEqual({ status: 'exists', baseCommit: tip });
    await expect(sandbox.git(repo, 'config', '--get', `branch.${ref.branch}.awgIntent`)).rejects.toThrow(); // the intent is gone once it is done
    expect(await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).toEqual({ status: 'removed' });
  });

  it('does not claim a worktree it has no token for, whoever made it', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr2');
    await sandbox.git(repo, 'worktree', 'add', '-q', '-b', ref.branch, ref.path, 'main');
    expect((await sandbox.adapter.createWorktree(ref, 'main')).status).toBe('failed');
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(existsSync(ref.path)).toBe(true);
  });

  it('does not take a user’s own worktree for its own after an interruption before `worktree add` (r3 P1-2)', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr4');
    // The intent is written, then the process dies before git is asked.
    const crashing = sandbox.hooked((args) => (args[0] === 'worktree' && args[1] === 'add' ? Promise.reject(new Error('crash')) : Promise.resolve()));
    await expect(crashing.createWorktree(ref, 'main')).rejects.toThrow('crash');
    expect((await sandbox.git(repo, 'config', '--get', `branch.${ref.branch}.awgIntent`)).trim()).toContain('|'); // token|path

    // The user makes the same branch, path and base by hand, with work in it.
    await sandbox.git(repo, 'worktree', 'add', '-q', '-b', ref.branch, ref.path, 'main');
    writeFileSync(join(ref.path, 'uncommitted.txt'), 'user work\n');

    expect(await sandbox.adapter.createWorktree(ref, 'main')).toMatchObject({ status: 'failed' });
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect((await sandbox.adapter.retryCleanup(ref, { deleteBranch: true })).status).toBe('pending-cleanup');
    expect(readFileSync(join(ref.path, 'uncommitted.txt'), 'utf8')).toBe('user work\n');
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined();
  });

  it('does not claim a worktree it made if the process died before the token was written (it stays, for the user)', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr5');
    const crashing = sandbox.hooked((args) => (args[0] === 'rev-parse' && args[1] === '--git-common-dir' ? Promise.reject(new Error('crash')) : Promise.resolve()));
    await expect(crashing.createWorktree(ref, 'main')).rejects.toThrow('crash'); // right after `worktree add`
    expect(existsSync(ref.path)).toBe(true);
    expect((await sandbox.adapter.createWorktree(ref, 'main')).status).toBe('failed');
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: false })).status).toBe('pending-cleanup');
    expect(existsSync(ref.path)).toBe(true);
  });

  it('keeps a branch made by somebody else while `worktree add` was running, and only withdraws its own intent (r3 P1-3)', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr6');
    const racing = sandbox.hooked(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add') await sandbox.git(repo, 'branch', ref.branch, 'main'); // same name, same base, made just now
    });
    expect((await racing.createWorktree(ref, 'main')).status).toBe('failed');
    expect(await sandbox.adapter.resolveBranch(repo, ref.branch)).toBeDefined(); // not deleted
    await expect(sandbox.git(repo, 'config', '--get-regexp', `branch\\.${ref.branch}\\.awg`)).rejects.toThrow(); // no record of ours left
    expect(existsSync(ref.path)).toBe(false);
  });

  it('leaves no record behind when git refuses the folder; the branch git left stays for the user and is never claimed', async () => {
    const repo = await sandbox.newRepo();
    const ref = sandbox.task(repo, 'cr3');
    mkdirSync(ref.path, { recursive: true });
    writeFileSync(join(ref.path, 'in-the-way.txt'), 'x\n'); // git will not use a folder that is not empty
    expect((await sandbox.adapter.createWorktree(ref, 'main')).status).toBe('failed');
    await expect(sandbox.git(repo, 'config', '--get-regexp', `branch\\.${ref.branch}\\.awg`)).rejects.toThrow();
    expect(readFileSync(join(ref.path, 'in-the-way.txt'), 'utf8')).toBe('x\n');
    expect((await sandbox.adapter.removeWorktree(ref, { deleteBranch: true })).status).toBe('pending-cleanup'); // not ours: kept
    expect(readFileSync(join(ref.path, 'in-the-way.txt'), 'utf8')).toBe('x\n');
  });
});

describe.concurrent('conflict checks that cannot read the staged content', () => {
  const conflicting = async () => {
    const repo = await sandbox.newRepo();
    await sandbox.commitFile(repo, 'shared.txt', 'base\n');
    const a = await taskWith(repo, 'e1', 'shared.txt', 'from e1\n');
    const b = await taskWith(repo, 'e2', 'shared.txt', 'from e2\n');
    const int = await integration(repo);
    await sandbox.adapter.merge(int, a.branch, 'merge e1');
    expect((await sandbox.adapter.merge(int, b.branch, 'merge e2')).status).toBe('conflict');
    return { repo, int };
  };

  it('fails, committing nothing, when the staged blob cannot be read or the output was cut', async () => {
    for (const broken of [{ code: 128, stderr: 'fatal: bad object' }, { code: 0, stdout: '', truncated: true }]) {
      const { int } = await conflicting();
      const head = (await sandbox.adapter.status(int)).head;
      const adapter = sandbox.hooked(
        () => Promise.resolve(),
        (args, result) => (args[0] === 'cat-file' ? { ...result, ...broken } : undefined),
      );
      const result = await adapter.commitAll(int, 'merge e2', []);
      expect(result).toMatchObject({ status: 'failed', detail: expect.stringContaining('shared.txt') as unknown });
      expect((await sandbox.adapter.status(int)).head).toBe(head);
    }
  });
});

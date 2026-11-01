// T033 (G8 ruling): the unlocked-write check skips what git ignores, from rules read once per folder.
import { describe, expect, it } from 'vitest';
import { GitIgnoreRules, parseGitignore } from './git-ignore';

const REPO = 'e:\\work';

const rules = (files: Record<string, string>) => {
  const reads: string[] = [];
  const read = (path: string) => {
    reads.push(path.toLowerCase());
    return files[path.toLowerCase()];
  };
  return { ignore: new GitIgnoreRules(read, (folder) => folder.toLowerCase() === REPO), reads };
};

describe('GitIgnoreRules', () => {
  it('ignores build output, node_modules and globs, with negation and anchoring', () => {
    const { ignore } = rules({
      'e:\\work\\.gitignore': '# output\nnode_modules/\n/out\n*.log\n!keep.log\ndocs/**/*.tmp\nbuild/\n',
    });
    expect(ignore.isIgnored('E:\\work\\node_modules\\pkg\\index.js')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\app\\node_modules\\x.js')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\out\\main.js')).toBe(true);
    // Anchored: only the root's out.
    expect(ignore.isIgnored('E:\\work\\src\\out\\a.ts')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\src\\debug.log')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\src\\keep.log')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\docs\\a\\b\\x.tmp')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\docs\\x.tmp')).toBe(true);
    // `build/` is a folder rule: a file named build is not ignored.
    expect(ignore.isIgnored('E:\\work\\build')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\build\\x.js')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\shared.txt')).toBe(false);
  });

  it('lets a deeper .gitignore decide later, and info/exclude count too', () => {
    const { ignore } = rules({
      'e:\\work\\.gitignore': '*.gen\n',
      'e:\\work\\pkg\\.gitignore': '!api.gen\nlocal/\n',
      'e:\\work\\.git\\info\\exclude': 'scratch.txt\n',
    });
    expect(ignore.isIgnored('E:\\work\\a.gen')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\pkg\\api.gen')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\pkg\\local\\x.txt')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\local\\x.txt')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\sub\\scratch.txt')).toBe(true);
  });

  it('reads each .gitignore once, and again only after the watcher saw it change', () => {
    const files: Record<string, string> = { 'e:\\work\\.gitignore': 'dist/\n' };
    const { ignore, reads } = rules(files);
    expect(ignore.isIgnored('E:\\work\\dist\\a.js')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\dist\\b.js')).toBe(true);
    expect(reads.filter((r) => r === 'e:\\work\\.gitignore')).toHaveLength(1);
    files['e:\\work\\.gitignore'] = '';
    expect(ignore.isIgnored('E:\\work\\dist\\a.js')).toBe(true);
    ignore.changed('E:\\work\\.gitignore');
    expect(ignore.isIgnored('E:\\work\\dist\\a.js')).toBe(false);
  });

  it('ignores nothing outside a repository', () => {
    const { ignore } = rules({});
    expect(ignore.isIgnored('D:\\elsewhere\\node_modules\\x.js')).toBe(false);
  });

  it('parses comments, blank lines and escapes', () => {
    expect(parseGitignore('\n# c\n\\#notcomment\n')).toHaveLength(1);
    expect(parseGitignore('\\#notcomment')[0]!.regex.test('#notcomment')).toBe(true);
  });
});

describe('review r1', () => {
  it('P1-4 a pattern that cannot be compiled ([z-a]) is left out with one warning, never thrown', () => {
    let bad = 0;
    expect(() => parseGitignore('[z-a]\n*.log\n', () => bad++)).not.toThrow();
    expect(bad).toBe(1);
    const logs: string[] = [];
    const ignore = new GitIgnoreRules(
      (path) => (path.toLowerCase() === 'e:\\work\\.gitignore' ? '[z-a]\n*.log\n' : undefined),
      (folder) => folder.toLowerCase() === REPO,
      (m) => logs.push(m),
      () => ({ close: () => undefined }),
    );
    expect(ignore.isIgnored('E:\\work\\z.txt')).toBe(false);
    expect(ignore.isIgnored('E:\\work\\a.log')).toBe(true);
    expect(ignore.isIgnored('E:\\work\\b.txt')).toBe(false);
    // Read once, so said once.
    expect(logs).toHaveLength(1);
  });

  it('P1-4 a reader that throws ignores nothing and does not throw', () => {
    const ignore = new GitIgnoreRules(
      () => {
        throw new Error('EACCES');
      },
      () => true,
      () => undefined,
    );
    expect(() => ignore.isIgnored('E:\\work\\a.txt')).not.toThrow();
    expect(ignore.isIgnored('E:\\work\\a.txt')).toBe(false);
  });

  it("P1-9 a linked worktree uses the common git dir's info/exclude", () => {
    const files: Record<string, string> = {
      'e:\\wt\\one\\.git': 'gitdir: E:/main/.git/worktrees/one\n',
      'e:\\main\\.git\\worktrees\\one\\commondir': '../..\n',
      'e:\\main\\.git\\info\\exclude': 'scratch/\n',
    };
    const ignore = new GitIgnoreRules((path) => files[path.toLowerCase()], (folder) => folder.toLowerCase() === 'e:\\wt\\one');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
    expect(ignore.isIgnored('E:\\wt\\one\\src\\x.txt')).toBe(false);
    // The common exclude changes: read again.
    files['e:\\main\\.git\\info\\exclude'] = '';
    ignore.changed('E:\\main\\.git\\info\\exclude');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(false);
  });
});

describe('review r2', () => {
  it('P2 a change of the common info/exclude, outside the workspace, is seen by its own watch', () => {
    const files: Record<string, string> = {
      'e:\\wt\\one\\.git': 'gitdir: E:/main/.git/worktrees/one\n',
      'e:\\main\\.git\\worktrees\\one\\commondir': '../..\n',
      'e:\\main\\.git\\info\\exclude': 'scratch/\n',
    };
    const watched: { folder: string; onChange: (filename: string | null) => void; closed: boolean }[] = [];
    const ignore = new GitIgnoreRules(
      (path) => files[path.toLowerCase()],
      (folder) => folder.toLowerCase() === 'e:\\wt\\one',
      () => undefined,
      (folder, onChange) => {
        const entry = { folder, onChange, closed: false };
        watched.push(entry);
        return { close: () => (entry.closed = true) };
      },
    );
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
    expect(watched.map((w) => w.folder.toLowerCase())).toEqual(['e:\\main\\.git\\info']);
    files['e:\\main\\.git\\info\\exclude'] = '';
    // Another file in that folder changes nothing; the exclude does.
    watched[0]!.onChange('attributes');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
    watched[0]!.onChange('exclude');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(false);
    // One watch per folder, closed on exit.
    expect(watched).toHaveLength(1);
    ignore.close();
    expect(watched[0]!.closed).toBe(true);
  });
});

describe('T043 the info watch lives while a session uses it', () => {
  const linked = (): Record<string, string> => ({
    'e:\\wt\\one\\.git': 'gitdir: E:/main/.git/worktrees/one\n',
    'e:\\main\\.git\\worktrees\\one\\commondir': '../..\n',
    'e:\\wt\\two\\.git': 'gitdir: E:/main/.git/worktrees/two\n',
    'e:\\main\\.git\\worktrees\\two\\commondir': '../..\n',
    'e:\\main\\.git\\info\\exclude': 'scratch/\n',
  });
  const make = (files: Record<string, string>) => {
    const watched: { folder: string; closed: boolean }[] = [];
    const ignore = new GitIgnoreRules(
      (path) => files[path.toLowerCase()],
      (folder) => ['e:\\wt\\one', 'e:\\wt\\two', 'e:\\other'].includes(folder.toLowerCase()),
      () => undefined,
      (folder) => {
        const entry = { folder, closed: false };
        watched.push(entry);
        return { close: () => (entry.closed = true) };
      },
    );
    return { ignore, watched };
  };

  it('is closed when the last session of the repository leaves, and made again (with the rules read again) when one comes back', () => {
    const files = linked();
    const { ignore, watched } = make(files);
    ignore.acquire('s1', 'E:\\wt\\one');
    ignore.acquire('s2', 'E:\\wt\\two');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
    expect(ignore.isIgnored('E:\\wt\\two\\scratch\\x.txt')).toBe(true);
    expect(watched).toHaveLength(1); // one watch for the shared info folder

    ignore.release('s1');
    expect(watched[0]!.closed).toBe(false); // wt\two still uses it
    ignore.release('s2');
    expect(watched[0]!.closed).toBe(true);

    // Nobody watches the exclude now, so what was cached is not trusted: it is read again, and watched again.
    files['e:\\main\\.git\\info\\exclude'] = '';
    ignore.acquire('s3', 'E:\\wt\\one');
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(false);
    expect(watched).toHaveLength(2);
    expect(watched[1]!.closed).toBe(false);
    ignore.release('s3');
    expect(watched[1]!.closed).toBe(true);
  });

  it('several sessions in one workspace keep it until the last leaves; starting or stopping twice accumulates nothing', () => {
    const { ignore, watched } = make(linked());
    ignore.acquire('a', 'E:\\wt\\one');
    ignore.acquire('a', 'E:\\wt\\one'); // the same session again
    ignore.acquire('b', 'e:/wt/one/'); // another session, the same folder written differently
    expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
    ignore.release('a');
    ignore.release('a'); // twice
    ignore.release('never-started');
    expect(watched[0]!.closed).toBe(false);
    ignore.release('b');
    expect(watched[0]!.closed).toBe(true);
    // Round after round leaves nothing open.
    for (let i = 0; i < 5; i++) {
      ignore.acquire('c', 'E:\\wt\\one');
      expect(ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt')).toBe(true);
      ignore.release('c');
    }
    expect(watched.filter((w) => !w.closed)).toHaveLength(0);
    expect(watched).toHaveLength(6);
  });

  it('a repository read for no session is left alone by other sessions leaving, and is closed with the app', () => {
    const files = { ...linked(), 'e:\\other\\.git\\info\\exclude': 'tmp/\n' };
    const { ignore, watched } = make(files);
    ignore.isIgnored('E:\\other\\tmp\\y.txt'); // no session acquired it
    ignore.acquire('s1', 'E:\\wt\\one');
    ignore.isIgnored('E:\\wt\\one\\scratch\\x.txt');
    expect(watched).toHaveLength(2);
    ignore.release('s1');
    expect(watched.map((w) => w.closed)).toEqual([false, true]);
    ignore.close();
    expect(watched.map((w) => w.closed)).toEqual([true, true]);
  });
});

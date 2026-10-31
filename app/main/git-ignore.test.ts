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

// Which changed paths git ignores (T033, main session's G8 ruling): build output, node_modules and the like
// are nobody's work on a file, so the folder watcher's unlocked-write check skips them. Cheap on purpose:
// each folder's `.gitignore` (and the repository's `.git\info\exclude`) is read once and kept until the
// watcher reports a change of it; no `git check-ignore` is run.
//
// Supported: the `.gitignore` files from the repository root down to the file's folder and `info/exclude`,
// with comments, `!` negation, leading / middle `/` anchoring, trailing `/` for folders, `*`, `?`, `**` and
// `[...]`, case-insensitive like git on Windows. Not read: the global excludes file (`core.excludesFile`).
import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/** Glob text → regex source, `/` separated (git's wildmatch, enough for .gitignore). */
const globSource = (glob: string): string => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        // `**/` any folders (or none), a trailing `**` everything below.
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) out += `\\${glob[++i]!}`;
    else out += c.replace(/[.+^${}()|]/g, '\\$&');
  }
  return out;
};

export const parseGitignore = (text: string): Rule[] => {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (line === '') continue;
    // A slash at the start or in the middle anchors the pattern to the .gitignore's folder.
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const source = globSource(line);
    rules.push({ negate, dirOnly, regex: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`, 'i') });
  }
  return rules;
};

/** The last rule that matches decides; undefined when none does. */
const decide = (rules: readonly Rule[], relative: string, isDir: boolean): boolean | undefined => {
  let result: boolean | undefined;
  for (const rule of rules) if ((!rule.dirOnly || isDir) && rule.regex.test(relative)) result = !rule.negate;
  return result;
};

const key = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

export class GitIgnoreRules {
  /** Rules of each folder's `.gitignore` by folder key; an empty list when it has none. */
  private readonly folders = new Map<string, Rule[]>();
  /** The repository root of each folder asked about (null: not in a repository). */
  private readonly roots = new Map<string, string | null>();

  constructor(
    private readonly read: (path: string) => string | undefined = (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    private readonly isRepoRoot: (folder: string) => boolean = (folder) => {
      try {
        statSync(win32.join(folder, '.git'));
        return true;
      } catch {
        return false;
      }
    },
  ) {}

  /** Whether git ignores the file `path` (absolute): the file, or a folder above it inside its repository. */
  isIgnored(path: string): boolean {
    const file = key(path);
    const root = this.repoRoot(win32.dirname(file));
    if (root === null || file === root) return false;
    const parts = file.slice(root.length + 1).split('\\');
    // Each folder on the way down: once one is ignored, nothing below it comes back (git's rule).
    for (let i = 1; i <= parts.length; i++) {
      const isDir = i < parts.length;
      if (this.matches(root, parts.slice(0, i), isDir)) return true;
    }
    return false;
  }

  /** The watcher saw `path` change: a `.gitignore` or `info/exclude` is read again on its next use. */
  changed(path: string): void {
    const file = key(path);
    if (win32.basename(file) === '.gitignore') this.folders.delete(win32.dirname(file));
    if (file.endsWith('\\.git\\info\\exclude')) this.folders.delete(`${file}#exclude`);
    // A repository made or removed below a folder changes where roots are.
    if (win32.basename(file) === '.git') this.roots.clear();
  }

  private matches(root: string, parts: string[], isDir: boolean): boolean {
    let result = decide(this.excludeOf(root), parts.join('/'), isDir);
    // From the root's .gitignore down to the folder holding this entry; deeper files decide later.
    for (let depth = 0; depth < parts.length; depth++) {
      const folder = depth === 0 ? root : `${root}\\${parts.slice(0, depth).join('\\')}`;
      const decided = decide(this.rulesOf(folder), parts.slice(depth).join('/'), isDir);
      if (decided !== undefined) result = decided;
    }
    return result === true;
  }

  private rulesOf(folder: string): Rule[] {
    let rules = this.folders.get(folder);
    if (rules === undefined) {
      rules = parseGitignore(this.read(`${folder}\\.gitignore`) ?? '');
      this.folders.set(folder, rules);
    }
    return rules;
  }

  private excludeOf(root: string): Rule[] {
    const cacheKey = `${root}\\.git\\info\\exclude#exclude`;
    let rules = this.folders.get(cacheKey);
    if (rules === undefined) {
      rules = parseGitignore(this.read(`${root}\\.git\\info\\exclude`) ?? '');
      this.folders.set(cacheKey, rules);
    }
    return rules;
  }

  private repoRoot(folder: string): string | null {
    const known = this.roots.get(folder);
    if (known !== undefined) return known;
    const parent = win32.dirname(folder);
    const root = this.isRepoRoot(folder) ? folder : parent === folder ? null : this.repoRoot(parent);
    this.roots.set(folder, root);
    return root;
  }
}

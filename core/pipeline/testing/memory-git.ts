// A GitPort in memory (T032 tests): commits, branches, worktrees with their files, three-way merges with
// conflict markers, the fast-forward rules of `advanceBranch` and cleanups that a held folder makes pending,
// as the T030 adapter behaves. `hang` stops a call forever before or after its effect (a crash there);
// `failNext` makes one call fail as git would.
import type { AdvanceResult, CleanupResult, CommitResult, CreateWorktreeResult, GitFailure, GitPort, MergeResult, WorktreeRef, WorktreeStatus } from '../../ports';

interface Commit {
  id: string;
  parents: string[];
  files: Map<string, string>;
  message: string;
}

interface Tree {
  repo: string;
  path: string;
  branch: string;
  files: Map<string, string>;
  /** The files git was told about (`add`) during a merge: no longer unmerged. */
  staged: Set<string>;
  merging?: { theirs: string; conflicts: string[] } | undefined;
  main: boolean;
}

type Op = keyof GitPort;

const key = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
const START = '<<<<<<<';
const END = '>>>>>>>';
const hasMarkers = (text: string | undefined) => text !== undefined && text.includes(START) && text.includes(END);

export class MemoryGit implements GitPort {
  readonly commits = new Map<string, Commit>();
  /** Branch tips by `repo|branch`. */
  readonly branches = new Map<string, string>();
  readonly trees = new Map<string, Tree>();
  /** Folders that exist (worktrees, and what a failed removal left). */
  readonly folders = new Set<string>();
  /** Folders a process holds: removing them leaves them pending. */
  readonly locked = new Set<string>();
  readonly calls: { op: Op; args: unknown[] }[] = [];
  private seq = 0;
  private hangs: { op: Op; when: 'before' | 'after'; match: (args: unknown[]) => boolean }[] = [];
  private fails: { op: Op; detail: string }[] = [];

  /** A repository with one commit on `branch`, checked out in its folder. */
  init(repo: string, files: Record<string, string>, branch = 'main'): string {
    const id = this.commit([], new Map(Object.entries(files)), 'initial');
    this.branches.set(`${key(repo)}|${branch}`, id);
    this.trees.set(key(repo), { repo, path: repo, branch, files: new Map(Object.entries(files)), staged: new Set(), main: true });
    this.folders.add(key(repo));
    return id;
  }

  hang(op: Op, when: 'before' | 'after' = 'before', match: (args: unknown[]) => boolean = () => true): void {
    this.hangs.push({ op, when, match });
  }

  failNext(op: Op, detail: string): void {
    this.fails.push({ op, detail });
  }

  tip(repo: string, branch: string): string | undefined {
    return this.branches.get(`${key(repo)}|${branch}`);
  }

  fileAt(commit: string | undefined, file: string): string | undefined {
    return commit === undefined ? undefined : this.commits.get(commit)?.files.get(file);
  }

  tree(path: string): Tree | undefined {
    return this.trees.get(key(path));
  }

  /** The files of the commit a checkout has checked out. */
  headFiles(path: string): Map<string, string> {
    const tree = this.trees.get(key(path));
    if (tree === undefined) throw new Error(`no checkout at ${path}`);
    return this.filesOf(this.headOf(tree));
  }

  /** An agent (or anyone) writes a file in a checkout; `add` stages it as `git add` would during a merge. */
  write(path: string, file: string, content: string | undefined, add = false): void {
    const tree = this.trees.get(key(path));
    if (tree === undefined) throw new Error(`no checkout at ${path}`);
    if (content === undefined) tree.files.delete(file);
    else tree.files.set(file, content);
    if (add) tree.staged.add(file);
  }

  /** Someone else commits on a branch directly (the target moving meanwhile). */
  commitOn(repo: string, branch: string, files: Record<string, string>, message = 'outside'): string {
    const tip = this.tip(repo, branch);
    const base = tip === undefined ? new Map<string, string>() : new Map(this.commits.get(tip)?.files);
    for (const [f, c] of Object.entries(files)) base.set(f, c);
    const id = this.commit(tip === undefined ? [] : [tip], base, message);
    this.branches.set(`${key(repo)}|${branch}`, id);
    for (const tree of this.trees.values()) if (key(tree.repo) === key(repo) && tree.branch === branch) tree.files = new Map(base);
    return id;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(this.commits.get(id)?.parents ?? []));
    }
    return false;
  }

  private commit(parents: string[], files: Map<string, string>, message: string): string {
    const id = `c${String(++this.seq).padStart(4, '0')}`;
    this.commits.set(id, { id, parents, files: new Map(files), message });
    return id;
  }

  private async call<T>(op: Op, args: unknown[], run: () => T): Promise<T> {
    this.calls.push({ op, args });
    await Promise.resolve();
    const before = this.hangs.findIndex((h) => h.op === op && h.when === 'before' && h.match(args));
    if (before >= 0) {
      this.hangs.splice(before, 1);
      return new Promise<T>(() => undefined);
    }
    const failing = this.fails.findIndex((f) => f.op === op);
    if (failing >= 0) {
      const [f] = this.fails.splice(failing, 1);
      return { status: 'failed', detail: f?.detail ?? 'failed' } as T;
    }
    const result = run();
    const after = this.hangs.findIndex((h) => h.op === op && h.when === 'after' && h.match(args));
    if (after >= 0) {
      this.hangs.splice(after, 1);
      return new Promise<T>(() => undefined);
    }
    return result;
  }

  private headOf(tree: Tree): string {
    const tip = this.tip(tree.repo, tree.branch);
    if (tip === undefined) throw new Error(`no branch ${tree.branch}`);
    return tip;
  }

  private filesOf(commit: string): Map<string, string> {
    return new Map(this.commits.get(commit)?.files);
  }

  private dirty(tree: Tree): boolean {
    const head = this.filesOf(this.headOf(tree));
    if (head.size !== tree.files.size) return true;
    for (const [f, c] of tree.files) if (head.get(f) !== c) return true;
    return false;
  }

  private mergeBase(a: string, b: string): string | undefined {
    const ancestors = (id: string) => {
      const seen = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (seen.has(x)) continue;
        seen.add(x);
        stack.push(...(this.commits.get(x)?.parents ?? []));
      }
      return seen;
    };
    const of = ancestors(a);
    const common = [...ancestors(b)].filter((x) => of.has(x));
    return common.find((c) => !common.some((d) => d !== c && this.isAncestor(c, d)));
  }

  resolveBranch(repo: string, branch: string): Promise<string | undefined> {
    return this.call('resolveBranch', [repo, branch], () => this.tip(repo, branch));
  }

  createWorktree(worktree: WorktreeRef, base: string): Promise<CreateWorktreeResult> {
    return this.call('createWorktree', [worktree, base], (): CreateWorktreeResult => {
      const baseCommit = this.commits.has(base) ? base : this.tip(worktree.repo, base);
      if (baseCommit === undefined) return { status: 'failed', detail: `The base commit ${base} was not found` };
      const existing = this.trees.get(key(worktree.path));
      const tip = this.tip(worktree.repo, worktree.branch);
      if (existing !== undefined) {
        if (existing.branch === worktree.branch && !existing.main && tip !== undefined && this.isAncestor(baseCommit, tip)) return { status: 'exists', baseCommit };
        return { status: 'failed', detail: `${worktree.path} is already a worktree for another branch or another base` };
      }
      if (tip !== undefined) return { status: 'failed', detail: `The branch ${worktree.branch} already exists` };
      if (this.folders.has(key(worktree.path))) return { status: 'failed', detail: `${worktree.path} already exists` };
      this.branches.set(`${key(worktree.repo)}|${worktree.branch}`, baseCommit);
      this.trees.set(key(worktree.path), { repo: worktree.repo, path: worktree.path, branch: worktree.branch, files: this.filesOf(baseCommit), staged: new Set(), main: false });
      this.folders.add(key(worktree.path));
      return { status: 'created', baseCommit };
    });
  }

  commitAll(worktree: WorktreeRef, message: string, exclude: readonly string[]): Promise<CommitResult> {
    return this.call('commitAll', [worktree, message, exclude], (): CommitResult => {
      const tree = this.trees.get(key(worktree.path));
      if (tree === undefined || tree.branch !== worktree.branch) return { status: 'failed', detail: `${worktree.path} is not a worktree of ${worktree.branch}` };
      const head = this.headOf(tree);
      const headFiles = this.filesOf(head);
      const specs = exclude.map((e) => e.replace(/^:\(literal\)/, ''));
      const excluded = (file: string) => specs.some((e) => file === e || file.startsWith(`${e}/`));
      const next = new Map<string, string>();
      for (const [f, c] of tree.files) if (!excluded(f)) next.set(f, c);
      for (const [f, c] of headFiles) if (excluded(f)) next.set(f, c);
      if (tree.merging !== undefined) {
        const unresolved = tree.merging.conflicts.filter((f) => hasMarkers(next.get(f)));
        if (unresolved.length > 0) return { status: 'failed', detail: `Conflict markers are still in: ${unresolved.join(', ')}` };
        const id = this.commit([head, tree.merging.theirs], next, message);
        this.branches.set(`${key(tree.repo)}|${tree.branch}`, id);
        tree.merging = undefined;
        tree.staged.clear();
        return { status: 'committed', commit: id };
      }
      const same = next.size === headFiles.size && [...next].every(([f, c]) => headFiles.get(f) === c);
      if (same) return { status: 'nothing', commit: head };
      const id = this.commit([head], next, message);
      this.branches.set(`${key(tree.repo)}|${tree.branch}`, id);
      return { status: 'committed', commit: id };
    });
  }

  merge(integration: WorktreeRef, branch: string, message: string): Promise<MergeResult> {
    return this.call('merge', [integration, branch, message], (): MergeResult => {
      const tree = this.trees.get(key(integration.path));
      if (tree === undefined || tree.branch !== integration.branch) return { status: 'failed', detail: `${integration.path} is not a worktree of ${integration.branch}` };
      if (tree.merging !== undefined) return { status: 'failed', detail: 'A merge is already in progress in the integration worktree' };
      if (this.dirty(tree)) return { status: 'failed', detail: 'The integration worktree has uncommitted changes' };
      const theirs = this.tip(integration.repo, branch);
      if (theirs === undefined) return { status: 'failed', detail: `The branch ${branch} was not found` };
      const head = this.headOf(tree);
      if (this.isAncestor(theirs, head)) return { status: 'merged', commit: head };
      const base = this.mergeBase(head, theirs);
      const b = base === undefined ? new Map<string, string>() : this.filesOf(base);
      const o = this.filesOf(head);
      const t = this.filesOf(theirs);
      const result = new Map<string, string>();
      const conflicts: string[] = [];
      for (const f of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
        const [bv, ov, tv] = [b.get(f), o.get(f), t.get(f)];
        let v: string | undefined;
        if (ov === tv) v = ov;
        else if (bv === ov) v = tv;
        else if (bv === tv) v = ov;
        else {
          conflicts.push(f);
          v = `${START} HEAD\n${ov ?? ''}\n=======\n${tv ?? ''}\n${END} ${branch}\n`;
        }
        if (v !== undefined) result.set(f, v);
      }
      if (conflicts.length > 0) {
        tree.files = result;
        tree.merging = { theirs, conflicts: conflicts.sort() };
        tree.staged.clear();
        return { status: 'conflict', files: conflicts.sort() };
      }
      const id = this.commit([head, theirs], result, message);
      this.branches.set(`${key(tree.repo)}|${tree.branch}`, id);
      tree.files = new Map(result);
      return { status: 'merged', commit: id };
    });
  }

  abortMerge(integration: WorktreeRef): Promise<{ status: 'aborted' } | GitFailure> {
    return this.call('abortMerge', [integration], (): { status: 'aborted' } | GitFailure => {
      const tree = this.trees.get(key(integration.path));
      if (tree?.merging === undefined) return { status: 'failed', detail: 'No merge is in progress' };
      tree.files = this.filesOf(this.headOf(tree));
      tree.merging = undefined;
      tree.staged.clear();
      return { status: 'aborted' };
    });
  }

  advanceBranch(repo: string, branch: string, expected: string, to: string): Promise<AdvanceResult> {
    return this.call('advanceBranch', [repo, branch, expected, to], (): AdvanceResult => {
      const current = this.tip(repo, branch);
      if (current === undefined) return { status: 'failed', detail: `The branch ${branch} was not found` };
      if (current !== expected) return { status: 'moved', current };
      if (to === current) return { status: 'advanced' };
      if (!this.isAncestor(current, to)) return { status: 'refused', detail: `${to} is not a fast-forward of ${branch}` };
      const checkout = [...this.trees.values()].find((t) => key(t.repo) === key(repo) && t.branch === branch);
      if (checkout !== undefined && this.dirty(checkout)) return { status: 'refused', detail: `${checkout.path} has local changes` };
      this.branches.set(`${key(repo)}|${branch}`, to);
      if (checkout !== undefined) checkout.files = this.filesOf(to);
      return { status: 'advanced' };
    });
  }

  status(worktree: WorktreeRef): Promise<WorktreeStatus> {
    this.calls.push({ op: 'status', args: [worktree] });
    const tree = this.trees.get(key(worktree.path));
    if (tree === undefined) return Promise.reject(new Error(`not a git repository: ${worktree.path}`));
    const conflictFiles = tree.merging?.conflicts.filter((f) => !tree.staged.has(f)) ?? [];
    return Promise.resolve({ head: this.headOf(tree), branch: tree.branch, dirty: this.dirty(tree), merging: tree.merging !== undefined, conflictFiles });
  }

  removeWorktree(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult> {
    return this.call('removeWorktree', [worktree, options], () => this.cleanup(worktree, options));
  }

  retryCleanup(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult> {
    return this.call('retryCleanup', [worktree, options], () => this.cleanup(worktree, options));
  }

  private cleanup(worktree: WorktreeRef, options: { deleteBranch: boolean }): CleanupResult {
    const tree = this.trees.get(key(worktree.path));
    if (tree?.main === true) return { status: 'pending-cleanup', detail: 'Refused: the main checkout' };
    // git unregisters the worktree even when a held file stops the removal (SP-07 G1).
    this.trees.delete(key(worktree.path));
    if (this.locked.has(key(worktree.path))) return { status: 'pending-cleanup', detail: 'git could not remove the worktree: a process holds a file' };
    this.folders.delete(key(worktree.path));
    if (options.deleteBranch) {
      const tip = this.tip(worktree.repo, worktree.branch);
      if (tip !== undefined) {
        const holders = [...this.branches].filter(([k, id]) => k !== `${key(worktree.repo)}|${worktree.branch}` && k.startsWith(`${key(worktree.repo)}|`) && this.isAncestor(tip, id));
        if (holders.length === 0) return { status: 'pending-cleanup', detail: `Refused: the commits of ${worktree.branch} are in no other branch, so deleting it would lose them` };
        this.branches.delete(`${key(worktree.repo)}|${worktree.branch}`);
      }
    }
    return { status: 'removed' };
  }
}

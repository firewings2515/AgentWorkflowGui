// GitPort on the host's git (T030, R-06, SP-07). Every command goes through run.ts, which adds
// `-c core.longpaths=true`. The adapter touches only what the pipeline made — task and integration worktrees
// and their branches — and moves a target branch only by fast-forward. It never pushes, never rewrites
// history, never resets a target branch. Expected outcomes (conflict, moved branch, failed cleanup) are
// results; a thrown error means git could not be run at all (run.ts's GitRunError).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  AdvanceResult,
  CleanupResult,
  CommitResult,
  CreateWorktreeResult,
  GitFailure,
  GitPort,
  MergeResult,
  WorktreeRef,
  WorktreeStatus,
} from '../../core/ports/git';
import { canonicalPath, isInside, parseWorktreeList, samePath, sanitizeDetail, type WorktreeEntry } from './paths';
import { createGitRunner, type GitResult, type GitRunner, type GitRunnerOptions } from './run';

export interface GitAdapterOptions extends GitRunnerOptions {
  /** Replaces the process runner (tests). */
  run?: GitRunner;
  /** Author and committer for the GUI's commits when git has none configured. */
  identity?: { name: string; email: string };
}

/** git ran and said no: the message goes back to the caller as a `failed` result. */
class GitStepError extends Error {
  override name = 'GitStepError';
}

const DEFAULT_IDENTITY = { name: 'AgentWorkflowGui', email: 'agent-workflow-gui@localhost' };
/** Where the pipeline keeps its worktrees, below the repository (SP-07 G6: short paths). */
const AWG_FOLDER = '.awg';

const pending = (detail: string): CleanupResult => ({ status: 'pending-cleanup', detail: sanitizeDetail(detail) });

/** git's message for a failed command. */
const detailOf = (result: GitResult): string => sanitizeDetail(result.stderr.trim() || result.stdout.trim() || `git exited with code ${String(result.code)}`);

/** The folder the pipeline puts its worktrees in: `<repo>\.awg\wt\<name>` (SP-07 G6). */
export const worktreePath = (repo: string, name: string): string => join(repo, AWG_FOLDER, 'wt', name);

export class GitAdapter implements GitPort {
  private readonly run: GitRunner;
  private readonly identity: { name: string; email: string };
  /** One mutating command per repository at a time: git's own locks would otherwise fail the second as an error. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Folders a failed `worktree remove` left behind (git had already unregistered them): `retryCleanup` may delete these. */
  private readonly leftovers = new Set<string>();

  constructor(options: GitAdapterOptions = {}) {
    this.run = options.run ?? createGitRunner(options);
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  async resolveBranch(repo: string, branch: string): Promise<string | undefined> {
    if (!(await this.validBranchName(repo, branch))) return undefined;
    return this.tip(repo, `refs/heads/${branch}`);
  }

  createWorktree(worktree: WorktreeRef, base: string): Promise<CreateWorktreeResult> {
    return this.serial(worktree.repo, () =>
      this.failing(async () => {
        await this.checkRef(worktree);
        if (base === '' || base.startsWith('-')) throw new GitStepError('The base must be a commit');
        const baseCommit = await this.tip(worktree.repo, base);
        if (baseCommit === undefined) throw new GitStepError(`The base commit ${base} was not found`);
        const full = `refs/heads/${worktree.branch}`;
        const branchTip = await this.tip(worktree.repo, full);
        const registered = (await this.worktrees(worktree.repo)).find((entry) => samePath(entry.path, worktree.path));
        if (registered !== undefined) {
          const same = registered.branch === full && !registered.prunable && existsSync(worktree.path);
          if (same && branchTip !== undefined && (await this.isAncestor(worktree.repo, baseCommit, branchTip))) return { status: 'exists', baseCommit };
          throw new GitStepError(`${worktree.path} is already a worktree for another branch or another base`);
        }
        if (branchTip !== undefined) throw new GitStepError(`The branch ${worktree.branch} already exists`);
        this.hideFromRepo(worktree);
        await this.must(['worktree', 'add', '-b', worktree.branch, worktree.path, baseCommit], worktree.repo);
        return { status: 'created', baseCommit };
      }),
    );
  }

  commitAll(worktree: WorktreeRef, message: string, exclude: readonly string[]): Promise<CommitResult> {
    return this.serial(worktree.repo, () =>
      this.failing(async () => {
        await this.checkRef(worktree);
        await this.requireBranch(worktree);
        if (message.trim() === '') throw new GitStepError('The commit message is empty');
        const excluded = exclude.map((pattern) => {
          const spec = pattern.replaceAll('\\', '/').trim();
          if (spec === '' || spec.startsWith(':')) throw new GitStepError(`Not a path to exclude: ${pattern}`);
          return `:(exclude)${spec}`;
        });
        // Files git still lists as unmerged are committed only when no conflict markers are left in them.
        const unresolved = this.withConflictMarkers(worktree.path, await this.unmergedFiles(worktree.path));
        if (unresolved.length > 0) throw new GitStepError(`Conflict markers are still in: ${unresolved.join(', ')}`);
        await this.must(['add', '-A', '--', '.', ...excluded], worktree.path);
        // A merge in progress is concluded by committing, even when the result equals HEAD.
        if (!(await this.merging(worktree.path))) {
          const staged = await this.git(['diff', '--cached', '--quiet'], worktree.path);
          if (staged.code === 0) return { status: 'nothing', commit: await this.head(worktree.path) };
          if (staged.code !== 1) throw new GitStepError(detailOf(staged));
        }
        await this.must([...(await this.identityArguments(worktree.path)), 'commit', '--cleanup=whitespace', '-m', message], worktree.path);
        return { status: 'committed', commit: await this.head(worktree.path) };
      }),
    );
  }

  merge(integration: WorktreeRef, branch: string, message: string): Promise<MergeResult> {
    return this.serial(integration.repo, () =>
      this.failing(async () => {
        await this.checkRef(integration);
        await this.requireBranch(integration);
        if (message.trim() === '') throw new GitStepError('The merge message is empty');
        if (!(await this.validBranchName(integration.repo, branch)) || (await this.tip(integration.repo, `refs/heads/${branch}`)) === undefined) {
          throw new GitStepError(`The branch ${branch} was not found`);
        }
        if (await this.merging(integration.path)) throw new GitStepError('A merge is already in progress in the integration worktree');
        if (await this.hasTrackedChanges(integration.path)) throw new GitStepError('The integration worktree has uncommitted changes');
        const result = await this.git(
          [...(await this.identityArguments(integration.path)), 'merge', '--no-ff', '--no-edit', '--cleanup=whitespace', '-m', message, `refs/heads/${branch}`],
          integration.path,
        );
        if (result.code === 0) return { status: 'merged', commit: await this.head(integration.path) };
        if (result.code === 1) {
          const files = await this.unmergedFiles(integration.path);
          if (files.length > 0) return { status: 'conflict', files };
        }
        // Not a conflict (a hook said no, a file in the way): leave the worktree as it was before the merge.
        const detail = detailOf(result);
        if (await this.merging(integration.path)) await this.git(['merge', '--abort'], integration.path);
        throw new GitStepError(detail);
      }),
    );
  }

  abortMerge(integration: WorktreeRef): Promise<{ status: 'aborted' } | GitFailure> {
    return this.serial(integration.repo, () =>
      this.failing(async () => {
        await this.checkRef(integration);
        if (!(await this.merging(integration.path))) throw new GitStepError('No merge is in progress');
        await this.must(['merge', '--abort'], integration.path);
        if (await this.merging(integration.path)) throw new GitStepError('The merge is still in progress after the abort');
        return { status: 'aborted' as const };
      }),
    );
  }

  advanceBranch(repo: string, branch: string, expected: string, to: string): Promise<AdvanceResult> {
    return this.serial(repo, () =>
      this.failing(async (): Promise<AdvanceResult> => {
        if (!(await this.validBranchName(repo, branch))) throw new GitStepError(`${branch} is not a branch name`);
        const full = `refs/heads/${branch}`;
        const current = await this.tip(repo, full);
        if (current === undefined) throw new GitStepError(`The branch ${branch} was not found`);
        const expectedCommit = await this.requireCommit(repo, expected);
        const target = await this.requireCommit(repo, to);
        // Someone else moved the branch: nothing changes, the merge starts again (R-06 step 5).
        if (current !== expectedCommit) return { status: 'moved', current };
        if (target === current) return { status: 'advanced' };
        if (!(await this.isAncestor(repo, current, target))) return { status: 'refused', detail: `${target} is not a fast-forward of ${branch}` };

        const checkouts = (await this.worktrees(repo)).filter((entry) => entry.branch === full);
        if (checkouts.length === 0) {
          // Not checked out anywhere: moving the ref is all there is to do, and only from the value just checked.
          const update = await this.git(['update-ref', '-m', 'awg: fast-forward', full, target, current], repo);
          if (update.code === 0) return { status: 'advanced' };
          return this.afterRefused(repo, full, current, detailOf(update));
        }
        const [checkout] = checkouts;
        if (checkouts.length > 1 || checkout === undefined) return { status: 'refused', detail: `${branch} is checked out in more than one worktree` };
        if (checkout.prunable || !existsSync(checkout.path)) return { status: 'refused', detail: `${branch} is checked out in ${checkout.path}, which no longer exists` };
        // Moving the ref alone would leave that checkout's index and files behind its HEAD: update the checkout itself.
        const busy = await this.operationInProgress(checkout.path);
        if (busy !== undefined) return { status: 'refused', detail: `${checkout.path} has a ${busy} in progress` };
        if (await this.hasTrackedChanges(checkout.path)) return { status: 'refused', detail: `${checkout.path} has local changes` };
        const merged = await this.git(['merge', '--ff-only', '--no-edit', target], checkout.path);
        if (merged.code === 0) return { status: 'advanced' };
        return this.afterRefused(repo, full, current, detailOf(merged));
      }),
    );
  }

  async status(worktree: WorktreeRef): Promise<WorktreeStatus> {
    const head = await this.head(worktree.path);
    const symbolic = await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], worktree.path);
    const changes = await this.must(['status', '--porcelain=v1', '-z'], worktree.path);
    const merging = await this.merging(worktree.path);
    const conflictFiles = await this.unmergedFiles(worktree.path);
    return {
      head,
      ...(symbolic.code === 0 && symbolic.stdout.trim() !== '' ? { branch: symbolic.stdout.trim() } : {}),
      dirty: changes !== '',
      merging,
      conflictFiles,
    };
  }

  removeWorktree(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult> {
    return this.cleanup(worktree, options, false);
  }

  retryCleanup(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult> {
    return this.cleanup(worktree, options, true);
  }

  // --- cleanup ---------------------------------------------------------------------------------------------

  private cleanup(worktree: WorktreeRef, options: { deleteBranch: boolean }, retry: boolean): Promise<CleanupResult> {
    return this.serial(worktree.repo, async () => {
      try {
        return await this.cleanupSteps(worktree, options, retry);
      } catch (error) {
        // Never thrown (R-06): whatever went wrong is a cleanup that is still to do.
        return pending(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async cleanupSteps(worktree: WorktreeRef, options: { deleteBranch: boolean }, retry: boolean): Promise<CleanupResult> {
    try {
      await this.checkRef(worktree);
    } catch (error) {
      return pending(`Refused: ${error instanceof Error ? error.message : String(error)}`);
    }
    const full = `refs/heads/${worktree.branch}`;
    const entries = await this.worktrees(worktree.repo);
    const registered = entries.find((entry) => samePath(entry.path, worktree.path));
    if (registered !== undefined && registered.branch !== full) {
      return pending(`Refused: ${worktree.path} is a worktree of ${registered.branch ?? 'a detached HEAD'}, not of ${worktree.branch}`);
    }

    if (registered !== undefined) {
      const removed = await this.git(['worktree', 'remove', '--force', worktree.path], worktree.repo);
      if (removed.code !== 0) {
        // A process holds something in the folder: git has already unregistered the worktree and deleted part of it (SP-07 G1).
        this.leftovers.add(canonicalKey(worktree.path));
        if (!retry) return pending(`git could not remove the worktree: ${detailOf(removed)}`);
      }
    }
    if (existsSync(worktree.path)) {
      if (!retry) return pending('The worktree is unregistered but its folder is still there; retryCleanup deletes it');
      const refusal = this.mayDelete(worktree, registered !== undefined);
      if (refusal !== undefined) return pending(refusal);
      try {
        rmSync(worktree.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        return pending(`The folder could not be deleted yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The registration of a folder that is gone: pruned, or removed alone when another worktree's folder is gone too.
    const after = await this.worktrees(worktree.repo);
    if (after.some((entry) => samePath(entry.path, worktree.path))) {
      const foreign = after.filter((entry) => entry.prunable && !samePath(entry.path, worktree.path));
      const done = foreign.length === 0 ? await this.git(['worktree', 'prune'], worktree.repo) : await this.git(['worktree', 'remove', '--force', worktree.path], worktree.repo);
      if (done.code !== 0) return pending(`The worktree is still registered: ${detailOf(done)}`);
      if ((await this.worktrees(worktree.repo)).some((entry) => samePath(entry.path, worktree.path))) return pending('The worktree is still registered after the prune');
    }

    if (options.deleteBranch && (await this.tip(worktree.repo, full)) !== undefined) {
      // The caller asked for a merged task's branch; git itself refuses a branch that is checked out anywhere.
      const deleted = await this.git(['branch', '-D', worktree.branch], worktree.repo);
      if (deleted.code !== 0) return pending(`The branch could not be deleted: ${detailOf(deleted)}`);
    }
    this.leftovers.delete(canonicalKey(worktree.path));
    return { status: 'removed' };
  }

  /** Why the folder must not be deleted by Node, or undefined: only a registered worktree, a folder git just failed to remove, or one below `.awg`. */
  private mayDelete(worktree: WorktreeRef, wasRegistered: boolean): string | undefined {
    if (!wasRegistered && !this.leftovers.has(canonicalKey(worktree.path)) && !isInside(join(worktree.repo, AWG_FOLDER), worktree.path)) {
      return `Refused: ${worktree.path} is not registered, not below ${AWG_FOLDER} and not a folder a removal left behind; delete it by hand`;
    }
    try {
      if (statSync(join(worktree.path, '.git')).isDirectory()) return `Refused: ${worktree.path} holds a repository of its own`;
    } catch {
      // No .git entry (half deleted): fine.
    }
    return undefined;
  }

  // --- helpers ---------------------------------------------------------------------------------------------

  private git(args: readonly string[], cwd: string, input?: string): Promise<GitResult> {
    return this.run(args, input === undefined ? { cwd } : { cwd, input });
  }

  /** Runs git and returns its stdout; a non-zero exit is a GitStepError carrying git's message. */
  private async must(args: readonly string[], cwd: string): Promise<string> {
    const result = await this.git(args, cwd);
    if (result.code !== 0) throw new GitStepError(detailOf(result));
    return result.stdout;
  }

  private async failing<T>(action: () => Promise<T>): Promise<T | GitFailure> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof GitStepError) return { status: 'failed', detail: error.message };
      throw error;
    }
  }

  private serial<T>(repo: string, action: () => Promise<T>): Promise<T> {
    const key = canonicalKey(repo);
    const run = (this.queues.get(key) ?? Promise.resolve()).then(action);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  /** The caller's arguments must name this repository's own worktree: absolute, not the main checkout, a valid branch. */
  private async checkRef(worktree: WorktreeRef): Promise<void> {
    if (!isAbsolute(worktree.repo) || !isAbsolute(worktree.path)) throw new GitStepError('The repository and worktree paths must be absolute');
    if (samePath(worktree.repo, worktree.path)) throw new GitStepError('The worktree path is the repository itself');
    if (isInside(worktree.path, worktree.repo)) throw new GitStepError('The worktree path contains the repository');
    if (isInside(join(worktree.repo, '.git'), worktree.path)) throw new GitStepError('The worktree path is inside .git');
    if (!(await this.validBranchName(worktree.repo, worktree.branch))) throw new GitStepError(`${worktree.branch} is not a branch name`);
  }

  private async validBranchName(repo: string, branch: string): Promise<boolean> {
    if (branch === '' || branch.startsWith('-') || branch === 'HEAD' || branch.includes('@{')) return false;
    return (await this.git(['check-ref-format', `refs/heads/${branch}`], repo)).code === 0;
  }

  private async worktrees(repo: string): Promise<WorktreeEntry[]> {
    return parseWorktreeList(await this.must(['worktree', 'list', '--porcelain', '-z'], repo));
  }

  /** The commit `revision` names, or undefined when there is none. */
  private async tip(repo: string, revision: string): Promise<string | undefined> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], repo);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 1) return undefined;
    throw new GitStepError(detailOf(result));
  }

  private async requireCommit(repo: string, revision: string): Promise<string> {
    if (revision === '' || revision.startsWith('-')) throw new GitStepError(`${revision} is not a commit`);
    const commit = await this.tip(repo, revision);
    if (commit === undefined) throw new GitStepError(`The commit ${revision} was not found`);
    return commit;
  }

  private async head(cwd: string): Promise<string> {
    return (await this.must(['rev-parse', 'HEAD'], cwd)).trim();
  }

  private async isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git(['merge-base', '--is-ancestor', ancestor, descendant], repo);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new GitStepError(detailOf(result));
  }

  private async requireBranch(worktree: WorktreeRef): Promise<void> {
    const result = await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], worktree.path);
    const current = result.code === 0 ? result.stdout.trim() : undefined;
    if (current !== worktree.branch) throw new GitStepError(`${worktree.path} has ${current ?? 'a detached HEAD'} checked out, not ${worktree.branch}`);
  }

  private async merging(cwd: string): Promise<boolean> {
    return (await this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)).code === 0;
  }

  private async unmergedFiles(cwd: string): Promise<string[]> {
    const output = await this.must(['diff', '--name-only', '--diff-filter=U', '-z'], cwd);
    return output.split('\0').filter((file) => file !== '');
  }

  /** Changes to tracked files, staged or not; untracked files are not counted. */
  private async hasTrackedChanges(cwd: string): Promise<boolean> {
    return (await this.must(['status', '--porcelain=v1', '-z', '--untracked-files=no'], cwd)) !== '';
  }

  /** A merge, cherry-pick, revert or rebase that has not ended, by name. */
  private async operationInProgress(cwd: string): Promise<string | undefined> {
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD']) {
      if ((await this.git(['rev-parse', '-q', '--verify', name], cwd)).code === 0) return name.replace('_HEAD', '').toLowerCase();
    }
    for (const folder of ['rebase-merge', 'rebase-apply']) {
      if (existsSync(resolve(cwd, (await this.must(['rev-parse', '--git-path', folder], cwd)).trim()))) return 'rebase';
    }
    return undefined;
  }

  /** Of `files` (relative to `cwd`), those that still hold a `<<<<<<<` or `>>>>>>>` line of an unresolved conflict. */
  private withConflictMarkers(cwd: string, files: readonly string[]): string[] {
    return files.filter((file) => {
      try {
        return /^(<{7}|>{7})( |$)/m.test(readFileSync(join(cwd, file), 'latin1'));
      } catch {
        return false; // deleted by the resolution
      }
    });
  }

  /** `-c user.name -c user.email` for the GUI's own commits, only when git has no identity to use. */
  private async identityArguments(cwd: string): Promise<string[]> {
    if ((await this.git(['var', 'GIT_COMMITTER_IDENT'], cwd)).code === 0) return [];
    return ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
  }

  /** A fast-forward that did not happen: the branch moved meanwhile, or git refused for its own reason. */
  private async afterRefused(repo: string, full: string, expected: string, detail: string): Promise<AdvanceResult> {
    const now = await this.tip(repo, full);
    if (now !== undefined && now !== expected) return { status: 'moved', current: now };
    return { status: 'refused', detail };
  }

  /**
   * Keeps `.awg/` out of the user's `git status`: a line in the repository's own `info/exclude` (not tracked, not
   * shared). Best effort; without it the worktrees only show up as untracked.
   */
  private hideFromRepo(worktree: WorktreeRef): void {
    if (!isInside(join(worktree.repo, AWG_FOLDER), worktree.path)) return;
    try {
      const exclude = join(canonicalPath(worktree.repo), '.git', 'info', 'exclude');
      if (!existsSync(join(canonicalPath(worktree.repo), '.git')) || !statSync(join(canonicalPath(worktree.repo), '.git')).isDirectory()) return;
      const line = `/${AWG_FOLDER}/`;
      const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      if (text.split(/\r?\n/).includes(line)) return;
      mkdirSync(dirname(exclude), { recursive: true });
      writeFileSync(exclude, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf8');
    } catch {
      // Hygiene only.
    }
  }
}

const canonicalKey = (path: string): string => canonicalPath(path).replaceAll('\\', '/').toLowerCase();

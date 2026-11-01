// GitPort on the host's git (T030, R-06, SP-07). Every command goes through run.ts, which adds
// `-c core.longpaths=true`. The adapter touches only what the pipeline made — task and integration worktrees
// and their branches — and moves a target branch only by fast-forward. It never pushes, never rewrites
// history, never resets a target branch. Expected outcomes (conflict, moved branch, failed cleanup) are
// results; a thrown error means git could not be run at all (run.ts's GitRunError).
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
/** The branch config entry that says the pipeline made this branch (and for which folder): it allows deleting the branch. */
const BRANCH_KEY = 'awgBranch';
/** Branch config: this attempt's token and path, written before `worktree add` (an intent, which claims nothing). */
const INTENT_KEY = 'awgIntent';
/** Branch config: the token that was written into the new worktree's admin folder, the proof that this adapter made it. */
const TOKEN_KEY = 'awgToken';
/** Branch config: identity of the folder git was asked to remove, so a leftover can be told from a folder made later. */
const LEFTOVER_KEY = 'awgLeftover';
/** Branch config: what the pipeline made the branch for, from the worktree's name at creation (`m-…`: an integration worktree). */
const KIND_KEY = 'awgKind';
/**
 * Branch config, of an integration branch only: the commit the branch pointed at when this adapter last made a commit on
 * it (creation, a `merge` or a `commitAll` that made a new commit on top of that tip). A branch somewhere else now
 * (`branch -f`, a copy under the old name, a commit made meanwhile) is not what the pipeline made, whatever its other
 * records say (T043 r1 P1-1, r2 P1-1). Never moved by an operation that made no commit ("Already up to date", nothing
 * to commit): a tip is claimed only when this adapter made it. A task branch has none: agents commit there themselves,
 * and it is deleted only when its commits are in another branch anyway.
 */
const TIP_KEY = 'awgTip';
/**
 * `<this><branch>` points at the tip of a branch whose deletion was decided and may not be finished: written before the
 * branch goes, removed once nothing is checked out on it (or it was put back). A retry that finds it finishes or undoes
 * the deletion instead of taking a missing branch for a done cleanup (T043 r1 P1-2).
 */
const PENDING_DELETE = 'refs/awg/pending-delete/';
const NO_REF = '0000000000000000000000000000000000000000';
/** The file in a worktree's admin folder (`<common dir>\worktrees\<name>`) that holds the token. */
const OWNER_FILE = 'awg-owner';
/** A worktree's name under `.awg\wt`: one safe segment (no separators, no `..`, no trailing dot, no device names). */
const SAFE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i;
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');

const pending = (detail: string): CleanupResult => ({ status: 'pending-cleanup', detail: sanitizeDetail(detail) });

/** git's message for a failed command. */
const detailOf = (result: GitResult): string => sanitizeDetail(result.stderr.trim() || result.stdout.trim() || `git exited with code ${String(result.code)}`);

/**
 * A caller's pathspec as an exclusion for `git add`: `:(exclude)` plus whatever magic it brings (`:(glob)out/**`,
 * `:(top)lock.json`, `:/lock.json`). A pathspec that is itself an exclusion (`:(exclude)x`, `:!x`, `:^x`) is refused:
 * wrapped again it would mean "include", the opposite of what the caller wrote. So is an empty one.
 */
export function excludePathspec(pathspec: string): string {
  const refuse = (): never => {
    throw new GitStepError(`Not a pathspec to exclude: ${pathspec}`);
  };
  const spec = pathspec.trim();
  if (spec === '') return refuse();
  if (!spec.startsWith(':')) return `:(exclude)${spec.replaceAll('\\', '/')}`;
  if (spec.startsWith(':(')) {
    const close = /(?<!\\)\)/.exec(spec);
    if (close === null) return refuse();
    const magic = spec.slice(2, close.index).split(',');
    if (magic.some((word) => word.trim() === 'exclude')) return refuse();
    return `:(exclude,${magic.join(',')})${spec.slice(close.index + 1)}`;
  }
  // Short form: `:` then magic characters, optionally a closing `:`.
  const short = /^:([!^/]*):?/.exec(spec);
  const characters = short?.[1] ?? '';
  if (short === null || characters.includes('!') || characters.includes('^')) return refuse();
  const rest = spec.slice(short[0].length);
  if (rest === '') return refuse();
  return characters.includes('/') ? `:(exclude,top)${rest}` : `:(exclude)${rest}`;
}

/** The folder the pipeline puts its worktrees in: `<repo>\.awg\wt\<name>` (SP-07 G6). */
export const worktreePath = (repo: string, name: string): string => {
  if (!SAFE_NAME.test(name) || name.endsWith('.')) throw new Error(`Not a worktree name: ${name}`);
  return join(repo, AWG_FOLDER, 'wt', name);
};

export class GitAdapter implements GitPort {
  private readonly run: GitRunner;
  private readonly identity: { name: string; email: string };
  /** One mutating command per repository at a time: git's own locks would otherwise fail the second as an error. */
  private readonly queues = new Map<string, Promise<unknown>>();

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
        const key = canonicalKey(worktree.path);
        if (registered !== undefined) {
          // Only a worktree this adapter finished making is taken up again: the token in its own admin folder is the
          // one this branch's config names. An intent record alone proves nothing (the folder may be somebody else's).
          const same = registered.branch === full && !registered.prunable && existsSync(worktree.path);
          if (same && branchTip !== undefined && (await this.ownsWorktree(worktree)) && (await this.isAncestor(worktree.repo, baseCommit, branchTip))) {
            return { status: 'exists', baseCommit };
          }
          throw new GitStepError(`${worktree.path} is already a worktree for another branch or another base, or not one this adapter made`);
        }
        if (branchTip !== undefined) throw new GitStepError(`The branch ${worktree.branch} already exists`);
        this.hideFromRepo(worktree);
        // Intent first, ownership after: the intent holds this attempt's token; only when `worktree add` has succeeded
        // is the token written into the new worktree's admin folder (the proof that this adapter made it) and the
        // branch record made. A failure or interruption in between leaves at most the intent, which claims nothing.
        const token = randomUUID();
        await this.must(['config', `branch.${worktree.branch}.${INTENT_KEY}`, `${token}|${key}`], worktree.repo);
        const added = await this.git(['worktree', 'add', '-b', worktree.branch, worktree.path, baseCommit], worktree.repo);
        if (added.code !== 0) {
          // Only the intent is withdrawn. A branch git left behind (or one somebody made meanwhile) is not ours to delete.
          await this.git(['config', '--unset-all', `branch.${worktree.branch}.${INTENT_KEY}`], worktree.repo);
          throw new GitStepError(detailOf(added));
        }
        const admin = await this.adminDir(worktree.repo, worktree.path);
        if (admin === undefined) throw new GitStepError(`git made ${worktree.path} but its worktree folder could not be found; it was not claimed`);
        writeFileSync(join(admin, OWNER_FILE), token, 'utf8');
        await this.must(['config', `branch.${worktree.branch}.${TOKEN_KEY}`, token], worktree.repo);
        // The kind and the tip before the ownership record: a branch that is owned has both.
        const integration = /^m-/.test(basename(worktree.path));
        await this.must(['config', `branch.${worktree.branch}.${KIND_KEY}`, integration ? 'integration' : 'task'], worktree.repo);
        if (integration) await this.must(['config', `branch.${worktree.branch}.${TIP_KEY}`, baseCommit], worktree.repo);
        await this.must(['config', `branch.${worktree.branch}.${BRANCH_KEY}`, key], worktree.repo);
        await this.git(['config', '--unset-all', `branch.${worktree.branch}.${INTENT_KEY}`], worktree.repo);
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
        const left = await this.leftTip(worktree);
        const excluded = exclude.map(excludePathspec);
        // A merge in progress is concluded by committing, even when the result equals HEAD.
        const merging = await this.merging(worktree.path);
        // The files that conflicted, read before the add: afterwards git no longer lists them as unmerged.
        const conflicted = merging ? await this.conflictedFiles(worktree.path) : [];
        await this.must(['add', '-A', '--', '.', ...excluded], worktree.path);
        if (merging) {
          const unresolved = await this.unresolvedConflicts(worktree.path, conflicted);
          if (unresolved.length > 0) throw new GitStepError(`Conflict markers are still in: ${unresolved.join(', ')}`);
        } else {
          const staged = await this.git(['diff', '--cached', '--quiet'], worktree.path);
          // Nothing was committed: whatever the branch points at now is not claimed.
          if (staged.code === 0) return { status: 'nothing', commit: await this.head(worktree.path) };
          if (staged.code !== 1) throw new GitStepError(detailOf(staged));
        }
        const mergeHead = merging ? (await this.git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktree.path)).stdout.trim() : undefined;
        // What is about to be committed, as git wrote it: the tree the new commit must have to count as ours.
        const staged = left === undefined ? undefined : (await this.git(['write-tree'], worktree.path)).stdout.trim();
        await this.must([...(await this.identityArguments(worktree.path)), 'commit', '--cleanup=whitespace', '-m', message], worktree.path);
        if (merging) await this.forgetConflicts(worktree.path);
        const head = await this.head(worktree.path);
        await this.claimTip(worktree, left, head, mergeHead === undefined || mergeHead === '' ? [] : [mergeHead], message, staged);
        return { status: 'committed', commit: head };
      }),
    );
  }

  merge(integration: WorktreeRef, branch: string, message: string): Promise<MergeResult> {
    return this.serial(integration.repo, () =>
      this.failing(async () => {
        await this.checkRef(integration);
        await this.requireBranch(integration);
        if (message.trim() === '') throw new GitStepError('The merge message is empty');
        const merged = await this.tip(integration.repo, `refs/heads/${branch}`);
        if (!(await this.validBranchName(integration.repo, branch)) || merged === undefined) {
          throw new GitStepError(`The branch ${branch} was not found`);
        }
        const left = await this.leftTip(integration);
        // The tree a clean merge of the two gives (the same merge git is about to make): the commit counts as ours only with it.
        const expected = left === undefined ? undefined : await this.mergedTree(integration, left.before, merged);
        if (await this.merging(integration.path)) throw new GitStepError('A merge is already in progress in the integration worktree');
        if (await this.hasTrackedChanges(integration.path)) throw new GitStepError('The integration worktree has uncommitted changes');
        await this.forgetConflicts(integration.path);
        const result = await this.git(
          [...(await this.identityArguments(integration.path)), 'merge', '--no-ff', '--no-edit', '--cleanup=whitespace', '-m', message, `refs/heads/${branch}`],
          integration.path,
        );
        if (result.code === 0) {
          const head = await this.head(integration.path);
          await this.claimTip(integration, left, head, [merged], message, expected);
          return { status: 'merged', commit: head };
        }
        if (result.code === 1) {
          const files = await this.unmergedFiles(integration.path);
          if (files.length > 0) {
            await this.rememberConflicts(integration.path, files);
            return { status: 'conflict', files };
          }
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
        await this.forgetConflicts(integration.path);
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
          if (update.code !== 0) return this.afterRefused(repo, full, current, detailOf(update));
          // git has no lock between "checked out nowhere" and the ref moving: a worktree that checked the branch
          // out in that gap now has a HEAD ahead of its index and files. A checkout seen now is always a failure
          // (root decides), even one that happens to be in step: nothing here widens what counts as success. The
          // window that remains is the one between this look and the caller's next step.
          const raced = (await this.worktrees(repo)).find((entry) => entry.branch === full);
          if (raced !== undefined) {
            throw new GitStepError(`${branch} moved, but it is checked out in ${raced.path}; that checkout may be behind its HEAD and needs the user's attention`);
          }
          return { status: 'advanced' };
        }
        const [checkout] = checkouts;
        if (checkouts.length > 1 || checkout === undefined) return { status: 'refused', detail: `${branch} is checked out in more than one worktree` };
        if (checkout.prunable || !existsSync(checkout.path)) return { status: 'refused', detail: `${branch} is checked out in ${checkout.path}, which no longer exists` };
        // Moving the ref alone would leave that checkout's index and files behind its HEAD: update the checkout itself.
        // Only modifications of tracked files count as local changes: an untracked file is left to git's own check,
        // which refuses a fast-forward that would overwrite one (a user's main checkout nearly always has some).
        const busy = await this.operationInProgress(checkout.path);
        if (busy !== undefined) return { status: 'refused', detail: `${checkout.path} has a ${busy} in progress` };
        if (await this.hasTrackedChanges(checkout.path)) return { status: 'refused', detail: `${checkout.path} has local changes` };
        const merged = await this.git(['merge', '--ff-only', '--no-edit', target], checkout.path);
        // The branch is read again: "already up to date" also comes from a branch someone moved past `target`
        // (A→C when asked for A→B), which is a moved branch, not an advance.
        const now = await this.tip(repo, full);
        if (merged.code === 0 && now === target) {
          // "Already up to date" is also what a ref moved from outside looks like: the checkout itself must be at
          // `target` — its branch, HEAD, index and files — before this is an advance.
          if (!(await this.checkoutAt(checkout.path, target, full))) {
            throw new GitStepError(`${branch} is at ${target}, but the checkout in ${checkout.path} is not (its HEAD, index or files differ); it needs the user's attention`);
          }
          return { status: 'advanced' };
        }
        if (now !== undefined && now !== current) return { status: 'moved', current: now };
        return { status: 'refused', detail: detailOf(merged) };
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
    const resumed = await this.resumeDelete(worktree, full);
    if (resumed !== undefined) return resumed;
    const entries = await this.worktrees(worktree.repo);
    const registered = entries.find((entry) => samePath(entry.path, worktree.path));
    if (registered !== undefined && registered.branch !== full) {
      return pending(`Refused: ${worktree.path} is a worktree of ${registered.branch ?? 'a detached HEAD'}, not of ${worktree.branch}`);
    }
    // What may be touched is decided by proofs this adapter wrote, never by a path alone:
    // - a registered worktree: the token in its own admin folder is the one the branch's config names;
    // - a folder git no longer lists (what a failed removal leaves): the folder itself, by the identity (file id and
    //   creation time) recorded just before git was asked to remove it; a folder made later at that path differs;
    // - the branch: the record `createWorktree` made once it had finished.
    // Without a proof the thing is kept and the result says so for the user to decide.
    const key = canonicalKey(worktree.path);
    const branchExists = (await this.tip(worktree.repo, full)) !== undefined;
    const branchOwned = branchExists && (await this.recorded(worktree.repo, worktree.branch, BRANCH_KEY)) === key;
    if (registered !== undefined && !(branchOwned && (await this.ownsWorktree(worktree)))) {
      return pending(`Refused: ${worktree.path} is not a worktree this adapter made for ${worktree.branch}; the user has to decide what to do with it`);
    }
    if (registered === undefined && existsSync(worktree.path)) {
      const identity = this.folderIdentity(worktree.path);
      const leftover = branchExists ? await this.recorded(worktree.repo, worktree.branch, LEFTOVER_KEY) : undefined;
      if (identity === undefined || leftover !== identity) {
        return pending(`Refused: the folder ${worktree.path} cannot be shown to be what a removal left behind; the user has to decide what to do with it`);
      }
    }
    if (options.deleteBranch && branchExists && !branchOwned) {
      return pending(`Refused: the branch ${worktree.branch} was not created by the pipeline for ${worktree.path}; it was not deleted`);
    }

    if (registered !== undefined) {
      // Written before git is asked: if the removal fails halfway, this is how the leftover folder is recognised.
      const identity = this.folderIdentity(worktree.path);
      if (identity !== undefined) await this.must(['config', `branch.${worktree.branch}.${LEFTOVER_KEY}`, identity], worktree.repo);
      const removed = await this.git(['worktree', 'remove', '--force', worktree.path], worktree.repo);
      // A process holds something in the folder: git has already unregistered the worktree and deleted part of it (SP-07 G1).
      if (removed.code !== 0 && !retry) return pending(`git could not remove the worktree: ${detailOf(removed)}`);
    }
    if (existsSync(worktree.path)) {
      if (!retry) return pending('The worktree is unregistered but its folder is still there; retryCleanup deletes it');
      const refusal = this.unsafeToDelete(worktree);
      if (refusal !== undefined) return pending(refusal);
      try {
        rmSync(worktree.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        return pending(`The folder could not be deleted yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The folder is gone. The permission that named it ends now, before any step that can fail (the identity would
    // not match a later folder anyway).
    if (!existsSync(worktree.path) && branchExists) {
      const withdrawn = await this.git(['config', '--unset-all', `branch.${worktree.branch}.${LEFTOVER_KEY}`], worktree.repo);
      if (withdrawn.code !== 0 && withdrawn.code !== 5) return pending(`The folder record could not be withdrawn: ${detailOf(withdrawn)}`);
    }

    // The registration of a folder that is gone: pruned, or removed alone when another worktree's folder is gone too.
    const after = await this.worktrees(worktree.repo);
    if (after.some((entry) => samePath(entry.path, worktree.path))) {
      const foreign = after.filter((entry) => entry.prunable && !samePath(entry.path, worktree.path));
      const done = foreign.length === 0 ? await this.git(['worktree', 'prune'], worktree.repo) : await this.git(['worktree', 'remove', '--force', worktree.path], worktree.repo);
      if (done.code !== 0) return pending(`The worktree is still registered: ${detailOf(done)}`);
      if ((await this.worktrees(worktree.repo)).some((entry) => samePath(entry.path, worktree.path))) return pending('The worktree is still registered after the prune');
    }

    if (options.deleteBranch && branchExists) {
      // The caller asks for the branch to go (a merged task's, or an ended merge attempt's integration branch).
      // `branch -d` would compare against the checked-out HEAD, which is not the target branch, so the same check is
      // made here. The branch must still be where the pipeline left it (`awgTip`: a branch moved with `branch -f`, or
      // copied back under the old name, is not what the pipeline made). Then another branch holds the commits, or
      // (T043 G-6) the branch is an integration branch and the only commits it holds alone are merge commits, which
      // carry no work of anyone's (their parents are all kept elsewhere) — what a failed attempt leaves. The delete is
      // `update-ref -d <ref> <checked sha>`, which git refuses when the branch moved since (`branch -D` has no such
      // condition); it does not look at checkouts, so those are checked before and again after (G-8).
      const tip = await this.tip(worktree.repo, full);
      if (tip !== undefined) {
        // A branch name that is a symbolic ref is not the branch the pipeline made: deleting it would take the branch it
        // points at (T043 r3 P1-2).
        if ((await this.git(['symbolic-ref', '-q', full], worktree.repo)).code === 0) return pending(`Refused: ${worktree.branch} is a symbolic ref, not a branch the pipeline made; it was not deleted`);
        const checkedOut = (await this.worktrees(worktree.repo)).find((entry) => entry.branch === full);
        if (checkedOut !== undefined) return pending(`Refused: ${worktree.branch} is checked out in ${checkedOut.path}`);
        const isIntegration = (await this.recorded(worktree.repo, worktree.branch, KIND_KEY)) === 'integration';
        const recordedTip = isIntegration ? await this.recorded(worktree.repo, worktree.branch, TIP_KEY) : undefined;
        if (recordedTip !== undefined && recordedTip !== tip) {
          return pending(`Refused: ${worktree.branch} is not at the commit the pipeline left it at (${recordedTip}); it was moved or copied, so it was not deleted`);
        }
        const others = lines(await this.must(['for-each-ref', '--format=%(refname)', 'refs/heads'], worktree.repo)).filter((ref) => ref !== full);
        const unique = await this.uniqueCommits(worktree.repo, tip, others);
        const mergesOnly = recordedTip === tip && unique.every((commit) => commit.parents > 1);
        if (unique.length > 0 && !mergesOnly) {
          return pending(`Refused: the commits of ${worktree.branch} are in no other branch, so deleting it would lose them`);
        }
        // The decision is written first (a ref that keeps the tip alive); it is removed when nothing is left to undo.
        const marker = `${PENDING_DELETE}${worktree.branch}`;
        await this.must(['update-ref', '--no-deref', marker, tip, NO_REF], worktree.repo);
        const deleted = await this.git(['update-ref', '-d', '--no-deref', full, tip], worktree.repo);
        if (deleted.code !== 0) {
          const withdrawn = await this.git(['update-ref', '-d', '--no-deref', marker], worktree.repo);
          return pending(
            `The branch changed while it was being checked and was kept: ${detailOf(deleted)}` + (withdrawn.code === 0 ? '' : `; the record of the deletion could not be withdrawn: ${detailOf(withdrawn)}`),
          );
        }
        const finished = await this.finishDelete(worktree, full, marker, tip);
        if (finished !== undefined) return finished;
      }
    }
    return { status: 'removed' };
  }

  /**
   * After the branch ref is gone (T043 G-8, r1 P1-2): git has no lock between "checked out nowhere" and the delete, so a
   * worktree that checked the branch out in that gap now has a HEAD that names a branch that is gone. Then the branch is
   * put back (only if it is still missing) and the checkout is the user's to deal with; otherwise the branch's records
   * go with it. The marker stays until either is done, so a look that failed or a crash here is picked up by the next
   * cleanup (`resumeDelete`), never taken for a finished one. A checkout after this look finds no branch and fails by
   * itself. Undefined: done.
   */
  private async finishDelete(worktree: WorktreeRef, full: string, marker: string, tip: string): Promise<CleanupResult | undefined> {
    const raced = (await this.worktrees(worktree.repo)).find((entry) => entry.branch === full);
    if (raced !== undefined) {
      // `--no-deref`: a name that was made a symbolic ref meanwhile is not followed (it would create what it points at).
      // A name that is a symbolic ref already is the user's: left as it is.
      const symbolic = (await this.git(['symbolic-ref', '-q', full], worktree.repo)).code === 0;
      const restored = symbolic ? { code: 1, stdout: '', stderr: `${worktree.branch} is a symbolic ref now`, truncated: false } : await this.git(['update-ref', '--no-deref', full, tip, NO_REF], worktree.repo);
      const back = restored.code === 0;
      if (back) await this.git(['update-ref', '-d', '--no-deref', marker], worktree.repo);
      return pending(`${worktree.branch} was checked out in ${raced.path} while it was being deleted; ` + (back ? 'it was put back' : `it could not be put back (${detailOf(restored)}), and the next cleanup tries again`));
    }
    // What `branch -D` also does: the branch's settings (and with them the records) go.
    const section = await this.git(['config', '--remove-section', `branch.${worktree.branch}`], worktree.repo);
    // A section that is not there is as good as removed; any other failure leaves records behind and the marker with it.
    if (section.code !== 0 && (await this.git(['config', '--get-regexp', `^branch\\.${worktree.branch.replaceAll('.', '\\.')}\\.`], worktree.repo)).code !== 1) {
      return pending(`The records of ${worktree.branch} could not be removed: ${detailOf(section)}; the next cleanup tries again`);
    }
    const cleared = await this.git(['update-ref', '-d', '--no-deref', marker], worktree.repo);
    if (cleared.code !== 0) return pending(`The record of the deletion could not be withdrawn: ${detailOf(cleared)}`);
    return undefined;
  }

  /** A deletion an earlier cleanup decided and did not finish (it failed after the ref went, or the GUI stopped there). */
  private async resumeDelete(worktree: WorktreeRef, full: string): Promise<CleanupResult | undefined> {
    const marker = `${PENDING_DELETE}${worktree.branch}`;
    const marked = await this.tip(worktree.repo, marker);
    if (marked === undefined) return undefined;
    if ((await this.tip(worktree.repo, full)) !== undefined) {
      // The branch is there again (put back, or made anew): the old decision is void.
      const withdrawn = await this.git(['update-ref', '-d', '--no-deref', marker], worktree.repo);
      if (withdrawn.code !== 0) return pending(`The record of an earlier deletion could not be withdrawn: ${detailOf(withdrawn)}; the next cleanup tries again`);
      return undefined;
    }
    return this.finishDelete(worktree, full, marker, marked);
  }

  /** The commits reachable from `tip` and from none of `others` (branch refs), each with its number of parents. Empty: another branch holds all of them. */
  private async uniqueCommits(repo: string, tip: string, others: readonly string[]): Promise<{ commit: string; parents: number }[]> {
    // The revisions go through stdin: a repository can have more branches than a command line holds.
    const result = await this.git(['rev-list', '--parents', '--stdin'], repo, `${tip}\n${others.map((ref) => `^${ref}`).join('\n')}\n`);
    if (result.code !== 0) throw new GitStepError(detailOf(result));
    if (result.truncated) throw new GitStepError('The list of commits was too large to read in full');
    const listed = lines(result.stdout);
    const commits = listed.map((line) => {
      const [commit = '', ...parents] = line.split(' ');
      return { commit, parents: parents.length };
    });
    return commits;
  }

  /**
   * Before an operation that makes a commit on an integration branch: where the branch is, which must be where the
   * pipeline left it (`awgTip`); the operation is refused when it was moved from outside. Undefined: nothing is tracked
   * (a task branch, or a branch made before the record).
   */
  private async leftTip(worktree: WorktreeRef): Promise<{ before: string } | undefined> {
    if ((await this.recorded(worktree.repo, worktree.branch, KIND_KEY)) !== 'integration') return undefined;
    const recorded = await this.recorded(worktree.repo, worktree.branch, TIP_KEY);
    if (recorded === undefined) return undefined;
    const before = await this.head(worktree.path);
    if (before !== recorded) throw new GitStepError(`${worktree.branch} was moved outside the pipeline (it is at ${before}, the pipeline left it at ${recorded}); nothing was done`);
    return { before };
  }

  /**
   * The tree of a clean merge of `ours` and `theirs` (`merge-tree --write-tree`), or undefined: conflicts, or a git that
   * does not have it. Without it nothing is claimed.
   */
  private async mergedTree(worktree: WorktreeRef, ours: string, theirs: string): Promise<string | undefined> {
    const result = await this.git(['merge-tree', '--write-tree', '--no-messages', ours, theirs], worktree.repo);
    return result.code === 0 ? lines(result.stdout)[0] : undefined;
  }

  /**
   * After the operation: the branch tip is claimed only when this operation made it. That is told by what is in the commit,
   * not by where it sits: a commit directly on top of the tip the operation started from, with the parents and the message
   * it was asked for, AND the tree this operation was to produce (a clean merge of the two, or what it staged). The cases
   * where the branch moved from outside between the check and the command can only end in one of these, and none claims:
   * the command made no commit ("Already up to date": the branch is whatever the outsider made, with a tree of their
   * choosing, whatever parents and message they gave it), or it made a commit on top of theirs (its first parent is not
   * the tip the operation started from). An outsider's commit whose tree is exactly the expected one holds nothing the
   * pipeline would not have made. A branch that did not move, or any doubt (no expected tree), is left unclaimed.
   */
  private async claimTip(worktree: WorktreeRef, left: { before: string } | undefined, head: string, others: readonly string[], message: string, expectedTree: string | undefined): Promise<void> {
    if (left === undefined || head === left.before || expectedTree === undefined || expectedTree === '') return;
    const tree = await this.git(['rev-parse', `${head}^{tree}`], worktree.repo);
    if (tree.code !== 0 || tree.stdout.trim() !== expectedTree) return;
    const parents = lines((await this.git(['rev-list', '--parents', '-n', '1', head], worktree.repo)).stdout)[0]?.split(' ').slice(1) ?? [];
    if (parents.length !== 1 + others.length || parents[0] !== left.before || others.some((other, i) => parents[i + 1] !== other)) return;
    const body = await this.git(['log', '-1', '--format=%B', head], worktree.repo);
    if (body.code !== 0 || body.stdout.trim() !== message.trim()) return;
    await this.git(['config', `branch.${worktree.branch}.${TIP_KEY}`, head], worktree.repo);
  }

  /** What `createWorktree` recorded in the branch's config under `key`. */
  private async recorded(repo: string, branch: string, key: string): Promise<string | undefined> {
    const result = await this.git(['config', '--get', `branch.${branch}.${key}`], repo);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  /** The folder git keeps for the worktree at `path` (`<common dir>\worktrees\<name>`), found by the path it names; works when the worktree's own folder is gone. */
  private async adminDir(repo: string, path: string): Promise<string | undefined> {
    const common = resolve(repo, (await this.must(['rev-parse', '--git-common-dir'], repo)).trim());
    const root = join(common, 'worktrees');
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const name of names) {
      try {
        const target = readFileSync(join(root, name, 'gitdir'), 'utf8').trim();
        if (samePath(dirname(target), path)) return join(root, name);
      } catch {
        // Not a worktree folder (or unreadable): skip.
      }
    }
    return undefined;
  }

  /** The worktree's admin folder holds the token the branch's config names: this adapter finished making it. */
  private async ownsWorktree(worktree: WorktreeRef): Promise<boolean> {
    try {
      const wanted = await this.recorded(worktree.repo, worktree.branch, TOKEN_KEY);
      const admin = await this.adminDir(worktree.repo, worktree.path);
      if (wanted === undefined || wanted === '' || admin === undefined) return false;
      return readFileSync(join(admin, OWNER_FILE), 'utf8').trim() === wanted;
    } catch {
      return false;
    }
  }

  /** A folder as itself, not as a path: file id and creation time. Undefined for a link or a folder that cannot be read. */
  private folderIdentity(path: string): string | undefined {
    try {
      const stats = lstatSync(path, { bigint: true });
      if (stats.isSymbolicLink() || (stats.ino === 0n && stats.birthtimeNs === 0n)) return undefined;
      return `${String(stats.ino)}:${String(stats.birthtimeNs)}`;
    } catch {
      return undefined;
    }
  }

  /** Why Node must not delete the folder, or undefined. */
  private unsafeToDelete(worktree: WorktreeRef): string | undefined {
    const awg = join(resolve(worktree.repo), AWG_FOLDER);
    for (const folder of [awg, join(awg, 'wt'), resolve(worktree.path)]) {
      try {
        if (lstatSync(folder).isSymbolicLink()) return `Refused: ${folder} is a link`;
      } catch {
        // Missing: nothing to follow.
      }
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
    if (result.truncated) throw new GitStepError(`The output of git ${args[0] ?? ''} was too large to read in full`);
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
    // Below .awg only `<repo>\.awg\wt\<name>` itself is a worktree: no other folder there is the pipeline's to touch.
    const awg = join(resolve(worktree.repo), AWG_FOLDER);
    const lexical = resolve(worktree.path).toLowerCase();
    if (lexical === awg.toLowerCase() || lexical.startsWith(`${awg.toLowerCase()}\\`) || isInside(awg, worktree.path)) {
      const wanted = join(awg, 'wt', basename(resolve(worktree.path)));
      if (lexical !== wanted.toLowerCase() || !SAFE_NAME.test(basename(wanted)) || basename(wanted).endsWith('.')) {
        throw new GitStepError(`A worktree below ${AWG_FOLDER} must be ${join(AWG_FOLDER, 'wt', '<name>')}`);
      }
    }
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

  /** Where the files of the merge's conflicts are written down (in the worktree's own git folder). */
  private async conflictRecord(cwd: string): Promise<string> {
    return resolve(cwd, (await this.must(['rev-parse', '--git-path', 'awg-conflicts'], cwd)).trim());
  }

  /** The conflict's files are noted at the merge: once an agent `git add`s one, git no longer lists it as unmerged. */
  private async rememberConflicts(cwd: string, files: readonly string[]): Promise<void> {
    writeFileSync(await this.conflictRecord(cwd), files.join('\0'), 'utf8');
  }

  private async forgetConflicts(cwd: string): Promise<void> {
    rmSync(await this.conflictRecord(cwd), { force: true });
  }

  /** Files that conflicted in the merge in progress: unmerged now, or noted when the merge reported them. */
  private async conflictedFiles(cwd: string): Promise<string[]> {
    let noted: string[] = [];
    try {
      noted = readFileSync(await this.conflictRecord(cwd), 'utf8').split('\0').filter((file) => file !== '');
    } catch {
      // Not written (a merge not made by this adapter): only what git lists now.
    }
    return [...new Set([...noted, ...(await this.unmergedFiles(cwd))])];
  }

  /**
   * The conflicted files in which unresolved conflict markers are staged. git decides what a marker is
   * (`diff --cached --check` knows the `conflict-marker-size` attribute); whitespace rules are switched off. A
   * file counts as unresolved when git flags both a start (`<<<<<<<`) and an end (`>>>>>>>`) marker in it: a lone
   * marker-looking line is ordinary text, kept. Only conflicted files are looked at, so text about markers in
   * other files is never refused.
   *
   * Known trade-offs, both pinned by tests: a half-resolved file with only one kind of marker left is committed
   * (a miss), and a conflicted file whose resolution legitimately shows both kinds (a document about conflicts) is
   * refused (a false alarm) unless the repository sets a larger `conflict-marker-size` for it.
   */
  private async unresolvedConflicts(cwd: string, files: readonly string[]): Promise<string[]> {
    if (files.length === 0) return [];
    const check = await this.git(
      ['-c', 'core.whitespace=-trailing-space,-space-before-tab', '-c', 'core.quotepath=false', 'diff', '--cached', '--check', '--', ...files.map((file) => `:(literal)${file}`)],
      cwd,
    );
    if (check.code !== 0 && check.code !== 2) throw new GitStepError(detailOf(check));
    if (check.truncated) throw new GitStepError('The conflict marker check printed too much to read in full; nothing was committed');
    // The lines are read from the index, the content that is about to be committed: the working file may differ
    // (resolved by hand after the conflict was staged, or left out of the add by an exclude).
    const kinds = new Map<string, Set<string>>();
    const staged = new Map<string, string[]>();
    for (const line of check.stdout.split('\n')) {
      const found = /^(.+):(\d+): leftover conflict marker/.exec(line.replace(/\r$/, ''));
      if (found === null) continue;
      const [, file = '', number = '0'] = found;
      if (!staged.has(file)) {
        const blob = await this.git(['cat-file', '-p', `:${file}`], cwd);
        // A blob that cannot be read in full is not "no markers": nothing is committed on a guess.
        if (blob.code !== 0 || blob.truncated) throw new GitStepError(`The staged content of ${file} could not be read in full to check it for conflict markers`);
        staged.set(file, blob.stdout.split('\n'));
      }
      const text = staged.get(file)?.[Number(number) - 1] ?? '';
      if (text.startsWith('<') || text.startsWith('>')) kinds.set(file, (kinds.get(file) ?? new Set<string>()).add(text.charAt(0)));
    }
    return [...kinds].filter(([, set]) => set.has('<') && set.has('>')).map(([file]) => file);
  }

  /** `-c user.name -c user.email` for the GUI's own commits, only when git has no identity to use. */
  private async identityArguments(cwd: string): Promise<string[]> {
    if ((await this.git(['var', 'GIT_COMMITTER_IDENT'], cwd)).code === 0) return [];
    return ['-c', `user.name=${this.identity.name}`, '-c', `user.email=${this.identity.email}`];
  }

  /** The checkout has `ref` checked out at `commit` with nothing out of line: HEAD, index and tracked files agree. */
  private async checkoutAt(path: string, commit: string, ref: string): Promise<boolean> {
    try {
      const symbolic = await this.git(['symbolic-ref', '-q', 'HEAD'], path);
      return existsSync(path) && symbolic.stdout.trim() === ref && (await this.head(path)) === commit && !(await this.hasTrackedChanges(path));
    } catch {
      return false;
    }
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

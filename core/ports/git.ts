// Git port (T028, R-06, SP-07): the git operations the task pipeline runs on the host. The git adapter
// (T030) implements it; the pipeline (T032) uses it. Every command runs with `-c core.longpaths=true`:
// without it git skips a too-long path with only a warning and exit code 0, so a file silently misses
// its commit (SP-07 G6).
//
// The GUI's git touches only what the pipeline made — task worktrees and branches, integration worktrees —
// and moves the target branch only by fast-forward. It never pushes, never rewrites history, and never
// resets the target branch. Expected outcomes (a conflict, a branch that moved, a worktree that could not be
// removed) are results, not exceptions; a thrown error means git could not be run at all.

/** A worktree the pipeline made: its folder and the branch checked out there. */
export interface WorktreeRef {
  /** The repository's top folder (the main checkout). */
  repo: string;
  /** Short, e.g. `<repo>\.awg\wt\<task>` (SP-07 G6). */
  path: string;
  branch: string;
}

/** Git ran and refused or failed; `detail` is git's own message, safe to show (no tokens). */
export interface GitFailure {
  status: 'failed';
  detail: string;
}

/**
 * `removed`: gone and unregistered. `pending-cleanup`: `worktree remove --force` failed (a process held a file,
 * or the folder is half deleted though no longer registered); `retryCleanup` finishes it later with Node
 * `rmSync` and `worktree prune` (SP-07 G1). Never thrown.
 */
export type CleanupResult = { status: 'removed' } | { status: 'pending-cleanup'; detail: string };

export type CreateWorktreeResult = { status: 'created'; baseCommit: string } | { status: 'exists'; baseCommit: string } | GitFailure;

/** `nothing`: no change to commit (the agent changed nothing, or only ignored files). */
export type CommitResult = { status: 'committed'; commit: string } | { status: 'nothing'; commit: string } | GitFailure;

/**
 * `merge --no-ff` in an integration worktree. `conflict` (git exit code 1): `files` from
 * `diff --name-only --diff-filter=U`, the merge left in progress for an agent or `abortMerge`.
 */
export type MergeResult = { status: 'merged'; commit: string } | { status: 'conflict'; files: string[] } | GitFailure;

/**
 * Fast-forward of the target branch to the tested commit (R-06 step 5). `moved`: the branch is no longer at
 * `expected` (someone else updated it), nothing changed and the merge starts again from step 1. `refused`:
 * it cannot move without touching someone's work; nothing changed. A branch checked out in any worktree is
 * never moved by its ref alone, which would leave that checkout's index and files behind its HEAD: that
 * checkout is fast-forwarded itself (`merge --ff-only`, refusing when it has local changes), else `refused`.
 */
export type AdvanceResult = { status: 'advanced' } | { status: 'moved'; current: string } | { status: 'refused'; detail: string } | GitFailure;

export interface WorktreeStatus {
  head: string;
  branch?: string;
  /** Tracked or untracked changes not committed. */
  dirty: boolean;
  /** A merge is in progress (conflicts not committed or aborted). */
  merging: boolean;
  conflictFiles: string[];
}

export interface GitPort {
  /** The commit a branch points at; `undefined` when there is no such branch. */
  resolveBranch(repo: string, branch: string): Promise<string | undefined>;
  /** Creates `branch` at `base` (a commit) and checks it out in a new worktree at `path`; `exists` when both already match. */
  createWorktree(worktree: WorktreeRef, base: string): Promise<CreateWorktreeResult>;
  /**
   * Commits everything changed in the worktree, as the GUI does at a handoff (R-06): the agent need not
   * commit. `exclude` are pathspecs never added, such as setup outputs not in `.gitignore` (SP-07 G1, G2).
   */
  commitAll(worktree: WorktreeRef, message: string, exclude: readonly string[]): Promise<CommitResult>;
  /** `merge --no-ff <branch>` into the integration worktree's branch. */
  merge(integration: WorktreeRef, branch: string, message: string): Promise<MergeResult>;
  /** `merge --abort`: puts the integration worktree back exactly as before the merge. */
  abortMerge(integration: WorktreeRef): Promise<{ status: 'aborted' } | GitFailure>;
  /** Moves `branch` from `expected` to `to` only if that is a fast-forward and the branch is still at `expected`. */
  advanceBranch(repo: string, branch: string, expected: string, to: string): Promise<AdvanceResult>;
  status(worktree: WorktreeRef): Promise<WorktreeStatus>;
  /**
   * Removes the worktree (`worktree remove --force`) once the GUI ended its own processes in it, and deletes
   * its branch when `deleteBranch` (a merged task's). A failure is `pending-cleanup`, never an exception.
   */
  removeWorktree(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult>;
  /** Finishes a `pending-cleanup`: `rmSync` of the folder, then `worktree prune`. */
  retryCleanup(worktree: WorktreeRef, options: { deleteBranch: boolean }): Promise<CleanupResult>;
}

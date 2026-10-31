// Git / worktree adapter (T030): GitPort on the host's git.
export { GitAdapter, type GitAdapterOptions, worktreePath } from './adapter';
export { createGitRunner, GitRunError, type GitResult, type GitRunner, type GitRunnerOptions } from './run';

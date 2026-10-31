// What the task pipeline (T032, R-06, CR-3) needs besides the GitPort: running the project's setup and test
// commands in a worktree, and a look at a worktree's folder. Both are the pipeline's own small interfaces,
// implemented in the main process (core has no processes and no file system).
import type { ProjectCommands } from '../../contracts';

export type CommandShell = NonNullable<ProjectCommands['shell']>;

export interface CommandSpec {
  /** The project's (or the workflow's) setup or test command, run as the shell's command line. */
  command: string;
  shell: CommandShell;
  /** A worktree the pipeline made. */
  cwd: string;
  /** Names the run, so the main process can keep its processes apart (one Job per run). */
  key: string;
  purpose: 'setup' | 'test';
}

/** How a command ended. `exitCode` null: it could not be started, was killed or timed out (`detail` says which). */
export interface CommandOutcome {
  exitCode: number | null;
  /** The end of its output; never the whole log. */
  outputTail: string;
  detail?: string;
}

export interface RunningCommand {
  readonly done: Promise<CommandOutcome>;
  /** Ends the command and everything it started; `done` then resolves with exitCode null. */
  kill(): Promise<void>;
}

export interface CommandRunner {
  run(spec: CommandSpec): RunningCommand;
}

/**
 * One path the setup script changed in a worktree (r1 P1-6): its content then (`sha256:<hex>`), `deleted`, or
 * `dir` for a whole folder that was not there (an untracked folder git lists as one entry, e.g. node_modules).
 * `tracked`: git tracked the path before (setup changed a file of the repository).
 */
export interface SetupChange {
  /** Relative to the worktree, `/` separated. */
  path: string;
  state: string;
  tracked: boolean;
}

export interface WorktreeFiles {
  /** Whether a folder exists (a session's cwd, a worktree). */
  exists(path: string): boolean;
  /** Every path that differs from the worktree's commit (git ignores what `.gitignore` ignores). */
  changes(worktree: string): Promise<SetupChange[]>;
  /** The state of one path now, in the terms of `SetupChange.state` (`dir` when it is a folder). */
  stateOf(worktree: string, path: string): Promise<string>;
  /** Keeps what a setup changed with the worktree (its own git folder), so a restart still knows. */
  saveSetupChanges(worktree: string, changes: readonly SetupChange[]): Promise<void>;
  /** What `saveSetupChanges` kept; undefined when nothing was. */
  loadSetupChanges(worktree: string): Promise<SetupChange[] | undefined>;
  /** Takes paths out of the index (`git reset -- <paths>`): a staged setup output is not committed (r2 P1-4). */
  unstage(worktree: string, paths: readonly string[]): Promise<void>;
  /** Puts paths back as the worktree's commit has them, index and files (G-13: before a setup runs again). */
  restore(worktree: string, paths: readonly string[]): Promise<void>;
}

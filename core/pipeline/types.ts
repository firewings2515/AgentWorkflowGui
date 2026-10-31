// What the task pipeline (T032, R-06, CR-3) needs besides the GitPort: running the project's setup and test
// commands in a worktree, and a look at a worktree's folder. Both are the pipeline's own small interfaces,
// implemented in the main process (core has no processes and no file system).
import type { ProjectCommands, Timestamp } from '../../contracts';

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

export interface WorktreeFiles {
  /** Whether a folder exists (a session's cwd, a worktree). */
  exists(path: string): boolean;
  /**
   * Top-level entries of a worktree created within [from, to]: what the setup script made (SP-07 G1, G2).
   * Names relative to the worktree, with `/` separators.
   */
  createdBetween(path: string, from: Timestamp, to: Timestamp): string[];
}

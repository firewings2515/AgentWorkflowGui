// Runs git as a child process on the host (T030). Every command gets `-c core.longpaths=true` here, in the one
// place that starts git: without it git skips a too-long path with only a warning and exit code 0, so a file
// silently misses its commit (SP-07 G6). A non-zero exit code is a result; only "git could not be run" or
// "did not finish" rejects.
import { type ChildProcessWithoutNullStreams, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Output beyond the size kept was dropped: what is here is not all git said. */
  truncated: boolean;
}

export interface GitRunOptions {
  cwd: string;
  /** Written to git's stdin, then closed. */
  input?: string;
}

/** `args` are what follows `git -c core.longpaths=true`. */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitResult>;

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;

export interface GitRunnerOptions {
  /** The git executable (default: `git`, found through PATH). */
  gitPath?: string;
  /** Added to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** A command that has not finished by then is killed and rejects (default 5 minutes). */
  timeoutMs?: number;
  /** Tests only: replaces `child_process.spawn`, to see the arguments of every command. */
  spawn?: SpawnFunction;
}

/** git could not be run, or did not finish: nothing can be said about what it did. */
export class GitRunError extends Error {
  override name = 'GitRunError';
}

/** Variables that would send git to another repository than the one the command names. */
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES'];
/** Stdout and stderr are kept up to this size; more is dropped, the exit code still counts. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const defaultSpawn: SpawnFunction = (command, args, options) => nodeSpawn(command, [...args], { ...options, stdio: 'pipe' });

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const spawn = options.spawn ?? defaultSpawn;
  const gitPath = options.gitPath ?? 'git';
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const environment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    for (const name of REDIRECTING) delete env[name];
    // Never wait for a person: no credential or editor prompt (the GUI makes no network calls and passes every message).
    return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: ':', GIT_OPTIONAL_LOCKS: '0' };
  };

  return (args, { cwd, input }) =>
    new Promise<GitResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(gitPath, ['-c', 'core.longpaths=true', ...args], { cwd, env: environment(), windowsHide: true });
      } catch (error) {
        reject(new GitRunError(`git could not be started (${error instanceof Error ? error.message : String(error)})`));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outSize = 0;
      let errSize = 0;
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() => reject(new GitRunError(`git ${args[0] ?? ''} did not finish within ${String(timeoutMs)} ms`)));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (outSize < MAX_OUTPUT_BYTES) out.push(chunk);
        outSize += chunk.length;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errSize < MAX_OUTPUT_BYTES) err.push(chunk);
        errSize += chunk.length;
      });
      child.on('error', (error) => finish(() => reject(new GitRunError(`git could not be run (${error.message})`))));
      child.on('close', (code) =>
        finish(() => resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          truncated: outSize > MAX_OUTPUT_BYTES || errSize > MAX_OUTPUT_BYTES,
        })),
      );
      // git may exit before reading its input: the exit code tells.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
}

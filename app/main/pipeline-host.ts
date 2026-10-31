// What the task pipeline (T032) needs of the host: the project's setup and test commands run in a worktree, each
// in a Job of its own (R-14: a GUI that dies takes them with it, and orphans are found by PID and creation time),
// and a look at a worktree's folder.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { SessionId } from '../../contracts';
import { createGitRunner, type GitRunner } from '../../adapters/git';
import type { CommandOutcome, CommandRunner, CommandSpec, RunningCommand, SetupChange, WorktreeFiles } from '../../core/pipeline';
import type { BackendProcessHost } from './backend';

const TAIL = 4000;
/** Longest a command may run; past it, it is ended as failed (a hung install or test). */
const LIMITS: Record<CommandSpec['purpose'], number> = { setup: 30 * 60_000, test: 60 * 60_000 };

/** The command line of a shell (PowerShell by default), run without a profile, without input. */
export const shellCommand = (spec: Pick<CommandSpec, 'command' | 'shell'>): { command: string; args: string[] } =>
  spec.shell === 'cmd'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', spec.command] }
    : { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', spec.command] };

/**
 * Runs each command in a Job of its own; `kill` (and the end of the command) closes that Job, so whatever the
 * command started ends with it. The process host records them like a runtime's processes: it has no other
 * entry for a command, and its record names a runtime (T032 report G-7).
 */
export const jobCommandRunner = (host: Pick<BackendProcessHost, 'spawn' | 'closeJob'>, options: { limits?: Partial<typeof LIMITS>; log?: (message: string) => void } = {}): CommandRunner => ({
  run(spec: CommandSpec): RunningCommand {
    const job = SessionId.parse(`cmd-${spec.purpose}-${randomUUID()}`);
    let output = '';
    const keep = (text: string) => {
      output = (output + text).slice(-TAIL);
    };
    let ended = false;
    /** Set before the Job is closed by `kill` or the limit: the exit that follows is that, not the command's. */
    let ending: string | undefined;
    let finish: (outcome: CommandOutcome) => void = () => undefined;
    const done = new Promise<CommandOutcome>((resolve) => {
      finish = (outcome) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        void host.closeJob(job).catch(() => undefined);
        resolve(outcome);
      };
    });
    const timer = setTimeout(() => {
      ending = `the ${spec.purpose} command ran past its limit and was ended`;
      finish({ exitCode: null, outputTail: output, detail: ending });
    }, options.limits?.[spec.purpose] ?? LIMITS[spec.purpose]);
    timer.unref();
    try {
      const { command, args } = shellCommand(spec);
      const child = host.spawn(job, 'codex', { command, args, cwd: spec.cwd });
      child.stdin.end();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.once('close', (code: number | null) =>
        finish(ending !== undefined || code === null ? { exitCode: null, outputTail: output, detail: ending ?? 'the command was ended' } : { exitCode: code, outputTail: output }),
      );
      child.once('error', (error: Error) => finish({ exitCode: null, outputTail: output, detail: `the ${spec.purpose} command failed: ${error.message}` }));
    } catch (error) {
      finish({ exitCode: null, outputTail: '', detail: `the ${spec.purpose} command could not be started: ${error instanceof Error ? error.message : String(error)}` });
    }
    return {
      done,
      kill: async () => {
        ending ??= 'the command was ended';
        await host.closeJob(job).catch((error: unknown) => options.log?.(`[pipeline] ending a ${spec.purpose} command failed (${error instanceof Error ? error.name : 'error'})`));
        finish({ exitCode: null, outputTail: output, detail: 'the command was ended' });
      },
    };
  },
});

/** A worktree's name below `.awg\wt`, as the git adapter allows it (T030 `SAFE_NAME`; no trailing dot). */
const SAFE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i;

/**
 * Whether a path has the shape of a pipeline worktree or something inside one: `<repo>\.awg\wt\<name>[\...]`
 * with `<name>` a name the git adapter would make (T030). The caller also asks the pipeline whether it made it.
 */
export const isPipelineFolder = (path: string): boolean => {
  const parts = path.split(/[\\/]+/);
  for (let i = 0; i + 2 < parts.length; i++) {
    if (parts[i]?.toLowerCase() !== '.awg' || parts[i + 1]?.toLowerCase() !== 'wt') continue;
    const name = parts[i + 2] ?? '';
    if (SAFE_NAME.test(name) && !name.endsWith('.')) return true;
  }
  return false;
};

/** The state of a path in a worktree: the hash of its content, `dir`, or `deleted` (`SetupChange.state`). */
export const pathState = (worktree: string, path: string): string => {
  const full = join(worktree, ...path.split('/'));
  let stats;
  try {
    stats = lstatSync(full);
  } catch {
    return 'deleted';
  }
  if (stats.isDirectory()) return 'dir';
  return `sha256:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
};

/** The file that keeps what a worktree's setup changed: in the worktree's own git folder, never in the worktree. */
const recordOf = (worktree: string): string => {
  const dotGit = join(worktree, '.git');
  if (statSync(dotGit).isDirectory()) return join(dotGit, 'awg-setup-changes.json');
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
  if (pointer === undefined) throw new Error(`${dotGit} names no git folder`);
  return join(isAbsolute(pointer) ? pointer : resolve(worktree, pointer), 'awg-setup-changes.json');
};

/**
 * Every path of `git status --porcelain -z` (what `.gitignore` ignores is left out; a folder that is new as a whole
 * is one `dir` entry). The output is read in full or not at all.
 */
export const statusChanges = async (run: GitRunner, worktree: string): Promise<SetupChange[]> => {
  const result = await run(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: worktree });
  if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim() || String(result.code)}`);
  if (result.truncated) throw new Error('git status printed too much to read in full');
  const fields = result.stdout.split('\0');
  const out: SetupChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') {
      out.push(path.endsWith('/') ? { path: path.slice(0, -1), state: 'dir', tracked: false } : { path, state: pathState(worktree, path), tracked: false });
      continue;
    }
    out.push({ path, state: pathState(worktree, path), tracked: !code.startsWith('A') });
    // A rename or copy names its source next: gone from where it was.
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = fields[++i] ?? '';
      if (from !== '' && code.startsWith('R')) out.push({ path: from, state: pathState(worktree, from), tracked: true });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** Folders on disk and what a setup changed in a worktree (r1 P1-6), through git's own status. */
export const gitWorktreeFiles = (run: GitRunner = createGitRunner()): WorktreeFiles => ({
  exists: (path) => existsSync(path),
  changes: (worktree) => statusChanges(run, worktree),
  stateOf: (worktree, path) => Promise.resolve(pathState(worktree, path)),
  saveSetupChanges(worktree, changes) {
    writeFileSync(recordOf(worktree), JSON.stringify(changes), 'utf8');
    return Promise.resolve();
  },
  loadSetupChanges(worktree) {
    const file = recordOf(worktree);
    if (!existsSync(file)) return Promise.resolve(undefined);
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${file} is not a list`);
    return Promise.resolve(parsed as SetupChange[]);
  },
  async unstage(worktree, paths) {
    // Index only, and only the paths named (the setup's record): the worktree's files stay as they are.
    const result = await run(['reset', '-q', '--', ...paths.map((p) => `:(literal)${p}`)], { cwd: worktree });
    if (result.code !== 0) throw new Error(`git reset failed: ${result.stderr.trim() || String(result.code)}`);
  },
  async restore(worktree, paths) {
    // Index and files back to the worktree's commit, only for the paths named.
    const result = await run(['checkout', '-q', 'HEAD', '--', ...paths.map((p) => `:(literal)${p}`)], { cwd: worktree });
    if (result.code !== 0) throw new Error(`git checkout failed: ${result.stderr.trim() || String(result.code)}`);
  },
});

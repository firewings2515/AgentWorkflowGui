// What the task pipeline (T032) needs of the host: the project's setup and test commands run in a worktree, each
// in a Job of its own (R-14: a GUI that dies takes them with it, and orphans are found by PID and creation time),
// and a look at a worktree's folder.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SessionId } from '../../contracts';
import type { CommandOutcome, CommandRunner, CommandSpec, RunningCommand, WorktreeFiles } from '../../core/pipeline';
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

/** Folders on disk: whether one exists, and the top-level entries a setup made (by their creation time). */
export const worktreeFiles: WorktreeFiles = {
  exists: (path) => existsSync(path),
  createdBetween(path, from, to) {
    const start = Date.parse(from);
    const end = Date.parse(to);
    const made: string[] = [];
    for (const name of readdirSync(path)) {
      if (name === '.git') continue;
      try {
        const born = lstatSync(join(path, name)).birthtimeMs;
        if (born >= start && born <= end) made.push(name);
      } catch {
        // Gone meanwhile.
      }
    }
    return made.sort();
  },
};

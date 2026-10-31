// The pipeline's commands and folders in memory (T032 tests). A script decides how each command ends: an exit
// code and output, or never (a crash while it ran, the process gone with the GUI). Folders come from the
// memory git; what a setup made is recorded with the time it was made.
import type { Timestamp } from '../../../contracts';
import type { CommandOutcome, CommandRunner, CommandSpec, RunningCommand, WorktreeFiles } from '../types';
import type { MemoryGit } from './memory-git';

export type Script = (spec: CommandSpec) => CommandOutcome | 'hang' | Promise<CommandOutcome>;

export class FakeCommands implements CommandRunner {
  readonly runs: CommandSpec[] = [];
  readonly killed: CommandSpec[] = [];
  script: Script = () => ({ exitCode: 0, outputTail: 'ok' });

  run(spec: CommandSpec): RunningCommand {
    this.runs.push(spec);
    let settle: (outcome: CommandOutcome) => void = () => undefined;
    const killed = new Promise<CommandOutcome>((resolve) => {
      settle = resolve;
    });
    const scripted = this.script(spec);
    const done = scripted === 'hang' ? killed : Promise.race([Promise.resolve(scripted), killed]);
    return {
      done,
      kill: () => {
        this.killed.push(spec);
        settle({ exitCode: null, outputTail: '', detail: 'killed' });
        return Promise.resolve();
      },
    };
  }

  /** The runs of one purpose, in order. */
  of(purpose: CommandSpec['purpose']): CommandSpec[] {
    return this.runs.filter((r) => r.purpose === purpose);
  }
}

export class FakeFiles implements WorktreeFiles {
  /** Top-level entries made in a folder, with when. */
  readonly made: { path: string; name: string; at: Timestamp }[] = [];
  /** Folders that exist although no checkout is there (left by a failed removal). */
  readonly extra = new Set<string>();

  constructor(private readonly git: MemoryGit) {}

  exists(path: string): boolean {
    const k = path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
    return this.git.folders.has(k) || this.extra.has(k);
  }

  createdBetween(path: string, from: Timestamp, to: Timestamp): string[] {
    const k = path.toLowerCase();
    return [...new Set(this.made.filter((m) => m.path.toLowerCase() === k && m.at >= from && m.at <= to).map((m) => m.name))];
  }
}

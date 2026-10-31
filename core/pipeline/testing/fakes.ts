// The pipeline's commands and folders in memory (T032 tests). A script decides how each command ends: an exit
// code and output, or never (a crash while it ran, the process gone with the GUI). Folders and their changes
// come from the memory git; what a setup changed is kept per worktree, like the main process keeps it.
import type { CommandOutcome, CommandRunner, CommandSpec, RunningCommand, SetupChange, WorktreeFiles } from '../types';
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

const folderKey = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
const stateOfContent = (content: string | undefined) => (content === undefined ? 'deleted' : `sha256:${content}`);

export class FakeFiles implements WorktreeFiles {
  /** Folders that exist although no checkout is there (left by a failed removal). */
  readonly extra = new Set<string>();
  /** What each worktree's setup changed, as saved. */
  readonly saved = new Map<string, SetupChange[]>();
  /** Makes the next `changes` (or `loadSetupChanges`) call throw. */
  failNext: 'changes' | 'load' | undefined;

  constructor(private readonly git: MemoryGit) {}

  exists(path: string): boolean {
    const k = folderKey(path);
    return this.git.folders.has(k) || this.extra.has(k);
  }

  changes(worktree: string): Promise<SetupChange[]> {
    if (this.failNext === 'changes') {
      this.failNext = undefined;
      return Promise.reject(new Error('git status failed'));
    }
    const files = this.git.tree(worktree)?.files ?? new Map<string, string>();
    const head = this.git.headFiles(worktree);
    const out: SetupChange[] = [];
    for (const path of new Set([...files.keys(), ...head.keys()])) {
      if (files.get(path) !== head.get(path)) out.push({ path, state: stateOfContent(files.get(path)), tracked: head.has(path) });
    }
    return Promise.resolve(out.sort((a, b) => (a.path < b.path ? -1 : 1)));
  }

  stateOf(worktree: string, path: string): Promise<string> {
    return Promise.resolve(stateOfContent(this.git.tree(worktree)?.files.get(path)));
  }

  saveSetupChanges(worktree: string, changes: readonly SetupChange[]): Promise<void> {
    this.saved.set(folderKey(worktree), [...changes]);
    return Promise.resolve();
  }

  loadSetupChanges(worktree: string): Promise<SetupChange[] | undefined> {
    if (this.failNext === 'load') {
      this.failNext = undefined;
      return Promise.reject(new Error('unreadable'));
    }
    return Promise.resolve(this.saved.get(folderKey(worktree)));
  }
}

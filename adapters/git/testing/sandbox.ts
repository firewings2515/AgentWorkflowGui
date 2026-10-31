// Test support for the git adapter (T030): throw-away repositories in a folder made with mkdtemp, a git that
// reads no user or system configuration, and a spy on every command the adapter starts. Nothing here touches a
// repository the tests did not create; `dispose` deletes the one folder by its explicit path.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeRef } from '../../../core/ports/git';
import { GitAdapter, worktreePath } from '../adapter';
import { createGitRunner, type GitRunner, type SpawnFunction } from '../run';

export interface Sandbox {
  /** The folder every repository below lives in. */
  root: string;
  /** Every argument list the adapter started, in order. */
  calls: string[][];
  adapter: GitAdapter;
  /** Plain git in a repository, for arranging and checking; not recorded in `calls`. */
  git(cwd: string, ...args: string[]): Promise<string>;
  newRepo(name?: string): Promise<string>;
  /** Writes a file (creating folders) and returns its path. */
  write(base: string, relative: string, content: string): string;
  commitFile(repo: string, relative: string, content: string, message?: string): Promise<string>;
  task(repo: string, name: string): WorktreeRef;
  /** The adapter's configuration without a user identity, so it has to supply one. */
  anonymousAdapter(): GitAdapter;
  /** An adapter whose every command is preceded by `before`: another process doing something in the middle of an operation. */
  hooked(before: (args: readonly string[], cwd: string) => Promise<void>): GitAdapter;
  children: ChildProcess[];
  dispose(): void;
}

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };

export function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'awg-t030-'));
  const identified = join(root, 'identified.gitconfig');
  const anonymous = join(root, 'anonymous.gitconfig');
  writeFileSync(identified, '[user]\n\tname = Test User\n\temail = test@example.invalid\n');
  writeFileSync(anonymous, '[user]\n\tuseConfigOnly = true\n');
  const isolated = (config: string): NodeJS.ProcessEnv => ({ GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' });

  const calls: string[][] = [];
  const children: ChildProcess[] = [];
  const spy: SpawnFunction = (command, args, options) => {
    calls.push([...args]);
    return spawn(command, [...args], { ...options, stdio: 'pipe' });
  };
  const adapter = new GitAdapter({ env: isolated(identified), spawn: spy });
  const plain: GitRunner = createGitRunner({ env: { ...isolated(identified), ...IDENTITY } });

  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await plain(args, { cwd });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };
  let counter = 0;
  const write = (base: string, relative: string, content: string): string => {
    const file = join(base, relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const commitFile = async (repo: string, relative: string, content: string, message = `change ${relative}`): Promise<string> => {
    write(repo, relative, content);
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', message);
    return (await git(repo, 'rev-parse', 'HEAD')).trim();
  };

  return {
    root,
    calls,
    adapter,
    git,
    async newRepo(name = `repo${String(++counter)}`) {
      const repo = join(root, name);
      mkdirSync(repo);
      await git(repo, 'init', '-q', '-b', 'main');
      await commitFile(repo, 'README.md', 'start\n', 'initial');
      return repo;
    },
    write,
    commitFile,
    task: (repo, name) => ({ repo, path: worktreePath(repo, name), branch: `task/${name}` }),
    anonymousAdapter: () => new GitAdapter({ env: isolated(anonymous) }),
    hooked: (before) => {
      const inner = createGitRunner({ env: isolated(identified) });
      return new GitAdapter({
        run: async (args, options) => {
          await before(args, options.cwd);
          return inner(args, options);
        },
      });
    },
    children,
    dispose() {
      for (const child of children) if (child.exitCode === null) child.kill();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// The git process runner (T030): the longpaths flag in front of every command, the environment git is given,
// and "could not run" as the only rejection.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseWorktreeList, sanitizeDetail } from './paths';
import { createGitRunner, GitRunError, type SpawnFunction } from './run';

describe('createGitRunner', () => {
  it('puts -c core.longpaths=true in front of the arguments and returns a non-zero exit as a result', async () => {
    const seen: string[][] = [];
    const spy: SpawnFunction = (command, args, options) => {
      seen.push([...args]);
      return createGitRunnerSpawn(command, args, options);
    };
    const run = createGitRunner({ spawn: spy });
    const ok = await run(['--version'], { cwd: process.cwd() });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^git version/);
    const bad = await run(['no-such-command'], { cwd: process.cwd() });
    expect(bad.code).not.toBe(0);
    expect(seen).toEqual([
      ['-c', 'core.longpaths=true', '--version'],
      ['-c', 'core.longpaths=true', 'no-such-command'],
    ]);
  });

  it('removes variables that would point git at another repository, and never prompts', async () => {
    let env: NodeJS.ProcessEnv | undefined;
    const spy: SpawnFunction = (command, args, options) => {
      env = options.env;
      return createGitRunnerSpawn(command, args, options);
    };
    const before = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = 'C:\\somewhere\\else\\.git';
    try {
      await createGitRunner({ spawn: spy })(['--version'], { cwd: process.cwd() });
    } finally {
      if (before === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = before;
    }
    expect(env?.['GIT_DIR']).toBeUndefined();
    expect(env?.['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('rejects with GitRunError when git cannot be started or does not finish', async () => {
    await expect(createGitRunner({ gitPath: 'git-that-does-not-exist-t030' })(['status'], { cwd: process.cwd() })).rejects.toBeInstanceOf(GitRunError);
    await expect(createGitRunner({ timeoutMs: 1 })(['--version'], { cwd: process.cwd() })).rejects.toBeInstanceOf(GitRunError);
  });
});

describe('parseWorktreeList', () => {
  it('reads NUL separated entries: main checkout, branch, detached, locked, prunable', () => {
    const output = [
      'worktree C:/r\0HEAD aaa\0branch refs/heads/main\0\0',
      'worktree C:/r/.awg/wt/a\0HEAD bbb\0branch refs/heads/task/a\0locked reason\0\0',
      'worktree C:/r/.awg/wt/b\0HEAD ccc\0detached\0prunable gitdir file points to non-existent location\0\0',
    ].join('');
    expect(parseWorktreeList(output)).toEqual([
      { path: 'C:/r', head: 'aaa', branch: 'refs/heads/main', prunable: false, locked: false },
      { path: 'C:/r/.awg/wt/a', head: 'bbb', branch: 'refs/heads/task/a', prunable: false, locked: true },
      { path: 'C:/r/.awg/wt/b', head: 'ccc', branch: undefined, prunable: true, locked: false },
    ]);
  });
});

describe('sanitizeDetail', () => {
  it('drops credentials from URLs and bounds the length', () => {
    expect(sanitizeDetail('fatal: unable to access https://user:token@example.com/x.git\n')).toBe('fatal: unable to access https://example.com/x.git');
    expect(sanitizeDetail('x'.repeat(5000)).length).toBeLessThan(2100);
  });
});

function createGitRunnerSpawn(command: string, args: readonly string[], options: Parameters<SpawnFunction>[2]) {
  return spawn(command, [...args], { ...options, stdio: 'pipe' });
}

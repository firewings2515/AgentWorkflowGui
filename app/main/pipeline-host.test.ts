// T032: the setup and test commands run for real, each in a Job of its own (R-14), and the setup outputs found
// by their creation time. Everything happens in an mkdtemp folder that is deleted by its explicit path.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsProcessHost } from '../../adapters/process';
import { createGitRunner } from '../../adapters/git';
import { gitWorktreeFiles, isPipelineFolder, jobCommandRunner, shellCommand } from './pipeline-host';

const folders: string[] = [];
const hosts: WindowsProcessHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose().catch(() => undefined);
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'awg-t032-host-'));
  folders.push(made);
  return made;
};

describe.skipIf(process.platform !== 'win32')('pipeline commands (T032)', () => {
  it('runs a PowerShell or cmd command in the worktree, keeps the end of its output and its exit code, and ends its Job', async () => {
    const cwd = folder();
    const host = new WindowsProcessHost();
    hosts.push(host);
    const runner = jobCommandRunner(host);
    const ps = await runner.run({ command: "Write-Output ('in ' + (Get-Location).Path); exit 3", shell: 'powershell', cwd, key: 'k1', purpose: 'test' }).done;
    expect(ps.exitCode).toBe(3);
    expect(ps.outputTail).toContain(`in ${cwd}`);
    const cmd = await runner.run({ command: 'echo made> out.txt && echo done', shell: 'cmd', cwd, key: 'k2', purpose: 'setup' }).done;
    expect(cmd).toMatchObject({ exitCode: 0 });
    expect(cmd.outputTail).toContain('done');
    expect(await host.listOwned()).toEqual([]);
  }, 60_000);

  it('kill ends a command that hangs, and a limit ends one that runs too long', async () => {
    const cwd = folder();
    const host = new WindowsProcessHost();
    hosts.push(host);
    const runner = jobCommandRunner(host, { limits: { test: 1500 } });
    const hung = runner.run({ command: 'Start-Sleep -Seconds 60', shell: 'powershell', cwd, key: 'k3', purpose: 'setup' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await hung.kill();
    expect(await hung.done).toMatchObject({ exitCode: null, detail: 'the command was ended' });
    const slow = await runner.run({ command: 'Start-Sleep -Seconds 60', shell: 'powershell', cwd, key: 'k4', purpose: 'test' }).done;
    expect(slow).toMatchObject({ exitCode: null });
    expect(slow.detail).toContain('past its limit');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await host.listOwned()).toEqual([]);
  }, 60_000);

  it('a command that cannot start is a failed outcome, not an exception', async () => {
    const runner = jobCommandRunner({
      spawn: () => {
        throw new Error('no such shell');
      },
      closeJob: () => Promise.resolve({ ended: [] }),
    });
    expect(await runner.run({ command: 'x', shell: 'cmd', cwd: 'C:\\', key: 'k', purpose: 'setup' }).done).toMatchObject({ exitCode: null, detail: expect.stringContaining('no such shell') as unknown });
  });

  it('shell lines: PowerShell without a profile or input; cmd with /d /s /c', () => {
    expect(shellCommand({ command: 'npm ci', shell: 'powershell' })).toEqual({ command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'npm ci'] });
    expect(shellCommand({ command: 'npm ci', shell: 'cmd' })).toEqual({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm ci'] });
  });
});

describe('pipeline folders (T032 live run 1)', () => {
  it('a path inside a pipeline worktree is one; the repository, .awg itself and look-alikes are not', () => {
    expect(isPipelineFolder('C:\\ws\\.awg\\wt\\t-1a2b\\greet.js')).toBe(true);
    expect(isPipelineFolder('C:\\ws\\.awg\\wt\\m-1a2b')).toBe(true);
    expect(isPipelineFolder('C:/ws/.AWG/WT/t-1/node_modules/x.js')).toBe(true);
    expect(isPipelineFolder('C:\\ws\\greet.js')).toBe(false);
    expect(isPipelineFolder('C:\\ws\\.awg\\wt')).toBe(false);
    expect(isPipelineFolder('C:\\ws\\x.awg\\wt\\t-1\\a.js')).toBe(false);
    expect(isPipelineFolder('C:\\ws\\.awg\\other\\t-1\\a.js')).toBe(false);
    // Only names the git adapter would make (T030 SAFE_NAME): no device names, no trailing dot, no leading dot.
    expect(isPipelineFolder('C:\\ws\\.awg\\wt\\con\\a.js')).toBe(false);
    expect(isPipelineFolder('C:\\ws\\.awg\\wt\\t-1.\\a.js')).toBe(false);
    expect(isPipelineFolder('C:\\ws\\.awg\\wt\\.hidden\\a.js')).toBe(false);
    expect(isPipelineFolder(`C:\\ws\\.awg\\wt\\${'x'.repeat(65)}\\a.js`)).toBe(false);
  });
});

describe('worktree files (T032 r1 P1-6)', () => {
  it('lists what changed in a linked worktree (a new folder as one entry, files in existing folders, tracked edits and deletions) and keeps it in the worktree\'s own git folder', async () => {
    const root = folder();
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = createGitRunner({ env: { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    const must = async (cwd: string, ...args: string[]) => {
      const r = await git(args, { cwd });
      if (r.code !== 0) throw new Error(r.stderr);
    };
    writeFileSync(join(repo, 'README.md'), 'readme\n');
    writeFileSync(join(repo, 'src', 'app.txt'), 'app\n');
    writeFileSync(join(repo, 'gone.txt'), 'gone\n');
    await must(repo, 'init', '-q', '-b', 'main');
    await must(repo, 'add', '-A');
    await must(repo, 'commit', '-q', '-m', 'initial');
    const wt = join(root, 'wt');
    await must(repo, 'worktree', 'add', '-q', '-b', 'task', wt);
    const files = gitWorktreeFiles(git);
    expect(await files.changes(wt)).toEqual([]);
    // What a setup does: a new folder, a new file in an existing folder, a tracked edit, a deletion.
    mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(wt, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(wt, 'src', 'generated.txt'), 'generated\n');
    writeFileSync(join(wt, 'README.md'), 'readme, port 1\n');
    rmSync(join(wt, 'gone.txt'));
    const changes = await files.changes(wt);
    expect(changes.map((c) => [c.path, c.state === 'dir' || c.state === 'deleted' ? c.state : 'hash', c.tracked])).toEqual([
      ['README.md', 'hash', true],
      ['gone.txt', 'deleted', true],
      ['node_modules', 'dir', false],
      ['src/generated.txt', 'hash', false],
    ]);
    expect(await files.stateOf(wt, 'README.md')).toBe(changes[0]?.state);
    expect(await files.stateOf(wt, 'node_modules')).toBe('dir');
    // Kept in the worktree's own git folder (not in the worktree, not in git status), and read back.
    expect(await files.loadSetupChanges(wt)).toBeUndefined();
    await files.saveSetupChanges(wt, changes);
    expect(await files.loadSetupChanges(wt)).toEqual(changes);
    expect((await files.changes(wt)).length).toBe(4);
    writeFileSync(join(wt, 'README.md'), 'readme, changed by the agent\n');
    expect(await files.stateOf(wt, 'README.md')).not.toBe(changes[0]?.state);
    // G-13: put back as the commit has them, index and files; r2 P1-4: out of the index, files kept.
    await must(wt, 'add', 'src/generated.txt');
    await files.restore(wt, ['README.md', 'gone.txt']);
    expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('readme\n');
    expect(readFileSync(join(wt, 'gone.txt'), 'utf8')).toBe('gone\n');
    await files.unstage(wt, ['src/generated.txt']);
    const staged = await git(['diff', '--cached', '--name-only'], { cwd: wt });
    expect(staged.stdout.trim()).toBe('');
    expect(readFileSync(join(wt, 'src', 'generated.txt'), 'utf8')).toBe('generated\n');
    expect(files.exists(wt)).toBe(true);
    expect(files.exists(join(wt, 'nope'))).toBe(false);
  }, 30_000);
});

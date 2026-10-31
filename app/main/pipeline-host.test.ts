// T032: the setup and test commands run for real, each in a Job of its own (R-14), and the setup outputs found
// by their creation time. Everything happens in an mkdtemp folder that is deleted by its explicit path.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsProcessHost } from '../../adapters/process';
import { jobCommandRunner, shellCommand, worktreeFiles } from './pipeline-host';

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

describe('worktree files (T032)', () => {
  it('lists the top-level entries made within the setup window, not those made before or after, nor .git', async () => {
    const path = folder();
    writeFileSync(join(path, 'tracked.txt'), 'x');
    writeFileSync(join(path, '.git'), 'gitdir: x');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const from = new Date().toISOString();
    mkdirSync(join(path, 'node_modules'));
    writeFileSync(join(path, 'node_modules', 'a.js'), 'a');
    writeFileSync(join(path, '.env.local'), 'PORT=1');
    const to = new Date(Date.now() + 1).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(join(path, 'agent.txt'), 'later');
    expect(worktreeFiles.createdBetween(path, from, to)).toEqual(['.env.local', 'node_modules']);
    expect(worktreeFiles.exists(path)).toBe(true);
    expect(worktreeFiles.exists(join(path, 'nope'))).toBe(false);
  });
});

// T042 (V-04): out-of-scope access on the real file system. Everything below lives in one mkdtemp folder: the
// session folder `ws`, an outside folder `far`, and links between them. The policy runs with the main process's
// own `resolveRealPath`, as the session service gives it. Claude's and Codex's forms of each attempt must both
// be refused, with the same rule.
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionRequest } from '../../contracts';
import { permissionPolicy } from '../../core/policy';
import type { PolicyContext } from '../../core/ports';
import { codexSingle, command, edit, request, tool } from '../../core/policy/testing/requests';
import { realFolder } from './exe-search';
import { resolveRealPath } from './real-path';

let base = '';
let ws = '';
let far = '';
const made: { symlink: boolean; short: { outside: string | undefined; inside: string | undefined } } = { symlink: false, short: { outside: undefined, inside: undefined } };

/** The 8.3 name Windows gives `path`, or undefined when the volume makes none. */
const shortName = (path: string): string | undefined => {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (r.stdout ?? '').trim();
  return r.status === 0 && out.includes('~') && out.toLowerCase() !== path.toLowerCase() ? out : undefined;
};

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'awg-t042-paths-')));
  ws = join(base, 'ws');
  far = join(base, 'far');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  mkdirSync(join(ws, 'swap'));
  mkdirSync(join(ws, 'inside-long-folder-name'));
  mkdirSync(join(far, 'deep'), { recursive: true });
  mkdirSync(join(far, 'outside-long-folder-name'));
  writeFileSync(join(ws, 'x.txt'), 'INSIDE');
  writeFileSync(join(far, 'x.txt'), 'OUTSIDE');
  writeFileSync(join(far, 'deep', 's.txt'), 'OUTSIDE-DEEP');
  symlinkSync(join(far, 'deep'), join(ws, 'link'), 'junction');
  linkSync(join(far, 'x.txt'), join(ws, 'hard.txt'));
  try {
    symlinkSync(join(far, 'x.txt'), join(ws, 'file-link.txt'), 'file');
    made.symlink = true;
  } catch {
    // Creating a file symbolic link needs Developer Mode or the privilege; a junction covers folders.
  }
  made.short.outside = shortName(join(far, 'outside-long-folder-name'));
  made.short.inside = shortName(join(ws, 'inside-long-folder-name'));
});

afterAll(() => {
  // One explicit folder, made by this file.
  if (base !== '' && /awg-t042-paths-[A-Za-z0-9]+$/.test(base)) rmSync(base, { recursive: true, force: true });
});

const context = (): PolicyContext => ({
  folderScope: { source: 'session-cwd', workspaceRoot: ws, writableRoots: [ws], readableRoots: [] },
  writtenPaths: [],
  resolveRealPath: (p) => resolveRealPath(p),
});
const verdict = (req: PermissionRequest): string => {
  const d = permissionPolicy.evaluate(req, context());
  return d.action === 'approve' ? 'approve' : d.rule;
};
const at = () => ({ cwd: ws });
const claudeRead = (p: string) => tool('Read', p);
const claudeWrite = (p: string) => request('fileChange', `Write ${p}`, { paths: [p], tool: 'Write', ...at() });
const bash = (cmd: string) => command(cmd, at());
const codexCmd = (script: string, paths: string[] = []) => codexSingle(script, { ...at(), paths });
const codexFileChange = (p: string) => request('fileChange', `apply_patch ${p}`, { paths: [p], ...at() });

describe('T042 A1: a junction inside the folder that leads outside', () => {
  it('reads through it are refused, Claude and Codex alike', () => {
    const target = join(ws, 'link', 's.txt');
    expect(verdict({ ...claudeRead(target), cwd: ws })).toBe('secret-read');
    expect(verdict({ ...tool('Grep', join(ws, 'link')), cwd: ws })).toBe('secret-read');
    expect(verdict(bash('cat link/s.txt'))).toBe('secret-read');
    expect(verdict(codexCmd(String.raw`Get-Content link\s.txt`))).toBe('secret-read');
    expect(verdict(codexCmd('Get-Content s.txt', [target]))).toBe('secret-read');
  });

  it('writes through it are refused, Claude and Codex alike', () => {
    const target = join(ws, 'link', 'new.txt');
    expect(verdict(claudeWrite(target))).toBe('write-outside-scope');
    expect(verdict({ ...edit(target), cwd: ws })).toBe('write-outside-scope');
    expect(verdict(bash('echo x > link/new.txt'))).toBe('write-outside-scope');
    expect(verdict(codexCmd(String.raw`Set-Content link\new.txt x`))).toBe('write-outside-scope');
    expect(verdict(codexFileChange(target))).toBe('write-outside-scope');
  });

  it('the same reads and writes next to it, inside the folder, are approved (not over-cautious)', () => {
    expect(verdict({ ...claudeRead(join(ws, 'x.txt')), cwd: ws })).toBe('approve');
    expect(verdict(claudeWrite(join(ws, 'sub', 'new.txt')))).toBe('approve');
    expect(verdict(bash('cat x.txt'))).toBe('approve');
    expect(verdict(codexCmd('Get-Content x.txt'))).toBe('approve');
    expect(verdict(codexFileChange(join(ws, 'sub', 'new.txt')))).toBe('approve');
  });
});

describe('T042 A2: a file symbolic link that leads outside', () => {
  it('is refused for read and write (skipped when this machine cannot make one)', (ctx) => {
    if (!made.symlink) ctx.skip();
    const link = join(ws, 'file-link.txt');
    expect(verdict({ ...claudeRead(link), cwd: ws })).toBe('secret-read');
    expect(verdict(claudeWrite(link))).toBe('write-outside-scope');
    expect(verdict(bash('cat file-link.txt'))).toBe('secret-read');
    expect(verdict(codexCmd('Get-Content file-link.txt'))).toBe('secret-read');
  });
});

describe('T042 A3 (F1): `..` after the junction, as Git Bash really resolves it', () => {
  const gitBash = String.raw`C:\Program Files\Git\bin\bash.exe`;

  it('Git Bash reads and writes next to the junction target (the measured behaviour the fix is for)', (ctx) => {
    if (!existsSync(gitBash)) ctx.skip();
    const run = (c: string) => spawnSync(gitBash, ['-c', c], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).stdout.trim();
    expect(run('cat link/../x.txt')).toBe('OUTSIDE');
    expect(run('cd link && cat ../x.txt')).toBe('OUTSIDE');
  });

  it.each([
    ['cat link/../x.txt', 'secret-read'],
    ['cd link && cat ../x.txt', 'secret-read'],
    ['echo W > link/../w1.txt', 'write-outside-scope'],
    ['cp x.txt link/../w2.txt', 'write-outside-scope'],
    ['mv x.txt link/../w3.txt', 'write-outside-scope'],
  ])('%s is refused', (cmd, rule) => {
    expect(verdict(bash(cmd))).toBe(rule);
  });

  it('`..` without a link in Bash is approved as before', () => {
    expect(verdict(bash('cat sub/../x.txt'))).toBe('approve');
    expect(verdict(bash('echo x > sub/../y.txt'))).toBe('approve');
  });
});

describe('T042 A4: device, UNC and URL forms of an outside path', () => {
  const outside = () => join(far, 'x.txt');
  const forms = () => {
    const p = outside();
    const fwd = p.replaceAll('\\', '/');
    return [
      `\\\\?\\${p}`,
      `\\\\.\\${p}`,
      `//?/${fwd}`,
      `\\??\\${p}`,
      `\\\\?\\UNC\\localhost\\${p.replace(':', '$')}`,
      `\\\\localhost\\${p.replace(':', '$')}`,
      `file:///${fwd}`,
      // The same forms pointing INSIDE are not trusted either: a device path skips Windows' normalisation.
      `\\\\?\\${join(ws, 'x.txt')}`,
    ];
  };

  it('every form is refused for Claude Read and Write', () => {
    for (const p of forms()) {
      expect(verdict({ ...claudeRead(p), cwd: ws }), p).not.toBe('approve');
      expect(verdict(claudeWrite(p)), p).not.toBe('approve');
    }
  });

  it('every form is refused in a command, Claude and Codex alike', () => {
    for (const p of forms()) {
      expect(verdict(bash(`cat '${p}'`)), p).not.toBe('approve');
      expect(verdict(codexCmd(`Get-Content -LiteralPath "${p}"`)), p).not.toBe('approve');
      expect(verdict(codexCmd('Get-Content x', [p])), p).not.toBe('approve');
    }
  });

  it('the resolver itself refuses device paths', () => {
    expect(resolveRealPath(`\\\\?\\${outside()}`)).toBeNull();
    expect(resolveRealPath(`//?/${outside().replaceAll('\\', '/')}`)).toBeNull();
    expect(resolveRealPath(`\\\\.\\${outside()}`)).toBeNull();
  });
});

describe('T042 A5: 8.3 short names', () => {
  it('a short name of an outside folder is refused', (ctx) => {
    const short = made.short.outside;
    if (short === undefined) ctx.skip();
    expect(verdict({ ...claudeRead(`${short}\\a.txt`), cwd: ws })).not.toBe('approve');
    expect(verdict(claudeWrite(`${short}\\a.txt`))).not.toBe('approve');
    expect(verdict(bash(`cat '${short}\\a.txt'`))).not.toBe('approve');
    expect(verdict(codexCmd(`Get-Content '${short}\\a.txt'`))).not.toBe('approve');
  });

  it('a short name inside the folder is not trusted either (it is unrecognised, never silently approved)', (ctx) => {
    const short = made.short.inside;
    if (short === undefined) ctx.skip();
    expect(verdict(claudeWrite(`${short}\\a.txt`))).toBe('unrecognised');
  });

  it('the resolver expands a short name to the long one, so a root given short still compares by its real path', (ctx) => {
    const short = made.short.outside;
    if (short === undefined) return ctx.skip();
    expect(resolveRealPath(short)?.toLowerCase()).toBe(join(far, 'outside-long-folder-name').toLowerCase());
  });
});

describe('T042 A6: letter case', () => {
  it('the folder in another case is still the folder (approved)', () => {
    expect(verdict({ ...claudeRead(join(ws, 'x.txt').toUpperCase()), cwd: ws })).toBe('approve');
    expect(verdict(claudeWrite(join(ws, 'SUB', 'N.TXT')))).toBe('approve');
  });

  it('an outside path in another case is still outside', () => {
    expect(verdict({ ...claudeRead(join(far, 'x.txt').toUpperCase()), cwd: ws })).toBe('secret-read');
    expect(verdict(claudeWrite(join(far, 'N.TXT').toUpperCase()))).toBe('write-outside-scope');
    expect(verdict(bash(`echo x > '${join(far, 'n.txt').toUpperCase()}'`))).toBe('write-outside-scope');
  });

  it('a non-ASCII letter in another case is not folded: the request goes to the user rather than being approved', () => {
    const root = join(base, 'wsÄ');
    mkdirSync(root, { recursive: true });
    const ctx: PolicyContext = { ...context(), folderScope: { source: 'session-cwd', workspaceRoot: root, writableRoots: [root], readableRoots: [] } };
    const d = permissionPolicy.evaluate(request('fileChange', 'Write', { paths: [join(base, 'wsä', 'a.txt')], tool: 'Write', cwd: root }), ctx);
    expect(d.action).toBe('escalate');
  });
});

describe('T042 A9: the same request after the folder was swapped for a junction (TOCTOU)', () => {
  it('is decided again from the file system, never from an earlier answer', () => {
    const swap = join(ws, 'swap');
    const req = claudeWrite(join(swap, 'f.txt'));
    expect(verdict(req)).toBe('approve');
    renameSync(swap, join(ws, 'swap-was'));
    symlinkSync(join(far, 'deep'), swap, 'junction');
    expect(verdict(req)).toBe('write-outside-scope');
    expect(verdict(bash('echo x > swap/f.txt'))).toBe('write-outside-scope');
    expect(verdict(codexFileChange(join(swap, 'f.txt')))).toBe('write-outside-scope');
  });
});

describe('T042 A10: making a link (the step a later swap needs) is never approved', () => {
  // Forward slashes and no quotes, so the Codex wrapper reads the command as written (r1-P2-1: the placeholder
  // is a word of its own, never a letter inside `-ItemType`).
  const target = () => join(far, 'deep').replaceAll('\\', '/');
  it.each([
    ['New-Item -ItemType Junction -Path j -Target TARGET'],
    ['New-Item -ItemType SymbolicLink -Path j -Target TARGET'],
    ['New-Item -ItemType HardLink -Path j -Target TARGET'],
    ['New-Item j -ItemType Junction -Value TARGET'],
    ['cmd /c mklink /J j TARGET'],
    ['cmd /c mklink /H j TARGET'],
    ['ln -s TARGET j'],
    ['ln TARGET j'],
    ['cp -s TARGET j'],
    ['cp -l TARGET j'],
    ['fsutil hardlink create j TARGET'],
    ['fsutil file setCaseSensitiveInfo sub enable'],
  ])('%s', (template) => {
    const cmd = template.replaceAll('TARGET', target());
    expect(cmd.replaceAll(target(), 'TARGET')).toBe(template);
    expect(verdict(bash(cmd)), cmd).not.toBe('approve');
    expect(verdict(codexCmd(cmd)), cmd).not.toBe('approve');
  });
});

describe('T042 A8: residual risk, pinned', () => {
  it('a hard link that already exists in the folder is approved: it has no other "real" path (G1)', () => {
    // Windows cannot tell which name of a hard-linked file is the original. Making one is refused (A10); one that
    // was there before the session is not detected. See T042-report.md, residual risks.
    expect(verdict(claudeWrite(join(ws, 'hard.txt')))).toBe('approve');
  });
});

describe('T042 F2 (r1-P1-3): the folder that is opened is the real one that was checked', () => {
  it('resolves a junction to its target, and refuses a file or a missing path', () => {
    expect(realFolder(ws)).toBe(ws);
    expect(realFolder(join(ws, 'link'))).toBe(join(far, 'deep'));
    expect(realFolder(join(ws, 'x.txt'))).toBeUndefined();
    expect(realFolder(join(ws, 'missing'))).toBeUndefined();
  });
});

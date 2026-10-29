// Node-side helpers of the T017 assembly: link resolution for the policy, finding codex.exe behind an npm
// shim, and the workspace watch behind writtenPaths (fail closed).
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionId } from '../../contracts';
import { resolveCodexExecutable } from './codex-exe';
import { resolveRealPath } from './real-path';
import { WorkspaceWatchers } from './workspace-watch';

let dir: string;
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'awg-t017-host-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const S = 'session-a' as SessionId;

describe('resolveRealPath', () => {
  it('resolves a junction in the existing part and keeps a tail that does not exist yet', () => {
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'junction');
    expect(resolveRealPath(join(dir, 'link', 'new', 'file.txt'))).toBe(join(dir, 'target', 'new', 'file.txt'));
    expect(resolveRealPath(join(dir, 'target'))).toBe(join(dir, 'target'));
  });

  it('cannot confirm relative paths, device paths or a missing tail with dots', () => {
    expect(resolveRealPath('relative\\a.txt')).toBeNull();
    expect(resolveRealPath('\\\\?\\C:\\x')).toBeNull();
    expect(resolveRealPath(`${dir}\\missing\\x\\..`)).toBeNull();
  });
});

describe('r1-P2 UNC paths', () => {
  it('r1-P2 resolves //server/share as \\\\server\\share, and still refuses device paths in either form', () => {
    // An administrative share of this machine may or may not be reachable; both spellings must agree.
    const back = resolveRealPath('\\\\localhost\\C$\\Windows');
    expect(resolveRealPath('//localhost/C$/Windows')).toBe(back);
    if (back !== null) expect(back.toLowerCase()).toContain('windows');
    for (const device of ['//?/C:/x', '//./pipe/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) expect(resolveRealPath(device)).toBeNull();
  });

  it('r1-P2 hands the file system the backslash form of //server/share', () => {
    const asked: string[] = [];
    const realpath = (path: string) => {
      asked.push(path);
      if (path === '\\\\server\\share\\work') return '\\\\server\\share\\real';
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(resolveRealPath('//server/share/work/a.txt', realpath)).toBe('\\\\server\\share\\real\\a.txt');
    expect(asked[0]).toBe('\\\\server\\share\\work\\a.txt');
  });

  it('r1-P2 takes forward slashes in a drive path too', () => {
    mkdirSync(join(dir, 'fwd'));
    expect(resolveRealPath(`${dir.replace(/\\/g, '/')}/fwd/new.txt`)).toBe(join(dir, 'fwd', 'new.txt'));
  });
});

describe('resolveCodexExecutable', () => {
  const env = (path: string, extra: Record<string, string> = {}) => ({ Path: path, ...extra });

  it('takes codex.exe on PATH, or the binary behind an npm shim; a shim alone is not enough', () => {
    const npm = join(dir, 'npm');
    mkdirSync(npm);
    writeFileSync(join(npm, 'codex.cmd'), '@echo off');
    expect(resolveCodexExecutable(env(npm))).toBeUndefined();
    const arch = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const vendored = join(npm, 'node_modules', '@openai', 'codex', 'vendor', arch, 'codex');
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(vendored, 'codex.exe'), '');
    expect(resolveCodexExecutable(env(npm))).toBe(join(vendored, 'codex.exe'));

    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex.exe'), '');
    expect(resolveCodexExecutable(env(`${bin};${npm}`))).toBe(join(bin, 'codex.exe'));
  });

  it('uses AWG_CODEX_COMMAND only when it is an existing .exe', () => {
    writeFileSync(join(dir, 'my-codex.exe'), '');
    expect(resolveCodexExecutable(env('', { AWG_CODEX_COMMAND: join(dir, 'my-codex.exe') }))).toBe(join(dir, 'my-codex.exe'));
    expect(resolveCodexExecutable(env('', { AWG_CODEX_COMMAND: join(dir, 'codex.cmd') }))).toBeUndefined();
  });
});

describe('WorkspaceWatchers', () => {
  const sink = () => {
    const seen = { changed: [] as string[], failed: 0 };
    return { seen, sink: { changed: (_s: SessionId, _r: string, path: string) => seen.changed.push(path), failed: () => seen.failed++ } };
  };

  it('reports changed files, and fails closed on a nameless change, an error or a watch that cannot start', () => {
    const { seen, sink: s } = sink();
    let emitter = new EventEmitter();
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const watchers = new WorkspaceWatchers(s, () => undefined, (_root, l) => {
      listener = l;
      emitter = new EventEmitter();
      return Object.assign(emitter, { close: () => undefined }) as never;
    });
    watchers.start(S, 'E:\\ws');
    listener!('change', '.git\\hooks\\pre-commit');
    expect(seen.changed).toEqual(['E:\\ws\\.git\\hooks\\pre-commit']);
    listener!('rename', null);
    expect(seen.failed).toBe(1);

    watchers.start(S, 'E:\\ws');
    emitter.emit('error', Object.assign(new Error('gone'), { code: 'EPERM' }));
    expect(seen.failed).toBe(2);

    const logs: string[] = [];
    new WorkspaceWatchers(s, (m) => logs.push(m), () => {
      throw Object.assign(new Error('no'), { code: 'ENOENT' });
    }).start(S, 'E:\\gone');
    expect(seen.failed).toBe(3);
    expect(logs[0]).toContain('ENOENT');
  });

  it('sees a real file written in the folder (fs.watch, recursive)', async () => {
    const { seen, sink: s } = sink();
    const watchers = new WorkspaceWatchers(s, () => undefined);
    mkdirSync(join(dir, 'sub'));
    watchers.start(S, dir);
    try {
      const deadline = Date.now() + 3000;
      while (!seen.changed.some((p) => p.endsWith('script.ps1')) && Date.now() < deadline) {
        writeFileSync(join(dir, 'sub', 'script.ps1'), `Write-Output ${String(Date.now())}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(seen.changed).toContain(join(dir, 'sub', 'script.ps1'));
      expect(seen.failed).toBe(0);
    } finally {
      watchers.stopAll();
    }
  });
});

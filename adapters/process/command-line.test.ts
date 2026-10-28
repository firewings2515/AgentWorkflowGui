import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commandLine, environmentBlock, quoteArg, resolveExecutable } from './command-line';

describe('quoteArg (MSVC argument rules)', () => {
  it.each([
    ['plain', 'plain'],
    ['', '""'],
    ['a b', '"a b"'],
    ['C:\\dir\\x', 'C:\\dir\\x'],
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['a\\"b', '"a\\\\\\"b"'],
  ])('%j -> %s', (arg, quoted) => expect(quoteArg(arg)).toBe(quoted));

  it('joins the executable and arguments', () => {
    expect(commandLine('C:\\Program Files\\x.exe', ['-c', 'k=v w'])).toBe('"C:\\Program Files\\x.exe" -c "k=v w"');
  });
});

describe('environmentBlock', () => {
  it('is sorted case-insensitively, NUL-separated and double-NUL-terminated', () => {
    const block = environmentBlock({ b: '2', A: '1', Path: 'C:\\x', skipped: undefined });
    expect(block.toString('utf16le')).toBe('A=1\0b=2\0Path=C:\\x\0\0');
  });
});

describe('resolveExecutable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t013-exe-'));
  writeFileSync(join(dir, 'tool.exe'), '');
  writeFileSync(join(dir, 'shim.cmd'), '');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a bare name in PATH with .exe added', () => {
    expect(resolveExecutable('tool', { PATH: dir }, tmpdir())).toBe(join(dir, 'tool.exe'));
  });

  it('refuses batch files, which need cmd.exe', () => {
    expect(() => resolveExecutable(join(dir, 'shim.cmd'), {}, tmpdir())).toThrow(/batch files/);
  });

  it('reports a missing executable', () => {
    expect(() => resolveExecutable('awg-no-such-tool', { PATH: dir }, tmpdir())).toThrow(/not found in PATH/);
  });
});

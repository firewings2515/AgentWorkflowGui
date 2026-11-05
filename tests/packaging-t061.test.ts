// T061: the app icon is wired into the build, lives in a tracked folder and has the sizes Windows asks for. What the
// main process hands to BrowserWindow is checked in app/main/t042-index.test.ts (it starts index.ts on a fake Electron).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const read = (name: string) => readFileSync(join(root, name), 'utf8');
const configLines = read('electron-builder.yml')
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('#'));

/** The value of `key: value` inside the top-level section `section` (two-space indentation). */
function setting(section: string, key: string): string | undefined {
  const start = configLines.findIndex((l) => l === `${section}:`);
  if (start < 0) return undefined;
  for (const line of configLines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    const match = new RegExp(`^ {2}${key}: (.+)$`).exec(line);
    if (match?.[1] !== undefined) return match[1].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

/** A config path as electron-builder reads it: relative to the project, `/` or `\` as separators, no `..` out of it. */
function projectPath(configured: string): string {
  const normalized = posix.normalize(configured.replaceAll('\\', '/'));
  expect(normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)).toBe(false);
  return normalized;
}

/** Git's own answer (the whole .gitignore, root rules and nested ones), run in this checkout. */
function gitIgnores(path: string): boolean {
  try {
    execFileSync('git', ['-c', 'core.longpaths=true', '-C', root, 'check-ignore', '-q', '--no-index', '--', path], { stdio: 'ignore' });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) return false;
    throw error;
  }
}

describe('T061 app icon', () => {
  const iconPaths = {
    'win.icon': setting('win', 'icon'),
    'nsis.installerIcon': setting('nsis', 'installerIcon'),
    'nsis.uninstallerIcon': setting('nsis', 'uninstallerIcon'),
  };

  for (const [name, configured] of Object.entries(iconPaths)) {
    it(`${name} is set, exists and git does not ignore it`, () => {
      expect(configured).toBeDefined();
      const path = projectPath(configured ?? '');
      expect(path).toMatch(/\.ico$/i);
      expect(existsSync(join(root, path))).toBe(true);
      expect(gitIgnores(path)).toBe(false);
    });
  }

  it('the icon the window uses is among the files the installer carries', () => {
    expect(configLines).toContain('  - assets/icon.ico');
  });

  it('the ignore check sees the folders that would hide an icon', () => {
    // The check itself must be able to say yes: generated folders are ignored, whatever the spelling.
    expect(gitIgnores('build-resources/icon.ico')).toBe(true);
    expect(gitIgnores(projectPath('./build-resources\\icon.ico'))).toBe(true);
    expect(gitIgnores('release/icon.ico')).toBe(true);
    expect(gitIgnores('assets/icon.ico')).toBe(false);
  });

  it('icon.ico holds 16, 24, 32, 48, 64, 128 and 256 pixel PNG images that lie inside the file', () => {
    const ico = readFileSync(join(root, 'assets', 'icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(ico.length).toBeGreaterThanOrEqual(6 + count * 16);
    const sizes = Array.from({ length: count }, (_, i) => {
      const entry = 6 + i * 16;
      const width = ico.readUInt8(entry) || 256;
      const height = ico.readUInt8(entry + 1) || 256;
      expect(height).toBe(width);
      const size = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(size).toBeGreaterThan(0);
      expect(offset).toBeGreaterThanOrEqual(6 + count * 16);
      expect(offset + size).toBeLessThanOrEqual(ico.length);
      // Every image is a PNG whose own header says the size the directory claims.
      expect(ico.subarray(offset, offset + 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(ico.subarray(offset + 12, offset + 16).toString('ascii')).toBe('IHDR');
      expect(ico.readUInt32BE(offset + 16)).toBe(width);
      expect(ico.readUInt32BE(offset + 20)).toBe(height);
      return width;
    });
    expect([...sizes].sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('icon.png is a 512 by 512 PNG', () => {
    const png = readFileSync(join(root, 'assets', 'icon.png'));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });
});

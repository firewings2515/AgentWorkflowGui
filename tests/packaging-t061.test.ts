// T061: the app icon is wired into the build, lives in a tracked folder and has the sizes Windows asks for.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WINDOW_ICON_RELATIVE } from '../app/main/window-options';

const root = join(import.meta.dirname, '..');
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
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

/** Folder rules of .gitignore (lines ending in `/`), as plain folder names. */
const ignoredFolders = read('.gitignore')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l.endsWith('/') && !l.startsWith('#') && !l.startsWith('!'))
  .map((l) => l.replace(/\/$/, ''));

describe('T061 app icon', () => {
  const iconPaths = {
    'win.icon': setting('win', 'icon'),
    'nsis.installerIcon': setting('nsis', 'installerIcon'),
    'nsis.uninstallerIcon': setting('nsis', 'uninstallerIcon'),
  };

  for (const [name, path] of Object.entries(iconPaths)) {
    it(`${name} is set, exists and is not inside a git-ignored folder`, () => {
      expect(path).toBeDefined();
      expect(path).toMatch(/\.ico$/);
      expect(existsSync(join(root, path ?? 'missing'))).toBe(true);
      const firstFolder = (path ?? '').split('/')[0] ?? '';
      expect(ignoredFolders).not.toContain(firstFolder);
      // The build-resources folder is where `npm run licenses` writes generated files; it is never tracked.
      expect(path).not.toMatch(/^build-resources\//);
    });
  }

  it('the window icon points at an existing file that the installer carries', () => {
    // out/main/index.js → ../../assets/icon.ico, resolved from the bundled main file.
    const file = join(root, 'out', 'main', WINDOW_ICON_RELATIVE);
    const relative = join('out', 'main', WINDOW_ICON_RELATIVE).split('\\').join('/');
    expect(relative).toBe('assets/icon.ico');
    expect(existsSync(file)).toBe(true);
    expect(configLines).toContain('  - assets/icon.ico');
  });

  it('icon.ico holds 16, 24, 32, 48, 64, 128 and 256 pixel images', () => {
    const ico = readFileSync(join(root, 'assets', 'icon.ico'));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => {
      const width = ico.readUInt8(6 + i * 16);
      return width === 0 ? 256 : width;
    });
    expect([...sizes].sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it('icon.png is 512 by 512', () => {
    const png = readFileSync(join(root, 'assets', 'icon.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });
});

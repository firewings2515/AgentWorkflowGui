import { describe, expect, it, vi } from 'vitest';
import { unpackedPath, withUnpackedCommand, type PackagedContext } from './packaged-paths';

const SDK_EXE = 'node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';
const RESOURCES = 'C:\\Users\\me\\AppData\\Local\\Programs\\AgentWorkflowGui\\resources';
const packaged: PackagedContext = { isPackaged: true, resourcesPath: RESOURCES };
const dev: PackagedContext = { isPackaged: false, resourcesPath: 'E:\\repo\\node_modules\\electron\\dist\\resources' };

describe('T044 unpackedPath', () => {
  it('points a file inside this app.asar at its unpacked copy', () => {
    expect(unpackedPath(`${RESOURCES}\\app.asar\\${SDK_EXE}`, packaged)).toBe(`${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}`);
    expect(unpackedPath(`${RESOURCES.replace(/\\/g, '/')}/app.asar/node_modules/koffi/koffi.node`, packaged)).toBe(`${RESOURCES}\\app.asar.unpacked\\node_modules\\koffi\\koffi.node`);
    expect(unpackedPath(`${RESOURCES.toUpperCase()}\\APP.ASAR\\x.exe`, packaged)).toBe(`${RESOURCES}\\app.asar.unpacked\\x.exe`);
  });

  it('changes nothing in a development run, whatever the path looks like', () => {
    for (const path of [`E:\\repo\\${SDK_EXE}`, `${dev.resourcesPath}\\app.asar\\${SDK_EXE}`, `C:\\dev\\app.asar\\project\\${SDK_EXE}`, `${RESOURCES}\\app.asar\\${SDK_EXE}`]) {
      expect(unpackedPath(path, dev)).toBe(path);
    }
  });

  it('changes nothing outside this app.asar, even when a folder is called app.asar (review r1 P1-1)', () => {
    for (const path of [
      `C:\\dev\\app.asar\\project\\${SDK_EXE}`,
      `C:/dev/app.asar/project/${SDK_EXE}`,
      `${RESOURCES}\\..\\app.asar\\${SDK_EXE}`,
      `${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}`,
      `${RESOURCES}\\app.asarx\\${SDK_EXE}`,
      `${RESOURCES}\\app.asar`,
      'claude',
      'C:\\data\\my.app.asar\\claude.exe',
    ]) {
      expect(unpackedPath(path, packaged)).toBe(path);
    }
  });

  it('replaces the right layer when the install path itself contains an app.asar folder', () => {
    const odd: PackagedContext = { isPackaged: true, resourcesPath: 'C:\\app.asar\\Apps\\AWG\\resources' };
    expect(unpackedPath(`C:\\app.asar\\Apps\\AWG\\resources\\app.asar\\${SDK_EXE}`, odd)).toBe(`C:\\app.asar\\Apps\\AWG\\resources\\app.asar.unpacked\\${SDK_EXE}`);
  });

  it('treats a \\\\?\\ prefix on either side as the same path (review r2 P2)', () => {
    const exe = `app.asar\\${SDK_EXE}`;
    const want = `${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}`;
    expect(unpackedPath(`\\\\?\\${RESOURCES}\\${exe}`, packaged)).toBe(want);
    expect(unpackedPath(`//?/${RESOURCES.replace(/\\/g, '/')}/${exe.replace(/\\/g, '/')}`, packaged)).toBe(want);
    expect(unpackedPath(`${RESOURCES}\\${exe}`, { isPackaged: true, resourcesPath: `\\\\?\\${RESOURCES}` })).toBe(want);
    expect(unpackedPath(`\\\\?\\${RESOURCES}\\${exe}`, { isPackaged: true, resourcesPath: `\\\\?\\${RESOURCES}` })).toBe(want);
    expect(unpackedPath(`\\\\?\\UNC\\srv\\share\\res\\${exe}`, { isPackaged: true, resourcesPath: '\\\\srv\\share\\res' })).toBe(`\\\\srv\\share\\res\\app.asar.unpacked\\${SDK_EXE}`);
  });

  it('still leaves a prefixed path outside this app.asar alone', () => {
    for (const path of [`\\\\?\\C:\\dev\\app.asar\\project\\${SDK_EXE}`, `\\\\?\\${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}`, '\\\\?\\', '\\\\.\\C:\\x\\claude.exe']) {
      expect(unpackedPath(path, packaged)).toBe(path);
    }
  });

  it('does not let .. climb out of the archive', () => {
    expect(unpackedPath(`${RESOURCES}\\app.asar\\..\\..\\Windows\\x.exe`, packaged)).toBe(`${RESOURCES}\\app.asar\\..\\..\\Windows\\x.exe`);
  });
});

describe('T044 withUnpackedCommand', () => {
  it('changes only the command of the spawn the SDK asks for', () => {
    const spawn = vi.fn((options: { command: string }) => options.command);
    const abort = new AbortController();
    const options = { command: `${RESOURCES}\\app.asar\\${SDK_EXE}`, args: ['--print'], cwd: 'C:\\w', env: { A: '1' }, signal: abort.signal };
    expect(withUnpackedCommand(spawn, packaged)(options)).toBe(`${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}`);
    expect(spawn).toHaveBeenCalledWith({ ...options, command: `${RESOURCES}\\app.asar.unpacked\\${SDK_EXE}` });
  });

  it('passes the spawn through unchanged in a development run', () => {
    const spawn = vi.fn((options: { command: string }) => options.command);
    const options = { command: `E:\\repo\\${SDK_EXE}`, args: [], env: {} };
    expect(withUnpackedCommand(spawn, dev)(options)).toBe(options.command);
  });
});

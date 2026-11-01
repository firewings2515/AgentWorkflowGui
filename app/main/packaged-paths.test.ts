import { describe, expect, it, vi } from 'vitest';
import { unpackedPath, withUnpackedCommand } from './packaged-paths';

const SDK_EXE = 'node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe';

describe('T044 unpackedPath', () => {
  it('points a file inside app.asar at its unpacked copy', () => {
    expect(unpackedPath(`C:\\Apps\\AWG\\resources\\app.asar\\${SDK_EXE}`)).toBe(`C:\\Apps\\AWG\\resources\\app.asar.unpacked\\${SDK_EXE}`);
    expect(unpackedPath('C:/Apps/AWG/resources/app.asar/node_modules/koffi/koffi.node')).toBe('C:/Apps/AWG/resources/app.asar.unpacked/node_modules/koffi/koffi.node');
    expect(unpackedPath('C:\\Apps\\AWG\\resources\\APP.ASAR\\x.exe')).toBe('C:\\Apps\\AWG\\resources\\app.asar.unpacked\\x.exe');
  });

  it('leaves a dev path, an already unpacked path and a bare command alone', () => {
    for (const path of [`E:\\repo\\${SDK_EXE}`, `C:\\Apps\\resources\\app.asar.unpacked\\${SDK_EXE}`, 'claude', 'C:\\data\\my.app.asar\\claude.exe']) {
      expect(unpackedPath(path)).toBe(path);
    }
  });
});

describe('T044 withUnpackedCommand', () => {
  it('changes only the command of the spawn the SDK asks for', () => {
    const spawn = vi.fn((options: { command: string }) => options.command);
    const abort = new AbortController();
    const options = { command: `C:\\r\\app.asar\\${SDK_EXE}`, args: ['--print'], cwd: 'C:\\w', env: { A: '1' }, signal: abort.signal };
    expect(withUnpackedCommand(spawn)(options)).toBe(`C:\\r\\app.asar.unpacked\\${SDK_EXE}`);
    expect(spawn).toHaveBeenCalledWith({ ...options, command: `C:\\r\\app.asar.unpacked\\${SDK_EXE}` });
  });
});

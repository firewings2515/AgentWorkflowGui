// Paths in the packaged app (T044). Files inside `app.asar` are read through Electron's patched fs, but a
// process cannot be started from there: `CreateProcessW` needs a real file. electron-builder unpacks such
// files to `app.asar.unpacked` (electron-builder.yml `asarUnpack`) at the same relative path.
import { win32 } from 'node:path';
import type { ClaudeProcessSpawnOptions } from '../../adapters/process';

/** Where the app is running from: Electron's `app.isPackaged` and `process.resourcesPath`. */
export interface PackagedContext {
  isPackaged: boolean;
  resourcesPath: string;
}

/**
 * The real file behind a path inside THIS app's `app.asar` (`<resourcesPath>\app.asar\...`). Anything else is
 * returned as it came: every path of a development run, a folder that merely contains an `app.asar`, the
 * already unpacked copy, a bare command. Windows rules: either slash, case-insensitive, `..` resolved first.
 */
export const unpackedPath = (path: string, context: PackagedContext): string => {
  if (!context.isPackaged || !win32.isAbsolute(path)) return path;
  const asar = win32.join(context.resourcesPath, 'app.asar') + win32.sep;
  const full = win32.normalize(path);
  if (!full.toLowerCase().startsWith(asar.toLowerCase())) return path;
  return win32.join(context.resourcesPath, 'app.asar.unpacked', full.slice(asar.length));
};

/**
 * The SDK finds its claude.exe with `require.resolve`, which inside the packaged app names the copy in
 * `app.asar`; this starts the unpacked one instead. Everything else about the spawn is the caller's.
 */
export const withUnpackedCommand =
  <Child>(spawn: (options: ClaudeProcessSpawnOptions) => Child, context: PackagedContext) =>
  (options: ClaudeProcessSpawnOptions): Child =>
    spawn({ ...options, command: unpackedPath(options.command, context) });

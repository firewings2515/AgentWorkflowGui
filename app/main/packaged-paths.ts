// Paths in the packaged app (T044). Files inside `app.asar` are read through Electron's patched fs, but a
// process cannot be started from there: `CreateProcessW` needs a real file. electron-builder unpacks such
// files to `app.asar.unpacked` (electron-builder.yml `asarUnpack`) at the same relative path.
import type { ClaudeProcessSpawnOptions } from '../../adapters/process';

const IN_ASAR = /([\\/])app\.asar([\\/])/i;

/** The real file behind a path inside `app.asar`; any other path (a dev run, an unpacked file) is unchanged. */
export const unpackedPath = (path: string): string => path.replace(IN_ASAR, '$1app.asar.unpacked$2');

/**
 * The SDK finds its claude.exe with `require.resolve`, which inside the packaged app names the copy in
 * `app.asar`; this starts the unpacked one instead. Everything else about the spawn is the caller's.
 */
export const withUnpackedCommand =
  <Child>(spawn: (options: ClaudeProcessSpawnOptions) => Child) =>
  (options: ClaudeProcessSpawnOptions): Child =>
    spawn({ ...options, command: unpackedPath(options.command) });

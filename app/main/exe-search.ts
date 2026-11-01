// What claude-exe.ts and codex-exe.ts share when they look for a runtime's executable (T045).
import { realpathSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import type { RuntimeSource } from '../../contracts';

/** An executable that may be the runtime, and where it came from. */
export interface ExeCandidate {
  path: string;
  source: RuntimeSource;
  /**
   * Set when the name says .exe but the file it is a link to is not (a link to `runtime.js`): the SDK starts a .js
   * file through `node`, which the launcher would look up in the session's folder or PATH. Such a candidate is shown
   * but never run or handed on.
   */
  unusable?: 'not-exe';
}

/** `fs.realpathSync.native`; replaced in tests, since a link cannot always be made. */
export type Realpath = (path: string) => string;

export const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Windows environment names are case-insensitive: `Path`, `PATH`. */
export const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  const value = key === undefined ? undefined : env[key];
  return value === undefined || value === '' ? undefined : value;
};

/** A drive path (`C:\x`) or a UNC path (`\\server\share`): not relative to a current folder or drive. */
export const isFullPath = (path: string): boolean => /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/?.]/.test(path);

/**
 * The folders of PATH. Only full paths count: `.`, an empty entry and a relative folder mean the current folder, and a
 * claude.exe or codex.exe left there would be started instead of the one that was checked (T045 review r1).
 */
export const pathDirs = (env: NodeJS.ProcessEnv): string[] =>
  (envValue(env, 'PATH') ?? '')
    .split(delimiter)
    .map((d) => d.replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && isFullPath(d));

const isExeName = (path: string): boolean => /\.exe$/i.test(path);

/**
 * The candidate for a path: a full path named .exe that exists, resolved through links. The resolved path is what is
 * checked (`--version`) and what is handed to the launcher, so it can never be looked up again in a session's folder.
 * A link whose target is not an .exe is `unusable`: the extension is checked again after the resolution (review r2).
 * Undefined when there is no such file.
 */
export const checkedExe = (path: string, source: RuntimeSource, realpath: Realpath = realpathSync.native): ExeCandidate | undefined => {
  if (!isFullPath(path) || !isExeName(path)) return undefined;
  try {
    const real = realpath(path);
    if (!isFullPath(real) || !isFile(real)) return undefined;
    return isExeName(real) ? { path: real, source } : { path, source, unusable: 'not-exe' };
  } catch {
    return undefined;
  }
};

/** The real path of a usable .exe, or undefined. */
export const verifiedExe = (path: string, realpath: Realpath = realpathSync.native): string | undefined => {
  const candidate = checkedExe(path, 'path', realpath);
  return candidate === undefined || candidate.unusable !== undefined ? undefined : candidate.path;
};

/** The same candidates without a repeated path (Windows paths compare ignoring case). */
export const unique = (candidates: ExeCandidate[]): ExeCandidate[] => {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

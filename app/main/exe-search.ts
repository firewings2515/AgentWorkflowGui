// What claude-exe.ts and codex-exe.ts share when they look for a runtime's executable (T045).
import { realpathSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import type { RuntimeSource } from '../../contracts';

/** An executable that may be the runtime, and where it came from. */
export interface ExeCandidate {
  path: string;
  source: RuntimeSource;
}

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

/**
 * The file a candidate really is: a full path to an existing .exe, resolved through links. This is what is checked
 * (`--version`) and what is handed to the launcher, so it can never be looked up again in a session's folder.
 */
export const verifiedExe = (path: string): string | undefined => {
  if (!isFullPath(path) || !/\.exe$/i.test(path)) return undefined;
  try {
    const real = realpathSync.native(path);
    return isFullPath(real) && isFile(real) ? real : undefined;
  } catch {
    return undefined;
  }
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

// What claude-exe.ts and codex-exe.ts share when they look for a runtime's executable (T045).
import { statSync } from 'node:fs';
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

export const pathDirs = (env: NodeJS.ProcessEnv): string[] => (envValue(env, 'PATH') ?? '').split(delimiter).filter((d) => d !== '');

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

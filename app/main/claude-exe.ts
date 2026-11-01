// Where the user's own Claude Code is (T045). The installer does not carry a claude.exe any more; like Codex
// (codex-exe.ts, same order and the same rule that a Job can only start a real executable) it is found on this
// computer. Nothing found means Claude is not available; it is never started through `cmd.exe`.
// Every candidate is a full path to an existing .exe, resolved through links (`verifiedExe`): a bare name or a
// relative PATH folder is never used, because the launcher would look it up again in the session's folder.
import { readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { compareVersions, parseVersion } from './runtime-version';
import { checkedExe, envValue, isDirectory, isFile, pathDirs, unique, type ExeCandidate, type Realpath, verifiedExe } from './exe-search';

interface Install {
  path: string;
  version: string;
}

/** Version folders (`2.1.309`) below `root`, each with the `claude.exe` in it or one folder deeper (`<hash>`). */
const versionedInstalls = (root: string): Install[] => {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const found: Install[] = [];
  for (const name of names) {
    const version = parseVersion('bare', name);
    if (version === undefined || !isDirectory(join(root, name))) continue;
    const dir = join(root, name);
    const direct = join(dir, 'claude.exe');
    if (isFile(direct)) {
      found.push({ path: direct, version });
      continue;
    }
    try {
      for (const inner of readdirSync(dir)) {
        const exe = join(dir, inner, 'claude.exe');
        if (isFile(exe)) found.push({ path: exe, version });
      }
    } catch {
      // Not a folder we can read: skipped.
    }
  }
  return found;
};

/**
 * The CLI the Claude desktop app keeps: `<data folder>\claude-code\<version>\[<hash>\]claude.exe`. The data folder
 * is `%APPDATA%\Claude` or, in the Store package, `%LOCALAPPDATA%\Claude-Data\<package id>`. The folders are
 * listed, not guessed; with several versions the newest comes first.
 */
export const desktopClaudeInstalls = (env: NodeJS.ProcessEnv): string[] => {
  const roots: string[] = [];
  const appData = envValue(env, 'APPDATA');
  if (appData !== undefined) roots.push(join(appData, 'Claude', 'claude-code'));
  const local = envValue(env, 'LOCALAPPDATA');
  if (local !== undefined) {
    try {
      for (const name of readdirSync(join(local, 'Claude-Data'))) roots.push(join(local, 'Claude-Data', name, 'claude-code'));
    } catch {
      // No Store package data.
    }
  }
  return roots
    .flatMap(versionedInstalls)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((install) => install.path);
};

/**
 * Every Claude executable worth trying, in the order they are looked for: `AWG_CLAUDE_PATH` (a full path to an .exe;
 * only that one when it is set: a path the user gave is never replaced by another), then each `claude.exe` in the
 * full-path folders of PATH or the binary behind an npm shim there, then the native installer's
 * `~\.local\bin\claude.exe`, then the Claude desktop app's CLI.
 */
export const claudeCandidates = (env: NodeJS.ProcessEnv = process.env, realpath: Realpath = realpathSync.native): ExeCandidate[] => {
  const override = env['AWG_CLAUDE_PATH'];
  if (override !== undefined && override !== '') {
    const candidate = checkedExe(override, 'env', realpath);
    return candidate === undefined ? [] : [candidate];
  }
  const found: ExeCandidate[] = [];
  const add = (path: string, source: ExeCandidate['source']) => {
    const candidate = checkedExe(path, source, realpath);
    if (candidate !== undefined) found.push(candidate);
  };
  for (const dir of pathDirs(env)) {
    const exe = join(dir, 'claude.exe');
    if (isFile(exe)) add(exe, 'path');
    else if (['claude.cmd', 'claude.ps1', 'claude'].some((shim) => isFile(join(dir, shim)))) {
      add(join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'path');
    }
  }
  const home = envValue(env, 'USERPROFILE');
  if (home !== undefined) add(join(home, '.local', 'bin', 'claude.exe'), 'known-location');
  for (const path of desktopClaudeInstalls(env)) add(path, 'known-location');
  return unique(found);
};

/** The Claude executable to start: the first candidate. Undefined when there is none. */
export const resolveClaudeExecutable = (env: NodeJS.ProcessEnv = process.env): string | undefined => claudeCandidates(env)[0]?.path;

/**
 * The claude.exe the Agent SDK ships in its platform package (development builds only; the installer carries
 * none). `fromDir` is a folder inside the project, where `node_modules` can be found.
 */
export const sdkBundledClaude = (fromDir: string): string | undefined => {
  if (process.platform !== 'win32') return undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  try {
    return verifiedExe(createRequire(join(fromDir, 'package.json')).resolve(`@anthropic-ai/claude-agent-sdk-win32-${arch}/claude.exe`));
  } catch {
    return undefined;
  }
};

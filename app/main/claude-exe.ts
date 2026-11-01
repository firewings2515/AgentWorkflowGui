// Where the user's own Claude Code is (T045). The installer does not carry a claude.exe any more; like Codex
// (codex-exe.ts, same order and the same rule that a Job can only start a real executable) it is found on this
// computer. Nothing found means Claude is not available; it is never started through `cmd.exe`.
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { compareVersions, parseVersion } from './runtime-version';
import { envValue, isDirectory, isFile, pathDirs, unique, type ExeCandidate } from './exe-search';

/** Version folders (`2.1.309`) below `root`, newest first, each with the `claude.exe` in it or one folder deeper (`<hash>`). */
const versionedInstalls = (root: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const versions = names
    .map((name) => ({ name, version: parseVersion(name) }))
    .filter((v): v is { name: string; version: string } => v.version !== undefined && isDirectory(join(root, v.name)))
    .sort((a, b) => compareVersions(b.version, a.version));
  const found: string[] = [];
  for (const { name } of versions) {
    const dir = join(root, name);
    const direct = join(dir, 'claude.exe');
    if (isFile(direct)) {
      found.push(direct);
      continue;
    }
    try {
      for (const inner of readdirSync(dir).sort().reverse()) {
        const exe = join(dir, inner, 'claude.exe');
        if (isFile(exe)) found.push(exe);
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
  return roots.flatMap(versionedInstalls).sort((a, b) => {
    const va = parseVersion(a.split(/[\\/]claude-code[\\/]/i)[1] ?? '') ?? '0.0.0';
    const vb = parseVersion(b.split(/[\\/]claude-code[\\/]/i)[1] ?? '') ?? '0.0.0';
    return compareVersions(vb, va);
  });
};

/**
 * Every Claude executable worth trying, in the order they are looked for: `AWG_CLAUDE_PATH` (only that one when it
 * is set: a path the user gave is never replaced by another), then each `claude.exe` on PATH or the binary behind
 * an npm shim there, then the native installer's `~\.local\bin\claude.exe`, then the Claude desktop app's CLI.
 */
export const claudeCandidates = (env: NodeJS.ProcessEnv = process.env): ExeCandidate[] => {
  const override = env['AWG_CLAUDE_PATH'];
  if (override !== undefined && override !== '') return isFile(override) && /\.exe$/i.test(override) ? [{ path: override, source: 'env' }] : [];
  const found: ExeCandidate[] = [];
  for (const dir of pathDirs(env)) {
    const exe = join(dir, 'claude.exe');
    if (isFile(exe)) found.push({ path: exe, source: 'path' });
    else if (['claude.cmd', 'claude.ps1', 'claude'].some((shim) => isFile(join(dir, shim)))) {
      const shipped = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (isFile(shipped)) found.push({ path: shipped, source: 'path' });
    }
  }
  const home = envValue(env, 'USERPROFILE');
  if (home !== undefined) {
    const native = join(home, '.local', 'bin', 'claude.exe');
    if (isFile(native)) found.push({ path: native, source: 'known-location' });
  }
  for (const path of desktopClaudeInstalls(env)) found.push({ path, source: 'known-location' });
  return unique(found);
};

/** The Claude executable to start: the first candidate. Undefined when there is none. */
export const resolveClaudeExecutable = (env: NodeJS.ProcessEnv = process.env): string | undefined => claudeCandidates(env)[0]?.path;

/**
 * The claude.exe the Agent SDK ships in its platform package (development builds only; the installer carries
 * none). `fromDir` is a folder inside the project, where `node_modules` can be found.
 */
export const sdkBundledClaude = (fromDir: string): string | undefined => {
  const platform = process.platform === 'win32' ? 'win32' : undefined;
  if (platform === undefined) return undefined;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  try {
    const path = createRequire(join(fromDir, 'package.json')).resolve(`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude.exe`);
    return isFile(path) ? path : undefined;
  } catch {
    return undefined;
  }
};

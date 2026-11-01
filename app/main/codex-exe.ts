// Where `codex.exe` is (T017, T013 known limit, T045). A Job can only start a real executable: npm's `codex`,
// `codex.cmd` and `codex.ps1` are shims that need a shell, so they are followed to the binary the npm
// package ships. Nothing found means Codex is not available; it is never started through `cmd.exe`.
// claude-exe.ts looks for Claude Code by the same rules, in the same order.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { envValue, isDirectory, isFile, pathDirs, unique, type ExeCandidate } from './exe-search';

/**
 * The oldest Codex this app works with: 0.160.0, the version T013, T017 and the live checks of the app-server
 * protocol ran against (docs/KNOWLEDGE.md). An older one may lack protocol messages the adapter relies on.
 */
export const CODEX_MIN_VERSION = '0.160.0';

const ARCH = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';

/** `codex.exe` below `dir` in a `vendor/<this arch>/` folder, at most `depth` levels down. */
const findVendored = (dir: string, depth: number): string | undefined => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (name.toLowerCase() === 'codex.exe' && path.toLowerCase().includes(`${'vendor'}\\${ARCH}`.toLowerCase()) && isFile(path)) return path;
  }
  if (depth === 0) return undefined;
  for (const name of entries) {
    const path = join(dir, name);
    if (!isDirectory(path)) continue;
    const found = findVendored(path, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Every Codex executable worth trying, in the order they are looked for: `AWG_CODEX_COMMAND` (only that one when it
 * is set: a path the user gave is never replaced by another), then each `codex.exe` on PATH or the binary behind
 * an npm shim there, then Codex's own install folder (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`).
 */
export const codexCandidates = (env: NodeJS.ProcessEnv = process.env): ExeCandidate[] => {
  const override = env['AWG_CODEX_COMMAND'];
  if (override !== undefined && override !== '') return isFile(override) && /\.exe$/i.test(override) ? [{ path: override, source: 'env' }] : [];
  const found: ExeCandidate[] = [];
  for (const dir of pathDirs(env)) {
    const exe = join(dir, 'codex.exe');
    if (isFile(exe)) found.push({ path: exe, source: 'path' });
    else if (['codex.cmd', 'codex.ps1', 'codex'].some((shim) => isFile(join(dir, shim)))) {
      const vendored = findVendored(join(dir, 'node_modules', '@openai'), 6);
      if (vendored !== undefined) found.push({ path: vendored, source: 'path' });
    }
  }
  const local = envValue(env, 'LOCALAPPDATA');
  if (local !== undefined) {
    const known = join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isFile(known)) found.push({ path: known, source: 'known-location' });
  }
  return unique(found);
};

/**
 * The Codex executable to start: `AWG_CODEX_COMMAND` when set, else the first `codex.exe` on PATH, else
 * the binary behind an npm shim on PATH, else the install folder. Undefined when there is none.
 */
export const resolveCodexExecutable = (env: NodeJS.ProcessEnv = process.env): string | undefined => codexCandidates(env)[0]?.path;

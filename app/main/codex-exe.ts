// Where `codex.exe` is (T017, T013 known limit). A Job can only start a real executable: npm's `codex`,
// `codex.cmd` and `codex.ps1` are shims that need a shell, so they are followed to the binary the npm
// package ships. Nothing found means Codex is not available; it is never started through `cmd.exe`.
import { readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

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
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findVendored(path, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * The Codex executable to start: `AWG_CODEX_COMMAND` when set, else the first `codex.exe` on PATH, else
 * the binary behind an npm shim on PATH. Undefined when there is none.
 */
export const resolveCodexExecutable = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const override = env['AWG_CODEX_COMMAND'];
  if (override !== undefined && override !== '') return isFile(override) && /\.exe$/i.test(override) ? override : undefined;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  const dirs = (pathKey === undefined ? '' : (env[pathKey] ?? '')).split(delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    const exe = join(dir, 'codex.exe');
    if (isFile(exe)) return exe;
    if (['codex.cmd', 'codex.ps1', 'codex'].some((shim) => isFile(join(dir, shim)))) {
      const found = findVendored(join(dir, 'node_modules', '@openai'), 6);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

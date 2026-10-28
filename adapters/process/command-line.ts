// What CreateProcessW needs that Node's spawn would otherwise prepare: the executable's full path, one
// quoted command line and a UTF-16 environment block. Same rules as libuv, so a runtime sees the argv it
// would have seen under child_process.spawn.
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';

/** Quotes one argument the way the MSVC runtime splits it back (libuv `quote_cmd_arg`). */
export const quoteArg = (arg: string): string => {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    // Backslashes before a quote (or the closing quote) are doubled; elsewhere they stay literal.
    out += ch === '"' ? '\\'.repeat(backslashes * 2 + 1) + ch : '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
};

export const commandLine = (application: string, args: readonly string[]) => [application, ...args].map(quoteArg).join(' ');

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** The variable's value whatever its case, as Windows treats environment names. */
const lookup = (env: NodeJS.ProcessEnv, name: string) => {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

/**
 * The executable CreateProcessW should start. A bare name is looked up in `cwd`, then PATH, trying the
 * name as given and with `.com` and `.exe`, like libuv. Batch files are refused: they need `cmd.exe`,
 * whose argument rules differ.
 */
export const resolveExecutable = (command: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string => {
  const candidates = (base: string) => (extname(base) === '' ? [`${base}.com`, `${base}.exe`, base] : [base]);
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir || isAbsolute(command) ? [cwd] : [cwd, ...(lookup(env, 'PATH') ?? '').split(delimiter).filter((d) => d !== '')];
  for (const dir of dirs) {
    for (const candidate of candidates(resolve(dir, command))) {
      if (!isFile(candidate)) continue;
      if (/\.(bat|cmd)$/i.test(candidate)) throw new Error(`${candidate}: batch files cannot be started in a Job; point to the executable`);
      return candidate;
    }
  }
  throw new Error(`${command}: executable not found${hasDir ? '' : ' in PATH'}`);
};

/** `KEY=value\0...\0\0` in UTF-16, sorted case-insensitively as CreateProcessW expects. */
export const environmentBlock = (env: NodeJS.ProcessEnv): Buffer => {
  const entries = Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== '' && !e[0].includes('='));
  entries.sort(([a], [b]) => {
    const [x, y] = [a.toUpperCase(), b.toUpperCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return Buffer.from(`${entries.map(([k, v]) => `${k}=${v}\0`).join('')}\0`, 'utf16le');
};

// The RuntimeLocator (C-33, T045): finds the user's own Claude Code and Codex, reads their versions and asks their
// own status commands whether they are signed in. It never installs, updates or signs in anything and never reads
// a credential file (D-02): the only sources are `<exe> --version` and `claude auth status` / `codex login status`.
// Those print an account (an e-mail, an organisation) or a masked key; only the sign-in CATEGORY is kept, and
// no output of them is logged or stored.
import { execFile } from 'node:child_process';
import { RuntimeStatus, type Runtime, type RuntimeAuth, type RuntimeSource, type Timestamp } from '../../contracts';
import { CLAUDE_CODE_MIN_VERSION } from '../../adapters/claude/cli-version';
import type { RuntimeLocator } from '../../core/ports';
import { claudeCandidates } from './claude-exe';
import { CODEX_MIN_VERSION, codexCandidates } from './codex-exe';
import { isFullPath, type ExeCandidate } from './exe-search';
import { compareVersions, parseVersion } from './runtime-version';

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process could not be started or was ended by the timeout. */
  code: number | null;
}
/** Runs a real executable (no shell) and waits for it; never rejects. */
export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const runCommand: RunCommand = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({ stdout, stderr, code });
      });
    } catch {
      resolve({ stdout: '', stderr: '', code: null });
    }
  });

export interface RuntimeLocatorOptions {
  env?: NodeJS.ProcessEnv;
  /** Development builds only: the claude.exe the Agent SDK ships, tried last. Packaged builds never fall back to it. */
  sdkBundledClaude?: () => string | undefined;
  run?: RunCommand;
  /** Replace the search (tests). */
  candidates?: (runtime: Runtime, env: NodeJS.ProcessEnv) => ExeCandidate[];
  /** Diagnostics: fixed text only (versions and categories; never a path, an account or command output). */
  log?: (message: string) => void;
  versionTimeoutMs?: number;
  authTimeoutMs?: number;
}

const REQUIRED: Record<Runtime, string> = { claude: CLAUDE_CODE_MIN_VERSION, codex: CODEX_MIN_VERSION };
const NAME: Record<Runtime, string> = { claude: 'Claude Code', codex: 'Codex' };
const SIGN_IN: Record<Runtime, string> = { claude: '請在終端機執行 claude 並完成登入', codex: '請在終端機執行 codex login 並完成登入' };

/** The fixed text for each state the user can act on. */
export const runtimeDetail = {
  notInstalled: (runtime: Runtime, env: boolean): string =>
    env
      ? `環境變數 AWG_${runtime.toUpperCase()}_${runtime === 'claude' ? 'PATH' : 'COMMAND'} 指定的檔案不存在或不是 .exe。請修正或移除它，再按「重新偵測」。`
      : `找不到 ${NAME[runtime]}。請先安裝 ${NAME[runtime]}，再按「重新偵測」。`,
  tooOld: (runtime: Runtime, version: string): string => `${NAME[runtime]} ${version} 比需要的 ${REQUIRED[runtime]} 舊，請更新 ${NAME[runtime]} 後再按「重新偵測」。`,
  notExe: (runtime: Runtime): string => `找到的 ${NAME[runtime]} 檔案實際指向的不是 .exe 程式，為了安全不會執行它。請改用 ${NAME[runtime]} 官方安裝的 .exe，再按「重新偵測」。`,
  failed: (runtime: Runtime): string => `找到 ${NAME[runtime]}，但讀不到它的版本，請確認它可以執行，再按「重新偵測」。`,
  signedOut: (runtime: Runtime): string => `${NAME[runtime]} 尚未登入。${SIGN_IN[runtime]}，再按「重新偵測」。`,
};

/** Claude's `auth status` JSON: only these two fields are read; the rest (account, organisation) is dropped. */
const claudeAuth = (text: string): RuntimeAuth => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return 'unknown';
  }
  if (typeof parsed !== 'object' || parsed === null) return 'unknown';
  const { loggedIn, authMethod, subscriptionType } = parsed as Record<string, unknown>;
  if (loggedIn === false) return 'signed-out';
  if (loggedIn !== true) return 'unknown';
  const method = typeof authMethod === 'string' ? authMethod.toLowerCase() : '';
  if (/api[-_ ]?key/.test(method)) return 'api-key';
  if (method === 'claude.ai' || method === 'oauth' || method === 'subscription' || typeof subscriptionType === 'string') return 'subscription';
  return 'unknown';
};

/** Codex's `login status` text: "Logged in using ChatGPT", "Logged in using an API key - sk-…", "Not logged in". */
const codexAuth = (text: string): RuntimeAuth => {
  if (/not logged in/i.test(text)) return 'signed-out';
  if (/logged in using (an? )?api key/i.test(text)) return 'api-key';
  if (/logged in using chatgpt/i.test(text)) return 'subscription';
  return 'unknown';
};

export function createRuntimeLocator(options: RuntimeLocatorOptions = {}): RuntimeLocator {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const log = options.log ?? (() => undefined);
  const versionTimeout = options.versionTimeoutMs ?? 8000;
  const authTimeout = options.authTimeoutMs ?? 10_000;
  const last = new Map<Runtime, RuntimeStatus>();

  const candidatesOf = (runtime: Runtime): ExeCandidate[] => {
    // Whatever the search gave: only a full path is ever checked or handed on, never a name the launcher would look up again.
    if (options.candidates !== undefined) return options.candidates(runtime, env).filter((c) => isFullPath(c.path));
    const found = runtime === 'claude' ? claudeCandidates(env) : codexCandidates(env);
    // The SDK's own copy is the last resort and only in development; an explicit AWG_CLAUDE_PATH is never replaced.
    const explicit = runtime === 'claude' && (env['AWG_CLAUDE_PATH'] ?? '') !== '';
    if (runtime === 'claude' && !explicit && options.sdkBundledClaude !== undefined) {
      const sdk = options.sdkBundledClaude();
      if (sdk !== undefined) found.push({ path: sdk, source: 'sdk-bundled' });
    }
    return found;
  };

  /** `--version` of each candidate in order; the first that is new enough, else the first that could be read, else the first. */
  const pick = async (runtime: Runtime, all: ExeCandidate[]) => {
    // A link to something that is not an .exe is never run; it only explains why nothing could be used.
    const candidates = all.filter((c) => c.unusable === undefined);
    if (candidates.length === 0) return { candidate: all[0] as ExeCandidate, version: undefined };
    let firstRead: { candidate: ExeCandidate; version: string } | undefined;
    for (const candidate of candidates) {
      const result = await run(candidate.path, ['--version'], versionTimeout);
      // Only stdout, and only the program's own version line: an error message with a number in it is no version.
      const version = result.code === 0 ? parseVersion(runtime, result.stdout) : undefined;
      if (version === undefined) continue;
      if (compareVersions(version, REQUIRED[runtime]) >= 0) return { candidate, version };
      firstRead ??= { candidate, version };
    }
    return firstRead === undefined ? { candidate: candidates[0] as ExeCandidate, version: undefined } : firstRead;
  };

  const auth = async (runtime: Runtime, exe: string): Promise<RuntimeAuth> => {
    const result = await run(exe, runtime === 'claude' ? ['auth', 'status'] : ['login', 'status'], authTimeout);
    // `codex login status` writes to stderr, `claude auth status` to stdout; an exit code of 1 may just mean signed out.
    const text = `${result.stdout}\n${result.stderr}`;
    return runtime === 'claude' ? claudeAuth(text) : codexAuth(text);
  };

  const detectOnce = async (runtime: Runtime, at: Timestamp): Promise<RuntimeStatus> => {
    const requiredVersion = REQUIRED[runtime];
    const base = { runtime, requiredVersion, checkedAt: at, modelCount: 0 };
    const candidates = candidatesOf(runtime);
    if (candidates.length === 0) {
      return { ...base, state: 'not-installed', auth: 'unknown', detail: runtimeDetail.notInstalled(runtime, (env[runtime === 'claude' ? 'AWG_CLAUDE_PATH' : 'AWG_CODEX_COMMAND'] ?? '') !== '') };
    }
    const { candidate, version } = await pick(runtime, candidates);
    const found = { ...base, executable: candidate.path, source: candidate.source satisfies RuntimeSource };
    if (candidate.unusable !== undefined) return { ...found, state: 'failed', auth: 'unknown', detail: runtimeDetail.notExe(runtime) };
    if (version === undefined) return { ...found, state: 'failed', auth: 'unknown', detail: runtimeDetail.failed(runtime) };
    if (compareVersions(version, requiredVersion) < 0) {
      return { ...found, state: 'too-old', version, auth: 'unknown', detail: runtimeDetail.tooOld(runtime, version) };
    }
    if (compareVersions(version, requiredVersion) > 0) log(`[runtime] ${runtime} ${version} is newer than the ${requiredVersion} this app was built for; using it`);
    if (candidate.source === 'sdk-bundled') log(`[runtime] no ${runtime} installed on this computer; using the Agent SDK's copy (development build)`);
    const kind = await auth(runtime, candidate.path);
    if (kind === 'signed-out') return { ...found, state: 'signed-out', version, auth: kind, detail: runtimeDetail.signedOut(runtime) };
    return { ...found, state: 'available', version, auth: kind };
  };

  return {
    async detect(runtime, at) {
      let status: RuntimeStatus;
      try {
        status = RuntimeStatus.parse(await detectOnce(runtime, at));
      } catch {
        // Detection must not throw: what could not be told is in the status.
        status = { runtime, state: 'not-installed', requiredVersion: REQUIRED[runtime], auth: 'unknown', modelCount: 0, checkedAt: at, detail: '偵測時發生錯誤，請按「重新偵測」再試一次。' };
      }
      log(`[runtime] ${runtime}: ${status.state}${status.version === undefined ? '' : ` ${status.version}`}${status.source === undefined ? '' : ` (${status.source})`}, sign-in ${status.auth}`);
      last.set(runtime, status);
      return status;
    },
    current: (runtime) => last.get(runtime),
  };
}

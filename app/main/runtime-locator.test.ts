// T045: version reading and comparison, the search for Claude Code, and the locator's states. The status commands
// are faked: nothing here starts a real runtime.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeStatus, type Runtime } from '../../contracts';
import { CLAUDE_CODE_MIN_VERSION } from '../../adapters/claude/cli-version';
import { claudeCandidates, desktopClaudeInstalls, resolveClaudeExecutable } from './claude-exe';
import { CODEX_MIN_VERSION, codexCandidates } from './codex-exe';
import { createRuntimeLocator, type RunCommand, type RunResult } from './runtime-locator';
import { compareVersions, parseVersion } from './runtime-version';

let dir: string;
beforeEach(() => {
  // As the search reports it: resolved through links and short names.
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'awg-t045-')));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const touch = (...parts: string[]) => {
  const path = join(dir, ...parts);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
};

describe('T045 version text', () => {
  it('reads the number from the known output forms only', () => {
    expect(parseVersion('claude', '2.1.309 (Claude Code)\n')).toBe('2.1.309');
    expect(parseVersion('claude', '2.1.309')).toBe('2.1.309');
    expect(parseVersion('codex', 'codex-cli 0.160.0\r\n')).toBe('0.160.0');
    expect(parseVersion('codex', '0.160.0')).toBe('0.160.0');
    expect(parseVersion('codex', 'codex-cli 0.161.0-alpha.2')).toBe('0.161.0-alpha.2');
    expect(parseVersion('bare', '2.1.309')).toBe('2.1.309');
    expect(parseVersion('codex', 'codex-cli 1.0.0+build.5')).toBe('1.0.0');
  });

  it('reads nothing from anything else: a number in an error message, an incomplete or odd version, the other program', () => {
    for (const text of ['', 'command not found', '1.2', '1.2.3.4', 'v3.0.1', 'error: Node 24.0.0 required', 'Error: Node 24.0.0 required\n', '2.1.309-', '2.1.309-.', '2.1.309+', '01.2.3', '1.2.3-01', '2.1.309 (Claude Code) extra', 'warning\n2.1.309 (Claude Code)', '2.1.309 (Claude Code)\n2.1.310']) {
      expect(parseVersion('claude', text), text).toBeUndefined();
      expect(parseVersion('codex', text), text).toBeUndefined();
    }
    expect(parseVersion('claude', 'codex-cli 0.160.0')).toBeUndefined();
    expect(parseVersion('codex', '0.160.0 (Claude Code)')).toBeUndefined();
    expect(parseVersion('bare', '2.1.309 (Claude Code)')).toBeUndefined();
  });

  it('compares numbers by part, not as text', () => {
    expect(compareVersions('2.1.309', '2.1.309')).toBe(0);
    expect(compareVersions('2.1.310', '2.1.309')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.309')).toBeLessThan(0);
    expect(compareVersions('10.0.0', '9.9.9')).toBeGreaterThan(0);
  });

  it('orders pre-releases as SemVer 2.0.0 does', () => {
    // The chain from the SemVer specification, each older than the next.
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(compareVersions(chain[i] as string, chain[i + 1] as string), `${chain[i]} < ${chain[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(chain[i + 1] as string, chain[i] as string)).toBeGreaterThan(0);
    }
    // Review r1: names compare as ASCII (an upper-case letter is older), a number is older than a name.
    expect(compareVersions('2.1.309-B', '2.1.309-a')).toBeLessThan(0);
    expect(compareVersions('2.1.309-1', '2.1.309-0a')).toBeLessThan(0);
    expect(compareVersions('2.1.309-alpha.2', '2.1.309-alpha.10')).toBeLessThan(0);
    expect(compareVersions('2.1.309-alpha', '2.1.309')).toBeLessThan(0);
  });

  it('requires the version of the pinned SDK for Claude and 0.160.0 for Codex', () => {
    expect(CLAUDE_CODE_MIN_VERSION).toBe('2.1.309');
    expect(CODEX_MIN_VERSION).toBe('0.160.0');
  });
});

describe('T045 finding Claude Code', () => {
  const env = (extra: Record<string, string> = {}) => ({ Path: join(dir, 'empty'), USERPROFILE: join(dir, 'home'), APPDATA: join(dir, 'roaming'), LOCALAPPDATA: join(dir, 'local'), ...extra });

  it('takes AWG_CLAUDE_PATH first, and when it is set but wrong takes nothing else', () => {
    const mine = touch('mine', 'claude.exe');
    touch('bin', 'claude.exe');
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: mine, Path: join(dir, 'bin') }))).toEqual([{ path: mine, source: 'env' }]);
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: join(dir, 'nope', 'claude.exe'), Path: join(dir, 'bin') }))).toEqual([]);
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: mine.replace(/\.exe$/, '.cmd'), Path: join(dir, 'bin') }))).toEqual([]);
  });

  it('never takes a relative PATH folder, the current folder or a bare name (review r1): the launcher would look it up again in the session folder', () => {
    // A folder below the current folder with a claude.exe and a codex.exe in it, reachable by a relative path.
    const here = realpathSync.native(mkdtempSync(join(process.cwd(), 'awg-t045-rel-')));
    try {
      writeFileSync(join(here, 'claude.exe'), '');
      writeFileSync(join(here, 'codex.exe'), '');
      const rel = relative(process.cwd(), here);
      expect(rel.startsWith('awg-t045-rel-')).toBe(true);
      const trusted = touch('trusted', 'claude.exe');
      const trustedCodex = touch('trusted', 'codex.exe');
      const path = ['.', '', rel, `.\\${rel}`, 'C:drive-relative', join(dir, 'trusted')].join(';');
      expect(claudeCandidates(env({ Path: path }))).toEqual([{ path: trusted, source: 'path' }]);
      expect(codexCandidates({ Path: path })).toEqual([{ path: trustedCodex, source: 'path' }]);
      // Nothing but relative folders: nothing found, although the files exist where they point.
      expect(claudeCandidates(env({ Path: `.;${rel}` }))).toEqual([]);
      expect(codexCandidates({ Path: `.;${rel}` })).toEqual([]);
      // The override must be a full path too.
      expect(claudeCandidates(env({ AWG_CLAUDE_PATH: join(rel, 'claude.exe') }))).toEqual([]);
      expect(claudeCandidates(env({ AWG_CLAUDE_PATH: 'claude.exe' }))).toEqual([]);
      expect(codexCandidates({ AWG_CODEX_COMMAND: join(rel, 'codex.exe'), Path: join(dir, 'trusted') })).toEqual([]);
      expect(codexCandidates({ AWG_CODEX_COMMAND: 'codex.exe', Path: join(dir, 'trusted') })).toEqual([]);
      // A full path in the override is kept as it is.
      expect(claudeCandidates(env({ AWG_CLAUDE_PATH: join(here, 'claude.exe') }))).toEqual([{ path: join(here, 'claude.exe'), source: 'env' }]);
    } finally {
      rmSync(here, { recursive: true, force: true });
    }
  });

  it('a link named .exe that points at something else is not used (review r2): it is shown as failed and never run', () => {
    // The check after the resolution, with the resolution faked: a link cannot always be made here.
    const link = touch('links', 'claude.exe');
    const target = touch('links', 'runtime.js');
    const codexLink = touch('links', 'codex.exe');
    const resolve = (path: string) => (path === link ? target : path === codexLink ? target : path);
    const claude = claudeCandidates(env({ AWG_CLAUDE_PATH: link }), resolve);
    expect(claude).toEqual([{ path: link, source: 'env', unusable: 'not-exe' }]);
    expect(claudeCandidates(env({ Path: join(dir, 'links') }), resolve)).toEqual([{ path: link, source: 'path', unusable: 'not-exe' }]);
    expect(codexCandidates({ AWG_CODEX_COMMAND: codexLink }, resolve)).toEqual([{ path: codexLink, source: 'env', unusable: 'not-exe' }]);
    expect(codexCandidates({ Path: join(dir, 'links') }, resolve)).toEqual([{ path: codexLink, source: 'path', unusable: 'not-exe' }]);
    // A resolution to a missing file or to a relative path is no candidate at all; one to an .exe in another folder is that folder's.
    const other = touch('other', 'real.exe');
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: link }), () => join(dir, 'missing.exe'))).toEqual([]);
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: link }), () => 'real.exe')).toEqual([]);
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: link }), () => other)).toEqual([{ path: other, source: 'env' }]);
  });

  it('hands on the real file: a link is resolved, so what was checked is what is started', () => {
    const real = touch('real', 'claude.exe');
    try {
      symlinkSync(real, join(dir, 'link.exe'), 'file');
    } catch {
      return; // creating a link needs a privilege some machines do not give; the case is not testable there
    }
    expect(claudeCandidates(env({ AWG_CLAUDE_PATH: join(dir, 'link.exe') }))).toEqual([{ path: real, source: 'env' }]);
  });

  it('takes claude.exe on PATH, then ~/.local/bin, then the desktop app, in that order', () => {
    const onPath = touch('bin', 'claude.exe');
    const native = touch('home', '.local', 'bin', 'claude.exe');
    const desktop = touch('local', 'Claude-Data', 'pkg', 'claude-code', '2.1.309', 'abc123', 'claude.exe');
    expect(claudeCandidates(env({ Path: join(dir, 'bin') }))).toEqual([
      { path: onPath, source: 'path' },
      { path: native, source: 'known-location' },
      { path: desktop, source: 'known-location' },
    ]);
    expect(resolveClaudeExecutable(env({ Path: join(dir, 'bin') }))).toBe(onPath);
  });

  it('does not take a shim alone, but the binary an npm package ships behind it', () => {
    touch('npm', 'claude.cmd');
    expect(claudeCandidates(env({ Path: join(dir, 'npm') }))).toEqual([]);
    const shipped = touch('npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    expect(claudeCandidates(env({ Path: join(dir, 'npm') }))).toEqual([{ path: shipped, source: 'path' }]);
  });

  it('finds the desktop CLI in a versioned folder with or without a hash folder, newest version first', () => {
    const old = touch('roaming', 'Claude', 'claude-code', '2.1.9', 'claude.exe');
    const mid = touch('local', 'Claude-Data', 'a', 'claude-code', '2.1.200', 'h1', 'claude.exe');
    const newest = touch('local', 'Claude-Data', 'b', 'claude-code', '2.1.310', 'h2', 'claude.exe');
    touch('local', 'Claude-Data', 'b', 'claude-code', 'cache', 'claude.exe');
    expect(desktopClaudeInstalls(env())).toEqual([newest, mid, old]);
  });

  it('finds nothing in empty or missing folders', () => {
    expect(claudeCandidates(env())).toEqual([]);
    expect(desktopClaudeInstalls({})).toEqual([]);
  });

  it('Codex: AWG_CODEX_COMMAND, PATH, then its install folder', () => {
    const mine = touch('mine', 'codex.exe');
    expect(codexCandidates({ AWG_CODEX_COMMAND: mine, Path: '' })).toEqual([{ path: mine, source: 'env' }]);
    const onPath = touch('bin', 'codex.exe');
    const known = touch('local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    expect(codexCandidates({ Path: join(dir, 'bin'), LOCALAPPDATA: join(dir, 'local') })).toEqual([
      { path: onPath, source: 'path' },
      { path: known, source: 'known-location' },
    ]);
  });
});

const ok = (stdout: string, stderr = ''): RunResult => ({ stdout, stderr, code: 0 });
const claudeJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgId: 'org-secret', orgName: 'Secret Org', subscriptionType: 'pro', ...over });

/** A fake `--version` and status command per executable. */
const fakeRun = (table: Record<string, { version?: RunResult; status?: RunResult }>): { run: RunCommand; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push([file, ...args]);
      const entry = table[file];
      const result = args[0] === '--version' ? entry?.version : entry?.status;
      return Promise.resolve(result ?? { stdout: '', stderr: '', code: null });
    },
  };
};

const AT = '2026-11-01T10:00:00.000Z';
const locate = (runtime: Runtime, table: Parameters<typeof fakeRun>[0], paths: { path: string; source: 'env' | 'path' | 'known-location' | 'sdk-bundled' }[], logs: string[] = []) => {
  const { run, calls } = fakeRun(table);
  const locator = createRuntimeLocator({ run, candidates: () => paths, log: (m) => logs.push(m), env: {} });
  return { detect: () => locator.detect(runtime, AT), calls, locator };
};

describe('T045 the locator', () => {
  const claude = 'C:/c/claude.exe';
  const codex = 'C:/c/codex.exe';

  it('Claude: found, new enough and signed in with a subscription is available, and the status is a valid C-33 status', async () => {
    const { detect, calls } = locate('claude', { [claude]: { version: ok('2.1.309 (Claude Code)'), status: ok(claudeJson()) } }, [{ path: claude, source: 'path' }]);
    const status = await detect();
    expect(status).toEqual({ runtime: 'claude', state: 'available', executable: claude, source: 'path', version: '2.1.309', requiredVersion: '2.1.309', auth: 'subscription', modelCount: 0, checkedAt: AT });
    expect(() => RuntimeStatus.parse(status)).not.toThrow();
    expect(calls).toEqual([[claude, '--version'], [claude, 'auth', 'status']]);
  });

  it('never keeps an account, an organisation or a key: not in the status, not in the log', async () => {
    const logs: string[] = [];
    const { detect } = locate('claude', { [claude]: { version: ok('2.1.400'), status: ok(claudeJson()) } }, [{ path: claude, source: 'path' }], logs);
    const status = await detect();
    const all = JSON.stringify(status) + logs.join('\n');
    for (const secret of ['someone@example.com', 'org-secret', 'Secret Org', 'firstParty']) expect(all).not.toContain(secret);
    const codexLogs: string[] = [];
    const c = locate('codex', { [codex]: { version: ok('codex-cli 0.160.0'), status: ok('', 'Logged in using an API key - sk-proj-***abcd\n') } }, [{ path: codex, source: 'path' }], codexLogs);
    const codexStatus = await c.detect();
    expect(codexStatus.auth).toBe('api-key');
    expect(JSON.stringify(codexStatus) + codexLogs.join('\n')).not.toMatch(/sk-|abcd/);
  });

  it('a newer version is available and one line is logged', async () => {
    const logs: string[] = [];
    const { detect } = locate('claude', { [claude]: { version: ok('2.2.0 (Claude Code)'), status: ok(claudeJson()) } }, [{ path: claude, source: 'path' }], logs);
    expect((await detect()).state).toBe('available');
    expect(logs.filter((l) => l.includes('newer than'))).toHaveLength(1);
  });

  it('too old: not available, with the version to update to, and no sign-in question asked', async () => {
    const { detect, calls } = locate('claude', { [claude]: { version: ok('2.1.100 (Claude Code)') } }, [{ path: claude, source: 'path' }]);
    const status = await detect();
    expect(status).toMatchObject({ state: 'too-old', version: '2.1.100', requiredVersion: '2.1.309', auth: 'unknown' });
    expect(status.detail).toContain('2.1.309');
    expect(calls).toEqual([[claude, '--version']]);
    expect(() => RuntimeStatus.parse(status)).not.toThrow();
  });

  it('a version that cannot be read is failed, never guessed', async () => {
    for (const version of [ok('hello'), ok(''), ok('error: Node 24.0.0 required'), ok('2.1.309-'), ok('2.1.309 (Claude Code)\nwarning'), ok('','2.1.309 (Claude Code)'), { stdout: '', stderr: '', code: null }, { stdout: '2.1.309', stderr: '', code: 1 }]) {
      const { detect } = locate('claude', { [claude]: { version } }, [{ path: claude, source: 'path' }]);
      const status = await detect();
      expect(status).toMatchObject({ state: 'failed', executable: claude, auth: 'unknown' });
      expect(() => RuntimeStatus.parse(status)).not.toThrow();
    }
  });

  it('nothing found: not-installed with the install hint, and the env variable named when it is the reason', async () => {
    const none = locate('claude', {}, []);
    const status = await none.detect();
    expect(status).toMatchObject({ state: 'not-installed', auth: 'unknown' });
    expect(status.detail).toContain('安裝');
    expect(status.executable).toBeUndefined();
    const { run } = fakeRun({});
    const withEnv = await createRuntimeLocator({ run, candidates: () => [], env: { AWG_CLAUDE_PATH: 'C:/nope/claude.exe' } }).detect('claude', AT);
    expect(withEnv.detail).toContain('AWG_CLAUDE_PATH');
  });

  it('signed out is not available and says how to sign in; an unreadable answer is unknown and still available', async () => {
    const out = locate('claude', { [claude]: { version: ok('2.1.309'), status: { stdout: JSON.stringify({ loggedIn: false }), stderr: '', code: 1 } } }, [{ path: claude, source: 'path' }]);
    const signedOut = await out.detect();
    expect(signedOut).toMatchObject({ state: 'signed-out', auth: 'signed-out' });
    expect(signedOut.detail).toContain('claude');
    expect(() => RuntimeStatus.parse(signedOut)).not.toThrow();

    for (const status of [ok('weather is nice'), ok('{not json'), { stdout: '', stderr: '', code: null }, ok(JSON.stringify({ loggedIn: 'maybe' }))]) {
      const unknown = await locate('claude', { [claude]: { version: ok('2.1.309'), status } }, [{ path: claude, source: 'path' }]).detect();
      expect(unknown).toMatchObject({ state: 'available', auth: 'unknown' });
    }
  });

  it('Claude auth categories: subscription, API key, and other', async () => {
    const kinds: [Record<string, unknown>, string][] = [
      [{ authMethod: 'claude.ai' }, 'subscription'],
      [{ authMethod: 'oauth_token', subscriptionType: 'max' }, 'subscription'],
      [{ authMethod: 'api_key', subscriptionType: undefined }, 'api-key'],
      [{ authMethod: 'apiKey', subscriptionType: undefined }, 'api-key'],
      [{ authMethod: 'bedrock', subscriptionType: undefined }, 'unknown'],
    ];
    for (const [over, want] of kinds) {
      const status = await locate('claude', { [claude]: { version: ok('2.1.309'), status: ok(claudeJson(over)) } }, [{ path: claude, source: 'path' }]).detect();
      expect(status.auth).toBe(want);
    }
  });

  it('Codex: the sign-in status is read from stderr as well as stdout', async () => {
    const fromStderr = await locate('codex', { [codex]: { version: ok('codex-cli 0.160.0'), status: ok('', 'Logged in using ChatGPT\n') } }, [{ path: codex, source: 'known-location' }]).detect();
    expect(fromStderr).toMatchObject({ state: 'available', auth: 'subscription', source: 'known-location', version: '0.160.0', requiredVersion: '0.160.0' });
    const fromStdout = await locate('codex', { [codex]: { version: ok('0.160.0'), status: ok('Logged in using ChatGPT') } }, [{ path: codex, source: 'path' }]).detect();
    expect(fromStdout.auth).toBe('subscription');
    const out = await locate('codex', { [codex]: { version: ok('codex-cli 0.160.0'), status: { stdout: '', stderr: 'Not logged in\n', code: 1 } } }, [{ path: codex, source: 'path' }]).detect();
    expect(out).toMatchObject({ state: 'signed-out', auth: 'signed-out' });
    expect(out.detail).toContain('codex login');
    const old = await locate('codex', { [codex]: { version: ok('codex-cli 0.150.0') } }, [{ path: codex, source: 'path' }]).detect();
    expect(old).toMatchObject({ state: 'too-old', version: '0.150.0' });
    expect(old.detail).toContain('0.160.0');
  });

  it('with several candidates, takes the first new enough one, else the first it could read', async () => {
    const a = 'C:/a/claude.exe';
    const b = 'C:/b/claude.exe';
    const table = { [a]: { version: ok('2.0.0') }, [b]: { version: ok('2.1.309'), status: ok(claudeJson()) } };
    const picked = await locate('claude', table, [{ path: a, source: 'path' }, { path: b, source: 'known-location' }]).detect();
    expect(picked).toMatchObject({ state: 'available', executable: b, source: 'known-location' });
    const allOld = await locate('claude', { [a]: { version: ok('2.0.0') }, [b]: { version: ok('2.1.0') } }, [{ path: a, source: 'path' }, { path: b, source: 'known-location' }]).detect();
    expect(allOld).toMatchObject({ state: 'too-old', executable: a, version: '2.0.0' });
  });

  it('an unusable candidate is failed with a fixed explanation, nothing is run, and a usable one after it is preferred', async () => {
    const bad = 'C:/links/claude.exe';
    const calls = fakeRun({});
    const only = createRuntimeLocator({ run: calls.run, candidates: () => [{ path: bad, source: 'env', unusable: 'not-exe' }], env: {} });
    const status = await only.detect('claude', AT);
    expect(status).toMatchObject({ state: 'failed', executable: bad, source: 'env', auth: 'unknown' });
    expect(status.detail).toContain('.exe');
    expect(() => RuntimeStatus.parse(status)).not.toThrow();
    expect(calls.calls).toEqual([]);
    const good = 'C:/good/claude.exe';
    const both = fakeRun({ [good]: { version: ok('2.1.309 (Claude Code)'), status: ok(claudeJson()) } });
    const picked = await createRuntimeLocator({ run: both.run, candidates: () => [{ path: bad, source: 'path', unusable: 'not-exe' }, { path: good, source: 'known-location' }], env: {} }).detect('claude', AT);
    expect(picked).toMatchObject({ state: 'available', executable: good });
    expect(both.calls.every((c) => c[0] === good)).toBe(true);
  });

  it('keeps the last status as current, and never throws', async () => {
    const { locator } = locate('claude', { [claude]: { version: ok('2.1.309'), status: ok(claudeJson()) } }, [{ path: claude, source: 'path' }]);
    expect(locator.current('claude')).toBeUndefined();
    await locator.detect('claude', AT);
    expect(locator.current('claude')?.state).toBe('available');
    const broken = createRuntimeLocator({ run: () => Promise.reject(new Error('boom')), candidates: () => [{ path: claude, source: 'path' }], env: {} });
    await expect(broken.detect('claude', AT)).resolves.toMatchObject({ runtime: 'claude' });
  });

  it('the SDK copy is the last resort, only when the locator is given one, and never replaces AWG_CLAUDE_PATH', async () => {
    const sdk = 'C:/sdk/claude.exe';
    const { run } = fakeRun({ [sdk]: { version: ok('2.1.309'), status: ok(claudeJson()) } });
    const logs: string[] = [];
    const dev = createRuntimeLocator({ run, env: { Path: '', AWG_CLAUDE_PATH: '' }, sdkBundledClaude: () => sdk, log: (m) => logs.push(m) });
    expect(await dev.detect('claude', AT)).toMatchObject({ state: 'available', executable: sdk, source: 'sdk-bundled' });
    expect(logs.some((l) => l.includes('development'))).toBe(true);
    const packaged = createRuntimeLocator({ run, env: { Path: '' } });
    expect((await packaged.detect('claude', AT)).state).toBe('not-installed');
    const explicit = createRuntimeLocator({ run, env: { AWG_CLAUDE_PATH: 'C:/nope/claude.exe' }, sdkBundledClaude: () => sdk });
    expect((await explicit.detect('claude', AT)).state).toBe('not-installed');
  });
});

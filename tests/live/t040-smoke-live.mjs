// T040 live smoke of the wiring (V-18): the built development app (`out/`, `electron .` in this worktree) on a temporary
// userData, one launch, two Claude turns (haiku). Not part of `npm test`; run by hand after the main session approved it:
//
//   node tests/live/t040-smoke-live.mjs run       batches (contiguous, acknowledged), queries (backup.list,
//                                                 session.history), backup.restore / cancelRestore, the supervisor
//                                                 following a saved preference (1 minute) and closing with cause `idle`
//   node tests/live/t040-smoke-live.mjs cleanup   removes BASE (one explicit path, checked)
//
// Rules (T040 brief): the app is reached only through its own DevToolsActivePort (port 0), after checking the
// listener's PID and creation time; only that PID is ever ended, and only when it did not exit by itself; no inspector,
// no fault point; a folder is removed only by its explicit path; nothing under ~/.claude or ~/.codex is removed (the
// paths this adds are listed in the result). Nothing of a payload or a token is written to the result.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MODE = process.argv[2];
const REPO = 'E:\\sideproj\\AgentWorkflowGui\\wt\\T040';
const RESULTS = 'C:\\Users\\capri\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\side-session-notes\\local_33889000-34ec-4796-966a-d586b11e4f9c';
const STATE = join(RESULTS, 'T040-live-smoke-state.json');
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const V = '0.7.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const createdOf = (pid) => ps(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`);
const claudeProjects = () => {
  const dir = join(homedir(), '.claude', 'projects');
  return existsSync(dir) ? readdirSync(dir) : [];
};

if (MODE === 'cleanup') {
  const { base } = JSON.parse(readFileSync(STATE, 'utf8'));
  if (typeof base !== 'string' || !/\\awg-t040-smoke-[A-Za-z0-9]+$/.test(base)) throw new Error('unexpected base');
  rmSync(base, { recursive: true, force: true });
  console.log('removed', !existsSync(base));
  process.exit(0);
}
if (MODE !== 'run') throw new Error('usage: t040-smoke-live.mjs run|cleanup');

const base = mkdtempSync(join(process.env.TEMP, 'awg-t040-smoke-'));
writeFileSync(STATE, JSON.stringify({ base }));
const userData = join(base, 'userData');
const ws = join(base, 'ws');
mkdirSync(userData, { recursive: true });
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, 'README.md'), '# T040 live workspace\n');
const projectsBefore = new Set(claudeProjects());
const result = { startedAt: now(), base, steps: [], checks: {} };
const step = (name, data = {}) => {
  const e = { at: now(), name, ...data };
  result.steps.push(e);
  console.log(JSON.stringify(e).slice(0, 800));
};
const check = (name, ok, detail) => {
  result.checks[name] = { ok: Boolean(ok), ...(detail !== undefined && { detail }) };
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 400));
};

const env = { ...process.env, AWG_IDLE_TICK_MS: '2000' };
for (const k of ['ELECTRON_RENDERER_URL', 'AWG_FAULT_POINT', 'AWG_IDLE_CLOSE_MS', 'AWG_MAX_OPEN_RUNTIMES', 'AWG_PERF_LOG', 'AWG_PERF_LOAD']) delete env[k];
const activePort = join(userData, 'DevToolsActivePort');
const logFd = openSync(join(base, 'electron.log'), 'a');
const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { cwd: REPO, env, stdio: ['ignore', logFd, logFd] });
result.electronPid = child.pid;
result.electronCreated = createdOf(child.pid);

const pageUrl = async () => {
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    if (child.exitCode !== null) throw new Error('the app exited before it was reachable');
    if (!existsSync(activePort)) continue;
    const port = Number(readFileSync(activePort, 'utf8').split(/\r?\n/)[0]);
    if (!Number.isInteger(port) || port <= 0) continue;
    const owner = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
    if (owner === '') continue;
    if (Number(owner) !== child.pid || createdOf(child.pid) !== result.electronCreated) throw new Error(`port ${port} is held by process ${owner}, not by the app this script started; nothing was sent`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.toLowerCase().startsWith('file:///') && decodeURI(t.url).replace(/\//g, '\\').toLowerCase().includes(`${REPO.toLowerCase()}\\out\\renderer`));
    if (page) return page.webSocketDebuggerUrl;
  }
  throw new Error('no page of the app on its own debugging port');
};

let socket;
let id = 0;
const pending = new Map();
const evaluate = (expression) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error || msg.result?.exceptionDetails ? reject(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails).slice(0, 500))) : resolve(msg.result.result.value)));
    socket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
let requests = 0;
const send = (command) => evaluate(`window.awg.send(${JSON.stringify({ requestId: `t040-smoke-${++requests}`, ...command })})`);
const query = (request) => evaluate(`window.awg.query(${JSON.stringify({ requestId: `t040-smoke-q${++requests}`, ...request })})`);
const snapshot = () => evaluate('window.awg.snapshot()');
const view = (s, sid) => ({
  activity: s.sessions.find((x) => x.id === sid)?.activity,
  revision: s.sessions.find((x) => x.id === sid)?.revision,
  turns: s.turns.filter((t) => t.sessionId === sid && t.nativeTaskId === undefined).map((t) => t.state),
  assistant: s.messages.filter((m) => m.sessionId === sid && m.role === 'assistant').length,
});
const waitFor = async (what, sid, test, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = view(await snapshot(), sid);
    if (test(v)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`);
    await sleep(1500);
  }
};
/** The batches the page received since `watch()`: ranges and the event types, nothing of their content. */
const batches = () => evaluate('window.__t040smoke.batches');

try {
  socket = new WebSocket(await pageUrl());
  await new Promise((res, rej) => {
    socket.onopen = res;
    socket.onerror = rej;
  });
  socket.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await sleep(2000);
  const api = await evaluate(`Object.keys(window.awg).sort()`);
  check('preload exposes query and onBatch', api.includes('query') && api.includes('onBatch'), api);
  await evaluate(`(() => { window.__t040smoke = { batches: [] }; window.awg.onBatch((b) => window.__t040smoke.batches.push({ from: b.fromSeq, to: b.toSeq, n: b.envelopes.length, types: b.envelopes.map((e) => e.event.type), causes: b.envelopes.filter((e) => e.event.type === 'session.activity' && e.event.cause).map((e) => [e.event.sessionId, e.event.activity, e.event.cause]) })); return true; })()`);
  const first = await snapshot();
  step('boot', { app: first.app, seq: first.seq, storage: first.storage, historyPages: first.historyPages, preferences: first.preferences });
  check('Snapshot: app ready, storage present', first.app.status === 'ready' && typeof first.storage === 'object');

  const backups = await query({ type: 'backup.list' });
  step('backup.list', { ok: backups.ok, backups: backups.ok ? backups.backups.map((b) => ({ id: b.id, reason: b.reason, storageVersion: b.storageVersion })) : backups });
  check('backup.list answered', backups.ok && backups.backups.some((b) => b.reason === 'daily'));
  const daily = backups.ok ? backups.backups.find((b) => b.reason === 'daily') : undefined;
  if (daily) {
    const restore = await send({ type: 'backup.restore', backupId: daily.id });
    await sleep(500);
    const afterRestore = (await snapshot()).storage;
    check('backup.restore scheduled, Snapshot shows it', restore.ok && afterRestore.pendingRestore?.backupId === daily.id, { restore, afterRestore });
    const cancel = await send({ type: 'backup.cancelRestore' });
    await sleep(500);
    const afterCancel = (await snapshot()).storage;
    check('backup.cancelRestore withdraws it', cancel.ok && afterCancel.pendingRestore === undefined, { cancel, afterCancel });
  }
  check('backup.restore of an unknown ID is not_found', (await send({ type: 'backup.restore', backupId: 'backup-00000000-0000-0000-0000-000000000000' })).code === 'not_found');

  step('agent.save', { result: await send({ type: 'agent.save', agent: { schemaVersion: V, id: 'agent-t040', revision: 0, name: 'T040', description: '', instructions: 'Answer in one short sentence. Do not use any tool and do not run any command.', updatedAt: now() }, expectedRevision: null }) });
  const sid = 't040-smoke-claude';
  step('session.create', { result: await send({ type: 'session.create', sessionId: sid, kind: 'ordinary', agentId: 'agent-t040', model: { runtime: 'claude', model: 'haiku' }, cwd: ws }) });
  let v = await waitFor('the session to start', sid, (x) => x.activity === 'idle', 120_000);
  for (const [n, text] of [
    [1, 'Say hello in five words.'],
    [2, 'Now say goodbye in five words.'],
  ]) {
    step(`send ${n}`, { result: await send({ type: 'session.send', sessionId: sid, messageId: `${sid}-m${n}`, expectedRevision: v.revision, text, attachments: [] }) });
    v = await waitFor(`turn ${n}`, sid, (x) => x.turns.length >= n && x.turns.every((t) => t !== 'running') && x.assistant >= n, 180_000);
    step(`turn ${n} ended`, { view: v });
  }

  const snap = await snapshot();
  const page = snap.historyPages.find((p) => p.sessionId === sid);
  step('history pages', { historyPages: snap.historyPages });
  check('a short history is all in the Snapshot (no older cursor)', page === undefined || page.olderCursor === null, page);
  const bad = await query({ type: 'session.history', sessionId: sid, before: 'made-up-cursor', limit: 50 });
  check('session.history refuses a cursor it never handed out', !bad.ok && bad.code === 'invalid_request', bad);
  const unknown = await query({ type: 'session.history', sessionId: 'nobody', before: 'x', limit: 50 });
  check('session.history of an unknown session is not_found', !unknown.ok && unknown.code === 'not_found', unknown);

  // C-30: one minute of idleness, from the user's preferences (no environment override), and the cause on the close.
  const prefs = await send({ type: 'preferences.set', preferences: { ...snap.preferences, supervisor: { idleCloseMinutes: 1, maxOpenRuntimes: snap.preferences.supervisor.maxOpenRuntimes } } });
  step('preferences.set (idle 1 minute)', { result: prefs });
  const setAt = Date.now();
  v = await waitFor('the idle close', sid, (x) => x.activity === 'closed', 150_000);
  const seen = await batches();
  const causes = seen.flatMap((b) => b.causes);
  step('closed', { afterMs: Date.now() - setAt, view: v, causes });
  check('the supervisor closed it after the saved idle time, with cause idle', causes.some(([s, a, c]) => s === sid && a === 'closed' && c === 'idle'), causes);

  const gaps = seen.filter((b, i) => i > 0 && b.from !== seen[i - 1].to + 1).length;
  const merged = seen.reduce((n, b) => n + (b.to - b.from + 1 - b.n), 0);
  result.batches = { count: seen.length, envelopes: seen.reduce((n, b) => n + b.n, 0), mergedAway: merged, gaps, largest: Math.max(0, ...seen.map((b) => b.n)) };
  check('batches are contiguous (fromSeq right after the last toSeq)', gaps === 0, result.batches);
  check('the renderer stayed connected (no reload asked for)', !seen.some((b) => b.types.includes('snapshot.invalidated')));
} catch (error) {
  result.error = String(error?.stack ?? error);
} finally {
  const t0 = Date.now();
  try {
    await evaluate('window.close()');
  } catch {
    // closing
  }
  const exited = await Promise.race([new Promise((r) => (child.exitCode !== null ? r(true) : child.once('exit', () => r(true)))), sleep(30_000).then(() => false)]);
  result.exited = exited;
  result.exitMs = Date.now() - t0;
  if (!exited && createdOf(child.pid) === result.electronCreated) {
    spawnSync('taskkill', ['/F', '/PID', String(child.pid)]);
    result.forcedEnd = child.pid;
  }
  socket?.close();
  result.addedUnderClaudeProjects = claudeProjects().filter((p) => !projectsBefore.has(p));
  result.log = readFileSync(join(base, 'electron.log'), 'utf8').slice(-3000);
  result.endedAt = now();
  writeFileSync(join(RESULTS, 'T040-live-smoke.json'), JSON.stringify(result, null, 2));
  console.log('exited', exited, 'exitMs', result.exitMs, result.error ?? '', 'checks', Object.values(result.checks).filter((c) => !c.ok).length, 'failed');
}

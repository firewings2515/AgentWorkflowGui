// T040 live performance baseline (V-18): the built development app (`out/`, `electron .` in this worktree) on a
// temporary userData, measured without an inspector on the main process. Not part of `npm test`; run by hand, one
// launch per invocation, after the main session approved the count:
//
//   node tests/live/t040-perf-live.mjs empty <n>     an empty database: start-up, then 100 keys typed while idle
//   node tests/live/t040-perf-live.mjs load <n>      the 10,000-message session (seeded first, once): start-up, open
//                                                    it, 50 keys idle, then 100 deltas a second for 60 s while 300
//                                                    keys are typed (one every 200 ms)
//   node tests/live/t040-perf-live.mjs cleanup       removes BASE (one explicit path, checked)
//
// Measured: the main process's event loop delay, memory and every process's CPU (AWG_PERF_LOG, perf-log.ts: written
// by the app itself, so no inspector); start-up marks (spawn → app ready → backend → window → first Snapshot, its
// size); in the page, through the renderer's own DevTools port (port 0, its DevToolsActivePort, PID and creation time
// checked — T044 r1 P1-3): each typed key's keydown → next frame, the Event Timing entries (≥ 16 ms, until paint),
// the first contentful paint, and the renderer's heap.
//
// Rules (T040 brief): only the PID this script started is ever ended, and only when it did not exit by itself; a
// folder is removed only by its explicit path; nothing under ~/.claude or ~/.codex is touched (no runtime turn runs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [MODE, RUN] = process.argv.slice(2);
const REPO = 'E:\\sideproj\\AgentWorkflowGui\\wt\\T040';
const RESULTS = 'C:\\Users\\capri\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\side-session-notes\\local_33889000-34ec-4796-966a-d586b11e4f9c';
const STATE = join(RESULTS, 'T040-live-perf-state.json');
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const SESSION = 's-perf';

/** Ends an empty-database run after its start-up measurements; not an error. */
class StartOnly extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const createdOf = (pid) => ps(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`);
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const stats = (values) => {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const r = (n) => (n === undefined ? null : Math.round(n * 100) / 100);
  return { n: sorted.length, median: r(at(0.5)), p95: r(at(0.95)), max: r(sorted.at(-1)) };
};

if (MODE === 'cleanup') {
  const { base } = state();
  if (typeof base !== 'string' || !/\\awg-t040-perf-[A-Za-z0-9]+$/.test(base)) throw new Error('unexpected base');
  rmSync(base, { recursive: true, force: true });
  console.log('removed', !existsSync(base));
  process.exit(0);
}
if ((MODE !== 'empty' && MODE !== 'load') || !/^\d+$/.test(RUN ?? '')) throw new Error('usage: t040-perf-live.mjs empty|load <n> | cleanup');

let { base } = state();
if (base === undefined || !existsSync(base)) {
  base = mkdtempSync(join(process.env.TEMP, 'awg-t040-perf-'));
  writeFileSync(STATE, JSON.stringify({ base }));
}
const label = `${MODE}-${RUN}`;
const userData = join(base, `userData-${label}`);
if (existsSync(userData)) throw new Error(`${userData} exists: use another run number`);
mkdirSync(userData, { recursive: true });
const perfLog = join(base, `perf-${label}.jsonl`);
const result = { label, mode: MODE, startedAt: now(), base, steps: [] };
const step = (name, data = {}) => {
  const e = { at: now(), name, ...data };
  result.steps.push(e);
  console.log(JSON.stringify(e).slice(0, 600));
};

if (MODE === 'load') {
  // The same seeded database for every load run: built once, copied into each run's userData.
  const seeded = join(base, 'seed', 'awg.sqlite');
  if (!existsSync(seeded)) {
    mkdirSync(join(base, 'seed'), { recursive: true });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [join(REPO, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/perf/seed-db.test.ts'], {
      cwd: REPO,
      env: { ...process.env, AWG_SEED_DB: seeded, AWG_SEED_TURNS: '5000' },
      encoding: 'utf8',
    });
    if (r.status !== 0 || !existsSync(seeded)) throw new Error(`seeding failed: ${r.stdout.slice(-2000)}${r.stderr.slice(-2000)}`);
    step('seeded', { ms: Date.now() - t0 });
  }
  writeFileSync(join(userData, 'awg.sqlite'), readFileSync(seeded));
}

// ---- launch ------------------------------------------------------------------------------------------------
const env = { ...process.env, AWG_PERF_LOG: perfLog };
delete env.ELECTRON_RENDERER_URL;
delete env.AWG_FAULT_POINT;
if (MODE === 'load') env.AWG_PERF_LOAD = `session=${SESSION};rate=100;seconds=60;delayMs=25000;chars=24`;
const activePort = join(userData, 'DevToolsActivePort');
const logFd = openSync(join(base, `electron-${label}.log`), 'a');
const spawnedAt = Date.now();
const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { cwd: REPO, env, stdio: ['ignore', logFd, logFd] });
result.electronPid = child.pid;
result.electronCreated = createdOf(child.pid);
step('spawned', { pid: child.pid });

const pageUrl = async () => {
  for (let i = 0; i < 300; i++) {
    await sleep(100);
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

let ws;
let id = 0;
const pending = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
const marks = () =>
  existsSync(perfLog)
    ? readFileSync(perfLog, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const waitMark = async (name, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = marks().find((x) => x.kind === 'mark' && x.name === name);
    if (m) return m;
    await sleep(100);
  }
  throw new Error(`no ${name} mark`);
};

/** Types `count` keys into the composer, one every `everyMs`, through CDP (trusted input). */
const type = async (count, everyMs) => {
  const rtt = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    rtt.push(performance.now() - t0);
    await sleep(Math.max(0, everyMs - (performance.now() - t0)));
  }
  return rtt;
};
const takeLatencies = () => evaluate('(() => { const v = window.__t040; window.__t040 = { frame: [], timing: [] }; return v; })()');

try {
  ws = new WebSocket(await pageUrl());
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  step('connected', { afterSpawnMs: Date.now() - spawnedAt });
  // In-page measurement, installed after connecting (the page is not reloaded): keydown → next frame for every key,
  // Event Timing for the slow ones (≥ 16 ms, until the next paint), paints from the buffer.
  await evaluate(`(() => {
    window.__t040 = { frame: [], timing: [] };
    document.addEventListener('keydown', (e) => { const t = e.timeStamp; requestAnimationFrame((f) => window.__t040.frame.push(f - t)); }, true);
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__t040.timing.push({ name: e.name, duration: e.duration, queued: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart }); })
      .observe({ type: 'event', durationThreshold: 16, buffered: true });
    return true;
  })()`);
  // The session list on screen.
  let listed = false;
  for (let i = 0; i < 600 && !listed; i++) {
    listed = await evaluate(MODE === 'load' ? `[...document.querySelectorAll('button.session-link')].some((b) => b.textContent.includes('perf-10k'))` : `document.querySelector('.composer textarea, .app-nav') !== null`);
    if (!listed) await sleep(50);
  }
  const page = await evaluate(`({ timeOrigin: performance.timeOrigin, now: performance.now(), fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null, heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null })`);
  step('listed', { listed, afterSpawnMs: Date.now() - spawnedAt, page });
  const start = marks().find((m) => m.kind === 'start');
  const at = (name) => {
    const m = marks().find((x) => x.kind === 'mark' && x.name === name);
    return m && start ? Math.round(start.timeOrigin + m.t - spawnedAt) : null;
  };
  const firstSnapshot = marks().find((x) => x.kind === 'mark' && x.name === 'snapshot');
  result.startup = {
    spawnToMainStartMs: at('main-start'),
    spawnToAppReadyMs: at('app-ready'),
    spawnToBackendMs: at('backend-started'),
    spawnToWindowMs: at('window-created'),
    spawnToWindowLoadedMs: at('window-loaded'),
    spawnToFirstSnapshotMs: at('snapshot'),
    firstSnapshot: firstSnapshot ? { ms: firstSnapshot.ms, bytes: firstSnapshot.bytes } : null,
    spawnToFirstContentfulPaintMs: page.fcp === null || start === undefined ? null : Math.round(page.timeOrigin + page.fcp - spawnedAt),
    spawnToListSeenMs: Date.now() - spawnedAt,
  };
  step('startup', result.startup);

  if (MODE === 'load') {
    await evaluate(`[...document.querySelectorAll('button.session-link')].find((b) => b.textContent.includes('perf-10k')).click()`);
    await sleep(1500);
  }
  // An empty database has no session, so no composer to type into: its runs measure the start only (T040 live, run 2).
  if (MODE === 'empty') {
    // Long enough for the app's own samples (every 5 s) of an idle main process.
    await sleep(12_000);
    throw new StartOnly();
  }
  // The composer of the open session; with no session (an empty database), the first text field on the page.
  result.typedInto = await evaluate(`(() => { const el = document.querySelector('.composer textarea') ?? [...document.querySelectorAll('textarea, input:not([type]), input[type=text]')].find((e) => e.offsetParent !== null); if (!el) return null; el.focus(); return el.tagName + (el.placeholder ? ':' + el.placeholder : ''); })()`);
  if (result.typedInto === null) throw new Error('no text field to type into');
  await takeLatencies();
  const idleRtt = await type(MODE === 'load' ? 50 : 100, 200);
  const idle = await takeLatencies();
  result.idleInput = { keys: idleRtt.length, keydownToFrameMs: stats(idle.frame), cdpRoundTripMs: stats(idleRtt), slowEvents: idle.timing.length, slowestEventMs: stats(idle.timing.map((e) => e.duration)) };
  step('idle input', result.idleInput);

  if (MODE === 'load') {
    await waitMark('load-start', 60_000);
    const loadRtt = await type(300, 200);
    await waitMark('load-end', 30_000);
    await sleep(3000);
    const load = await takeLatencies();
    result.loadInput = { keys: loadRtt.length, keydownToFrameMs: stats(load.frame), cdpRoundTripMs: stats(loadRtt), slowEvents: load.timing.length, slowestEventMs: stats(load.timing.map((e) => e.duration)), timing: load.timing.slice(0, 50) };
    step('load input', result.loadInput);
    // What the renderer shows of the stream: one message's text, all 6000 lines.
    result.streamShown = await evaluate(`document.body.innerText.split('x'.repeat(23)).length - 1`);
  }
  result.pageEnd = await evaluate(`({ heap: performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null })`);
  await sleep(6000);
} catch (error) {
  if (!(error instanceof StartOnly)) result.error = String(error?.stack ?? error);
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
  ws?.close();
  // The app's own measurements.
  const all = marks();
  const loadStart = all.find((m) => m.name === 'load-start')?.t ?? Infinity;
  const loadEnd = all.find((m) => m.name === 'load-end')?.t ?? Infinity;
  const samples = all.filter((m) => m.kind === 'sample');
  const phase = (from, to) => {
    const s = samples.filter((x) => x.t > from && x.t <= to + 5000);
    const cpu = (type) => stats(s.map((x) => x.processes.filter((p) => p.type === type).reduce((a, p) => a + p.cpu, 0)));
    const ws = (type) => stats(s.map((x) => x.processes.filter((p) => p.type === type).reduce((a, p) => a + p.workingSetKb, 0) / 1024));
    return {
      samples: s.length,
      eventLoopDelayP50Ms: stats(s.map((x) => x.eventLoopDelayMs.p50)),
      eventLoopDelayP95Ms: stats(s.map((x) => x.eventLoopDelayMs.p95)),
      eventLoopDelayMaxMs: stats(s.map((x) => x.eventLoopDelayMs.max)),
      mainRssMb: stats(s.map((x) => x.mainMemory.rss / 1048576)),
      mainHeapMb: stats(s.map((x) => x.mainMemory.heapUsed / 1048576)),
      cpuPercent: { browser: cpu('Browser'), renderer: cpu('Tab'), gpu: cpu('GPU') },
      workingSetMb: { browser: ws('Browser'), renderer: ws('Tab'), gpu: ws('GPU') },
      batcher: s.at(-1)?.batcher ?? null,
    };
  };
  result.main = { idle: phase(0, Math.min(loadStart, Infinity)), ...(MODE === 'load' && { load: phase(loadStart, loadEnd) }) };
  result.loadMarks = all.filter((m) => m.name === 'load-start' || m.name === 'load-end');
  result.log = readFileSync(join(base, `electron-${label}.log`), 'utf8').slice(-3000);
  result.endedAt = now();
  writeFileSync(join(RESULTS, `T040-live-perf-${label}.json`), JSON.stringify(result, null, 2));
  console.log('exited', exited, 'exitMs', result.exitMs, result.error ?? '');
}

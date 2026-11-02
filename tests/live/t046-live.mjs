// T046 live runs (F-1, F-2, G-1, and T039's P4 flow): the built development app (`out/`, `electron .` in this worktree)
// is ended with `taskkill /F /PID` at the dispatch fault point and started again on the same temporary userData. Not part
// of `npm test`; run by hand, one launch per invocation, after the main session approved the count:
//
//   node tests/live/t046-live.mjs <chain> <step>
//     chain claude | codex   n1  session A created and never sent to; session B's first message stops after its unknown
//                                commit (fault point) → kill
//                            n2  check B: reconciled only, its message escalation (G-1); A's first message (Claude: opened
//                                again under its own ID, one turn; Codex: refused plainly, A shows error); another message
//                                to B is refused; the user's retry of B (Claude: opened again, one turn; Codex: refused
//                                plainly); normal exit
//     chain flow             f1  workflow: root (Codex) creates a task and hands it to Implement (Claude), whose dispatch
//                                stops after its unknown commit (P3) → kill
//                            f2  check P3; the user's retry (attempt 2, Implement opened again under its own ID);
//                                Implement works and hands off; the merge queue's test runs (it waits on its first run)
//                                (P4) → kill
//                            f3  check P4: tests again, merged once, worktrees cleaned; normal exit
//     <chain> cleanup        removes that chain's BASE (one explicit path, checked)
//
// The helpers and the flow chain are T039's (tests/live/t039-crash-live.mjs) with the runtimes of the flow swapped:
// Codex cannot open a thread again under its own ID (F-2), so the P4 flow needs a Claude Implement (main session's
// decision, 2026-11-02). Rules as T039's: the app is reached only through its own DevToolsActivePort (port 0), after
// checking the listener's PID and creation time; only that PID is ever ended (`taskkill /F /PID`, no /T); no inspector;
// a folder is removed only by its explicit path; nothing under ~/.claude or ~/.codex is removed (the paths this adds are
// listed in the results). Results go to the shared notes folder as T046-live-<chain>-<step>.json; nothing of a payload
// or a token is written there.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [CHAIN, STEP] = process.argv.slice(2);
// `--no-kill`: an exit that does not finish is left as it is (its PID recorded) instead of ended: the approved count
// of kills has no room left (T039 run 2).
const NO_KILL = process.argv.includes('--no-kill');
// `--rerun=N`: a step run again on the same userData. Its message and request IDs differ from the earlier run's, which
// the app already took (an ID it has seen is not sent again: T039 run 3, l4b).
const RERUN = process.argv.find((a) => /^--rerun=\d+$/.test(a))?.slice('--rerun='.length);
const ID = `t046-${CHAIN}-${STEP}${RERUN === undefined ? '' : `-r${RERUN}`}`;
const REPO = 'E:\\sideproj\\AgentWorkflowGui\\wt\\T046';
const RESULTS = 'C:\\Users\\capri\\AppData\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\side-session-notes\\local_33889000-34ec-4796-966a-d586b11e4f9c';
const STATE = join(RESULTS, `T046-live-state-${CHAIN}.json`);
const ELECTRON = join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const V = '0.7.0';
const RUNTIME = CHAIN === 'claude' || CHAIN === 'codex' ? CHAIN : undefined;
const MODEL = RUNTIME === 'claude' ? { runtime: 'claude', model: 'haiku' } : { runtime: 'codex', model: 'gpt-6-luna' };
const AGENT = 'agent-t046';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const ps = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const json = (text) => (text === '' ? [] : [JSON.parse(text)].flat());
/** Every process now, with its parent and creation time (no command lines: they could carry settings). */
const processes = () =>
  json(ps("Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, @{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"));
const createdOf = (pid) => ps(`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`);
/** The tree below `pid` (itself included). */
const treeOf = (pid, all = processes()) => {
  const out = [];
  const walk = (p) => {
    const self = all.find((x) => x.ProcessId === p);
    if (self) out.push(self);
    for (const c of all.filter((x) => x.ParentProcessId === p && x.ProcessId !== p)) walk(c.ProcessId);
  };
  walk(pid);
  return out;
};
/** Whether this very process (PID and creation time to the millisecond) still runs. */
const stillRuns = (all, pid, startedAt) => all.some((x) => x.ProcessId === pid && Math.abs(Date.parse(x.Created) - Date.parse(startedAt)) < 1000);

const state = () => JSON.parse(readFileSync(STATE, 'utf8'));
const save = (name, data) => writeFileSync(join(RESULTS, `T046-live-${CHAIN}-${name}.json`), JSON.stringify(data, null, 2));
const versions = () => ({
  commit: spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).filter(Boolean).length,
  electron: JSON.parse(readFileSync(join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
  outBuilt: statSync(join(REPO, 'out', 'main', 'index.js')).mtime.toISOString(),
});

/** The database, read only, while the app runs or after it is gone (WAL). */
const readDb = (userData, sessionIds) => {
  const db = new DatabaseSync(join(userData, 'awg.sqlite'), { readOnly: true });
  try {
    const own = (sessionId) => sessionIds === undefined || sessionIds.includes(sessionId);
    const deliveries = db
      .prepare("SELECT operation_id, kind, state, json_extract(target, '$.sessionId') AS session, accepted_at, outcome FROM delivery ORDER BY accepted_at")
      .all()
      .filter((d) => d.session === null || own(d.session));
    const ops = new Set(deliveries.map((d) => d.operation_id));
    const attempts = db
      .prepare('SELECT operation_id, seq, attempt_id, client_message_id, state, dispatch_started_at, abandoned, resolution, native_ref FROM dispatch_attempt ORDER BY operation_id, seq')
      .all()
      .filter((a) => ops.has(a.operation_id));
    const owned = db
      .prepare('SELECT pid, ended_at, body FROM owned_process')
      .all()
      .map((r) => ({ ...JSON.parse(r.body), endedAt: r.ended_at ?? undefined }))
      .filter((p) => own(p.sessionId) || p.sessionId.startsWith('cmd-') || p.sessionId.startsWith('models-'));
    return { deliveries, attempts, owned };
  } finally {
    db.close();
  }
};

/** What the Snapshot says of the given sessions (and of the run, for the flow). */
const viewOf = (s, sessionIds) => {
  const own = (id) => sessionIds === undefined || sessionIds.includes(id);
  return {
    sessions: s.sessions.filter((x) => own(x.id)).map((x) => ({ id: x.id, activity: x.activity, cwd: x.cwd, revision: x.revision })),
    turns: s.turns.filter((t) => own(t.sessionId) && t.nativeTaskId === undefined).map((t) => ({ session: t.sessionId, id: t.id, state: t.state, startedAt: t.startedAt, endedAt: t.endedAt })),
    items: s.items.filter((i) => own(i.sessionId)).map((i) => ({ session: i.sessionId, id: i.id, kind: i.kind, state: i.state, endedAt: i.endedAt, ...(i.kind === 'command' && { command: i.command.slice(0, 80) }) })),
    messages: s.messages.filter((m) => own(m.sessionId)).map((m) => ({ session: m.sessionId, role: m.role, origin: m.origin?.kind, chars: m.text.length })),
    permissionRequests: s.permissionRequests.filter((p) => own(p.sessionId)).map((p) => ({ session: p.sessionId, id: p.id, kind: p.kind, state: p.state, decision: p.decision?.outcome, decidedBy: p.decision?.decidedBy })),
    escalations: s.escalations.map((e) => ({ id: e.id, kind: e.kind, state: e.state, from: e.fromSessionId, resolvedBy: e.resolvedBy, ref: e.ref?.kind })),
    handoffs: s.handoffs.map((h) => ({ id: h.id, task: h.taskId, from: h.fromNodeId, to: h.toNodeId, state: h.delivery.state, attempts: h.delivery.attempts.length, session: h.target.sessionId })),
    instances: s.instances.map((i) => ({
      id: i.id,
      state: i.state,
      tasks: i.tasks.map((t) => ({ id: t.id, status: t.status, blockedReason: t.blockedReason, cleanup: t.worktree?.cleanup })),
      mergeQueue: i.mergeQueue.map((m) => ({ task: m.taskId, attempt: m.attempt, state: m.state, cleanup: m.integration?.cleanup, test: m.test && { exitCode: m.test.exitCode, passed: m.test.passed } })),
    })),
  };
};

/** Starts the app on its own debugging port (0) and connects to its page after checking who listens there. */
const launch = async (base, extraEnv, logName) => {
  const userData = join(base, 'userData');
  const activePort = join(userData, 'DevToolsActivePort');
  rmSync(activePort, { force: true });
  const logPath = join(base, `electron-${logName}.log`);
  const logFd = openSync(logPath, 'a');
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
    cwd: REPO,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', logFd, logFd],
  });
  await sleep(500);
  const created = createdOf(child.pid);
  let url;
  for (let i = 0; i < 90 && url === undefined; i++) {
    await sleep(1000);
    if (child.exitCode !== null) throw new Error('the app exited before it was reachable');
    if (!existsSync(activePort)) continue;
    const port = Number(readFileSync(activePort, 'utf8').split(/\r?\n/)[0]);
    if (!Number.isInteger(port) || port <= 0) continue;
    const owner = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
    if (owner === '') continue;
    if (Number(owner) !== child.pid || createdOf(child.pid) !== created) throw new Error(`port ${port} is held by process ${owner}, not by the app this script started (${child.pid}); nothing was sent`);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && typeof t.url === 'string' && decodeURI(t.url).replace(/\//g, '\\').toLowerCase().includes(`${REPO.toLowerCase()}\\out\\renderer`));
    if (page) url = page.webSocketDebuggerUrl;
  }
  if (url === undefined) throw new Error('no page of the app on its own debugging port');
  const ws = new globalThis.WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const evaluate = (expression, awaitPromise = true) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => (msg.error || msg.result?.exceptionDetails ? reject(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails))) : resolve(msg.result.result.value)));
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }));
    });
  let requests = 0;
  const command = (c) => ({ requestId: `${ID}-${String(++requests)}`, ...c });
  const app = {
    child,
    created,
    logPath,
    userData,
    log: () => readFileSync(logPath, 'utf8'),
    send: (c) => evaluate(`window.awg.send(${JSON.stringify(command(c))})`),
    /** A command whose answer is not waited for (its dispatch is meant to stop). */
    fire: (c) => evaluate(`void window.awg.send(${JSON.stringify(command(c))}); 'fired'`, false),
    snapshot: () => evaluate('window.awg.snapshot()'),
    close: () => ws.close(),
    windowClose: () => evaluate('window.close()', false),
    /** Ends exactly the process this script started, after checking it is still that process. */
    kill: () => {
      if (createdOf(child.pid) !== created) throw new Error('the app PID no longer belongs to the app; nothing ended');
      const r = spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { encoding: 'utf8' });
      return { status: r.status, out: r.stdout.trim() };
    },
  };
  return app;
};

const waitFor = async (what, check, ms, everyMs = 2000) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
};
const waitLog = (app, pattern, ms) => waitFor(`log ${pattern}`, () => app.log().split(/\r?\n/).find((l) => pattern.test(l)), ms, 200);

/** The renderer-independent part of each run's record. */
const begin = (name) => ({ chain: CHAIN, step: name, startedAt: now(), versions: versions(), steps: [] });
const step = (result, name, data) => {
  const e = { at: now(), name, ...data };
  result.steps.push(e);
  console.log(JSON.stringify(e).slice(0, 1500));
};

const agentDef = (id, name, instructions) => ({ schemaVersion: V, id, revision: 0, name, description: '', instructions, updatedAt: now() });
/** Saved once in a userData; reused as it is afterwards (no second save, T045). */
const ensureAgent = async (app, result, id, name, instructions) => {
  const existing = (await app.snapshot()).agents.find((a) => a.id === id);
  const saved = existing ? { ok: true, reused: existing.revision } : await app.send({ type: 'agent.save', agent: agentDef(id, name, instructions), expectedRevision: null });
  step(result, `agent ${id}`, { result: saved });
  if (!saved.ok) throw new Error('agent.save failed');
};
const sessionView = async (app, id) => {
  const s = await app.snapshot();
  const session = s.sessions.find((x) => x.id === id);
  const turns = s.turns.filter((t) => t.sessionId === id && t.nativeTaskId === undefined);
  return { activity: session?.activity, revision: session?.revision, turns: turns.map((t) => t.state), assistant: s.messages.filter((m) => m.sessionId === id && m.role === 'assistant').length, s };
};
/** A session view without its Snapshot, for the record. */
const withoutSnapshot = (view) => Object.fromEntries(Object.entries(view).filter(([k]) => k !== 's'));
const createSession = async (app, result, id, cwd) => {
  step(result, `session.create ${id}`, { result: await app.send({ type: 'session.create', sessionId: id, kind: 'ordinary', agentId: AGENT, model: MODEL, cwd }) });
  return waitFor(`${id} to start`, async () => {
    const v = await sessionView(app, id);
    return v.activity === 'idle' ? v : undefined;
  }, 120_000);
};
let messages = 0;
const sendText = async (app, id, text) => {
  const v = await sessionView(app, id);
  return app.send({ type: 'session.send', sessionId: id, messageId: `${ID}-m${String(++messages)}`, expectedRevision: v.revision, text, attachments: [] });
};
/** Waits until the session's own turns all ended and one more assistant message than before is there. */
const turnDone = (app, id, assistantBefore, ms = 180_000) =>
  waitFor(`${id}'s turn to end`, async () => {
    const v = await sessionView(app, id);
    return v.turns.length > 0 && v.turns.every((t) => t !== 'running') && v.assistant > assistantBefore ? v : undefined;
  }, ms);

/** The kill and what is left of the app's tree right after (the Job must have ended the runtimes and commands). */
const killAndCheck = async (app, result, watched) => {
  const before = treeOf(app.child.pid);
  step(result, 'process tree before the kill', { tree: before.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, created: p.Created })) });
  const killedAt = now();
  const killed = app.kill();
  const exited = await Promise.race([new Promise((r) => app.child.once('exit', () => r(true))), sleep(15_000).then(() => false)]);
  await sleep(3000);
  const all = processes();
  const left = before.filter((p) => stillRuns(all, p.ProcessId, p.Created));
  const ownedLeft = watched.filter((p) => stillRuns(all, p.pid, p.startedAt));
  step(result, 'killed', { killedAt, killed, exited, treeLeft: left.map((p) => ({ pid: p.ProcessId, name: p.Name })), ownedLeft: ownedLeft.map((p) => ({ pid: p.pid, kind: p.kind })) });
  app.close();
  return { left, ownedLeft };
};

/**
 * R-14: the exit asks first when work is left; the button that goes on is pressed in that app's own dialog. With
 * `press` false the dialog is only looked for (the exit's observation, T039 run 2).
 */
const answerExitConfirmation = (pid, created, press = true) => {
  if (createdOf(pid) !== created) return { pressed: false, reason: 'not the app', dialogs: [] };
  const out = ps(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, ${pid})
$found = @()
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
  $texts = @($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text))) | ForEach-Object { $_.Current.Name })
  $button = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, '結束程式')))
  if ($button -ne $null) {
    $pressed = $false
    $how = ''
    if (${press ? '$true' : '$false'}) {
      # T039 run 2: Invoke alone left the dialog open (it stayed for 160 s, nothing was shut down). The button's own
      # window is clicked when the dialog is still there a moment later.
      $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      $how = 'invoke'
      Start-Sleep -Milliseconds 800
      $still = $true
      $hwnd = 0
      try { $hwnd = $button.Current.NativeWindowHandle } catch { $still = $false }
      if ($still -and $hwnd -ne 0) {
        Add-Type -Namespace T039 -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
        [void][T039.User32]::SendMessage([System.IntPtr]$hwnd, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
        $how = 'invoke+bm_click'
      }
      $pressed = $true
    }
    $found += @{ title = $w.Current.Name; texts = $texts; pressed = $pressed; how = $how; controlType = $button.Current.ControlType.ProgrammaticName }
  }
}
$found | ConvertTo-Json -Compress -Depth 4`);
  const dialogs = json(out);
  return { pressed: dialogs.some((d) => d.pressed), dialogs };
};

/**
 * What the shutdown has written so far (read only): before-quit is seen as the dialog itself (confirmExit runs only
 * there), and the shutdown as its writes (held approvals declined, sessions closed, Jobs' records ended).
 */
const shutdownWrites = (userData) => {
  const db = new DatabaseSync(join(userData, 'awg.sqlite'), { readOnly: true });
  try {
    const bodies = (table) => db.prepare(`SELECT body FROM ${table}`).all().map((r) => JSON.parse(r.body));
    return {
      activities: bodies('logical_session').filter((s) => s.activity !== 'closed').map((s) => `${s.id}:${s.activity}`),
      heldRequests: bodies('permission_request').filter((p) => p.state === 'held').length,
      liveOwned: db.prepare('SELECT COUNT(*) AS n FROM owned_process WHERE ended_at IS NULL').get().n,
    };
  } finally {
    db.close();
  }
};

/** Normal exit (R-14): window.close(), answering the exit confirmation when it comes; observed every second. */
const exitApp = async (app, result) => {
  const t0 = Date.now();
  // Closing the last window quits the app (window-all-closed); before-quit asks first when work is left.
  await app.windowClose().catch(() => undefined);
  let confirmation;
  const observed = [];
  const exited = await Promise.race([
    new Promise((r) => app.child.once('exit', () => r(true))),
    (async () => {
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (app.child.exitCode !== null) return true;
        let dialogs;
        if (confirmation === undefined || !confirmation.pressed) {
          const answered = answerExitConfirmation(app.child.pid, app.created);
          if (answered.dialogs.length > 0) confirmation = { ...answered, atMs: Date.now() - t0, presses: 1 };
          dialogs = answered.dialogs.length;
        } else {
          dialogs = answerExitConfirmation(app.child.pid, app.created, false).dialogs.length;
          // Still there after a press: pressed again, at most three times in all (each press is recorded).
          if (dialogs > 0 && confirmation.presses < 3 && Date.now() - t0 - confirmation.atMs > 3000) {
            const again = answerExitConfirmation(app.child.pid, app.created);
            confirmation = { ...confirmation, presses: confirmation.presses + 1, again: [...(confirmation.again ?? []), { atMs: Date.now() - t0, dialogs: again.dialogs }] };
          }
        }
        let writes;
        try {
          writes = shutdownWrites(app.userData);
        } catch (error) {
          writes = { error: String(error).slice(0, 120) };
        }
        observed.push({ atMs: Date.now() - t0, dialogs, tree: treeOf(app.child.pid).map((p) => p.Name), writes });
      }
      return false;
    })(),
  ]);
  app.close();
  step(result, 'exit', { exited, exitMs: Date.now() - t0, confirmation, observed });
  if (!exited && NO_KILL) {
    // A plain close request to this very process (no /F, no /T), then 30 s more; past that it is left as it is.
    const asked = createdOf(app.child.pid) === app.created ? spawnSync('taskkill', ['/PID', String(app.child.pid)], { encoding: 'utf8' }) : undefined;
    step(result, 'not exited; asked to close (taskkill without /F)', { pid: app.child.pid, status: asked?.status ?? 'not the app' });
    let closed = false;
    for (let i = 0; i < 30 && !closed; i++) {
      await sleep(1000);
      closed = app.child.exitCode !== null;
    }
    step(result, closed ? 'closed after the request' : 'not exited; left running (--no-kill)', {
      pid: app.child.pid,
      created: app.created,
      tree: treeOf(app.child.pid).map((p) => ({ pid: p.ProcessId, name: p.Name })),
      dialogs: closed ? 0 : answerExitConfirmation(app.child.pid, app.created, false).dialogs,
    });
  } else if (!exited) step(result, 'not exited; ended', { killed: app.kill() });
  await sleep(2000);
};

const finish = (result, app, base) => {
  result.endedAt = now();
  try {
    result.electronLog = readFileSync(app.logPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => /^\[(backend|sessions|supervisor|runtimes|fault|pipeline|process|claude|codex|mcp)\]/.test(l))
      .slice(-120);
  } catch {
    result.electronLog = [];
  }
  result.base = base;
  save(STEP, result);
};

// ---- T046: the ordinary chains --------------------------------------------------------------------------------------
const S = (p) => `live-${CHAIN}-${p}`;
const A = S('a');
const B = S('b');
const INSTRUCTIONS = 'Answer in one short sentence. Do not use any tool and do not run any command.';
/** Whether a delivery-unknown escalation of the session is open, pointing at a message (G-1). */
const messageEscalation = (s, sessionId) => s.escalations.find((e) => e.kind === 'delivery-unknown' && e.state === 'open' && e.fromSessionId === sessionId && e.ref?.kind === 'message');

const ordinary = async () => {
  if (STEP === 'n1') {
    if (existsSync(STATE)) throw new Error(`${STATE} exists: this chain was started already`);
    const base = mkdtempSync(join(process.env.TEMP, `awg-t046-live-${CHAIN}-`));
    for (const d of ['userData', 'ws']) mkdirSync(join(base, d), { recursive: true });
    writeFileSync(join(base, 'ws', 'README.md'), '# T046 live workspace\n');
    writeFileSync(STATE, JSON.stringify({ base, createdAt: now() }));
  }
  const { base } = state();
  const ws = join(base, 'ws');
  const env = { n1: { AWG_FAULT_POINT: 'dispatch', AWG_FAULT_SESSION: B }, n2: {} }[STEP];
  if (env === undefined) throw new Error(`unknown step ${STEP}`);
  const result = begin(STEP);
  result.env = Object.keys(env).map((k) => `${k}=${env[k]}`);
  const app = await launch(base, env, STEP);
  result.electronPid = app.child.pid;
  result.electronCreated = app.created;
  try {
    await sleep(2000);
    const boot = await app.snapshot();
    step(result, 'boot', { runtimes: boot.runtimes.map((r) => ({ runtime: r.runtime, state: r.state, version: r.version })), view: viewOf(boot, [A, B]), db: readDb(app.userData, [A, B]) });
    await ensureAgent(app, result, AGENT, 'T046', INSTRUCTIONS);

    if (STEP === 'n1') {
      // A: created, never sent to (nothing handed over). B: its first message stops after its unknown commit.
      await createSession(app, result, A, ws);
      await createSession(app, result, B, ws);
      const v = await sessionView(app, B);
      step(result, 'B send (its dispatch stops at the fault point)', { fired: await app.fire({ type: 'session.send', sessionId: B, messageId: `t046-${CHAIN}-b-m1`, expectedRevision: v.revision, text: 'Reply with the single word ONE.', attachments: [] }) });
      step(result, 'B fault point reached', { line: await waitLog(app, new RegExp(`^\\[fault\\] dispatch reached session=${B} `), 60_000) });
      const db = readDb(app.userData, [A, B]);
      step(result, 'before the kill', { db, view: viewOf(await app.snapshot(), [A, B]) });
      await killAndCheck(app, result, db.owned.filter((p) => p.endedAt === undefined));
      return;
    }

    // n2: after the crash.
    const s0 = await app.snapshot();
    const escalation = messageEscalation(s0, B);
    step(result, 'after the restart', { db: readDb(app.userData, [A, B]), view: viewOf(s0, [A, B]), escalation: escalation && { id: escalation.id, ref: escalation.ref, title: escalation.title }, check: { gOne: escalation !== undefined, bReconciling: s0.sessions.find((x) => x.id === B)?.activity === 'reconciling' } });
    if (escalation === undefined) throw new Error('no message escalation for B after the restart (G-1)');

    // A: nothing was handed over. Claude opens it again under its own ID; Codex says it cannot.
    const beforeA = (await sessionView(app, A)).assistant;
    const sentA = await sendText(app, A, 'Reply with the single word TWO.');
    step(result, 'A first message', { result: sentA });
    if (RUNTIME === 'claude') step(result, 'A turn', { view: withoutSnapshot(await turnDone(app, A, beforeA)), db: readDb(app.userData, [A]) });
    else step(result, 'A refused', { view: withoutSnapshot(await sessionView(app, A)), db: readDb(app.userData, [A]), check: { refused: sentA.ok === false && sentA.code === 'invalid_transition' } });

    // B: an attempt is undecided; another message is refused, nothing is opened or sent.
    const sentB = await sendText(app, B, 'Reply with the single word THREE.');
    await sleep(3000);
    step(result, 'B another message (refused)', { result: sentB, view: withoutSnapshot(await sessionView(app, B)), db: readDb(app.userData, [B]), check: { refused: sentB.ok === false && sentB.code === 'invalid_transition' } });

    // B: the user's retry of the unknown message.
    const beforeB = (await sessionView(app, B)).assistant;
    const retried = await app.send({ type: 'delivery.resolve', escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true });
    step(result, 'B the user retries', { result: retried });
    if (RUNTIME === 'claude') step(result, 'B retried turn', { view: withoutSnapshot(await turnDone(app, B, beforeB)), db: readDb(app.userData, [B]) });
    else {
      await sleep(5000);
      step(result, 'B retry refused', { view: withoutSnapshot(await sessionView(app, B)), db: readDb(app.userData, [B]), check: { refused: retried.ok === false && retried.code === 'runtime_unavailable' } });
    }
    await exitApp(app, result);
    step(result, 'after the exit', { db: readDb(app.userData, [A, B]) });
  } catch (error) {
    result.error = String(error?.stack ?? error);
    try {
      if (app.child.exitCode === null) await exitApp(app, result);
    } catch (e) {
      result.exitError = String(e);
    }
  } finally {
    finish(result, app, base);
  }
};

// ---- the workflow chain -------------------------------------------------------------------------------------------
const RUN = 'run-t046-live';
const ROOT = 'root-t046-live';
const WF = 'wf-t046-live';
const flow = async () => {
  if (STEP === 'f1') {
    if (existsSync(STATE)) throw new Error(`${STATE} exists: this chain was started already`);
    const base = mkdtempSync(join(process.env.TEMP, 'awg-t046-live-flow-'));
    const ws = join(base, 'ws');
    for (const d of ['userData', 'ws']) mkdirSync(join(base, d), { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'user.name=AWG live', '-c', 'user.email=live@example.invalid', ...args], { cwd: ws, encoding: 'utf8' });
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'live', private: true, type: 'module' }, null, 2) + '\n');
    writeFileSync(join(ws, 'greet.js'), "export function greet(name) {\n  return 'Hello, ' + name;\n}\n");
    writeFileSync(join(ws, 'greet.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { greet } from './greet.js';\n\ntest('greet names the person', () => {\n  assert.ok(greet('Ann').includes('Ann'));\n});\n");
    // The first run of the tests says where it runs, then waits (the GUI is ended meanwhile); later runs test.
    const started = join(base, 'test-started.json');
    writeFileSync(
      join(ws, 'run-tests.mjs'),
      `import { existsSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst mark = ${JSON.stringify(started)};\nif (!existsSync(mark)) {\n  writeFileSync(mark, JSON.stringify({ pid: process.pid, cwd: process.cwd(), at: new Date().toISOString() }));\n  setTimeout(() => process.exit(1), 240000);\n} else {\n  const r = spawnSync(process.execPath, ['--test'], { stdio: 'inherit' });\n  process.exit(r.status ?? 1);\n}\n`,
    );
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    writeFileSync(STATE, JSON.stringify({ base, createdAt: now(), started }));
  }
  const { base, started } = state();
  const ws = join(base, 'ws');
  const env = { f1: { AWG_FAULT_POINT: 'dispatch', AWG_FAULT_RUNTIME: 'claude' }, f2: {}, f3: {} }[STEP];
  if (env === undefined) throw new Error(`unknown step ${STEP}`);
  const result = begin(STEP);
  result.env = Object.keys(env).map((k) => `${k}=${env[k]}`);
  const app = await launch(base, env, STEP);
  result.electronPid = app.child.pid;
  result.electronCreated = app.created;
  /** Permission requests of this throw-away run are declined (the agents are told to run no command). */
  const answered = [];
  const declinePermissions = async (s) => {
    for (const e of s.escalations.filter((x) => x.kind === 'permission' && x.state === 'open' && !answered.includes(x.id))) {
      answered.push(e.id);
      step(result, 'a permission request declined', { escalation: e.id, from: e.fromSessionId, result: await app.send({ type: 'escalation.respond', escalationId: e.id, decision: 'decline', note: 'T046 live: no commands' }) });
    }
  };
  const run = (s) => s.instances.find((i) => i.id === RUN);
  try {
    await sleep(2000);
    const boot = await app.snapshot();
    step(result, 'boot', { runtimes: boot.runtimes.map((r) => ({ runtime: r.runtime, state: r.state, version: r.version })), view: viewOf(boot), db: readDb(app.userData) });
    if (STEP === 'f1') {
      const haiku = { runtime: 'claude', model: 'haiku' };
      const codex = { runtime: 'codex', model: 'gpt-6-luna' };
      const out = (id, condition, target) => ({ id, condition, payload: condition, target, requiresUserConfirmation: false });
      const workflow = {
        schemaVersion: V, id: WF, revision: 0, name: 'T046 live', description: 'T046 live: one task, Codex root, Claude Implement, merge after tests', reworkLimit: 1, isolation: 'worktree',
        nodes: [
          { id: 'plan', kind: 'agent', label: 'Plan', agentId: 'agent-t046-lead', model: codex, isRoot: true, writePolicy: 'read-only', concurrency: 1, inputRules: [], position: { x: 0, y: 0 }, outputRules: [out('split', 'the work splits into tasks', { kind: 'tasks' }), out('to-impl', 'a task is ready to build', { kind: 'node', nodeId: 'impl' })] },
          { id: 'impl', kind: 'agent', label: 'Implement', agentId: 'agent-t046-builder', model: haiku, isRoot: false, writePolicy: 'write', concurrency: 1, inputRules: [{ id: 'work', condition: 'a task', waitForAllUpstream: false }], position: { x: 200, y: 0 }, outputRules: [out('to-merge', 'the task is done', { kind: 'node', nodeId: 'merge' })] },
          { id: 'merge', kind: 'merge', label: 'Merge', writePolicy: 'write', concurrency: 1, inputRules: [], position: { x: 400, y: 0 }, outputRules: [] },
        ],
        edges: [{ source: 'plan', target: 'impl' }, { source: 'impl', target: 'merge' }],
        updatedAt: now(),
      };
      const project = { schemaVersion: V, id: 'project-t046-live', revision: 0, name: 'T046 live repo', rootPath: ws, defaultBranch: 'main', commands: { test: 'node run-tests.mjs', shell: 'powershell' }, updatedAt: now() };
      await ensureAgent(app, result, 'agent-t046-lead', 'Lead', 'You coordinate a small piece of work with the GUI tools, exactly as the user says. Do not edit files and do not run commands. When the GUI reports that a task was merged, answer with one short sentence and call no tool.');
      await ensureAgent(app, result, 'agent-t046-builder', 'Builder', 'You make small, exact code changes in your working folder with your file editing tools. Do not run shell commands and do not use git. When the change is made, call the handoff tool with ruleId "to-merge" and target {"kind":"node","nodeId":"merge"}.');
      step(result, 'workflow.save', { result: await app.send({ type: 'workflow.save', workflow, expectedRevision: null }) });
      step(result, 'project.save', { result: await app.send({ type: 'project.save', project, expectedRevision: null }) });
      const firstMessage = [
        'Do exactly this in this one turn, then end your turn:',
        '1. Call create_tasks with ruleId "split" and tasks: [{"key":"a","title":"Greet with Hi"}].',
        '2. Call handoff once with ruleId "to-impl", target {"kind":"node","nodeId":"impl"}, taskId set to the created task\'s ID, and content: "In greet.js, make greet return \'Hi, \' + name instead of \'Hello, \' + name. Change only that line."',
        'Do not edit any file yourself.',
      ].join('\n');
      step(result, 'workflow.start', { result: await app.send({ type: 'workflow.start', instanceId: RUN, rootSessionId: ROOT, workflowId: WF, workflowRevision: 0, title: 'Greeting change', cwd: ws, firstMessage, crossToolConsent: true }) });
      const line = await waitFor('the handoff dispatch to stop', async () => {
        await declinePermissions(await app.snapshot());
        return app.log().split(/\r?\n/).find((l) => /^\[fault\] dispatch reached session=/.test(l));
      }, 300_000);
      step(result, 'P3 fault point reached', { line });
      const s = await app.snapshot();
      const db = readDb(app.userData);
      step(result, 'P3 before the kill', { db, view: viewOf(s) });
      await killAndCheck(app, result, db.owned.filter((p) => p.endedAt === undefined));
      return;
    }
    if (STEP === 'f2') {
      const s0 = await app.snapshot();
      step(result, 'P3 after the restart', { db: readDb(app.userData), view: viewOf(s0) });
      const unknown = s0.escalations.find((e) => e.kind === 'delivery-unknown' && e.state === 'open');
      if (unknown === undefined) throw new Error('no delivery-unknown escalation after the restart');
      step(result, 'P3 the user retries', { escalation: unknown.id, result: await app.send({ type: 'delivery.resolve', escalationId: unknown.id, decision: 'retry', acceptDuplicateRisk: true }) });
      const second = await waitFor('the retry\'s attempt 2', async () => {
        const h = (await app.snapshot()).handoffs.find((x) => x.toNodeId === 'impl');
        return h && h.delivery.attempts.length >= 2 ? { state: h.delivery.state, attempts: h.delivery.attempts.length } : undefined;
      }, 120_000, 1000);
      step(result, 'P3 attempt 2', { handoff: second, db: readDb(app.userData) });
      const testing = await waitFor('the merge queue to test', async () => {
        const s = await app.snapshot();
        await declinePermissions(s);
        const m = run(s)?.mergeQueue.find((x) => x.state === 'testing');
        return m && existsSync(started) ? { attempt: m, started: JSON.parse(readFileSync(started, 'utf8')) } : undefined;
      }, 600_000, 3000);
      const all = processes();
      const testProcess = all.find((p) => p.ProcessId === testing.started.pid);
      step(result, 'P4 the test runs', { started: testing.started, process: testProcess && { pid: testProcess.ProcessId, ppid: testProcess.ParentProcessId, name: testProcess.Name, created: testProcess.Created }, chain: testProcess ? treeOf(app.child.pid, all).some((p) => p.ProcessId === testProcess.ProcessId) : false });
      const db = readDb(app.userData);
      step(result, 'P4 before the kill', { db, view: viewOf(await app.snapshot()) });
      const watched = [...db.owned.filter((p) => p.endedAt === undefined), ...(testProcess ? [{ pid: testProcess.ProcessId, startedAt: testProcess.Created, kind: 'test' }] : [])];
      await killAndCheck(app, result, watched);
      return;
    }
    // f3
    const s0 = await app.snapshot();
    step(result, 'P4 after the restart', { db: readDb(app.userData), view: viewOf(s0) });
    const done = await waitFor('the task to be merged and cleaned', async () => {
      const s = await app.snapshot();
      await declinePermissions(s);
      const i = run(s);
      const merged = i?.tasks.every((t) => t.status === 'merged') === true;
      const clean = i?.tasks.every((t) => t.worktree === undefined || t.worktree.cleanup === 'removed') === true && i.mergeQueue.every((m) => m.integration?.cleanup !== 'active' && m.integration?.cleanup !== 'pending-cleanup');
      return merged && clean ? s : undefined;
    }, 600_000, 3000);
    step(result, 'P4 merged', {
      view: viewOf(done),
      main: spawnSync('git', ['-C', ws, 'log', '--oneline', '-3', 'main'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/),
      greet: readFileSync(join(ws, 'greet.js'), 'utf8').split(/\r?\n/)[1],
      worktrees: spawnSync('git', ['-C', ws, 'worktree', 'list'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/),
    });
    // Root's report turn, if any, ends before the exit.
    await waitFor('root to be idle', async () => {
      const s = await app.snapshot();
      return s.turns.filter((t) => t.sessionId === ROOT && t.nativeTaskId === undefined).every((t) => t.state !== 'running');
    }, 180_000);
    await exitApp(app, result);
    step(result, 'after the exit', { db: readDb(app.userData) });
  } catch (error) {
    result.error = String(error?.stack ?? error);
    try {
      if (app.child.exitCode === null) await exitApp(app, result);
    } catch (e) {
      result.exitError = String(e);
    }
  } finally {
    finish(result, app, base);
  }
};

if (STEP === 'cleanup') {
  const { base } = state();
  if (!new RegExp(`\\\\awg-t046-live-${CHAIN}-[A-Za-z0-9]{6}$`).test(base)) throw new Error(`unexpected base ${base}`);
  const listed = readdirSync(base);
  for (let i = 0; i < 5 && existsSync(base); i++) {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch (error) {
      console.log('retry', String(error));
      await sleep(2000);
    }
  }
  console.log(JSON.stringify({ removed: !existsSync(base), base, listed }));
} else if (RUNTIME !== undefined) {
  await ordinary();
} else if (CHAIN === 'flow') {
  await flow();
} else {
  throw new Error('usage: node tests/live/t046-live.mjs claude|codex|flow <step>|cleanup');
}

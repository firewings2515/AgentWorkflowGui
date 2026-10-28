// Real Codex in a session Job (T013, CR-7): the model starts a detached `Start-Process` worker, which no
// terminal API lists and which outlives the app-server; closing the session's Job ends it. Skipped unless
// AWG_CODEX_LIVE=1 because it spends Codex usage (one short turn on the cheapest model). Optional:
// AWG_CODEX_MODEL (default gpt-6-luna), AWG_CODEX_COMMAND (codex.exe; default `codex` on PATH),
// AWG_T013_LIVE_NOTE=<file> writes the observations.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionId } from '../../contracts';
import { CodexAdapter, type CodexAdapterEvent } from '../codex';
import { WindowsProcessHost } from './host';
import { codexAppServerSpawn } from './runtimes';
import { isAlive, waitUntil } from './testing/workers';
import { closeHandle, creationTime, exitCodeOf, openProcess, terminateProcess } from './win32';

const live = process.env.AWG_CODEX_LIVE === '1' && process.platform === 'win32';
const model = process.env.AWG_CODEX_MODEL ?? 'gpt-6-luna';
const command = process.env.AWG_CODEX_COMMAND;
const S = SessionId.parse('live-t013');

/** Heartbeat worker: writes its PID and a tick count next to itself every 250 ms, for at most 4 minutes. */
const WORKER = `const fs=require('fs'),p=require('path').join(__dirname,'beat.json');let t=0;
const beat=()=>fs.writeFileSync(p,JSON.stringify({pid:process.pid,ticks:++t}));beat();
const i=setInterval(beat,250);setTimeout(()=>{clearInterval(i);process.exit(0)},240000);`;

describe.skipIf(!live)('Codex in a session Job (live)', () => {
  const cwd = live ? mkdtempSync(join(tmpdir(), 'awg-t013-')) : '';
  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('closing the session Job ends the detached Start-Process worker the app-server left behind', { timeout: 180_000 }, async () => {
    const worker = join(cwd, 'worker.cjs');
    writeFileSync(worker, WORKER);
    const beat = () => {
      try {
        return JSON.parse(readFileSync(join(cwd, 'beat.json'), 'utf8')) as { pid: number; ticks: number };
      } catch {
        return undefined;
      }
    };
    const host = new WindowsProcessHost();
    const events: CodexAdapterEvent[] = [];
    const approvals: { command: string | undefined; approved: boolean }[] = [];
    const adapter = new CodexAdapter({
      spawn: codexAppServerSpawn(host, S, command === undefined ? {} : { command }),
      endJob: () => host.closeJob(S),
      // Only the fixture command is approved.
      onPermissionRequest: (h) => {
        const cmd = h.request.command;
        const approved = cmd !== undefined && cmd.includes('worker.cjs') && cmd.includes('Start-Process') && !/remove-item|del\s|rm\s|curl|invoke-webrequest/i.test(cmd);
        approvals.push({ command: cmd, approved });
        h.answer({ outcome: approved ? 'approve' : 'decline', decidedBy: 'policy', at: new Date().toISOString() });
      },
    });
    adapter.subscribe((e) => events.push(e));
    const note: Record<string, unknown> = { model, approvals };
    let identity: { pid: number; startedAt: string } | undefined;
    try {
      await adapter.start();
      const thread = await adapter.startThread({ sessionId: S, cwd, sandbox: 'workspace-write', model });
      const ps = `Start-Process -FilePath '${process.execPath}' -ArgumentList @('${worker}') -WindowStyle Hidden`;
      await adapter.startTurn({
        threadId: thread.threadId,
        model,
        effort: 'low',
        text: `Run exactly this PowerShell command once for an authorized process lifecycle test, then reply STARTED. Do not run any other command: ${ps}`,
      });
      expect(await waitUntil(() => beat() !== undefined, 120_000)).toBe(true);
      const pid = beat()!.pid;
      const handle = openProcess(pid);
      if (handle === undefined) throw new Error('the worker exited at once');
      identity = { pid, startedAt: new Date(creationTime(handle)).toISOString() };
      closeHandle(handle);

      const owned = await host.listOwned(S);
      note.owned = owned.map((p) => ({ pid: p.pid, kind: p.kind }));
      expect(owned.find((p) => p.pid === pid)).toMatchObject({ kind: 'command', runtime: 'codex', sessionId: S });
      await waitUntil(() => events.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running'), 60_000);

      // R-14 graceful close: stdin, the app-server exits; the detached worker does not (spike §1).
      note.closeSession = await adapter.closeSession(thread.threadId);
      await new Promise((r) => setTimeout(r, 1000));
      note.workerAliveAfterAppServerExit = isAlive(identity);
      const ticks = beat()!.ticks;

      const { ended } = await host.closeJob(S);
      note.ended = ended.map((p) => ({ pid: p.pid, kind: p.kind }));
      note.workerAliveAfterCloseJob = isAlive(identity);
      await new Promise((r) => setTimeout(r, 1000));
      note.ticks = [ticks, beat()!.ticks];
      expect(ended.some((p) => p.pid === pid)).toBe(true);
      expect(note.workerAliveAfterCloseJob).toBe(false);
      expect(beat()!.ticks).toBeLessThanOrEqual(ticks + 1);
    } finally {
      // Only the worker this test identified, and only if it is still that very process.
      if (identity && isAlive(identity)) {
        const h = openProcess(identity.pid);
        if (h !== undefined) {
          if (creationTime(h) === Date.parse(identity.startedAt) && exitCodeOf(h) === undefined) terminateProcess(h, 1);
          closeHandle(h);
        }
      }
      await adapter.close().catch(() => undefined);
      await host.dispose();
      if (process.env.AWG_T013_LIVE_NOTE) writeFileSync(process.env.AWG_T013_LIVE_NOTE, JSON.stringify(note, null, 2));
    }
  });
});

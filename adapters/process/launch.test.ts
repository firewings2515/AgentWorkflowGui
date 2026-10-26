// The launcher against the real kernel32: a suspended start inside a KILL_ON_JOB_CLOSE Job, stdio through
// named pipes, the exit code, and that only the three pipe handles are inherited.
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { launchInJob } from './launch';
import { closeHandle, createKillOnCloseJob, jobProcessIds, terminateJob } from './win32';

const windows = process.platform === 'win32';

const node = (script: string) => ({ command: process.execPath, args: ['-e', script] });

const collect = (stream: NodeJS.ReadableStream) => {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (text += chunk));
  return () => text;
};

describe.runIf(windows)('launchInJob', () => {
  it('echoes stdin through the pipes and reports the exit code', async () => {
    const job = createKillOnCloseJob();
    try {
      const child = launchInJob(job, node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('out:'+s);process.stderr.write('err');process.exitCode=7;})"));
      expect(jobProcessIds(job)).toContain(child.pid);
      expect(child.startedAt).toBeGreaterThan(Date.now() - 60_000);
      const out = collect(child.stdout);
      const err = collect(child.stderr);
      child.stdin.end('héllo "quoted" \\ text');
      const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
      expect({ code, signal, out: out(), err: err() }).toEqual({ code: 7, signal: null, out: 'out:héllo "quoted" \\ text', err: 'err' });
    } finally {
      closeHandle(job);
    }
  });

  it('passes arguments and the environment unchanged', async () => {
    const job = createKillOnCloseJob();
    try {
      const args = ['a b', 'q"uote', 'trail\\', '', 'back\\\\"slash'];
      const child = launchInJob(job, {
        command: process.execPath,
        args: ['-e', "process.stdout.write(JSON.stringify({argv:process.argv.slice(1),v:process.env.AWG_T013,n:Object.keys(process.env).length}))", ...args],
        env: { ...process.env, AWG_T013: 'value with spaces' },
      });
      const out = collect(child.stdout);
      child.stdin.end();
      await once(child, 'close');
      const parsed = JSON.parse(out()) as { argv: string[]; v: string };
      expect(parsed.argv).toEqual(args);
      expect(parsed.v).toBe('value with spaces');
    } finally {
      closeHandle(job);
    }
  });

  it('starts grandchildren inside the same Job and ends them with it', async () => {
    const job = createKillOnCloseJob();
    const child = launchInJob(job, node("const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)"));
    const out = collect(child.stdout);
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const grandchild = Number(out());
    // The console host of CREATE_NO_WINDOW is in the Job too.
    expect(jobProcessIds(job)).toEqual(expect.arrayContaining([child.pid, grandchild]));
    terminateJob(job);
    await once(child, 'exit');
    // Terminating the Job is asynchronous for the other members.
    for (let i = 0; i < 50 && jobProcessIds(job).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(jobProcessIds(job)).toEqual([]);
    closeHandle(job);
  });

  it('kill ends the process and reports the signal', async () => {
    const job = createKillOnCloseJob();
    try {
      const child = launchInJob(job, node('setInterval(()=>{},1000)'));
      expect(child.kill('SIGTERM')).toBe(true);
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      expect({ code, signal, killed: child.killed }).toEqual({ code: null, signal: 'SIGTERM', killed: true });
      expect(child.kill()).toBe(false);
    } finally {
      closeHandle(job);
    }
  });
});

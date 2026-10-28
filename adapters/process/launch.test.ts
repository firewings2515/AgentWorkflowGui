// The launcher against the real kernel32: a suspended start inside a KILL_ON_JOB_CLOSE Job, stdio through
// named pipes, the exit code, and that only the three pipe handles are inherited. Failure paths run on a
// simulated kernel32.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { type LaunchNative, launchInJob } from './launch';
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

describe.runIf(windows)('launchInJob handle inheritance', () => {
  // A named, inheritable event stands for any inheritable handle the GUI happens to hold. The child opens
  // the event by name and asks the kernel whether the handle value it was told about is that same object.
  const koffiPath = createRequire(import.meta.url).resolve('koffi');
  const probe = (handle: bigint, name: string) =>
    `const k=require(${JSON.stringify(koffiPath)}).load('kernel32.dll');` +
    "const open=k.func('void * __stdcall OpenEventW(uint32_t a,int i,const char16_t *n)');" +
    `const same=require(${JSON.stringify(koffiPath)}).load('kernelbase.dll').func('int __stdcall CompareObjectHandles(void *a,void *b)');` +
    `const mine=open(0x100000,0,${JSON.stringify(name)});` +
    `process.stdout.write(String(same(${handle}n,mine)!==0))`;

  it('gives the child none of the GUI’s other inheritable handles (Node’s own spawn does)', async () => {
    const koffi = createRequire(import.meta.url)('koffi') as { load(p: string): { func(s: string): (...a: unknown[]) => unknown } };
    const k32 = koffi.load('kernel32.dll');
    const createEvent = k32.func('void * __stdcall CreateEventW(void *sa, int manual, int initial, const char16_t *name)');
    const security = Buffer.alloc(24);
    security.writeUInt32LE(24, 0);
    security.writeInt32LE(1, 16);
    const name = `awg-t013-${randomUUID()}`;
    const event = createEvent(security, 1, 0, name) as bigint;
    const job = createKillOnCloseJob();
    try {
      const run = async (child: { stdout: NodeJS.ReadableStream | null }) => {
        let out = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (d: string) => (out += d));
        await once(child.stdout!, 'end');
        return out;
      };
      const viaNode = spawn(process.execPath, ['-e', probe(event, name)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      expect(await run(viaNode)).toBe('true');
      const inJob = launchInJob(job, { command: process.execPath, args: ['-e', probe(event, name)] });
      inJob.stdin.end();
      expect(await run(inJob)).toBe('false');
    } finally {
      closeHandle(event);
      closeHandle(job);
    }
  });
});

describe.runIf(windows)('launchInJob failure paths (simulated kernel32)', () => {
  const fake = (fail: 'create' | 'assign' | 'resume') => {
    const calls: string[] = [];
    const closed: bigint[] = [];
    let next = 10n;
    const native: LaunchNative = {
      openInheritablePipe: () => next++,
      createSuspended: () => {
        if (fail === 'create') throw new Error('CreateProcessW failed');
        calls.push('create');
        return { process: 20n, thread: 21n, pid: 5 };
      },
      assignToJob: () => {
        if (fail === 'assign') throw new Error('AssignProcessToJobObject failed');
        calls.push('assign');
      },
      creationTime: () => 0,
      resumeThread: () => {
        if (fail === 'resume') throw new Error('ResumeThread failed');
        calls.push('resume');
      },
      exitCodeOf: () => undefined,
      terminateProcess: (handle) => (calls.push(`terminate ${handle}`), true),
      closeHandle: (handle) => void closed.push(handle),
    };
    return { native, calls, closed };
  };

  it.each([
    ['create', [], [10n, 11n, 12n]],
    ['assign', ['create', 'terminate 20'], [10n, 11n, 12n, 20n, 21n]],
    ['resume', ['create', 'assign', 'terminate 20'], [10n, 11n, 12n, 20n, 21n]],
  ] as const)('a failed %s never resumes, ends the suspended process and closes every handle', (fail, calls, closed) => {
    const f = fake(fail);
    expect(() => launchInJob(1n, { command: process.execPath }, f.native)).toThrow(/failed/);
    expect(f.calls).toEqual(calls);
    expect(f.closed.sort()).toEqual([...closed]);
  });
});

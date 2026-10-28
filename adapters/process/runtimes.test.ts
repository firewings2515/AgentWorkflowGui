// The spawn functions handed to the adapters: each runtime host starts in its session's Job, the shapes
// fit the adapters' injection points, and the SDK's abort signal ends claude.exe.
import { once } from 'node:events';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { SessionId } from '../../contracts';
import type { WireQueryOptions } from '../claude/wire';
import type { AppServerProcess, CodexAdapterOptions } from '../codex';
import { WindowsProcessHost } from './host';
import type { JobChild, LaunchOptions } from './launch';
import { type JobSpawner, claudeProcessSpawn, codexAppServerSpawn } from './runtimes';

const S = 'session-r' as SessionId;

describe('runtime spawn functions', () => {
  it('fit the adapters’ injection points', () => {
    expectTypeOf<JobChild>().toExtend<AppServerProcess>();
    expectTypeOf(codexAppServerSpawn(new WindowsProcessHost(), S)).toExtend<NonNullable<CodexAdapterOptions['spawn']>>();
    expectTypeOf(claudeProcessSpawn(new WindowsProcessHost(), S)).toExtend<NonNullable<WireQueryOptions['spawnClaudeCodeProcess']>>();
  });

  it('starts `codex app-server` with the given arguments in the session’s Job', () => {
    const calls: [SessionId, string, LaunchOptions][] = [];
    const host: JobSpawner = { spawn: (sessionId, runtime, options) => (calls.push([sessionId, runtime, options]), {} as JobChild) };
    codexAppServerSpawn(host, S, { command: 'C:\\codex\\codex.exe', args: ['-c', 'features.apps=false'], cwd: 'E:\\w' })();
    expect(calls).toEqual([[S, 'codex', { command: 'C:\\codex\\codex.exe', args: ['-c', 'features.apps=false', 'app-server'], cwd: 'E:\\w', env: undefined }]]);
  });

  it.runIf(process.platform === 'win32')('reads claude.exe’s stderr, so a chatty process never blocks on it', async () => {
    const host = new WindowsProcessHost();
    try {
      let stderr = 0;
      // 4 MiB of stderr, far beyond any pipe buffer, then one line on stdout.
      const script = "const b=Buffer.alloc(65536,120);let n=0;const w=()=>{while(n<64){n++;if(!process.stderr.write(b))return process.stderr.once('drain',w)}process.stdout.write('done')};w();setInterval(()=>{},1000)";
      const child = claudeProcessSpawn(host, S, (text) => (stderr += text.length))({ command: process.execPath, args: ['-e', script], env: { ...process.env } });
      const [line] = (await once(child.stdout, 'data')) as [Buffer];
      expect(line.toString()).toBe('done');
      expect(stderr).toBe(64 * 65536);
    } finally {
      await host.dispose();
    }
  });

  it.runIf(process.platform === 'win32')('ends claude.exe when the SDK aborts', async () => {
    const host = new WindowsProcessHost();
    try {
      const abort = new AbortController();
      const child = claudeProcessSpawn(host, S)({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: { ...process.env }, signal: abort.signal });
      expect((await host.listOwned(S)).find((p) => p.pid === child.pid)).toMatchObject({ runtime: 'claude', kind: 'runtime-host' });
      abort.abort();
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
    } finally {
      await host.dispose();
    }
  });
});

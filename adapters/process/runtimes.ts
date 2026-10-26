// Spawn functions for the adapters' injection points, so each GUI session's runtime starts in that
// session's Job: the Codex app-server (one per GUI session, CR-7) and claude.exe (the SDK's
// `spawnClaudeCodeProcess`). Typed structurally; the adapters do not depend on this module.
import type { Runtime, SessionId } from '../../contracts';
import type { JobChild, LaunchOptions } from './launch';

/** The part of the host the spawn functions need (WindowsProcessHost). */
export interface JobSpawner {
  spawn(sessionId: SessionId, runtime: Runtime, options: LaunchOptions): JobChild;
}

export interface AppServerSpawnOptions {
  /** Executable; defaults to `codex.exe` on PATH. */
  command?: string;
  /** Arguments placed before `app-server`, as in the Codex adapter's own spawn. */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** For `CodexAdapterOptions.spawn`: this session's own app-server, inside its Job. */
export const codexAppServerSpawn =
  (host: JobSpawner, sessionId: SessionId, options: AppServerSpawnOptions = {}) =>
  (): JobChild =>
    host.spawn(sessionId, 'codex', { command: options.command ?? 'codex', args: [...(options.args ?? []), 'app-server'], cwd: options.cwd, env: options.env });

/** What the Claude Agent SDK hands its `spawnClaudeCodeProcess`. */
export interface ClaudeProcessSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /** Aborts only after the SDK's own stdin-EOF grace period, so killing on it is safe. */
  signal?: AbortSignal;
}

/** For the SDK's `spawnClaudeCodeProcess`: claude.exe of this session, inside its Job. */
export const claudeProcessSpawn =
  (host: JobSpawner, sessionId: SessionId) =>
  (options: ClaudeProcessSpawnOptions): JobChild => {
    const child = host.spawn(sessionId, 'claude', { command: options.command, args: options.args, cwd: options.cwd, env: options.env });
    const { signal } = options;
    if (signal) {
      const onAbort = () => child.kill('SIGTERM');
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        child.once('exit', () => signal.removeEventListener('abort', onAbort));
      }
    }
    return child;
  };

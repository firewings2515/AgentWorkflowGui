// A stand-in GUI main process for the forced-exit test: opens Jobs for two sessions, starts a runtime
// with a detached worker in each, prints what it owns as one JSON line and waits to be killed.
import type { SessionId } from '../../../contracts';
import { WindowsProcessHost } from '../host';
import { RUNTIME_WITH_DETACHED_WORKER } from './workers';

const host = new WindowsProcessHost();
const sessions = ['session-A', 'session-B'] as SessionId[];

const started = sessions.map(
  (id) =>
    new Promise<void>((resolve) => {
      const child = host.spawn(id, 'codex', { command: process.execPath, args: ['-e', RUNTIME_WITH_DETACHED_WORKER] });
      child.stdout.once('data', () => resolve());
    }),
);
await Promise.all(started);
// Give the workers' console hosts a moment, so the list holds every member.
await new Promise((resolve) => setTimeout(resolve, 200));
process.stdout.write(`${JSON.stringify(await host.listOwned())}\n`);
setInterval(() => undefined, 1000);

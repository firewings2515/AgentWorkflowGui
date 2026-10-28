// Fixture processes for the process host tests: a runtime stand-in that starts a detached worker (as an
// agent's `Start-Process` would) and reports both PIDs, and the identity check the assertions use.
import type { OwnedProcess } from '../../../contracts';
import { closeHandle, creationTime, exitCodeOf, openProcess } from '../win32';

/**
 * Node script for a runtime host: spawns a detached, window-less worker that keeps running, prints
 * `{"worker":<pid>}` and stays up until killed.
 */
export const RUNTIME_WITH_DETACHED_WORKER =
  "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',windowsHide:true});" +
  "c.unref();process.stdout.write(JSON.stringify({worker:c.pid})+'\\n');setInterval(()=>{},1000)";

/** Whether the very process (PID and creation time) still runs; an exited one stays openable for a while. */
export const isAlive = (p: Pick<OwnedProcess, 'pid' | 'startedAt'>): boolean => {
  const handle = openProcess(p.pid);
  if (handle === undefined) return false;
  try {
    return creationTime(handle) === Date.parse(p.startedAt) && exitCodeOf(handle) === undefined;
  } finally {
    closeHandle(handle);
  }
};

export const waitUntil = async (condition: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};

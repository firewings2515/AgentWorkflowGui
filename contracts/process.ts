// Processes the GUI started (REVISION §3 OwnedProcess, R-14, CR-7, C-11). Recorded so stopping and exiting
// end exactly the GUI's own process trees, and so a restart can clean up orphans of a crashed GUI.
import { z } from 'zod';
import { Runtime, SessionId, Timestamp } from './common';

/**
 * One process in a session's Job Object. A process is identified by PID **and** creation time: PIDs are
 * reused, so cleanup ends only a process whose both still match (spike CR-7 audit).
 */
export const OwnedProcess = z.strictObject({
  pid: z.number().int().positive(),
  /** The OS creation time of the process. */
  startedAt: Timestamp,
  /** The GUI session whose Job holds it; every runtime host serves exactly one GUI session (CR-7). */
  sessionId: SessionId,
  runtime: Runtime,
  kind: z.enum(['runtime-host', 'command', 'helper']),
  /** Opaque handle of the Job it runs in, as the process host names it. */
  jobRef: z.string().min(1),
  recordedAt: Timestamp,
  endedAt: Timestamp.optional(),
});
export type OwnedProcess = z.infer<typeof OwnedProcess>;

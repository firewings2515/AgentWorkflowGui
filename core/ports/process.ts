// Process host port (T012, C-11): every GUI session's runtime processes live in one Windows Job Object
// with KILL_ON_JOB_CLOSE (R-14, CR-7, spike review-followup §1). Closing the session's Job ends its whole
// tree, detached `Start-Process` children included, without touching other sessions; a GUI that dies
// takes its Jobs with it. T013 implements it; how an adapter spawns inside a Job is between T013 and the
// adapters (an injected spawn), not part of this port.
import type { OwnedProcess, SessionId } from '../../contracts';

export interface SessionJob {
  readonly sessionId: SessionId;
  /** Recorded as `OwnedProcess.jobRef` for every process started in it. */
  readonly jobRef: string;
}

export interface ProcessHost {
  /** The Job that every runtime process of this GUI session starts in; created on first use. */
  openJob(sessionId: SessionId): Promise<SessionJob>;
  /**
   * Ends every process in the session's Job, after the graceful close of R-14 (Claude: interrupt then
   * close; Codex: close stdin) had its chance. Idempotent; returns what it ended.
   */
  closeJob(sessionId: SessionId): Promise<{ ended: OwnedProcess[] }>;
  /** Live processes in this host's Jobs, for the exit check of unfinished work (R-14). */
  listOwned(sessionId?: SessionId): Promise<OwnedProcess[]>;
  /**
   * At start: ends recorded processes of a previous run whose PID and creation time both still match, and
   * nothing else. `gone`: already exited, or the PID now belongs to another process.
   */
  cleanupOrphans(records: readonly OwnedProcess[]): Promise<{ ended: OwnedProcess[]; gone: OwnedProcess[] }>;
}

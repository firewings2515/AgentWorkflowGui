// The idle supervisor (T036, HC-04, R-14, D-03): runtime processes of sessions idle for a while are closed while
// the app runs; the next delivery resumes them in their original folder (R-06) through the one dispatch entry,
// `prepareTarget`. It owns no timer (core has none): the main process calls `tick`.
//
// A close goes `checking` → `releasing` → done, in the session's own queue (in order with its commands, deliveries
// and stored events). While `checking`, any use of the session (a delivery reaching `prepareTarget`, a runtime
// event) cancels the close without waiting for it, since the delivery may itself sit ahead in that queue. Once
// every fact said idle, the close is decided synchronously and the graceful close starts in the same step; from
// then on a delivery from outside the queue waits for the release to end and resumes the session afterwards, so
// nothing reaches a runtime that is going away (it would be claimed and end unknown, CR-2).
//
// Nothing about a close is stored: it happens only to a session with nothing unfinished, and after a crash every
// session is closed anyway (its Job ended with the GUI, `SessionService.start` marks it closed).
import type { SessionId, Timestamp } from '../../contracts';
import { type BusyReason, busyReasons, type IdleFacts } from './idle';

/** What the supervisor needs from the session service (`SessionService` has it). */
export interface SupervisedSessions {
  /** Sessions whose runtime is open now. */
  openSessions(): { sessionId: SessionId; nativeSessionRef: string }[];
  isClosing(): boolean;
  /** The stored and in-memory facts of the session; undefined when it does not exist. */
  idleFacts(sessionId: SessionId): Promise<Omit<IdleFacts, 'ownedCommands'> | undefined>;
  /**
   * In the session's queue: `decide()` and, when it says yes, the runtime closed (R-14) and the session marked
   * closed. The graceful close starts in the same synchronous step that `decide` resolved in.
   */
  closeIdle(sessionId: SessionId, decide: () => Promise<boolean>, timeoutMs: number): Promise<'closed' | 'kept'>;
}

export interface SupervisorOptions {
  sessions: SupervisedSessions;
  now(): Timestamp;
  /** How long a session must go unused before its runtime is closed. */
  idleMs: number;
  /** Open runtimes above this close the least recently used idle sessions first; 0 or less: no limit. */
  maxOpen: number;
  /** The graceful close's deadline before the session's Job is ended (R-14). */
  closeTimeoutMs: number;
  /** Live command processes in the session's Job (ProcessHost.listOwned, kind `command`). */
  ownedCommands(sessionId: SessionId): Promise<number>;
  log?(message: string): void;
}

export const SUPERVISOR_DEFAULTS = { idleMs: 15 * 60_000, maxOpen: 6, tickMs: 30_000 } as const;

interface Watch {
  lastUse: number;
  phase: 'none' | 'checking' | 'releasing';
  /** A use of the session while `checking`: the close is not made. */
  aborted: boolean;
  /** While `releasing`: resolves once the release (and the session's `closed` record) is done. */
  release?: Promise<void>;
}

export class IdleSupervisor {
  private readonly watches = new Map<SessionId, Watch>();
  private stopped = false;
  private ticking: Promise<void> | undefined;
  /** A tick was asked for while one ran: it runs once more afterwards. */
  private again = false;

  constructor(private readonly options: SupervisorOptions) {}

  /**
   * The session is in use (a delivery about to be claimed, or one of its runtime events). Returns the release
   * under way, which the caller waits for before it resumes the session; undefined when there is none.
   */
  touch(sessionId: SessionId): Promise<void> | undefined {
    const w = this.watch(sessionId);
    w.lastUse = this.nowMs();
    if (w.phase === 'checking') w.aborted = true;
    return w.phase === 'releasing' ? w.release : undefined;
  }

  /** A session's runtime came up (start or resume): in use now; above the limit, the oldest idle ones go. */
  opened(sessionId: SessionId): void {
    void this.touch(sessionId);
    if (this.options.maxOpen > 0 && this.options.sessions.openSessions().length > this.options.maxOpen) void this.tick();
  }

  /** No new closes from now on (the app is exiting); a release under way finishes. */
  stop(): void {
    this.stopped = true;
  }

  /** Last use of a session in this process, for tests and diagnostics. */
  lastUse(sessionId: SessionId): number | undefined {
    return this.watches.get(sessionId)?.lastUse;
  }

  /**
   * Closes every open session idle for `idleMs`, and above `maxOpen` the least recently used idle ones whatever
   * their idle time. A session that is not idle stays; above the limit with nothing idle, the limit is passed
   * for now rather than cutting off work. One tick at a time; one asked for meanwhile runs right after.
   */
  tick(): Promise<void> {
    if (this.ticking !== undefined) {
      this.again = true;
      return this.ticking;
    }
    const run = (async () => {
      do {
        this.again = false;
        await this.sweep();
      } while (this.again && !this.halted());
    })();
    this.ticking = run;
    const done = () => {
      if (this.ticking === run) this.ticking = undefined;
    };
    void run.then(done, done);
    return run;
  }

  private async sweep(): Promise<void> {
    if (this.halted()) return;
    const open = this.options.sessions.openSessions();
    // Oldest use first; a session first seen now counts as used now.
    const order = open.map((s) => ({ sessionId: s.sessionId, lastUse: this.watch(s.sessionId).lastUse })).sort((a, b) => a.lastUse - b.lastUse);
    let over = this.options.maxOpen > 0 ? open.length - this.options.maxOpen : 0;
    for (const { sessionId } of order) {
      if (this.halted()) return;
      const closed = await this.tryClose(sessionId, over > 0);
      if (closed) over--;
    }
    if (over > 0) this.log(`${String(over)} runtime(s) above the limit of ${String(this.options.maxOpen)}: no idle session to close`);
  }

  /** One close of one session, when it is (still) due and every fact says idle. */
  private async tryClose(sessionId: SessionId, overLimit: boolean): Promise<boolean> {
    const w = this.watch(sessionId);
    // Checked and marked in one step: a use from here on cancels it.
    if (w.phase !== 'none' || (!overLimit && this.nowMs() - w.lastUse < this.options.idleMs)) return false;
    w.phase = 'checking';
    w.aborted = false;
    let released: (() => void) | undefined;
    const { sessions } = this.options;
    try {
      const outcome = await sessions.closeIdle(
        sessionId,
        async () => {
          if (w.aborted || this.halted()) return false;
          const facts = await sessions.idleFacts(sessionId);
          if (facts === undefined || w.aborted || this.halted()) return false;
          const ownedCommands = await this.options.ownedCommands(sessionId);
          if (w.aborted || this.halted()) return false;
          const reasons: BusyReason[] = busyReasons({ ...facts, ownedCommands });
          if (reasons.length > 0) {
            this.log(`${sessionId} is not idle (${reasons.join(', ')})`);
            return false;
          }
          // Decided, with nothing awaited since the last check: from here a delivery waits for the release.
          w.phase = 'releasing';
          w.release = new Promise<void>((resolve) => {
            released = resolve;
          });
          return true;
        },
        this.options.closeTimeoutMs,
      );
      if (outcome === 'closed') this.log(`closed the idle runtime of ${sessionId}`);
      return outcome === 'closed';
    } catch (error) {
      this.log(`closing the idle runtime of ${sessionId} failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
      return false;
    } finally {
      w.phase = 'none';
      delete w.release;
      released?.();
    }
  }

  private halted(): boolean {
    return this.stopped || this.options.sessions.isClosing();
  }

  private watch(sessionId: SessionId): Watch {
    let w = this.watches.get(sessionId);
    if (w === undefined) {
      w = { lastUse: this.nowMs(), phase: 'none', aborted: false };
      this.watches.set(sessionId, w);
    }
    return w;
  }

  private nowMs(): number {
    return Date.parse(this.options.now());
  }

  private log(message: string): void {
    this.options.log?.(`[supervisor] ${message}`);
  }
}

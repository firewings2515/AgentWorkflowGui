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
// Known limit (T036 G-4, judged in T043): a runtime that starts a turn of its own at the very moment of the close — a
// sub-agent's wake-up, a scheduled task — shows nothing before its first event, and `RuntimeAdapter` has no query for
// "about to run something". Waiting cannot close that window (no signal to wait for, only a longer one), so nothing is
// waited for: the turn is interrupted by the graceful close (R-14), recorded as interrupted, the session ends `closed`
// and the next message resumes it; no transcript is lost. What the supervisor does is say so: a use of the session while
// it is being released is logged.
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
   * closed. The graceful close starts in the same synchronous step that `decide` resolved in. `cause` is why
   * (C-30): the idle time passed, or only the open-runtime limit made it go.
   */
  closeIdle(sessionId: SessionId, decide: () => Promise<boolean>, timeoutMs: number, cause: CloseCause): Promise<'closed' | 'kept'>;
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

/** Why the supervisor closed a runtime (C-30, `session.activity` `cause`). */
export type CloseCause = 'idle' | 'process-limit';

/** The limits the user can set (C-30, `UiPreferences.supervisor`). */
export interface SupervisorLimits {
  idleMs: number;
  maxOpen: number;
}

interface Watch {
  lastUse: number;
  phase: 'none' | 'checking' | 'releasing';
  /** A use of the session while `checking`: the close is not made. */
  aborted: boolean;
  /** While `releasing`: resolves once the release (and the session's `closed` record) is done. */
  release?: Promise<void>;
  /** Something used the session while its runtime was being released (G-4): logged when the release ends. */
  usedDuringRelease?: boolean;
}

export class IdleSupervisor {
  private readonly watches = new Map<SessionId, Watch>();
  /** The options' limits, until the user's preferences change them (`setLimits`). */
  private limits: SupervisorLimits;
  private stopped = false;
  private ticking: Promise<void> | undefined;
  /** A tick was asked for while one ran: it runs once more afterwards. */
  private again = false;

  constructor(private readonly options: SupervisorOptions) {
    this.limits = { idleMs: options.idleMs, maxOpen: options.maxOpen };
  }

  /** New limits (the user saved the preferences, C-30); the next tick uses them. */
  setLimits(limits: SupervisorLimits): void {
    this.limits = { ...limits };
  }

  /** The limits in use now. */
  currentLimits(): SupervisorLimits {
    return { ...this.limits };
  }

  /**
   * The session is in use (a delivery about to be claimed, or one of its runtime events). Returns the release
   * under way, which the caller waits for before it resumes the session; undefined when there is none.
   */
  touch(sessionId: SessionId): Promise<void> | undefined {
    const w = this.watch(sessionId);
    w.lastUse = this.nowMs();
    if (w.phase === 'checking') w.aborted = true;
    if (w.phase === 'releasing') w.usedDuringRelease = true;
    return w.phase === 'releasing' ? w.release : undefined;
  }

  /** A session's runtime came up (start or resume): in use now; above the limit, the oldest idle ones go. */
  opened(sessionId: SessionId): void {
    void this.touch(sessionId);
    if (this.limits.maxOpen > 0 && this.options.sessions.openSessions().length > this.limits.maxOpen) void this.tick();
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
    const { maxOpen } = this.limits;
    let over = maxOpen > 0 ? open.length - maxOpen : 0;
    for (const { sessionId } of order) {
      if (this.halted()) return;
      const closed = await this.tryClose(sessionId, over > 0);
      if (closed) over--;
    }
    if (over > 0) this.log(`${String(over)} runtime(s) above the limit of ${String(maxOpen)}: no idle session to close`);
  }

  /** One close of one session, when it is (still) due and every fact says idle. */
  private async tryClose(sessionId: SessionId, overLimit: boolean): Promise<boolean> {
    const w = this.watch(sessionId);
    // Checked and marked in one step: a use from here on cancels it.
    const idle = this.nowMs() - w.lastUse >= this.limits.idleMs;
    if (w.phase !== 'none' || (!overLimit && !idle)) return false;
    // Idle long enough is the reason whenever it holds; only the limit otherwise (C-30).
    const cause: CloseCause = idle ? 'idle' : 'process-limit';
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
          delete w.usedDuringRelease;
          w.release = new Promise<void>((resolve) => {
            released = resolve;
          });
          return true;
        },
        this.options.closeTimeoutMs,
        cause,
      );
      if (outcome === 'closed') this.log(`closed the idle runtime of ${sessionId}`);
      return outcome === 'closed';
    } catch (error) {
      this.log(`closing the idle runtime of ${sessionId} failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
      return false;
    } finally {
      if (w.usedDuringRelease === true) this.log(`${sessionId} was used while its runtime was being closed; a turn it started meanwhile was interrupted by the close (known limit), and its next message resumes it`);
      delete w.usedDuringRelease;
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

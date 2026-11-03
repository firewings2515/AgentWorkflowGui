// The work folders the GUI makes (T048, U-02, Q-2): `<location>\YYYY-MM-DD-NNN`, numbered per local day from 001,
// past 999 into four digits and on without a limit. The claim is the decision and is written first; the folder is
// made after it (non-recursive, so a name already there is never taken over), so the same session asking again,
// also after a restart, gets the folder it was given. One allocation at a time in this process; another process
// that made the same name is met by the claim's uniqueness and the non-recursive make.
//
// Only what our own make created is ours (T048 r1 P1-1): the claim says `made`, with the real path the folder had
// then. A folder at a claimed name that our make did not create, or one whose real path changed since (a link put in
// its place), is never reused. Nothing is ever removed (T048 r2): taking a folder back drops its claim and leaves the
// folder, so no check that could go stale stands between a session using a folder and its removal. A folder left so
// is at most a number used up; a claim that could not be dropped is `released` and never reused.
import type { InstanceId, SessionId, Timestamp } from '../../contracts';
import type { WorkFolderClaim, WorkFolderClaimRepository, WorkFolderFs } from '../ports';

export interface WorkFolderOptions {
  claims: WorkFolderClaimRepository;
  fs: WorkFolderFs;
  /** Where new folders go now: the user's `workFolderRoot`, else the default location. */
  location(): Promise<string>;
  now(): Timestamp;
  /** The local date of an instant, `YYYY-MM-DD`. Default: this computer's local date. */
  day?: (at: Timestamp) => string;
  /** Link resolution as the policy sees it (T042); null when it cannot be confirmed. */
  resolveRealPath(path: string): string | null;
  log?(message: string): void;
}

/** `taken`: the session ID already has a folder for something else (another run's root, or an ordinary session). */
export type Allocated = { ok: true; path: string } | { ok: false; message: string; taken?: true };

const pad = (n: number) => String(n).padStart(2, '0');
/** This computer's local date of an instant. */
export const localDay = (at: Timestamp): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** `<day>-<seq>`, the number at least three digits. */
export const workFolderName = (day: string, seq: number): string => `${day}-${String(seq).padStart(3, '0')}`;

/** The number of a name made for `day`, or undefined when the name is not one (`2026-11-04-07`, `-abc`, ...). */
export const seqOf = (name: string, day: string): number | undefined => {
  if (!name.startsWith(`${day}-`)) return undefined;
  const digits = name.slice(day.length + 1);
  if (!/^\d{3,}$/.test(digits)) return undefined;
  const seq = Number(digits);
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : undefined;
};

/** `folder` joined with `name`, in the folder's own separator. */
export const joinFolder = (folder: string, name: string): string => {
  const separator = folder.includes('\\') || !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${name}`;
};

/** A folder path compared as Windows does: either slash, no trailing separator, without case. */
export const folderKey = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Gives up after this many names in a row were taken by someone else (never by our own numbering). */
const MAX_TRIES = 10_000;

/** What making a claimed folder came to: ours now, someone else's already, or the file system refused. */
type Made = { made: true } | { made: false; exists: true } | { made: false; exists: false; error: unknown };

export class WorkFolders {
  private queue: Promise<unknown> = Promise.resolve();
  /** Claims taken back in this process whose removal failed: never reused, whatever storage still says (r2 ③). */
  private readonly released = new Set<SessionId>();

  constructor(private readonly options: WorkFolderOptions) {}

  /**
   * The folder of `sessionId`: the one our make created for it before (made again when it went missing), or a new one.
   * Nothing on disk is touched before its claim is written, so a write refused (read-only data) makes no folder.
   */
  allocate(sessionId: SessionId, instanceId?: InstanceId): Promise<Allocated> {
    return this.serial(() => this.allocateNow(sessionId, instanceId));
  }

  /**
   * Takes back the folder of a session that was not created: its claim goes, the folder stays (r2). A claim that cannot
   * be removed (the data turned read-only) is marked released when it can be, and in any case never reused; the next
   * start removes it.
   */
  release(sessionId: SessionId, path: string): Promise<void> {
    return this.serial(async () => {
      const claim = await this.options.claims.get(sessionId);
      if (claim === undefined || claim.path !== path) return;
      await this.drop(claim);
    });
  }

  /**
   * At start (T048): a claim whose session and run never came (the app stopped between the claim and the session), or
   * one released, is removed. Its folder stays.
   */
  reconcile(ownerInUse: (claim: WorkFolderClaim) => Promise<boolean>): Promise<void> {
    return this.serial(async () => {
      for (const claim of await this.options.claims.list()) {
        if (claim.state !== 'released' && (await ownerInUse(claim))) continue;
        try {
          await this.options.claims.remove(claim.sessionId);
          this.log(`dropped the claim of ${claim.sessionId}; its folder ${claim.path} is left as it is`);
        } catch (error) {
          this.log(`dropping the claim of ${claim.sessionId} failed (${nameOf(error)})`);
        }
      }
    });
  }

  private async allocateNow(sessionId: SessionId, instanceId: InstanceId | undefined): Promise<Allocated> {
    const { claims } = this.options;
    const previous = await claims.get(sessionId);
    // Another run's root (or an ordinary session) under this ID: never its folder.
    if (previous !== undefined && previous.instanceId !== instanceId) return { ok: false, message: 'This session ID already has a work folder for something else', taken: true };
    if (previous !== undefined) {
      // Asked again for the same session: its folder when our make created it and it was never taken back.
      const own = await this.ownAgain(previous);
      if (own !== undefined) return own;
      // Not ours (made by someone else, a link in its place, or taken back): only the claim goes, then a new name.
      await claims.remove(sessionId);
      this.released.delete(sessionId);
    }
    const location = await this.options.location();
    const at = this.options.now();
    const day = (this.options.day ?? localDay)(at);
    let names: string[];
    try {
      names = this.options.fs.list(location);
    } catch (error) {
      return this.failed('the work folder location could not be read', error);
    }
    // Claimed names in this location count too: a claim's folder may not be made yet (another session's, a stop).
    const claimed = (await claims.listDay(day)).filter((c) => folderKey(parentOf(c.path)) === folderKey(location));
    let seq = Math.max(0, ...claimed.map((c) => c.seq), ...names.map((n) => seqOf(n, day) ?? 0)) + 1;
    for (let tries = 0; tries < MAX_TRIES; tries++, seq++) {
      const path = joinFolder(location, workFolderName(day, seq));
      const claim: WorkFolderClaim = { sessionId, ...(instanceId !== undefined && { instanceId }), path, day, seq, state: 'claimed', createdAt: at };
      // Another session claimed the name in the meantime; this session has no claim (read above, one at a time).
      if ((await claims.claim(claim)) === 'taken') continue;
      const made = await this.makeOwn(sessionId, path);
      if (made.made) return { ok: true, path };
      await claims.remove(sessionId);
      if (!made.exists) return this.failed('the work folder could not be made', made.error);
      // Someone else's folder (the user's, another program's, or one we left): not ours, the next number.
    }
    return { ok: false, message: 'No free work folder name was found' };
  }

  /** The claimed folder again when it is ours: made by our make, never taken back and still where it was, or made by it now. */
  private async ownAgain(claim: WorkFolderClaim): Promise<Allocated | undefined> {
    if (claim.state === 'released' || this.released.has(claim.sessionId)) return undefined;
    // Gone (or never made): ours when our make creates it now.
    const made = await this.makeOwn(claim.sessionId, claim.path);
    if (made.made) return { ok: true, path: claim.path };
    if (!made.exists) {
      await this.options.claims.remove(claim.sessionId);
      return this.failed('its work folder could not be made again', made.error);
    }
    // There: ours only when our make created it and it is still that folder (no link put in its place).
    const real = this.options.resolveRealPath(claim.path);
    if (claim.state === 'made' && real !== null && claim.madeReal !== undefined && folderKey(real) === folderKey(claim.madeReal)) return { ok: true, path: claim.path };
    this.log(`the folder of ${claim.sessionId} was not made by this program; a new one is chosen`);
    return undefined;
  }

  /**
   * Makes the claimed folder (and the location when missing) and marks the claim `made` with its real path. When the
   * storage refuses the mark, the folder stays and the claim stays `claimed`, which never makes it ours (r2 ②).
   */
  private async makeOwn(sessionId: SessionId, path: string): Promise<Made> {
    const { fs } = this.options;
    try {
      fs.makeTree(parentOf(path));
      if (fs.make(path) === 'exists') return { made: false, exists: true };
    } catch (error) {
      return { made: false, exists: false, error };
    }
    const real = this.options.resolveRealPath(path);
    if (real === null) return { made: false, exists: false, error: new Error('unresolvable') };
    await this.options.claims.markMade(sessionId, real);
    return { made: true };
  }

  /** The claim goes; when it cannot, it is released (in storage when that works, here in any case). */
  private async drop(claim: WorkFolderClaim): Promise<void> {
    try {
      await this.options.claims.remove(claim.sessionId);
      this.released.delete(claim.sessionId);
    } catch (error) {
      this.released.add(claim.sessionId);
      await this.options.claims.markReleased(claim.sessionId).catch(() => undefined);
      throw error;
    }
  }

  private failed(message: string, error: unknown): Allocated {
    this.log(`${message} (${nameOf(error)})`);
    return { ok: false, message: `${message.charAt(0).toUpperCase()}${message.slice(1)}` };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private log(message: string): void {
    this.options.log?.(`[work-folders] ${message}`);
  }
}

const nameOf = (error: unknown) => (error instanceof Error ? error.name : 'non-error thrown');
const parentOf = (path: string): string => path.replace(/[\\/][^\\/]+[\\/]*$/, '') || path;

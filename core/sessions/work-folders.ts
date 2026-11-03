// The work folders the GUI makes (T048, U-02, Q-2): `<location>\YYYY-MM-DD-NNN`, numbered per local day from 001,
// past 999 into four digits and on without a limit. The claim is the decision and is written first; the folder is
// made after it (non-recursive, so a name already there is never taken over), so the same session asking again,
// also after a restart, gets the folder it was given. One allocation at a time in this process; another process
// that made the same name is met by the claim's uniqueness and the non-recursive make.
import type { InstanceId, SessionId, Timestamp } from '../../contracts';
import type { WorkFolderClaim, WorkFolderClaimRepository, WorkFolderFs } from '../ports';

export interface WorkFolderOptions {
  claims: WorkFolderClaimRepository;
  fs: WorkFolderFs;
  /** Where new folders go now: the user's `workFolderRoot`, else the default location. */
  location(): Promise<string>;
  now(): Timestamp;
  /** The local date of an instant, `YYYY-MM-DD`. Default: this computer's local date. */
  day?(at: Timestamp): string;
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

/** Gives up after this many names in a row were taken by someone else (never by our own numbering). */
const MAX_TRIES = 10_000;

export class WorkFolders {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: WorkFolderOptions) {}

  /**
   * The folder of `sessionId`: the one it was given before, made again when it went missing, or a new one. Nothing
   * on disk is touched before its claim is written, so a write refused (read-only data) makes no folder.
   */
  allocate(sessionId: SessionId, instanceId?: InstanceId): Promise<Allocated> {
    return this.serial(() => this.allocateNow(sessionId, instanceId));
  }

  /**
   * Takes back a folder whose session was not created: the claim goes, the folder too when it is still empty.
   * Only that one folder, never what is in it.
   */
  release(sessionId: SessionId, path: string): Promise<void> {
    return this.serial(async () => {
      const claim = await this.options.claims.get(sessionId);
      if (claim === undefined || claim.path !== path) return;
      await this.options.claims.remove(sessionId);
      this.removeIfEmpty(path);
    });
  }

  /**
   * At start (T048): a claim whose session never came (the app stopped between the claim and the session) is
   * removed, and its folder too when it is empty; a folder with anything in it stays and is logged.
   */
  reconcile(inUse: (claim: WorkFolderClaim) => Promise<boolean>): Promise<void> {
    return this.serial(async () => {
      for (const claim of await this.options.claims.list()) {
        if (await inUse(claim)) continue;
        await this.options.claims.remove(claim.sessionId);
        this.removeIfEmpty(claim.path);
      }
    });
  }

  private async allocateNow(sessionId: SessionId, instanceId: InstanceId | undefined): Promise<Allocated> {
    const { claims, fs } = this.options;
    const previous = await claims.get(sessionId);
    // Another run's root (or an ordinary session) under this ID: never its folder, so neither can take back the other's.
    if (previous !== undefined && previous.instanceId !== instanceId) return { ok: false, message: 'This session ID already has a work folder for something else', taken: true };
    if (previous !== undefined) {
      // Asked again for the same session: its folder, never a second one.
      try {
        fs.makeTree(parentOf(previous.path));
        fs.make(previous.path);
      } catch (error) {
        return this.failed('its work folder could not be made again', error);
      }
      return { ok: true, path: previous.path };
    }
    const location = await this.options.location();
    const at = this.options.now();
    const day = (this.options.day ?? localDay)(at);
    let names: string[];
    try {
      names = fs.list(location);
    } catch (error) {
      return this.failed('the work folder location could not be read', error);
    }
    // Claimed names in this location count too: a claim's folder may not be made yet (another session's, a stop).
    const claimed = (await claims.listDay(day)).filter((c) => parentOf(c.path).toLowerCase() === location.replace(/[\\/]+$/, '').toLowerCase());
    let seq = Math.max(0, ...claimed.map((c) => c.seq), ...names.map((n) => seqOf(n, day) ?? 0)) + 1;
    let madeLocation = false;
    for (let tries = 0; tries < MAX_TRIES; tries++, seq++) {
      const path = joinFolder(location, workFolderName(day, seq));
      const claim: WorkFolderClaim = { sessionId, ...(instanceId !== undefined && { instanceId }), path, day, seq, createdAt: at };
      if ((await claims.claim(claim)) === 'taken') {
        // Another session claimed the name in the meantime; this session has no claim (read above, one at a time).
        continue;
      }
      try {
        if (!madeLocation) fs.makeTree(location);
        madeLocation = true;
        if (fs.make(path) === 'created') return { ok: true, path };
      } catch (error) {
        await claims.remove(sessionId);
        return this.failed('the work folder could not be made', error);
      }
      // Someone else's folder (the user's, another program's): not ours, the next number.
      await claims.remove(sessionId);
    }
    return { ok: false, message: 'No free work folder name was found' };
  }

  private removeIfEmpty(path: string): void {
    try {
      if (this.options.fs.removeEmpty(path) === 'not-empty') this.log(`kept work folder ${path}: it is not empty`);
    } catch (error) {
      this.log(`removing work folder ${path} failed (${error instanceof Error ? error.name : 'non-error thrown'})`);
    }
  }

  private failed(message: string, error: unknown): Allocated {
    this.log(`${message} (${error instanceof Error ? error.name : 'non-error thrown'})`);
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

const parentOf = (path: string): string => path.replace(/[\\/][^\\/]+[\\/]*$/, '') || path;

// ProcessHost (core/ports/process.ts) on Windows Job Objects: one KILL_ON_JOB_CLOSE Job per GUI session,
// its only handle held here in the GUI main process (T013 approach A). Closing a session's Job ends that
// session's whole tree, detached `Start-Process` children included, and nothing else; a GUI that dies
// closes every handle, so the OS ends every Job (R-14, CR-7, spike review-followup §1).
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { OwnedProcess, Runtime, SessionId, Timestamp } from '../../contracts';
import type { ProcessHost, SessionJob } from '../../core/ports/process';
import type { OwnedProcessRepository } from '../../core/ports/repository';
import { type JobChild, type LaunchOptions, launchInJob } from './launch';
import * as kernel32 from './win32';

/** The kernel32 calls the host makes, swappable in tests. */
export type HostNative = Pick<
  typeof kernel32,
  'createKillOnCloseJob' | 'terminateJob' | 'jobProcessIds' | 'openProcess' | 'isProcessInJob' | 'creationTime' | 'imagePath' | 'exitCodeOf' | 'terminateProcess' | 'closeHandle'
>;

export interface WindowsProcessHostOptions {
  /** Where every started process is recorded, so the next start can clean up after a crash. */
  repository?: OwnedProcessRepository;
  now?: () => Date;
  /** How long closeJob waits for the Job to empty (default 5 s). */
  closeTimeoutMs?: number;
  log?: (level: 'debug' | 'warn', message: string, detail?: unknown) => void;
  /** Tests only: replaces kernel32 and the launcher. */
  native?: HostNative;
  launch?: (job: kernel32.Handle, options: LaunchOptions) => JobChild;
}

interface OpenJob extends SessionJob {
  handle: kernel32.Handle;
  runtime?: Runtime;
  hosts: Set<JobChild>;
  /**
   * Every process seen in the Job, by PID and creation time: a PID the OS reuses inside the Job is another
   * process, and the earlier one keeps its record until the Job ends (t021-r1-P2-1).
   */
  seen: Map<string, OwnedProcess>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const sameProcess = (a: Pick<OwnedProcess, 'pid' | 'startedAt'>, b: Pick<OwnedProcess, 'pid' | 'startedAt'>) =>
  a.pid === b.pid && Date.parse(a.startedAt) === Date.parse(b.startedAt);
/** The key of one process: its PID alone can come back as another process. */
const identityKey = (p: Pick<OwnedProcess, 'pid' | 'startedAt'>) => `${String(p.pid)}@${String(Date.parse(p.startedAt))}`;
/** Image names (lower case) of Job members that are never the agent's commands. */
const HELPER_IMAGES = new Set(['conhost.exe', 'codex-code-mode-host.exe']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class WindowsProcessHost implements ProcessHost {
  private readonly jobs = new Map<SessionId, OpenJob>();
  private readonly win32: HostNative;

  constructor(private readonly options: WindowsProcessHostOptions = {}) {
    this.win32 = options.native ?? kernel32;
  }

  openJob(sessionId: SessionId): Promise<SessionJob> {
    const { sessionId: id, jobRef } = this.job(sessionId);
    return Promise.resolve({ sessionId: id, jobRef });
  }

  /**
   * Starts a runtime host (Codex app-server, claude.exe) in the session's Job; synchronous, as the
   * adapters' injected spawn functions are. The process is recorded as `runtime-host`.
   */
  spawn(sessionId: SessionId, runtime: Runtime, options: LaunchOptions): JobChild {
    const job = this.job(sessionId);
    if (job.runtime !== undefined && job.runtime !== runtime) throw new Error(`session ${sessionId} already runs ${job.runtime}`);
    job.runtime = runtime;
    const child = (this.options.launch ?? launchInJob)(job.handle, options);
    job.hosts.add(child);
    child.once('exit', () => job.hosts.delete(child));
    this.remember(job, runtime, { pid: child.pid, startedAt: iso(child.startedAt), kind: 'runtime-host' });
    return child;
  }

  closeJob(sessionId: SessionId): Promise<{ ended: OwnedProcess[] }> {
    const job = this.jobs.get(sessionId);
    if (!job) return Promise.resolve({ ended: [] });
    this.jobs.delete(sessionId);
    return this.end(job);
  }

  listOwned(sessionId?: SessionId): Promise<OwnedProcess[]> {
    const jobs = sessionId === undefined ? [...this.jobs.values()] : [this.jobs.get(sessionId)].filter((j) => j !== undefined);
    return Promise.resolve(jobs.flatMap((job) => this.scan(job)));
  }

  cleanupOrphans(records: readonly OwnedProcess[]): Promise<{ ended: OwnedProcess[]; gone: OwnedProcess[] }> {
    const ended: OwnedProcess[] = [];
    const gone: OwnedProcess[] = [];
    const ours = [...this.jobs.values()].flatMap((job) => [...job.seen.values()]);
    for (const record of records) {
      if (record.endedAt !== undefined || ours.some((p) => sameProcess(p, record))) continue;
      // Compare and terminate through one handle: the PID cannot change owner in between.
      const outcome = this.withProcess(record.pid, (handle) => {
        // An exited process stays openable while someone holds a handle to it.
        if (this.win32.creationTime(handle) !== Date.parse(record.startedAt) || this.win32.exitCodeOf(handle) !== undefined) return 'gone';
        return this.win32.terminateProcess(handle, 1) ? 'ended' : 'failed';
      });
      if (outcome === 'ended') ended.push({ ...record, endedAt: this.now() });
      else if (outcome === 'failed') this.log('warn', 'could not end an orphan', record);
      else gone.push(record);
    }
    return this.markEnded([...ended, ...gone.map((r) => ({ ...r, endedAt: this.now() }))]).then(() => ({ ended, gone }));
  }

  /** Closes every Job (GUI exit); the OS ends what is still running in them. */
  async dispose(): Promise<void> {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    await Promise.all(jobs.map((job) => this.end(job)));
  }

  private job(sessionId: SessionId): OpenJob {
    let job = this.jobs.get(sessionId);
    if (!job) {
      job = { sessionId, jobRef: `job-${randomUUID()}`, handle: this.win32.createKillOnCloseJob(), hosts: new Set(), seen: new Map() };
      this.jobs.set(sessionId, job);
    }
    return job;
  }

  /** The Job's live processes; new ones are recorded. Ones that exit while being read are skipped. */
  private scan(job: OpenJob): OwnedProcess[] {
    const runtime = job.runtime;
    // Nothing was started in the Job yet, so it is empty.
    if (runtime === undefined) return [];
    const live: OwnedProcess[] = [];
    for (const pid of this.win32.jobProcessIds(job.handle)) {
      let info: { startedAt: Timestamp; image: string } | undefined;
      try {
        // The PID may have been reused since the list was read: only a handle to a process that is in
        // this Job identifies one of ours, and its identity is read through that same handle.
        info = this.withProcess(pid, (handle) =>
          this.win32.isProcessInJob(handle, job.handle) ? { startedAt: iso(this.win32.creationTime(handle)), image: this.win32.imagePath(handle) } : undefined,
        );
      } catch (error) {
        this.log('debug', `cannot read process ${pid} of ${job.jobRef}`, error);
      }
      if (!info) continue;
      const known = job.seen.get(identityKey({ pid, startedAt: info.startedAt }));
      if (known) {
        live.push(known);
        continue;
      }
      // The console host Windows adds for CREATE_NO_WINDOW, and the runtimes' own resident helpers, are not
      // the agent's commands: counted as commands they made exiting warn of work that is not there (T021).
      const kind = HELPER_IMAGES.has(basename(info.image).toLowerCase()) ? 'helper' : 'command';
      live.push(this.remember(job, runtime, { pid, startedAt: info.startedAt, kind }));
    }
    return live;
  }

  private remember(job: OpenJob, runtime: Runtime, p: Pick<OwnedProcess, 'pid' | 'startedAt' | 'kind'>): OwnedProcess {
    const record: OwnedProcess = { ...p, sessionId: job.sessionId, runtime, jobRef: job.jobRef, recordedAt: this.now() };
    job.seen.set(identityKey(p), record);
    this.options.repository?.record(record).catch((error: unknown) => this.log('warn', 'could not record an owned process', error));
    return record;
  }

  private async end(job: OpenJob): Promise<{ ended: OwnedProcess[] }> {
    let before: OwnedProcess[] = [];
    try {
      before = this.scan(job);
      this.win32.terminateJob(job.handle, 1);
      // TerminateJobObject returns, and the Job's member list empties, before the processes have exited.
      const deadline = Date.now() + (this.options.closeTimeoutMs ?? 5000);
      while (before.some((p) => this.running(p)) && Date.now() < deadline) await sleep(20);
    } catch (error) {
      this.log('warn', `ending ${job.jobRef} failed; closing its handle ends it`, error);
    } finally {
      // The last handle: KILL_ON_JOB_CLOSE ends whatever is still in the Job.
      this.win32.closeHandle(job.handle);
    }
    const at = this.now();
    const ended = before.map((p) => ({ ...p, endedAt: at }));
    // What exited before the Job was ended (a graceful close lets the runtime end its own processes) is
    // recorded as ended too, by now at the latest; otherwise its record stays open until the next start (T021).
    const exited = [...job.seen.values()].filter((p) => !before.some((b) => sameProcess(b, p))).map((p) => ({ ...p, endedAt: at }));
    await this.markEnded([...ended, ...exited]);
    return { ended };
  }

  private async markEnded(records: readonly OwnedProcess[]) {
    const repository = this.options.repository;
    if (!repository) return;
    for (const r of records) {
      try {
        await repository.markEnded(r.pid, r.startedAt, r.endedAt ?? this.now());
      } catch (error) {
        this.log('warn', 'could not mark an owned process ended', error);
      }
    }
  }

  /** Opens a process, runs `fn` on its handle, and always closes it; undefined when it is gone. */
  private withProcess<T>(pid: number, fn: (handle: kernel32.Handle) => T): T | undefined {
    const handle = this.win32.openProcess(pid);
    if (handle === undefined) return undefined;
    try {
      return fn(handle);
    } finally {
      this.win32.closeHandle(handle);
    }
  }

  /** Whether this very process (PID and creation time) has not exited yet. */
  private running(p: Pick<OwnedProcess, 'pid' | 'startedAt'>): boolean {
    return this.withProcess(p.pid, (handle) => this.win32.creationTime(handle) === Date.parse(p.startedAt) && this.win32.exitCodeOf(handle) === undefined) ?? false;
  }

  private now(): Timestamp {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private log(level: 'debug' | 'warn', message: string, detail?: unknown) {
    this.options.log?.(level, message, detail);
  }
}

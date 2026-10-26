// Starts one runtime process inside a Job in the spike's order: CREATE_SUSPENDED -> (Job already set to
// KILL_ON_JOB_CLOSE) -> AssignProcessToJobObject -> ResumeThread, so not one instruction of the child runs
// outside the Job (spike review-followup §1). Node cannot start a suspended process, so stdio goes through
// three named pipes whose server ends Node owns; the result behaves like the ChildProcess both adapters
// take from an injected spawn (Codex `AppServerProcess`, Claude SDK `SpawnedProcess`).
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { commandLine, environmentBlock, resolveExecutable } from './command-line';
import { type Handle, assignToJob, closeHandle, createSuspended, creationTime, exitCodeOf, openInheritablePipe, resumeThread, terminateProcess } from './win32';

export interface LaunchOptions {
  command: string;
  args?: readonly string[];
  cwd?: string | undefined;
  /** The child's whole environment; the GUI's own when absent. */
  env?: NodeJS.ProcessEnv | undefined;
  /** How often the exit is checked (default 100 ms). */
  exitPollMs?: number;
}

/** Calls the launcher needs, swappable in tests; defaults to kernel32. */
export interface LaunchNative {
  openInheritablePipe: typeof openInheritablePipe;
  createSuspended: typeof createSuspended;
  assignToJob: typeof assignToJob;
  resumeThread: typeof resumeThread;
  creationTime: typeof creationTime;
  exitCodeOf: typeof exitCodeOf;
  terminateProcess: typeof terminateProcess;
  closeHandle: typeof closeHandle;
}

const kernel32: LaunchNative = { openInheritablePipe, createSuspended, assignToJob, resumeThread, creationTime, exitCodeOf, terminateProcess, closeHandle };

/** One end of a stdio pipe: the server Node listens on and the socket the child's handle connects to. */
interface PipeEnd {
  name: string;
  server: Server;
  socket: Promise<Socket>;
}

const listenPipe = (): PipeEnd => {
  const name = `\\\\.\\pipe\\awg-${randomUUID()}`;
  const server = createServer();
  server.maxConnections = 1;
  const socket = new Promise<Socket>((resolve, reject) => {
    server.once('connection', (s) => {
      server.close();
      resolve(s);
    });
    server.once('error', reject);
  });
  // libuv creates the pipe instances inside listen(), so CreateFileW can connect right after it returns.
  server.listen(name);
  return { name, server, socket };
};

/**
 * A process running in a Job. Holds its process handle until it exits, so `kill` and the creation time
 * always refer to this process, never to a later one that reused its PID.
 */
export class JobChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  /** OS creation time, milliseconds since 1970. */
  readonly startedAt: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private handle: Handle | undefined;
  private killSignal: NodeJS.Signals | undefined;
  private readonly timer: NodeJS.Timeout;
  private openOutputs = 2;

  /** @internal Use `launchInJob`. */
  constructor(
    created: { process: Handle; pid: number; startedAt: number },
    pipes: readonly [PipeEnd, PipeEnd, PipeEnd],
    private readonly native: LaunchNative,
    pollMs: number,
  ) {
    super();
    this.handle = created.process;
    this.pid = created.pid;
    this.startedAt = created.startedAt;
    this.attach(pipes);
    this.timer = setInterval(() => this.poll(), pollMs);
  }

  get exited() {
    return this.handle === undefined;
  }

  /** TerminateProcess on this process only; the rest of its tree goes with the Job (closeJob). */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.handle === undefined) return false;
    if (!this.native.terminateProcess(this.handle, 1)) return false;
    this.killed = true;
    this.killSignal = signal;
    this.poll();
    return true;
  }

  private attach([stdin, stdout, stderr]: readonly [PipeEnd, PipeEnd, PipeEnd]) {
    // Data written before the pipe connected waits in the PassThrough.
    void stdin.socket.then((socket) => {
      socket.on('error', () => {
        // The child went away; its exit is reported by the exit poll.
      });
      // Closing our end is what the child reads as EOF (a named pipe has no half-close).
      socket.once('finish', () => socket.destroy());
      this.stdin.pipe(socket);
    }, () => undefined);
    // `close` follows the exit once both output pipes closed, whether or not anyone reads them.
    for (const [end, out] of [
      [stdout, this.stdout],
      [stderr, this.stderr],
    ] as const) {
      void end.socket.then(
        (socket) => {
          socket.on('error', () => socket.destroy());
          socket.once('close', () => {
            // A pipe that broke instead of ending still ends the stream.
            if (!out.writableEnded) out.end();
            this.outputClosed();
          });
          socket.pipe(out);
        },
        () => {
          out.end();
          this.outputClosed();
        },
      );
    }
  }

  private outputClosed() {
    if (--this.openOutputs === 0 && this.exited) this.emit('close', this.exitCode, this.signalCode);
  }

  private poll() {
    if (this.handle === undefined) return;
    const code = this.native.exitCodeOf(this.handle);
    if (code === undefined) return;
    clearInterval(this.timer);
    this.native.closeHandle(this.handle);
    this.handle = undefined;
    if (this.killSignal !== undefined) this.signalCode = this.killSignal;
    else this.exitCode = code;
    this.emit('exit', this.exitCode, this.signalCode);
    if (this.openOutputs === 0) this.emit('close', this.exitCode, this.signalCode);
  }
}

/**
 * Starts `options.command` suspended, puts it into `job`, then lets it run. On any failure before the
 * resume the process is terminated, so nothing ever runs outside the Job.
 */
export const launchInJob = (job: Handle, options: LaunchOptions, native: LaunchNative = kernel32): JobChild => {
  const env = options.env ?? process.env;
  const application = resolveExecutable(options.command, env, options.cwd);
  const pipes = [listenPipe(), listenPipe(), listenPipe()] as const;
  const clients: Handle[] = [];
  let created: { process: Handle; thread: Handle; pid: number } | undefined;
  try {
    // From the first inheritable handle to CloseHandle below everything is synchronous, so no other
    // spawn of this process can inherit the pipe handles in between.
    for (const pipe of pipes) clients.push(native.openInheritablePipe(pipe.name));
    created = native.createSuspended({
      application,
      commandLine: commandLine(application, options.args ?? []),
      cwd: options.cwd,
      environment: options.env === undefined ? undefined : environmentBlock(env),
      stdio: [clients[0]!, clients[1]!, clients[2]!],
    });
    native.assignToJob(job, created.process);
    const startedAt = native.creationTime(created.process);
    native.resumeThread(created.thread);
    return new JobChild({ process: created.process, pid: created.pid, startedAt }, pipes, native, options.exitPollMs ?? 100);
  } catch (error) {
    if (created) {
      native.terminateProcess(created.process, 1);
      native.closeHandle(created.process);
    }
    for (const pipe of pipes) pipe.server.close();
    throw error;
  } finally {
    if (created) native.closeHandle(created.thread);
    for (const client of clients) native.closeHandle(client);
  }
};

// JSON-RPC 2.0 (newline-delimited, no "jsonrpc" field, as Codex speaks it) over the stdio of one
// `codex app-server` child process. Requests are never retried here; a lost response surfaces as a
// timeout or a closed connection and the caller decides what that means (CR-2).
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import type { RpcId } from './protocol';

/** The parts of a child process the connection needs, so tests can plug in a fake app-server. */
export interface AppServerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SpawnOptions {
  /** Executable; defaults to `codex` on PATH. */
  command?: string;
  /** Arguments placed before `app-server` (e.g. `-c key=value`). */
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Our own stdio child, never the shared daemon (D-03). */
export const spawnAppServer = (options: SpawnOptions = {}): AppServerProcess =>
  spawn(options.command ?? 'codex', [...(options.args ?? []), 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.env !== undefined && { env: options.env }),
  });

/** The runtime answered with a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message} (${code})`);
    this.name = 'RpcError';
  }
}

/** No response within the deadline. The request may or may not have been processed. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method}: no response within ${timeoutMs} ms`);
    this.name = 'RpcTimeoutError';
  }
}

/**
 * The connection ended before a response. `written` tells whether the request bytes were handed to the
 * pipe; when false the payload never left this process.
 */
export class RpcClosedError extends Error {
  constructor(
    readonly method: string,
    readonly written: boolean,
    readonly exit: ExitInfo | undefined,
  ) {
    super(`${method}: app-server connection closed${exit ? ` (exit code ${exit.code ?? 'none'}, signal ${exit.signal ?? 'none'})` : ''}`);
    this.name = 'RpcClosedError';
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started or the pipe failed. */
  error?: string;
}

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: RpcId, method: string, params: unknown): void;
  onExit(exit: ExitInfo): void;
  onStderr?(text: string): void;
  /** Lines that are not JSON, responses nobody waits for, and similar protocol noise. */
  onProtocolNoise?(detail: string, line: string): void;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcConnection {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  /** Requests that timed out; their late responses are dropped instead of reported as noise. */
  private readonly abandoned = new Set<RpcId>();
  private exitInfo: ExitInfo | undefined;
  private inputClosed = false;
  readonly exited: Promise<ExitInfo>;

  constructor(
    private readonly proc: AppServerProcess,
    private readonly handlers: RpcHandlers,
  ) {
    let resolveExit!: (exit: ExitInfo) => void;
    this.exited = new Promise((resolve) => (resolveExit = resolve));
    const finish = (exit: ExitInfo) => {
      if (this.exitInfo) return;
      this.exitInfo = exit;
      this.inputClosed = true;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcClosedError(p.method, true, exit));
        this.pending.delete(id);
      }
      handlers.onExit(exit);
      resolveExit(exit);
    };
    proc.on('exit', (code, signal) => finish({ code, signal }));
    proc.on('error', (error) => finish({ code: null, signal: null, error: error.message }));
    // A broken pipe shows up as an error on stdin; the exit event follows, but do not crash before it.
    proc.stdin.on('error', (error: Error) => handlers.onProtocolNoise?.(`stdin error: ${error.message}`, ''));
    proc.stderr.on('data', (chunk: Buffer | string) => handlers.onStderr?.(chunk.toString()));
    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
  }

  get running(): boolean {
    return this.exitInfo === undefined;
  }

  get exit(): ExitInfo | undefined {
    return this.exitInfo;
  }

  /**
   * Sends one request. Rejects with RpcError (runtime said no), RpcTimeoutError (no answer in time;
   * outcome unknown) or RpcClosedError (connection gone; see `written`).
   */
  request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.inputClosed) return Promise.reject(new RpcClosedError(method, false, this.exitInfo));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      this.pending.set(id, entry);
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.abandoned.add(id);
          reject(new RpcTimeoutError(method, options.timeoutMs!));
        }, options.timeoutMs);
      }
      if (!this.write({ id, method, params })) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(new RpcClosedError(method, false, this.exitInfo));
      }
    });
  }

  notify(method: string, params?: unknown): boolean {
    return this.write(params === undefined ? { method } : { method, params });
  }

  /** Answers a server request. Returns false when the connection is already closed. */
  respond(id: RpcId, result: unknown): boolean {
    return this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): boolean {
    return this.write({ id, error: { code, message } });
  }

  /** Ends stdin; Codex exits on its own when its input closes (SP-08). */
  closeInput(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.proc.stdin.end();
  }

  kill(): void {
    if (this.running) this.proc.kill();
  }

  private write(message: Record<string, unknown>): boolean {
    if (this.inputClosed || this.proc.stdin.destroyed || this.proc.stdin.writableEnded) return false;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private receive(line: string): void {
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onProtocolNoise?.('not JSON', line);
      return;
    }
    if (!isObject(msg)) {
      this.handlers.onProtocolNoise?.('not an object', line);
      return;
    }
    const { id, method } = msg;
    const hasId = typeof id === 'number' || typeof id === 'string';
    if (typeof method === 'string') {
      if (hasId) this.handlers.onServerRequest(id, method, msg.params);
      else this.handlers.onNotification(method, msg.params);
      return;
    }
    if (!hasId) {
      this.handlers.onProtocolNoise?.('message without id or method', line);
      return;
    }
    const p = this.pending.get(id);
    if (!p) {
      if (!this.abandoned.delete(id)) this.handlers.onProtocolNoise?.('response to unknown request', line);
      return;
    }
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (isObject(msg.error)) {
      const { code, message, data } = msg.error;
      p.reject(new RpcError(p.method, typeof code === 'number' ? code : 0, typeof message === 'string' ? message : 'unknown error', data));
    } else {
      p.resolve(msg.result);
    }
  }
}

// Running one tool call (CR2_DELIVERY_FIX §4): validate the input, recognise a resend of the same source
// call, fix its operationId, call the injected handler once, and validate what it returns. Kept apart
// from the transport so every rule here is testable without HTTP.
import { createHash } from 'node:crypto';
import type { McpToolName, OperationId, SessionId } from '../../contracts';
import {
  describeInputIssues,
  type McpCallContext,
  type McpToolHandlers,
  type McpToolResult,
  rejection,
  toolSpecs,
} from './tools';

/**
 * Where the native tool-call ID sits in `tools/call` `_meta`, by client (key names seen live in T016):
 * Claude Code 2.1.309 sends `claudecode/toolUseId`, Codex 0.160.0 sends `callId`.
 */
export const DEFAULT_META_CALL_ID_KEYS: readonly string[] = ['claudecode/toolUseId', 'callId'];

/**
 * The source call identity: the client's native tool-call ID when `_meta` carries one under a known key,
 * otherwise the JSON-RPC request ID within its MCP session (IDs are unique per session, so a repeated
 * one is a resend). Only ever compared within the same caller.
 */
export const sourceCallRefOf = (
  meta: Record<string, unknown> | undefined,
  fallback: { mcpSessionId: string; requestId: string | number },
  keys: readonly string[] = DEFAULT_META_CALL_ID_KEYS,
): string => {
  for (const key of keys) {
    const value = meta?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 512) return `meta:${key}:${value}`;
  }
  return `rpc:${fallback.mcpSessionId}:${JSON.stringify(fallback.requestId)}`;
};

/** JSON with object keys sorted, so equal arguments give equal text whatever their key order. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ) ?? 'undefined';

const digestOf = (tool: McpToolName, args: unknown): string =>
  createHash('sha256').update(`${tool}\n${canonicalJson(args)}`, 'utf8').digest('hex');

/** `result`: send it to the agent. `failed`: the handler threw or broke its contract; say nothing more. */
export type CallOutcome = { kind: 'result'; result: McpToolResult } | { kind: 'failed' };

interface Entry {
  caller: SessionId;
  digest: string;
  operationId?: OperationId;
  /** The handler's run while it is in progress. */
  running?: Running;
  /** Kept once the handler answered validly, for later resends. */
  result?: McpToolResult;
}

interface Running {
  done: Promise<CallOutcome>;
  controller: AbortController;
  waiters: number;
}

export interface CallRunnerOptions {
  handlers: McpToolHandlers;
  /** A fresh UUID per new operation. */
  uuid(): string;
  /** Diagnostics for the GUI's own log; never sent to the agent. Gets no tokens and no tool input. */
  log?(message: string): void;
  /** How many source calls and operations to remember; the oldest finished ones go first. */
  maxEntries?: number;
}

export class CallRunner {
  readonly #options: CallRunnerOptions;
  readonly #max: number;
  readonly #calls = new Map<string, Entry>();
  /** Which session created each operation, so a `retryOf` from another session is refused. */
  readonly #owners = new Map<OperationId, SessionId>();
  #closing = false;

  constructor(options: CallRunnerOptions) {
    this.#options = options;
    this.#max = options.maxEntries ?? 10_000;
  }

  get closing(): boolean {
    return this.#closing;
  }

  /** Calls in progress, counting each source call once. */
  get inFlight(): number {
    let n = 0;
    for (const entry of this.#calls.values()) if (entry.running) n++;
    return n;
  }

  /**
   * Runs `tool` for `caller`. `signal` is this request's own: when it aborts the request no longer waits,
   * and the handler is aborted once no request waits for it.
   */
  async run(caller: SessionId, tool: McpToolName, args: unknown, sourceCallRef: string, signal: AbortSignal): Promise<CallOutcome> {
    if (this.#closing) return { kind: 'result', result: rejection('shutting-down', 'the GUI is shutting down') };
    const spec = toolSpecs[tool];
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) return { kind: 'result', result: rejection('invalid-input', describeInputIssues(parsed.error)) };
    const input = parsed.data as { retryOf?: OperationId };

    const key = `${caller}\u0000${sourceCallRef}`;
    const digest = digestOf(tool, args ?? {});
    let entry = this.#calls.get(key);
    let first = false;
    if (entry) {
      if (entry.digest !== digest) {
        return { kind: 'result', result: rejection('invalid-input', 'this tool call ID was already used with another tool or input') };
      }
      if (entry.result) return { kind: 'result', result: asResend(tool, entry.result) };
    } else {
      if (input.retryOf !== undefined) {
        const owner = this.#owners.get(input.retryOf);
        // Unknown here (e.g. after a restart) is for the handler to check against the store.
        if (owner !== undefined && owner !== caller) {
          return { kind: 'result', result: rejection('unknown-target', 'retryOf does not name an operation of this session') };
        }
      }
      entry = { caller, digest };
      if (spec.delivers) {
        entry.operationId = input.retryOf ?? (this.#options.uuid() as OperationId);
        this.#remember(this.#owners, entry.operationId, caller);
      }
      this.#remember(this.#calls, key, entry);
      first = true;
    }

    if (!entry.running) {
      first = true;
      entry.running = this.#start(tool, input, entry, sourceCallRef);
    }
    const outcome = await this.#wait(entry.running, signal);
    if (outcome.kind === 'result' && !first) return { kind: 'result', result: asResend(tool, outcome.result) };
    return outcome;
  }

  /** Refuses new calls and answers every waiting one with `shutting-down`; handlers see their signal abort. */
  shutdown(): void {
    this.#closing = true;
    for (const entry of this.#calls.values()) entry.running?.controller.abort(new ShuttingDown());
  }

  #start(tool: McpToolName, input: unknown, entry: Entry, sourceCallRef: string): Running {
    const controller = new AbortController();
    const ctx: McpCallContext & { operationId?: OperationId } = { caller: entry.caller, sourceCallRef, signal: controller.signal };
    if (entry.operationId !== undefined) ctx.operationId = entry.operationId;
    const handlers = this.#options.handlers as unknown as Record<McpToolName, (input: unknown, ctx: unknown) => Promise<unknown>>;
    const running: Running = { controller, waiters: 0, done: Promise.resolve({ kind: 'failed' }) };
    running.done = (async (): Promise<CallOutcome> => {
      try {
        const answer = await handlers[tool](input, ctx);
        const checked = toolSpecs[tool].result.safeParse(answer);
        if (!checked.success) {
          this.#options.log?.(`[mcp] ${tool} handler returned an invalid result: ${describeInputIssues(checked.error)}`);
          return { kind: 'failed' };
        }
        const result = checked.data as McpToolResult;
        if (!controller.signal.aborted) entry.result = result;
        return { kind: 'result', result };
      } catch (error) {
        this.#options.log?.(`[mcp] ${tool} handler failed: ${error instanceof Error ? error.name : 'non-error thrown'}`);
        return { kind: 'failed' };
      } finally {
        if (entry.running === running) delete entry.running;
      }
    })();
    return running;
  }

  /** Waits for the run, or stops waiting when this request is cancelled or the server shuts down. */
  async #wait(running: Running, signal: AbortSignal): Promise<CallOutcome> {
    running.waiters++;
    const shutdown = running.controller.signal;
    let release = (): void => {};
    const stopped = new Promise<CallOutcome>((resolve) => {
      const onShutdown = (): void => resolve({ kind: 'result', result: rejection('shutting-down', 'the GUI is shutting down') });
      const onCancel = (): void => {
        if (--running.waiters === 0) running.controller.abort(new Cancelled());
        resolve({ kind: 'failed' });
      };
      if (shutdown.aborted && shutdown.reason instanceof ShuttingDown) return onShutdown();
      if (signal.aborted) return onCancel();
      shutdown.addEventListener('abort', () => shutdown.reason instanceof ShuttingDown && onShutdown(), { once: true });
      signal.addEventListener('abort', onCancel, { once: true });
      release = () => signal.removeEventListener('abort', onCancel);
    });
    try {
      return await Promise.race([running.done, stopped]);
    } finally {
      release();
    }
  }

  #remember<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.set(key, value);
    if (map.size <= this.#max) return;
    for (const [k, v] of map) {
      if (map.size <= this.#max) break;
      if (!(v as Partial<Entry>).running) map.delete(k);
    }
  }
}

class ShuttingDown extends Error {
  override name = 'ShuttingDown';
}

class Cancelled extends Error {
  override name = 'Cancelled';
}

/** What a resend of a call gets: the same answer, with an acceptance reported as a duplicate. */
const asResend = (tool: McpToolName, result: McpToolResult): McpToolResult =>
  toolSpecs[tool].delivers && result.status === 'accepted' ? { ...result, status: 'duplicate' } : result;

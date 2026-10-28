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

/**
 * `result`: send it to the agent. `failed`: the handler threw or broke its contract; nothing more is said,
 * and every resend of the same source call gets the same answer. `refused`: the caller has too many calls
 * on record, so this one was not run.
 */
export type CallOutcome = { kind: 'result'; result: McpToolResult } | { kind: 'failed' } | { kind: 'refused' };

/** Why a handler's answer was not used; the only thing logged about it. */
type FailureCategory = 'handler-threw' | 'invalid-result';

interface Entry {
  digest: string;
  operationId?: OperationId;
  /** Settles once with the handler's outcome. The entry is on record before the handler starts. */
  done: Promise<CallOutcome>;
  /** The settled outcome, for resends; failures are kept too, so a resend never runs the handler again. */
  outcome?: CallOutcome;
  /** The handler's signal: aborted on shutdown or when the caller is forgotten, never by one waiter. */
  controller: AbortController;
}

/** One caller's calls. Kept for as long as the caller's token is valid; never evicted entry by entry. */
interface CallerRecord {
  calls: Map<string, Entry>;
  /** Operations this caller created, so a `retryOf` from another caller is refused. */
  operations: Set<OperationId>;
  /** Aborted when the caller is forgotten, so its waiters stop waiting. */
  forgotten: AbortController;
}

export interface CallRunnerOptions {
  handlers: McpToolHandlers;
  /** A fresh UUID per new operation. */
  uuid: () => string;
  /** Diagnostics for the GUI's own log; never sent to the agent. Gets fixed categories and tool names only. */
  log?: (message: string) => void;
  /** Calls kept on record per caller; past this, new calls are refused rather than older ones forgotten. */
  maxCallsPerCaller?: number;
}

const shuttingDown = (): CallOutcome => ({ kind: 'result', result: rejection('shutting-down', 'the GUI is shutting down') });

export class CallRunner {
  readonly #options: CallRunnerOptions;
  readonly #max: number;
  readonly #callers = new Map<SessionId, CallerRecord>();
  readonly #shutdown = new AbortController();

  constructor(options: CallRunnerOptions) {
    this.#options = options;
    this.#max = options.maxCallsPerCaller ?? 10_000;
  }

  get closing(): boolean {
    return this.#shutdown.signal.aborted;
  }

  /** Calls whose handler has not answered yet, counting each source call once. */
  get inFlight(): number {
    let n = 0;
    for (const record of this.#callers.values()) for (const entry of record.calls.values()) if (!entry.outcome) n++;
    return n;
  }

  /**
   * Runs `tool` for `caller`, or joins the run of the same source call. `signal` is this request's own:
   * when it aborts, this request stops waiting; the handler keeps running for the other waiters and for
   * later resends.
   */
  async run(caller: SessionId, tool: McpToolName, args: unknown, sourceCallRef: string, signal: AbortSignal): Promise<CallOutcome> {
    if (this.closing) return shuttingDown();
    const spec = toolSpecs[tool];
    const parsed = spec.input.safeParse(args ?? {});
    if (!parsed.success) return { kind: 'result', result: rejection('invalid-input', describeInputIssues(parsed.error)) };
    const input = parsed.data as { retryOf?: OperationId };

    const record = this.#recordOf(caller);
    const digest = digestOf(tool, args ?? {});
    const known = record.calls.get(sourceCallRef);
    if (known) {
      if (known.digest !== digest) {
        return { kind: 'result', result: rejection('invalid-input', 'this tool call ID was already used with another tool or input') };
      }
      return asResend(tool, await this.#wait(known, record, signal));
    }

    if (input.retryOf !== undefined) {
      const owner = this.#ownerOf(input.retryOf);
      // Unknown here (e.g. after a restart) is for the handler to check against the store.
      if (owner !== undefined && owner !== caller) {
        return { kind: 'result', result: rejection('unknown-target', 'retryOf does not name an operation of this session') };
      }
    }
    if (record.calls.size >= this.#max) return { kind: 'refused' };
    const operationId = spec.delivers ? (input.retryOf ?? (this.#options.uuid() as OperationId)) : undefined;
    const entry = this.#start(tool, input, caller, sourceCallRef, record, digest, operationId);
    return this.#wait(entry, record, signal);
  }

  /**
   * Drops a caller's record, e.g. when its token is replaced or revoked: its waiters stop waiting and its
   * handlers see their signal abort.
   *
   * Known limit: after a resume (new token) or a GUI restart, a resend of a call made before it is taken
   * for a new call and gets a new operationId. Only `retryOf` plus the store's deduplication by operationId
   * keep it from being accepted twice, until `DeliveryStore` can look a delivery up by `sourceCallRef`
   * (T017 / the next port version).
   */
  forget(caller: SessionId): void {
    const record = this.#callers.get(caller);
    if (!record) return;
    this.#callers.delete(caller);
    record.forgotten.abort();
    for (const entry of record.calls.values()) if (!entry.outcome) entry.controller.abort();
  }

  /** Refuses new calls and answers every waiting one with `shutting-down`; handlers see their signal abort. */
  shutdown(): void {
    this.#shutdown.abort();
    for (const record of this.#callers.values()) for (const entry of record.calls.values()) if (!entry.outcome) entry.controller.abort();
  }

  #recordOf(caller: SessionId): CallerRecord {
    let record = this.#callers.get(caller);
    if (!record) {
      record = { calls: new Map(), operations: new Set(), forgotten: new AbortController() };
      this.#callers.set(caller, record);
    }
    return record;
  }

  #ownerOf(operationId: OperationId): SessionId | undefined {
    for (const [caller, record] of this.#callers) if (record.operations.has(operationId)) return caller;
    return undefined;
  }

  /** Puts the call on record, then starts its handler. */
  #start(
    tool: McpToolName,
    input: unknown,
    caller: SessionId,
    sourceCallRef: string,
    record: CallerRecord,
    digest: string,
    operationId: OperationId | undefined,
  ): Entry {
    const controller = new AbortController();
    let settle!: (outcome: CallOutcome) => void;
    const entry: Entry = { digest, controller, done: new Promise<CallOutcome>((resolve) => (settle = resolve)) };
    if (operationId !== undefined) {
      entry.operationId = operationId;
      record.operations.add(operationId);
    }
    record.calls.set(sourceCallRef, entry);

    const ctx: McpCallContext & { operationId?: OperationId } = { caller, sourceCallRef, signal: controller.signal };
    if (operationId !== undefined) ctx.operationId = operationId;
    const handlers = this.#options.handlers as unknown as Record<McpToolName, (input: unknown, ctx: unknown) => Promise<unknown>>;
    const fail = (category: FailureCategory): CallOutcome => {
      this.#options.log?.(`[mcp] ${tool}: ${category}`);
      return { kind: 'failed' };
    };
    void (async () => {
      let outcome: CallOutcome;
      try {
        const answer = await handlers[tool](input, ctx);
        const checked = toolSpecs[tool].result.safeParse(answer);
        outcome = checked.success ? { kind: 'result', result: checked.data as McpToolResult } : fail('invalid-result');
      } catch {
        outcome = fail('handler-threw');
      }
      entry.outcome = outcome;
      settle(outcome);
    })();
    return entry;
  }

  /** Waits for the run; stops early with `shutting-down` on shutdown, or when this request or caller ends. */
  async #wait(entry: Entry, record: CallerRecord, signal: AbortSignal): Promise<CallOutcome> {
    if (entry.outcome) return entry.outcome;
    if (this.closing) return shuttingDown();
    const listeners: [AbortSignal, () => void][] = [];
    const stopped = new Promise<CallOutcome>((resolve) => {
      const on = (s: AbortSignal, outcome: () => CallOutcome) => {
        const listener = () => resolve(outcome());
        s.addEventListener('abort', listener, { once: true });
        listeners.push([s, listener]);
      };
      on(this.#shutdown.signal, shuttingDown);
      on(record.forgotten.signal, () => ({ kind: 'failed' }));
      on(signal, () => ({ kind: 'failed' }));
      if (record.forgotten.signal.aborted || signal.aborted) resolve({ kind: 'failed' });
    });
    try {
      return await Promise.race([entry.done, stopped]);
    } finally {
      for (const [s, listener] of listeners) s.removeEventListener('abort', listener);
    }
  }
}

/** What a resend of a call gets: the same answer, with an acceptance reported as a duplicate. */
const asResend = (tool: McpToolName, outcome: CallOutcome): CallOutcome =>
  outcome.kind === 'result' && toolSpecs[tool].delivers && outcome.result.status === 'accepted'
    ? { kind: 'result', result: { ...outcome.result, status: 'duplicate' } }
    : outcome;

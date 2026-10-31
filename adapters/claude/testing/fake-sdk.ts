// A scriptable stand-in for the Claude Agent SDK (tests only). Each query() is a FakeQuery: the test
// feeds SDK messages into it (recorded or synthetic), sees what the adapter wrote to the streaming
// input, calls the PreToolUse hook the adapter registered, and controls how control requests answer.
// Stored transcripts are read with the SDK's own readers (sdk.ts transcriptReaders), not a copy of them.
import { transcriptReaders } from '../sdk';
import type { ClaudeSdk, WireHookOutput, WireModelInfo, WireQuery, WireQueryOptions, WireSessionMessage, WireTranscript, WireTranscriptEntry, WireUserMessage } from '../wire';

class Channel<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private failure: Error | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) continue;
      yield next.value;
    }
  }
}

export interface FakeQueryBehaviour {
  /** How initializationResult() answers (default: resolves). */
  init?: 'ok' | 'hang' | Error;
  /** Called for every message the adapter writes to the streaming input. */
  onInput?: (message: WireUserMessage, query: FakeQuery) => void;
  /** Called on interrupt(); default does nothing beyond recording it. */
  onInterrupt?: (query: FakeQuery) => void;
  /** close() ends the stream unless this is false (a process that does not exit). */
  closeEnds?: boolean;
  models?: WireModelInfo[];
  /** query() calls the options' `spawnClaudeCodeProcess`, as the SDK does (default: it does not). */
  spawnOnQuery?: boolean;
  /** Called on supportedModels(), before it answers. */
  onSupportedModels?: (query: FakeQuery) => void;
  setModelError?: Error;
}

export class FakeQuery implements WireQuery {
  readonly inputs: WireUserMessage[] = [];
  readonly calls: string[] = [];
  readonly models: string[] = [];
  readonly stoppedTasks: string[] = [];
  readonly flagSettings: unknown[] = [];
  closed = false;
  private readonly out = new Channel<unknown>();

  constructor(
    readonly options: WireQueryOptions,
    prompt: AsyncIterable<WireUserMessage>,
    private readonly behaviour: FakeQueryBehaviour,
  ) {
    void (async () => {
      for await (const message of prompt) {
        this.inputs.push(message);
        this.behaviour.onInput?.(message, this);
      }
      this.calls.push('input-ended');
    })();
  }

  /** Feeds SDK messages to the adapter. */
  emit(...messages: unknown[]): void {
    for (const m of messages) this.out.push(m);
  }

  /** The CLI process ends (with an error, if given). */
  end(error?: Error): void {
    this.out.end(error);
  }

  /** Calls the PreToolUse hook the adapter registered, as the CLI would before running a tool. */
  callHook(input: Record<string, unknown>, toolUseId?: string): { output: Promise<WireHookOutput>; abort: () => void } {
    const controller = new AbortController();
    const hook = this.options.hooks.PreToolUse[0]?.hooks[0];
    if (!hook) throw new Error('no PreToolUse hook registered');
    const id = toolUseId ?? (typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined);
    return { output: hook({ hook_event_name: 'PreToolUse', session_id: this.options.sessionId ?? this.options.resume, ...input }, id, { signal: controller.signal }), abort: () => controller.abort() };
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this.out.iterate();
  }

  interrupt(): Promise<unknown> {
    this.calls.push('interrupt');
    this.behaviour.onInterrupt?.(this);
    return Promise.resolve({ still_queued: [] });
  }

  close(): void {
    this.calls.push('close');
    this.closed = true;
    if (this.behaviour.closeEnds !== false) this.out.end();
  }

  setModel(model?: string): Promise<void> {
    this.calls.push(`setModel:${model ?? ''}`);
    if (this.behaviour.setModelError) return Promise.reject(this.behaviour.setModelError);
    if (model) this.models.push(model);
    return Promise.resolve();
  }

  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    this.flagSettings.push(settings);
    return Promise.resolve();
  }

  supportedModels(): Promise<WireModelInfo[]> {
    this.calls.push('supportedModels');
    this.behaviour.onSupportedModels?.(this);
    return Promise.resolve(this.behaviour.models ?? []);
  }

  stopTask(taskId: string): Promise<void> {
    this.stoppedTasks.push(taskId);
    return Promise.resolve();
  }

  initializationResult(): Promise<unknown> {
    const init = this.behaviour.init ?? 'ok';
    if (init === 'ok') return Promise.resolve({ models: [] });
    if (init === 'hang') return new Promise(() => {});
    return Promise.reject(init);
  }
}

const folder = (dir: string) => dir.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

interface Stored {
  folders: string[];
  entries: WireTranscriptEntry[];
  subagents: Record<string, WireTranscriptEntry[]>;
}

/**
 * Stored sessions. Like the real SDK, a session is found under the folder it ran in and under other git
 * worktrees of the same repository (SP-07; `alsoFoundFrom`), and nowhere else. The reads themselves go
 * through the SDK's readers over these lines, so deduplication and compaction behave as in production.
 */
export class FakeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = [];
  readonly reads: string[] = [];
  behaviour: FakeQueryBehaviour = {};
  readError: Error | undefined;
  private readonly stored = new Map<string, Stored>();
  private readonly readers = transcriptReaders({
    main: (sessionId) => this.stored.get(sessionId)?.entries,
    subagents: (sessionId) => this.stored.get(sessionId)?.subagents ?? {},
  });

  store(cwd: string, sessionId: string, entries: WireTranscriptEntry[], o: { subagents?: Record<string, WireTranscriptEntry[]>; alsoFoundFrom?: string[] } = {}): void {
    this.stored.set(sessionId, { folders: [cwd, ...(o.alsoFoundFrom ?? [])].map(folder), entries, subagents: o.subagents ?? {} });
  }

  query(params: { prompt: AsyncIterable<WireUserMessage>; options: WireQueryOptions }): FakeQuery {
    const q = new FakeQuery(params.options, params.prompt, this.behaviour);
    this.queries.push(q);
    // As the SDK does: the custom spawn starts claude.exe when the query is made.
    if (this.behaviour.spawnOnQuery) params.options.spawnClaudeCodeProcess?.({ command: 'claude.exe', args: [], ...(params.options.cwd !== undefined && { cwd: params.options.cwd }), env: params.options.env ?? {}, signal: new AbortController().signal });
    return q;
  }

  get last(): FakeQuery {
    const q = this.queries.at(-1);
    if (!q) throw new Error('no query started');
    return q;
  }

  getSessionMessages(sessionId: string, options: { dir: string; includeSystemMessages?: boolean }): Promise<WireSessionMessage[]> {
    this.reads.push(`messages:${sessionId}`);
    if (this.readError) return Promise.reject(this.readError);
    return this.found(sessionId, options.dir) ? this.readers.getSessionMessages(sessionId, options) : Promise.resolve([]);
  }

  listSubagents(sessionId: string, options: { dir: string }): Promise<string[]> {
    this.reads.push(`subagents:${sessionId}`);
    return this.found(sessionId, options.dir) ? this.readers.listSubagents(sessionId, options) : Promise.resolve([]);
  }

  getSubagentMessages(sessionId: string, agentId: string, options: { dir: string }): Promise<WireSessionMessage[]> {
    this.reads.push(`subagent:${agentId}`);
    return this.found(sessionId, options.dir) ? this.readers.getSubagentMessages(sessionId, agentId, options) : Promise.resolve([]);
  }

  /** Set to report the next raw reads as incomplete (sdk.test.ts covers the real check). */
  incompleteRead: string | undefined;

  readTranscript(sessionId: string, options: { dir: string }): Promise<WireTranscript> {
    this.reads.push(`transcript:${sessionId}`);
    if (this.readError) return Promise.reject(this.readError);
    const stored = this.found(sessionId, options.dir);
    const lines = stored ? stored.entries.map((e) => ({ ...e })) : [];
    return Promise.resolve(this.incompleteRead !== undefined && stored ? { lines, complete: false, detail: this.incompleteRead } : { lines, complete: true });
  }

  private found(sessionId: string, dir: string): Stored | undefined {
    const stored = this.stored.get(sessionId);
    return stored?.folders.includes(folder(dir)) ? stored : undefined;
  }
}

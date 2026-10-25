// A scriptable stand-in for the Claude Agent SDK (tests only). Each query() is a FakeQuery: the test
// feeds SDK messages into it (recorded or synthetic), sees what the adapter wrote to the streaming
// input, calls the PreToolUse hook the adapter registered, and controls how control requests answer.
import type { ClaudeSdk, WireHookOutput, WireModelInfo, WireQuery, WireQueryOptions, WireSessionMessage, WireUserMessage } from '../wire';

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

/** Stored transcripts are found only under the cwd they were written in (SP-01), like the real SDK. */
const key = (dir: string, sessionId: string) => `${dir.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()}|${sessionId}`;

export class FakeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = [];
  readonly reads: string[] = [];
  behaviour: FakeQueryBehaviour = {};
  private readonly transcripts = new Map<string, WireSessionMessage[]>();
  private readonly subagents = new Map<string, Map<string, WireSessionMessage[]>>();
  readError: Error | undefined;

  store(dir: string, sessionId: string, messages: WireSessionMessage[], subagents: Record<string, WireSessionMessage[]> = {}): void {
    this.transcripts.set(key(dir, sessionId), messages);
    this.subagents.set(key(dir, sessionId), new Map(Object.entries(subagents)));
  }

  query(params: { prompt: AsyncIterable<WireUserMessage>; options: WireQueryOptions }): FakeQuery {
    const q = new FakeQuery(params.options, params.prompt, this.behaviour);
    this.queries.push(q);
    return q;
  }

  get last(): FakeQuery {
    const q = this.queries.at(-1);
    if (!q) throw new Error('no query started');
    return q;
  }

  getSessionMessages(sessionId: string, options: { dir: string }): Promise<WireSessionMessage[]> {
    this.reads.push(`messages:${sessionId}`);
    if (this.readError) return Promise.reject(this.readError);
    return Promise.resolve([...(this.transcripts.get(key(options.dir, sessionId)) ?? [])]);
  }

  listSubagents(sessionId: string, options: { dir: string }): Promise<string[]> {
    this.reads.push(`subagents:${sessionId}`);
    return Promise.resolve([...(this.subagents.get(key(options.dir, sessionId))?.keys() ?? [])]);
  }

  getSubagentMessages(sessionId: string, agentId: string, options: { dir: string }): Promise<WireSessionMessage[]> {
    this.reads.push(`subagent:${agentId}`);
    return Promise.resolve([...(this.subagents.get(key(options.dir, sessionId))?.get(agentId) ?? [])]);
  }
}

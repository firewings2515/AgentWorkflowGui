// A stand-in for `codex app-server` that replays a recorded conversation (spike JSONL, one
// `{kind, data}` per line: `out` = client -> server, `in` = server -> client). It emits every `in`
// record up to the next `out`, then waits until the adapter sends a matching message. Client request
// IDs are remapped, so the adapter's own numbering does not have to match the recording.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import type { AppServerProcess } from '../rpc';

export interface ReplayRecord {
  kind: 'in' | 'out';
  data: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const loadFixture = (name: string): ReplayRecord[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReplayRecord);

/** The `in` response that answered the recorded client request `method` (the n-th one, 0-based). */
export const recordedResult = (records: ReplayRecord[], method: string, n = 0): unknown => {
  const ids = records.filter((r) => r.kind === 'out' && r.data.method === method).map((r) => r.data.id);
  const id = ids[n];
  return records.find((r) => r.kind === 'in' && r.data.method === undefined && r.data.id === id)?.data.result;
};

/** The text the recording sent with the n-th client request of `method` (turn/start, turn/steer). */
export const recordedText = (records: ReplayRecord[], method: string, n = 0): string => {
  const params = records.filter((r) => r.kind === 'out' && r.data.method === method)[n]?.data.params;
  const input = isObject(params) && Array.isArray(params.input) ? (params.input as unknown[])[0] : undefined;
  if (!isObject(input) || typeof input.text !== 'string') throw new Error(`no recorded ${method} #${n}`);
  return input.text;
};

// Builders for hand-made scripts (scenarios no spike recorded, e.g. crashes and reroutes).
export const out = (method: string, id?: number, params?: Record<string, unknown>): ReplayRecord => ({
  kind: 'out',
  data: { ...(id !== undefined && { id }), method, ...(params !== undefined && { params }) },
});
export const outResponse = (id: number, result?: unknown): ReplayRecord => ({ kind: 'out', data: result === undefined ? { id } : { id, result } });
export const reply = (id: number, result: unknown): ReplayRecord => ({ kind: 'in', data: { id, result } });
export const replyError = (id: number, code: number, message: string): ReplayRecord => ({ kind: 'in', data: { id, error: { code, message } } });
export const notify = (method: string, params: unknown): ReplayRecord => ({ kind: 'in', data: { method, params } });
export const serverRequest = (id: number, method: string, params: unknown): ReplayRecord => ({ kind: 'in', data: { id, method, params } });

export class FakeAppServer extends EventEmitter implements AppServerProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  /** Every message the adapter sent, in order. */
  readonly received: Record<string, unknown>[] = [];
  /** Messages that did not match the script. Tests assert this stays empty. */
  readonly mismatches: string[] = [];
  private cursor = 0;
  private readonly idMap = new Map<unknown, unknown>();
  private buffer = '';
  private exited = false;
  private waiters: (() => void)[] = [];

  constructor(
    private readonly records: ReplayRecord[],
    private readonly options: { exitOnStdinEnd?: boolean } = {},
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.buffer += chunk.toString();
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          this.receive(line);
        }
        callback();
      },
      final: (callback) => {
        callback();
        if (this.options.exitOnStdinEnd !== false) setImmediate(() => this.exit(0, null));
      },
    });
    setImmediate(() => this.pump());
  }

  /** True when the whole script has been played. */
  get finished(): boolean {
    return this.cursor >= this.records.length;
  }

  /** What the script expects next from the adapter, if it is waiting. */
  get expecting(): Record<string, unknown> | undefined {
    return this.records[this.cursor]?.kind === 'out' ? this.records[this.cursor]!.data : undefined;
  }

  /** Resolves once the script waits for the adapter (or has ended). */
  idle(): Promise<void> {
    if (this.expecting !== undefined || this.finished) return new Promise((resolve) => setImmediate(resolve));
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** The process dies unexpectedly. */
  crash(code = 1): void {
    this.exit(code, null);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal);
    return true;
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
  }

  private receive(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.received.push(msg);
    const expected = this.expecting;
    if (!expected) {
      this.mismatches.push(`unexpected ${describe(msg)} (script ${this.finished ? 'ended' : 'is still sending'})`);
      return;
    }
    const isRequest = typeof expected.method === 'string';
    const matches = isRequest
      ? msg.method === expected.method && (expected.id === undefined) === (msg.id === undefined)
      : msg.method === undefined && msg.id === expected.id;
    if (!matches) {
      this.mismatches.push(`expected ${describe(expected)}, got ${describe(msg)}`);
      return;
    }
    // Where the recording has them, the parameters that select what happens and the approval answers
    // must be the same; settings that differ by design (policy, config, clientInfo) are not compared.
    for (const problem of differences(expected, msg)) this.mismatches.push(`${describe(expected)}: ${problem}`);
    if (isRequest && expected.id !== undefined) this.idMap.set(expected.id, msg.id);
    this.cursor++;
    setImmediate(() => this.pump());
  }

  private pump(): void {
    while (!this.exited && this.records[this.cursor]?.kind === 'in') {
      // Advance first: the write can synchronously reach the adapter, which may answer right away.
      const data = { ...this.records[this.cursor++]!.data };
      // A response to a recorded client request goes to the adapter's own request ID.
      if (data.method === undefined && this.idMap.has(data.id)) data.id = this.idMap.get(data.id);
      this.stdout.write(`${JSON.stringify(data)}\n`);
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) setImmediate(w);
  }
}

const CHECKED_PARAMS = ['threadId', 'turnId', 'expectedTurnId', 'cursor', 'input', 'clientUserMessageId', 'model', 'includeTurns', 'sortDirection'];

const differences = (expected: Record<string, unknown>, actual: Record<string, unknown>): string[] => {
  if (typeof expected.method !== 'string') {
    return 'result' in expected && !isDeepStrictEqual(expected.result, actual.result)
      ? [`answer ${JSON.stringify(actual.result ?? actual.error)} differs from recorded ${JSON.stringify(expected.result)}`]
      : [];
  }
  const want = expected.params;
  if (!isObject(want)) return [];
  const got = isObject(actual.params) ? actual.params : {};
  return CHECKED_PARAMS.filter((k) => k in want && !isDeepStrictEqual(want[k], got[k])).map(
    (k) => `${k} ${JSON.stringify(got[k])} differs from recorded ${JSON.stringify(want[k])}`,
  );
};

const describe = (m: Record<string, unknown>) => {
  const id = JSON.stringify(m.id ?? null);
  return typeof m.method === 'string' ? `${m.method}${m.id !== undefined ? `#${id}` : ''}` : `response#${id}${isObject(m.error) ? ' (error)' : ''}`;
};

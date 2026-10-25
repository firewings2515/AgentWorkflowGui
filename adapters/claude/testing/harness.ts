// Test wiring: an adapter on a fake SDK, its events, and checks that every event satisfies the contracts
// schemas (the refinements are the point: e.g. endedAt exactly when an item or turn is finished).
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { AppEvent, AttemptId, ClientMessageId, type DispatchAttempt, SessionId } from '../../../contracts';
import type { PermissionHandle, RuntimeEvent, StartSessionOptions } from '../../../core/ports';
import { ClaudeAdapter, type ClaudeAdapterOptions } from '../adapter';
import type { WireTranscriptEntry } from '../wire';
import { FakeSdk } from './fake-sdk';

export const SESSION = SessionId.parse('session-a');
export const NOW = new Date('2026-10-25T12:00:00.000Z');
export const CWD = 'E:\\work\\task-1';
export const REF = '5f3c2a1e-8b7d-4c6e-9f10-112233445566';

export interface Harness {
  sdk: FakeSdk;
  adapter: ClaudeAdapter;
  events: RuntimeEvent[];
  permissions: PermissionHandle[];
  logs: string[];
  of<T extends RuntimeEvent['type']>(type: T): Extract<RuntimeEvent, { type: T }>[];
}

export const setup = (options: Partial<ClaudeAdapterOptions> = {}): Harness => {
  const sdk = new FakeSdk();
  const events: RuntimeEvent[] = [];
  const permissions: PermissionHandle[] = [];
  const logs: string[] = [];
  let n = 0;
  const adapter = new ClaudeAdapter({
    sdk,
    onPermissionRequest: (handle) => permissions.push(handle),
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    cwdExists: () => true,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...options,
  });
  adapter.subscribe((event) => events.push(event));
  return {
    sdk,
    adapter,
    events,
    permissions,
    logs,
    of: <T extends RuntimeEvent['type']>(type: T) => events.filter((e): e is Extract<RuntimeEvent, { type: T }> => e.type === type),
  };
};

export const startOptions = (extra: Partial<StartSessionOptions> = {}): StartSessionOptions => ({
  sessionId: SESSION,
  cwd: CWD,
  model: { runtime: 'claude', model: 'haiku' },
  readOnly: false,
  preallocatedRef: REF,
  ...extra,
});

/** Starts the adapter and one session on the fake SDK. */
export const started = async (options: Partial<ClaudeAdapterOptions> = {}, session: Partial<StartSessionOptions> = {}): Promise<Harness> => {
  const h = setup(options);
  await h.adapter.start();
  await h.adapter.startSession(startOptions(session));
  return h;
};

/** Polls until `predicate` holds (the fake delivers messages on the event loop). */
export const until = async (predicate: () => boolean, what = 'condition', timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Lets the adapter drain what the fake already emitted. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Every event must parse with its contracts schema. */
export const expectValidEvents = (events: RuntimeEvent[]): void => {
  for (const event of events) {
    const result = AppEvent.safeParse(event);
    expect(result.success, `${event.type}: ${result.error?.message ?? ''}`).toBe(true);
  }
};

let attempts = 0;
export const attempt = (clientMessageId?: string): Extract<DispatchAttempt, { state: 'unknown' }> => {
  attempts++;
  return {
    state: 'unknown',
    attemptId: AttemptId.parse(`attempt-${attempts}`),
    clientMessageId: ClientMessageId.parse(clientMessageId ?? `9a7c1e52-0d3b-4f6e-8a21-${String(attempts).padStart(12, '0')}`),
    dispatchStartedAt: NOW.toISOString(),
  };
};

const fixturePath = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

/** SDK messages recorded by the spikes (fixtures/*.jsonl, SDK 0.3.309 / Claude Code 2.1.309). */
export const loadMessages = (name: string): Record<string, unknown>[] =>
  readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

export interface StoredFixture {
  sessionId: string;
  cwd: string;
  entries: WireTranscriptEntry[];
  subagents: Record<string, WireTranscriptEntry[]>;
}

/**
 * A stored session as raw transcript lines (the CLI's JSONL shape, reduced to the fields the SDK reader
 * uses; paths made up). sp03-transcript.json is SP-03's session.
 */
export const loadStored = (name: string): StoredFixture => JSON.parse(readFileSync(fixturePath(name), 'utf8')) as StoredFixture;

type Line = Partial<WireTranscriptEntry> & { type: string; uuid: string };

/**
 * Raw transcript lines for one session, chained by parentUuid in the given order (a line may name its
 * own parent), with the fields every CLI line carries.
 */
export const transcript = (sessionId: string, cwd: string, lines: Line[]): WireTranscriptEntry[] => {
  let parent: string | null = null;
  return lines.map((line, i) => {
    const entry: WireTranscriptEntry = { parentUuid: parent, isSidechain: false, sessionId, cwd, timestamp: `2026-10-25T11:00:${String(i).padStart(2, '0')}.000Z`, ...line };
    parent = line.uuid;
    return entry;
  });
};

/** A prompt line (typed or dispatched; `content` as the CLI stores it). */
export const promptLine = (uuid: string, content: unknown, extra: Partial<WireTranscriptEntry> = {}): Line => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });

/** An assistant line: one content block of API message `id`, carrying the message's final stop_reason. */
export const replyLine = (uuid: string, block: Record<string, unknown>, o: { id?: string; stop?: string; model?: string } = {}): Line => ({
  type: 'assistant',
  uuid,
  message: { id: o.id ?? `msg_${uuid.slice(-4)}`, type: 'message', role: 'assistant', model: o.model ?? 'claude-haiku-5-5', stop_reason: o.stop ?? 'end_turn', content: [block] },
});

export const toolResultLine = (uuid: string, toolUseId: string, content: string, isError = false): Line => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] },
});

/** A transcript uuid with a readable tail, e.g. u(7) → 11111111-0000-4000-8000-000000000007. */
export const u = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The recorded messages up to and including the n-th result (0-based), split into turns. */
export const turnsOf = (messages: Record<string, unknown>[]): Record<string, unknown>[][] => {
  const turns: Record<string, unknown>[][] = [[]];
  for (const m of messages) {
    turns.at(-1)!.push(m);
    if (m.type === 'result' && m.parent_tool_use_id == null) turns.push([]);
  }
  return turns.filter((t) => t.length > 0);
};

/** An assistant frame that echoes a dispatched uuid, as the CLI stamps the turn's first reply. */
export const echo = (uuid: string, text = 'ACK', extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-5-5', id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  uuid: `a-${uuid}`,
  session_id: REF,
  user_message_uuid: uuid,
  user_message_uuids: [uuid],
  ...extra,
});

export const init = () => ({ type: 'system', subtype: 'init', session_id: REF, model: 'claude-haiku-5-5', cwd: CWD, uuid: 'init' });

export const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: REF,
  usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 10, contextWindow: 200000 } },
  ...extra,
});

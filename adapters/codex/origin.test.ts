// T017 on the Codex adapter: the GUI MCP server is mounted from the port's `mcp` option, payloads that
// are not from the user go out in an envelope naming their source (R-03), and a failed initialize leaves
// nothing behind, so the next start spawns a fresh app-server (T013 review P2).
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, type MessageOrigin, PeerMessageId, SessionId } from '../../contracts';
import type { DispatchRequest } from '../../core/ports';
import { CodexAdapter } from './adapter';
import { envelope, unwrap } from './origin';
import { ISOLATION_CONFIG } from './protocol';
import { FakeAppServer, loadFixture, notify, out, recordedResult, reply, replyError, type ReplayRecord } from './testing/fake-app-server';
import { SESSION, expectValidEvents, sentParams, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const CWD = 'E:\\work\\task';
const TOKEN = 'tok-0123456789abcdef0123456789abcdef';
const MOUNT = { url: 'http://127.0.0.1:50123/mcp', token: TOKEN };
const PEER: MessageOrigin = {
  kind: 'peer',
  fromSessionId: SessionId.parse('session-b'),
  peerMessageId: PeerMessageId.parse('peer-1'),
};
const CLIENT_ID = ClientMessageId.parse('9a7c1e52-0d3b-4f6e-8a21-000000000001');

const init = (): ReplayRecord[] => [out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized')];
const request = (origin?: MessageOrigin, text = 'hello'): DispatchRequest => ({
  nativeSessionRef: THREAD_ID,
  attempt: {
    state: 'unknown',
    attemptId: AttemptId.parse('attempt-1'),
    clientMessageId: CLIENT_ID,
    dispatchStartedAt: '2026-10-24T12:00:00.000Z',
  },
  text,
  entry: { kind: 'new-turn' },
  ...(origin && { origin }),
});
const userItem = (clientId: string | null, text: string) => ({
  type: 'userMessage',
  id: 'u-1',
  clientId,
  content: [{ type: 'text', text, text_elements: [] }],
});

describe('the GUI MCP server from the port’s mcp option', () => {
  const mcpConfig = {
    ...ISOLATION_CONFIG,
    'mcp_servers.gui.url': MOUNT.url,
    'mcp_servers.gui.http_headers': { Authorization: `Bearer ${TOKEN}` },
  };

  it('is in the thread config on start and on resume, and the isolation keys still apply', async () => {
    const logs: unknown[] = [];
    const h = setup(
      [
        ...init(),
        out('thread/start', 2, { cwd: CWD, config: mcpConfig }),
        reply(2, recordedResult(sp01, 'thread/start')),
        out('thread/resume', 3, {
          threadId: THREAD_ID,
          config: {
            ...mcpConfig,
            'mcp_servers.gui.http_headers': { Authorization: 'Bearer second' },
          },
        }),
        reply(3, recordedResult(sp01, 'thread/start')),
      ],
      { log: (...args) => logs.push(args) },
    );
    await h.adapter.startSession({
      sessionId: SESSION,
      cwd: CWD,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      readOnly: false,
      mcp: MOUNT,
    });
    await h.adapter.resumeSession({
      sessionId: SESSION,
      nativeSessionRef: THREAD_ID,
      cwd: CWD,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      readOnly: false,
      mcp: { ...MOUNT, token: 'second' },
    });
    expect(h.fake.mismatches).toEqual([]);
    expect(sentParams(h.fake, 'thread/start').config).toEqual(mcpConfig);
    // Nothing the adapter emits or logs carries the token.
    expect(JSON.stringify([h.events, logs])).not.toContain(TOKEN);
  });

  it('mounts nothing without the option', async () => {
    const h = setup([...init(), out('thread/start', 2), reply(2, recordedResult(sp01, 'thread/start'))]);
    await h.adapter.startSession({
      sessionId: SESSION,
      cwd: CWD,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      readOnly: false,
    });
    expect(sentParams(h.fake, 'thread/start').config).toEqual(ISOLATION_CONFIG);
  });
});

describe('origin (R-03)', () => {
  const started = async (records: ReplayRecord[]) => {
    const h = setup([...init(), out('thread/resume', 2), reply(2, recordedResult(sp01, 'thread/start')), ...records]);
    await h.adapter.start();
    await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
    return h;
  };

  it('sends a peer payload in an envelope that names its source, and shows it with that origin and its own text', async () => {
    const wrapped = envelope('hello', PEER);
    const h = await started([
      out('turn/start', 3, {
        threadId: THREAD_ID,
        input: [{ type: 'text', text: wrapped, text_elements: [] }],
        clientUserMessageId: CLIENT_ID,
      }),
      reply(3, recordedResult(sp01, 'turn/start')),
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: 'turn-x',
        completedAtMs: 1792739196000,
        item: userItem(CLIENT_ID, wrapped),
      }),
    ]);
    expect(await h.adapter.dispatchOnce(request(PEER))).toMatchObject({
      state: 'sent',
    });
    expect(wrapped).toMatch(/session-b.*peer-1.*not from the user/);
    await until(() => h.of('message.completed').length > 0, 'the user message');
    expect(h.of('message.completed')[0]?.message).toMatchObject({
      role: 'user',
      origin: PEER,
      text: 'hello',
    });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });

  it('sends the user’s own payload as it is', async () => {
    const h = await started([
      out('turn/start', 3, {
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      }),
      reply(3, recordedResult(sp01, 'turn/start')),
    ]);
    await h.adapter.dispatchOnce(request({ kind: 'user' }));
    expect(h.fake.mismatches).toEqual([]);
  });

  it('reads the origin back from a stored envelope, and reconciles the payload text against it', async () => {
    const wrapped = envelope('hello', PEER);
    const h = setup([
      ...init(),
      out('thread/items/list', 2),
      reply(2, {
        data: [
          {
            turnId: 'turn-1',
            item: userItem(CLIENT_ID, wrapped),
            startedAtMs: 1792739195018,
            completedAtMs: 1792739195018,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
      }),
    ]);
    await h.adapter.start();
    const result = await h.adapter.reconcile({
      nativeSessionRef: THREAD_ID,
      cwd: CWD,
      clientMessageId: CLIENT_ID,
      text: 'hello',
    });
    expect(result).toMatchObject({
      state: 'sent',
      nativeRef: { itemRef: 'u-1' },
    });
    expect(unwrap(wrapped)).toEqual({ text: 'hello', origin: PEER });
  });

  it('takes only the outermost header, and not a header inside a payload', () => {
    const inner = envelope('x', { kind: 'system' });
    expect(unwrap(envelope(inner, PEER))).toEqual({
      text: inner,
      origin: PEER,
    });
    expect(unwrap(`hi\n${inner}`)).toBeUndefined();
    expect(unwrap('[AgentWorkflowGui] This message comes from the user.\n---\nx')).toBeUndefined();
    for (const origin of [{ kind: 'agent' }, { kind: 'system' }, { kind: 'handoff', fromSessionId: 's', handoffId: 'h' }] as MessageOrigin[]) {
      expect(unwrap(envelope('body', origin))).toEqual({
        text: 'body',
        origin,
      });
    }
  });
});

describe('a failed initialize (T013 review P2)', () => {
  it('drops the failed connection, so the next start spawns a fresh app-server', async () => {
    const failing = new FakeAppServer([out('initialize', 1), replyError(1, -32000, 'not logged in')]);
    const working = new FakeAppServer([...init(), out('thread/start', 2), reply(2, recordedResult(sp01, 'thread/start'))]);
    const fakes = [failing, working];
    let spawned = 0;
    const adapter = new CodexAdapter({
      spawn: () => fakes[spawned++]!,
      onPermissionRequest: () => undefined,
    });
    const start = {
      sessionId: SESSION,
      cwd: CWD,
      model: { runtime: 'codex' as const, model: 'gpt-6-luna' },
      readOnly: false,
    };
    await expect(adapter.startSession(start)).rejects.toThrow(/not logged in/);
    expect(adapter.running).toBe(false);
    await expect(adapter.startSession(start)).resolves.toMatchObject({
      nativeSessionRef: THREAD_ID,
    });
    expect(spawned).toBe(2);
    expect(working.mismatches).toEqual([]);
    await adapter.close();
  });
});

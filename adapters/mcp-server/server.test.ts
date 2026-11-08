// Real loopback HTTP: the SDK client for the normal paths, raw requests for what a client would not send.
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import type { HandoffId, HandoffToolResult, PeerMessageId, SessionId } from '../../contracts';
import type { McpMount } from '../../core/ports';
import { GuiMcpServer, type GuiMcpServerOptions } from './server';
import type { McpToolHandlers } from './tools';

const A = 'session-a' as SessionId;
const B = 'session-b' as SessionId;
const PROTOCOL = '2025-06-18';

type Fakes = { [K in keyof McpToolHandlers]: Mock<McpToolHandlers[K]> };
const notExpected = () => Promise.reject(new Error('not expected'));
const makeHandlers = (overrides: Partial<Fakes> = {}): Fakes => ({
  handoff: vi.fn<McpToolHandlers['handoff']>((_input, ctx) =>
    Promise.resolve<HandoffToolResult>({
      status: 'accepted',
      handoffId: `handoff-${ctx.operationId}` as HandoffId,
      operationId: ctx.operationId,
      delivery: 'pending',
    }),
  ),
  create_tasks: vi.fn<McpToolHandlers['create_tasks']>(notExpected),
  send_message: vi.fn<McpToolHandlers['send_message']>(notExpected),
  report_to_root: vi.fn<McpToolHandlers['report_to_root']>(() => Promise.resolve({ status: 'reported' })),
  wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>(notExpected),
  ...overrides,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const open: { servers: GuiMcpServer[]; clients: Client[] } = { servers: [], clients: [] };

afterEach(async () => {
  await Promise.allSettled(open.clients.splice(0).map((c) => c.close()));
  await Promise.allSettled(open.servers.splice(0).map((s) => s.close()));
});

const startServer = async (handlers: McpToolHandlers, options: Partial<GuiMcpServerOptions> = {}) => {
  let n = 0;
  const server = await GuiMcpServer.start({ handlers, uuid: () => `op-${++n}`, ...options });
  open.servers.push(server);
  return server;
};

const connect = async (mount: McpMount) => {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(mount.url), {
    requestInit: { headers: { Authorization: `Bearer ${mount.token}` } },
  });
  await client.connect(transport);
  open.clients.push(client);
  return { client, transport };
};

const resultOf = (answer: unknown): unknown => {
  const content = (answer as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]?.text ?? 'null') as unknown;
};

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** A request left open: what has arrived so far is in `state`; `req.destroy()` drops the connection. */
const rawOpen = (url: string, headers: Record<string, string>, body: string) => {
  const target = new URL(url);
  const state = { status: 0, text: '' };
  const req = request({ host: '127.0.0.1', port: target.port, path: target.pathname, method: 'POST', headers }, (res) => {
    state.status = res.statusCode ?? 0;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => (state.text += chunk));
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end(body);
  return { req, state };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repeats `send` while it answers 409 (the ID still taken), up to about a second. */
const untilNot409 = async (send: () => Promise<RawResponse>): Promise<RawResponse> => {
  for (let i = 0; i < 50; i++) {
    const res = await send();
    if (res.status !== 409) return res;
    await sleep(20);
  }
  throw new Error('the ID stayed taken');
};

const toolCall = (id: number, name: string, args: unknown, meta?: Record<string, unknown>) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta && { _meta: meta }) } });

const raw = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      { host: '127.0.0.1', port: target.port, path: target.pathname, method: options.method ?? 'POST', headers: options.headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });

const jsonHeaders = (token: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`,
  ...extra,
});

/** The JSON-RPC message in an SSE or JSON answer. */
const messageOf = (res: RawResponse): { result?: unknown; error?: { code: number; message: string } } => {
  const data = res.text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice(6) : res.text) as { result?: unknown };
};

/** A raw MCP session: initialize, then the initialized notification. */
const rawSession = async (mount: McpMount) => {
  const init = await raw(mount.url, {
    headers: jsonHeaders(mount.token),
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'raw', version: '0' } } }),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers['mcp-session-id'] as string;
  const headers = (token = mount.token) => jsonHeaders(token, { 'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL });
  await raw(mount.url, { headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const call = (id: number, name: string, args: unknown, meta?: Record<string, unknown>, token?: string) =>
    raw(mount.url, {
      headers: headers(token),
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta && { _meta: meta }) } }),
    });
  return { sessionId, headers, call };
};

const handoffArgs = { ruleId: 'done', target: { kind: 'root' }, content: 'the work', taskId: 'task-1' };

describe('GuiMcpServer', () => {
  it('listens on 127.0.0.1 at a port the system picks', async () => {
    const one = await startServer(makeHandlers());
    const two = await startServer(makeHandlers());
    expect(one.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(one.url).not.toBe(two.url);
  });

  it('refuses a missing, wrong or revoked token without saying more', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'x', version: '0' } } });
    const noToken: Record<string, string> = jsonHeaders('');
    delete noToken['authorization'];
    const missing = await raw(mount.url, { headers: noToken, body });
    const wrong = await raw(mount.url, { headers: jsonHeaders(`${mount.token}x`), body });
    server.revoke(A);
    const revoked = await raw(mount.url, { headers: jsonHeaders(mount.token), body });
    for (const res of [missing, wrong, revoked]) {
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.text).not.toContain(mount.token);
      expect(res.text).not.toContain(A);
    }
  });

  it('identifies the caller by its token only, and lists the five tools', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const a = await connect(server.mount(A));
    const b = await connect(server.mount(B));
    const { tools } = await a.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_tasks', 'handoff', 'report_to_root', 'send_message', 'wait_for_file']);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
    await a.client.callTool({ name: 'report_to_root', arguments: { content: 'from a' } });
    await b.client.callTool({ name: 'report_to_root', arguments: { content: 'from b' } });
    expect(handlers.report_to_root.mock.calls.map((c) => c[1].caller)).toEqual([A, B]);
    // A claim of identity in the input is not a field of any tool.
    const claimed = await b.client.callTool({ name: 'report_to_root', arguments: { content: 'x', sessionId: A } });
    expect(claimed.isError).toBe(true);
    expect(resultOf(claimed)).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    expect(handlers.report_to_root).toHaveBeenCalledTimes(2);
  });

  // T069: a message answered before its delivery is confirmed comes with a fixed line telling the agent not to resend it.
  it('adds the line "being confirmed" after a send_message answered pending or unknown, and only then', async () => {
    const answers: Awaited<ReturnType<McpToolHandlers['send_message']>>[] = [];
    const handlers = makeHandlers({
      send_message: vi.fn<McpToolHandlers['send_message']>((_input, ctx) => {
        const delivery = (['pending', 'unknown', 'sent'] as const)[answers.length % 3]!;
        const answer = { status: answers.length < 3 ? ('accepted' as const) : ('duplicate' as const), peerMessageId: `peer-${ctx.operationId}` as PeerMessageId, operationId: ctx.operationId, delivery };
        answers.push(answer);
        return Promise.resolve(answer);
      }),
    });
    const server = await startServer(handlers);
    const a = await connect(server.mount(A));
    const texts: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const answer = await a.client.callTool({ name: 'send_message', arguments: { to: B, content: `secret ${String(i)}` } });
      expect(resultOf(answer)).toEqual(answers[i]);
      texts.push((answer.content as { text: string }[]).slice(1).map((c) => c.text));
    }
    const line = 'The message was handed over and its delivery is being confirmed. Do not send it again; a reply, if any, comes later as a new message.';
    expect(texts).toEqual([[line], [line], [], [line], [line], []]);
    // Another tool's result gets no such line.
    const reported = await a.client.callTool({ name: 'report_to_root', arguments: { content: 'r' } });
    expect(reported.content).toHaveLength(1);
  });

  it('does not find one session\'s MCP session under another session\'s token', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const mountA = server.mount(A);
    const mountB = server.mount(B);
    const a = await rawSession(mountA);
    const stolen = await a.call(1, 'report_to_root', { content: 'x' }, undefined, mountB.token);
    const unknown = await raw(mountB.url, {
      headers: jsonHeaders(mountB.token, { 'mcp-session-id': 'no-such-session', 'mcp-protocol-version': PROTOCOL }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(stolen.status).toBe(404);
    expect(stolen.text).toBe(unknown.text);
    expect(handlers.report_to_root).not.toHaveBeenCalled();
    // A's own token still works.
    expect((await a.call(2, 'report_to_root', { content: 'x' })).status).toBe(200);
  });

  it('maps a resend with the same native call ID to the same operationId and accepts it once', async () => {
    const handlers = makeHandlers();
    const metaKeys: string[][] = [];
    const versions: string[] = [];
    const server = await startServer(handlers, { onCallMeta: (info) => metaKeys.push(info.metaKeys), onProtocolVersion: (info) => versions.push(`${info.caller} ${info.protocolVersion}`) });
    const session = await rawSession(server.mount(A));
    const meta = { 'claudecode/toolUseId': 'toolu_01' };
    const first = messageOf(await session.call(1, 'handoff', handoffArgs, meta));
    const resend = messageOf(await session.call(2, 'handoff', handoffArgs, meta));
    const other = messageOf(await session.call(3, 'handoff', handoffArgs, { 'claudecode/toolUseId': 'toolu_02' }));
    expect(resultOf(first.result)).toMatchObject({ status: 'accepted', operationId: 'op-1' });
    expect(resultOf(resend.result)).toMatchObject({ status: 'duplicate', operationId: 'op-1', handoffId: 'handoff-op-1' });
    expect(resultOf(other.result)).toMatchObject({ status: 'accepted', operationId: 'op-2' });
    expect(handlers.handoff).toHaveBeenCalledTimes(2);
    expect(handlers.handoff.mock.calls[0]?.[1].sourceCallRef).toBe('meta:claudecode/toolUseId:toolu_01');
    expect(metaKeys[0]).toEqual(['claudecode/toolUseId']);
    // Reported once for the MCP session, from the version header the client sends after initialize.
    expect(versions).toEqual([`${A} ${PROTOCOL}`]);
  });

  it('without a native call ID, recognises a resend by its JSON-RPC ID within the MCP session', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const one = await rawSession(mount);
    const first = messageOf(await one.call(7, 'handoff', handoffArgs));
    const resend = messageOf(await one.call(7, 'handoff', handoffArgs));
    // The same JSON-RPC ID in another MCP session is another call.
    const two = await rawSession(mount);
    const elsewhere = messageOf(await two.call(7, 'handoff', handoffArgs));
    expect(resultOf(first.result)).toMatchObject({ status: 'accepted', operationId: 'op-1' });
    expect(resultOf(resend.result)).toMatchObject({ status: 'duplicate', operationId: 'op-1' });
    expect(resultOf(elsewhere.result)).toMatchObject({ status: 'accepted', operationId: 'op-2' });
    expect(handlers.handoff).toHaveBeenCalledTimes(2);
  });

  it('uses a replaceable source call identity', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers, { sourceCallRef: (meta) => `custom:${String(meta?.['codex/callId'])}` });
    const session = await rawSession(server.mount(A));
    await session.call(1, 'handoff', handoffArgs, { 'codex/callId': 'c1' });
    await session.call(2, 'handoff', handoffArgs, { 'codex/callId': 'c1' });
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
    expect(handlers.handoff.mock.calls[0]?.[1].sourceCallRef).toBe('custom:c1');
  });

  it('validates input with the contracts and answers without echoing it', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const { client } = await connect(server.mount(A));
    const secret = 'SECRET-VALUE-9';
    const bad = await client.callTool({ name: 'handoff', arguments: { ...handoffArgs, target: { kind: 'node', nodeId: '' }, note: secret } });
    expect(bad.isError).toBe(true);
    expect(resultOf(bad)).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
    expect(JSON.stringify(bad)).not.toContain(secret);
    const unknownTool = await client.callTool({ name: 'whoami', arguments: {} });
    expect(unknownTool.isError).toBe(true);
    expect(handlers.handoff).not.toHaveBeenCalled();
  });

  it('gives a generic error when a handler fails, with nothing of the failure in it', async () => {
    const error = Object.assign(new Error('db at C:/secret token=abc'), { name: 'NAME-MARKER' });
    const handlers = makeHandlers({ report_to_root: vi.fn<McpToolHandlers['report_to_root']>(() => Promise.reject(error)) });
    const log = vi.fn<(m: string) => void>();
    const server = await startServer(handlers, { log });
    const mount = server.mount(A);
    const { client } = await connect(mount);
    const answer = await client.callTool({ name: 'report_to_root', arguments: { content: 'x' } });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toMatch(/secret|token=abc|NAME-MARKER/);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['[mcp] report_to_root: handler-threw']);
    // The same source call again: the same failure, and the handler does not run twice (review r1 P1-5).
    const session = await rawSession(mount);
    const meta = { 'claudecode/toolUseId': 'toolu_9' };
    const one = messageOf(await session.call(1, 'report_to_root', { content: 'y' }, meta));
    const two = messageOf(await session.call(2, 'report_to_root', { content: 'y' }, meta));
    expect(two).toEqual({ ...one, id: 2 });
    expect(handlers.report_to_root).toHaveBeenCalledTimes(2);
  });

  // Review r1 P1-3: two requests with one JSON-RPC ID at once used to leave the first without an answer.
  it('answers both of two concurrent requests with the same JSON-RPC ID', async () => {
    const gate = deferred<void>();
    const handlers = makeHandlers({
      handoff: vi.fn<McpToolHandlers['handoff']>(async (_input, ctx) => {
        await gate.promise;
        return { status: 'accepted', handoffId: `handoff-${ctx.operationId}` as HandoffId, operationId: ctx.operationId, delivery: 'pending' };
      }),
    });
    const server = await startServer(handlers);
    const session = await rawSession(server.mount(A));
    const first = session.call(7, 'handoff', handoffArgs);
    await vi.waitFor(() => expect(handlers.handoff).toHaveBeenCalled());
    const second = await session.call(7, 'handoff', handoffArgs);
    expect(second.status).toBe(409);
    expect(messageOf(second)).toMatchObject({ id: 7, error: { code: -32600 } });
    gate.resolve();
    const answer = await first;
    expect(answer.status).toBe(200);
    expect(resultOf(messageOf(answer).result)).toMatchObject({ status: 'accepted', operationId: 'op-1' });
    // Once answered, the same ID is a resend of a finished call.
    expect(resultOf(messageOf(await session.call(7, 'handoff', handoffArgs)).result)).toMatchObject({ status: 'duplicate', operationId: 'op-1' });
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
    expect((await session.call(8, 'handoff', handoffArgs)).status).toBe(200);
  });

  // Review r1 P1-4: an initialize whose body arrived after the token was replaced still opened a session.
  // Review r2 P1 (a): the ID was freed when the connection dropped, and the old handler's answer then
  // went to the new request with the same ID.
  it('keeps an ID taken after its connection drops until the SDK has ended that request', async () => {
    const oldGate = deferred<void>();
    let finished = 0;
    const handlers = makeHandlers({
      handoff: vi.fn<McpToolHandlers['handoff']>(async (_input, ctx) => {
        if (ctx.sourceCallRef.endsWith(':old')) await oldGate.promise;
        finished++;
        return { status: 'accepted', handoffId: `handoff-${ctx.operationId}` as HandoffId, operationId: ctx.operationId, delivery: 'pending' };
      }),
    });
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const session = await rawSession(mount);
    const first = rawOpen(mount.url, session.headers(), toolCall(7, 'handoff', handoffArgs, { callId: 'old' }));
    await vi.waitFor(() => expect(handlers.handoff).toHaveBeenCalledTimes(1));
    first.req.destroy();
    await sleep(50);
    const newArgs = { ...handoffArgs, content: 'other work' };
    const whileOldRuns = await session.call(7, 'handoff', newArgs, { callId: 'new' });
    expect(whileOldRuns.status).toBe(409);
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
    oldGate.resolve();
    await vi.waitFor(() => expect(finished).toBe(1));
    // Once the old request has ended, the ID is free and the new request gets its own answer.
    const second = await untilNot409(() => session.call(7, 'handoff', newArgs, { callId: 'new' }));
    expect(second.status).toBe(200);
    expect(resultOf(messageOf(second).result)).toMatchObject({ status: 'accepted', operationId: 'op-2' });
    expect(second.text).not.toContain('op-1');
  });

  // Review r2 P1 (b): after a cancel the handler had ended, but the ID stayed taken while the old
  // connection stayed open.
  it('frees an ID once a cancelled request has ended, even while its connection stays open', async () => {
    const gate = deferred<void>();
    let finished = 0;
    const handlers = makeHandlers({
      handoff: vi.fn<McpToolHandlers['handoff']>(async (_input, ctx) => {
        await gate.promise;
        finished++;
        return { status: 'accepted', handoffId: `handoff-${ctx.operationId}` as HandoffId, operationId: ctx.operationId, delivery: 'pending' };
      }),
    });
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const session = await rawSession(mount);
    const meta = { callId: 'c1' };
    const first = rawOpen(mount.url, session.headers(), toolCall(7, 'handoff', handoffArgs, meta));
    await vi.waitFor(() => expect(handlers.handoff).toHaveBeenCalledTimes(1));
    const cancel = await raw(mount.url, {
      headers: session.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'test' } }),
    });
    expect(cancel.status).toBe(202);
    gate.resolve();
    await vi.waitFor(() => expect(finished).toBe(1));
    const resend = await untilNot409(() => session.call(7, 'handoff', handoffArgs, meta));
    expect(resend.status).toBe(200);
    expect(resultOf(messageOf(resend).result)).toMatchObject({ status: 'duplicate', operationId: 'op-1' });
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
    // The cancelled request's stream got nothing, not even the resend's answer.
    expect(first.state.text).not.toContain('operationId');
    first.req.destroy();
  });

  // Review r2 P2: a refused batch without a session header used to leave a transport behind.
  // Review r3 P1-1: a batch freed an answered ID before the SDK had finished the batch, and a new batch
  // reusing it lost its answer. Batches are refused outright now (not part of MCP since 2025-06-18).
  it('refuses every batch before opening a transport or taking an ID', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const session = await rawSession(mount);
    expect(server.openMcpSessions).toBe(1);
    const init = { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'x', version: '0' } } };
    for (let i = 0; i < 5; i++) {
      const res = await raw(mount.url, { headers: jsonHeaders(mount.token), body: JSON.stringify([{ ...init, id: 1 }, { jsonrpc: '2.0', id: 1, method: 'ping' }]) });
      expect(res.status).toBe(400);
      expect(messageOf(res)).toMatchObject({ error: { code: -32600 } });
    }
    expect(server.openMcpSessions).toBe(1);
    // The r3 sequence inside a session: [7, 8], then [7, 9]. Neither reaches the SDK or takes 7.
    const batch = (ids: number[], callId: string) =>
      raw(mount.url, {
        headers: session.headers(),
        body: JSON.stringify(ids.map((id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'handoff', arguments: handoffArgs, _meta: { callId: `${callId}-${id}` } } }))),
      });
    for (const res of [await batch([7, 8], 'a'), await batch([7, 9], 'b')]) {
      expect(res.status).toBe(400);
      expect(messageOf(res)).toMatchObject({ error: { code: -32600 } });
    }
    expect(handlers.handoff).not.toHaveBeenCalled();
    const single = await session.call(7, 'handoff', handoffArgs, { callId: 'c' });
    expect(single.status).toBe(200);
    expect(resultOf(messageOf(single).result)).toMatchObject({ status: 'accepted', operationId: 'op-1' });
  });

  // Review r3 P1-2: only cancelled calls that reached our tool handler freed their ID; a cancelled ping,
  // tools/list or invalid tools/call kept it taken for good, even after the connection dropped.
  describe('frees the ID of a cancelled or dropped request, whatever its method', () => {
    const requests: Record<string, Record<string, unknown>> = {
      ping: { method: 'ping' },
      'tools/list': { method: 'tools/list' },
      'invalid tools/call': { method: 'tools/call', params: { name: 42 } },
      'pending tools/call': { method: 'tools/call', params: { name: 'wait_for_file', arguments: { path: 'src/a.ts' } } },
    };
    const endings = ['cancel', 'drop then cancel', 'drop'] as const;
    for (const [label, message] of Object.entries(requests)) {
      for (const ending of endings) {
        // A pending call whose connection only drops keeps its ID until its handler ends (tested above).
        if (label === 'pending tools/call' && ending === 'drop') continue;
        it(`${label}, ${ending}`, async () => {
          const handlers = makeHandlers({ wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>(() => new Promise<never>(() => {})) });
          const server = await startServer(handlers);
          const mount = server.mount(A);
          const session = await rawSession(mount);
          const first = rawOpen(mount.url, session.headers(), JSON.stringify({ jsonrpc: '2.0', id: 7, ...message }));
          if (label === 'pending tools/call') await vi.waitFor(() => expect(handlers.wait_for_file).toHaveBeenCalled());
          else await sleep(30);
          if (ending !== 'cancel') {
            first.req.destroy();
            await sleep(30);
          }
          if (ending !== 'drop') {
            const cancelled = await raw(mount.url, {
              headers: session.headers(),
              body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }),
            });
            expect(cancelled.status).toBe(202);
          }
          // A new tool call with its own native ID (without one, the same JSON-RPC ID would be the same call).
          const next = await untilNot409(() => session.call(7, 'report_to_root', { content: 'next' }, { callId: 'next' }));
          expect(next.status).toBe(200);
          // The new request's own answer, not the old request's.
          expect(resultOf(messageOf(next).result)).toEqual({ status: 'reported' });
          expect(first.state.text).not.toContain('reported');
          first.req.destroy();
        });
      }
    }
  });

  // Review r2 P2: an invalid UTF-8 byte was replaced with U+FFFD and the tool ran on the changed text.
  it('answers a body that is not valid UTF-8 with a parse error and runs nothing', async () => {
    const handlers = makeHandlers();
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const session = await rawSession(mount);
    const [head, tail] = toolCall(1, 'report_to_root', { content: 'a#b' }).split('#');
    const body = Buffer.concat([Buffer.from(head!, 'utf8'), Buffer.from([0xff]), Buffer.from(tail!, 'utf8')]);
    const res = await raw(mount.url, { headers: session.headers(), body });
    expect(res.status).toBe(400);
    expect(messageOf(res)).toMatchObject({ error: { code: -32700 } });
    expect(handlers.report_to_root).not.toHaveBeenCalled();
    // Valid multi-byte text still passes.
    expect((await session.call(2, 'report_to_root', { content: '交接 ✓' })).status).toBe(200);
    expect(handlers.report_to_root.mock.calls[0]?.[0].content).toBe('交接 ✓');
  });

  it('does not open an MCP session for a token replaced while the initialize body was arriving', async () => {
    const server = await startServer(makeHandlers());
    const old = server.mount(A);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'slow', version: '0' } } });
    const target = new URL(old.url);
    const pending = new Promise<RawResponse>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: target.port, path: target.pathname, method: 'POST', headers: { ...jsonHeaders(old.token), 'content-length': String(Buffer.byteLength(body)) } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on('error', reject);
      req.flushHeaders();
      req.write(body.slice(0, 10));
      setTimeout(() => {
        current = server.mount(A);
        req.end(body.slice(10));
      }, 100);
    });
    let current: McpMount | undefined;
    const answer = await pending;
    expect(answer.status).toBe(401);
    expect(answer.headers['mcp-session-id']).toBeUndefined();
    // The new token opens its own session as usual.
    await rawSession(current!);
  });

  it('answers calls in progress with shutting-down when it closes, then refuses connections', async () => {
    let seen: AbortSignal | undefined;
    const handlers = makeHandlers({
      wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>((_input, ctx) => {
        seen = ctx.signal;
        return new Promise<never>(() => {});
      }),
    });
    const server = await startServer(handlers);
    const mount = server.mount(A);
    const { client } = await connect(mount);
    const waiting = client.callTool({ name: 'wait_for_file', arguments: { path: 'src/a.ts' } });
    await vi.waitFor(() => expect(handlers.wait_for_file).toHaveBeenCalled());
    await server.close();
    const answer = await waiting;
    expect(answer.isError).toBe(true);
    expect(resultOf(answer)).toEqual({ status: 'rejected', rejection: { reason: 'shutting-down', detail: 'the GUI is shutting down' } });
    expect(seen?.aborted).toBe(true);
    await expect(raw(mount.url, { headers: jsonHeaders(mount.token), body: '{}' })).rejects.toThrow();
    expect(() => server.mount(B)).toThrow();
  });

  it('refuses a body over its limit before parsing it', async () => {
    const handlers = makeHandlers();
    const small = await startServer(handlers, { maxRequestBodyBytes: 2048 });
    const session = await rawSession(small.mount(A));
    const big = await session.call(1, 'report_to_root', { content: 'x'.repeat(4096) });
    expect(big.status).toBe(413);
    expect(handlers.report_to_root).not.toHaveBeenCalled();
    expect((await session.call(2, 'report_to_root', { content: 'x'.repeat(100) })).status).toBe(200);

    // The default limit is 1 MiB.
    const standard = await startServer(handlers);
    const other = await rawSession(standard.mount(A));
    expect((await other.call(1, 'report_to_root', { content: 'x'.repeat(1024 * 1024) })).status).toBe(413);
    expect((await other.call(2, 'report_to_root', { content: 'x'.repeat(1000 * 1000) })).status).toBe(200);
  });

  it('refuses requests from a browser page or another host name', async () => {
    const server = await startServer(makeHandlers());
    const mount = server.mount(A);
    const body = '{}';
    const port = new URL(mount.url).port;
    const rebound = await raw(mount.url, { headers: jsonHeaders(mount.token, { host: `evil.example:${port}` }), body });
    const fromPage = await raw(mount.url, { headers: jsonHeaders(mount.token, { origin: 'http://evil.example' }), body });
    expect(rebound.status).toBe(403);
    expect(fromPage.status).toBe(403);
    const named = await raw(mount.url, { headers: jsonHeaders(mount.token, { host: `localhost:${port}` }), body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'x', version: '0' } } }) });
    expect(named.status).toBe(200);
  });

  it('ends the earlier token and MCP sessions when a session is mounted again', async () => {
    const server = await startServer(makeHandlers());
    const first = server.mount(A);
    const session = await rawSession(first);
    const second = server.mount(A);
    expect(second.token).not.toBe(first.token);
    expect((await session.call(1, 'report_to_root', { content: 'x' })).status).toBe(401);
    expect((await session.call(2, 'report_to_root', { content: 'x' }, undefined, second.token)).status).toBe(404);
  });
});

// Real loopback HTTP: the SDK client for the normal paths, raw requests for what a client would not send.
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Mock, afterEach, describe, expect, it, vi } from 'vitest';
import type { HandoffId, HandoffToolResult, SessionId } from '../../contracts';
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

const raw = (url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> =>
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
    const server = await startServer(handlers, { onCallMeta: (info) => metaKeys.push(info.metaKeys) });
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
    const handlers = makeHandlers({ report_to_root: vi.fn<McpToolHandlers['report_to_root']>(() => Promise.reject(new Error('db at C:/secret token=abc'))) });
    const log = vi.fn<(m: string) => void>();
    const server = await startServer(handlers, { log });
    const mount = server.mount(A);
    const { client } = await connect(mount);
    const answer = await client.callTool({ name: 'report_to_root', arguments: { content: 'x' } });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).not.toMatch(/secret|token=abc/);
    expect(log.mock.calls.join('\n')).not.toMatch(/secret|token=abc/);
    expect(log.mock.calls.join('\n')).not.toContain(mount.token);
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

// The GUI's local MCP server (T016; R-03, SP-05): streamable HTTP on 127.0.0.1 with a system-chosen port,
// shared by every Claude and Codex session. A session is identified only by its bearer token; each MCP
// session (`Mcp-Session-Id`) belongs to the very token that initialised it and is not found under any
// other, including the same session's later token. The SDK only speaks JSON-RPC here: authentication,
// identity, the request body, validation and deduplication are ours.
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpToolName, type SessionId } from '../../contracts';
import type { McpMount } from '../../core/ports';
import { CallRunner, sourceCallRefOf } from './calls';
import { SessionTokens, type TokenGrant, bearerToken } from './tokens';
import { type McpToolHandlers, toolListings } from './tools';

const MCP_PATH = '/mcp';
const SERVER_INFO = { name: 'agent-workflow-gui', version: '0.1.0' };

/** Builds the source call identity of a `tools/call` (CR2 §4); replaceable once a client's `_meta` is known. */
export type SourceCallRefOf = (
  meta: Record<string, unknown> | undefined,
  fallback: { mcpSessionId: string; requestId: string | number },
) => string;

export interface GuiMcpServerOptions {
  handlers: McpToolHandlers;
  /** Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** The GUI's own diagnostics: fixed categories and tool names only, never tokens, input or handler errors. */
  log?: (message: string) => void;
  /** Default `sourceCallRefOf` (`claudecode/toolUseId`, `callId`). */
  sourceCallRef?: SourceCallRefOf;
  /** Sees the `_meta` key names of every tool call (never the values), to learn what a client sends. */
  onCallMeta?: (info: { caller: SessionId; tool: string; metaKeys: string[] }) => void;
  /** Largest accepted POST body; larger ones get 413 and are never parsed. Default 1 MiB. */
  maxRequestBodyBytes?: number;
  /** MCP sessions kept per GUI session; the oldest is closed beyond this. Default 8. */
  maxMcpSessionsPerCaller?: number;
  /**
   * Tool calls kept on record per GUI session token (for resends); past this, new calls get an error and
   * nothing on record is forgotten. Default 10 000.
   */
  maxCallsPerCaller?: number;
  /** How long `close()` lets answered calls flush before dropping connections. Default 1000 ms. */
  closeGraceMs?: number;
}

/** One request whose JSON-RPC ID is taken in its MCP session. */
interface TakenId {
  /** The SDK has the request: from then on only the SDK ending it frees the ID, not the HTTP response. */
  dispatched: boolean;
}

interface McpSession {
  grant: TokenGrant;
  transport: StreamableHTTPServerTransport;
  server: Server;
  /**
   * JSON-RPC IDs (as JSON text) of the requests this MCP session has not finished. The SDK maps a
   * response to its HTTP stream by request ID, so a second request with a taken ID would receive the
   * first one's answer, or take its answer away; it is refused until the first has ended.
   */
  ids: Map<string, TakenId>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

export class GuiMcpServer {
  readonly #options: GuiMcpServerOptions;
  readonly #tokens = new SessionTokens();
  readonly #runner: CallRunner;
  /** Initialised MCP sessions by ID. */
  readonly #sessions = new Map<string, McpSession>();
  /** Opened for an initialize that has not finished; closed with the rest of their token's sessions. */
  readonly #opening = new Set<McpSession>();
  /** POSTs being answered, so `close()` can let their answers out first. */
  readonly #posts = new Set<ServerResponse>();
  readonly #http: HttpServer;
  #port = 0;
  #closing: Promise<void> | undefined;

  private constructor(options: GuiMcpServerOptions) {
    this.#options = options;
    this.#runner = new CallRunner({
      handlers: options.handlers,
      uuid: options.uuid ?? randomUUID,
      ...(options.log && { log: options.log }),
      ...(options.maxCallsPerCaller !== undefined && { maxCallsPerCaller: options.maxCallsPerCaller }),
    });
    this.#http = createServer((req, res) => void this.#handle(req, res));
  }

  /** Starts listening on 127.0.0.1 at a port the system picks. */
  static async start(options: GuiMcpServerOptions): Promise<GuiMcpServer> {
    const server = new GuiMcpServer(options);
    await new Promise<void>((resolve, reject) => {
      server.#http.once('error', reject);
      server.#http.listen(0, '127.0.0.1', () => {
        server.#http.off('error', reject);
        resolve();
      });
    });
    server.#port = (server.#http.address() as AddressInfo).port;
    return server;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}${MCP_PATH}`;
  }

  /** MCP sessions alive now, initialised or still initialising (diagnostics). */
  get openMcpSessions(): number {
    return this.#sessions.size + this.#opening.size;
  }

  /**
   * The mount for one session's start or resume (`StartSessionOptions.mcp`). Every call issues a new token
   * and ends the session's earlier token, its MCP sessions (open or still initialising) and its calls on
   * record. Never store or log the result (C-07).
   *
   * Known limit: after a resume (or a GUI restart) a resend of a call made before it is taken for a new
   * call and gets a new operationId. Only `retryOf` plus the store's deduplication by operationId keep it
   * from being accepted twice, until `DeliveryStore` can look a delivery up by `sourceCallRef` (T017 / the
   * next port version).
   */
  mount(sessionId: SessionId): McpMount {
    if (this.#closing) throw new Error('the GUI MCP server is closed');
    this.#endCaller(sessionId);
    return { url: this.url, token: this.#tokens.issue(sessionId) };
  }

  /** Ends a session's token, its MCP sessions and its calls on record, e.g. when it is closed. */
  revoke(sessionId: SessionId): void {
    this.#tokens.revoke(sessionId);
    this.#endCaller(sessionId);
  }

  /**
   * Stops accepting requests, answers every call in progress with `shutting-down`, lets those answers
   * out for up to `closeGraceMs`, then closes every MCP session and connection.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#runner.shutdown();
      const closed = new Promise<void>((resolve) => this.#http.close(() => resolve()));
      this.#http.closeIdleConnections();
      await this.#drainPosts(this.#options.closeGraceMs ?? 1000);
      await Promise.allSettled([...this.#sessions.values(), ...this.#opening].map(closeQuietly));
      this.#sessions.clear();
      this.#opening.clear();
      this.#tokens.clear();
      this.#http.closeAllConnections();
      await closed;
    })();
    return this.#closing;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (this.#closing) return reply(res, 503, 'shutting down');
      // Only this machine's loopback, never a page in a browser (DNS rebinding).
      const host = req.headers.host;
      if (host !== `127.0.0.1:${this.#port}` && host !== `localhost:${this.#port}`) return reply(res, 403, 'forbidden');
      if (req.headers.origin !== undefined) return reply(res, 403, 'forbidden');

      const grant = this.#tokens.resolve(bearerToken(req.headers.authorization));
      if (!grant) return unauthorized(res);
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== MCP_PATH) return reply(res, 404, 'not found');

      let body: unknown;
      if (req.method === 'POST') {
        const read = await readJsonBody(req, this.#options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY);
        if (read.kind === 'too-large') {
          res.setHeader('connection', 'close');
          return reply(res, 413, 'request body too large');
        }
        if (read.kind === 'invalid') return reply(res, 400, 'parse error', -32700);
        body = read.value;
        // The token may have been replaced, or the server closed, while the body arrived.
        if (this.#closing) return reply(res, 503, 'shutting down');
        if (!this.#tokens.isCurrent(grant)) return unauthorized(res);
      }
      // Before any transport is opened, so a refused batch leaves nothing behind.
      const ids = req.method === 'POST' ? requestIdsOf(body) : [];
      if (ids === 'duplicate') return reply(res, 400, 'duplicate request ID in batch', -32600);

      const sessionHeader = req.headers['mcp-session-id'];
      let session: McpSession | undefined;
      if (sessionHeader !== undefined) {
        session = typeof sessionHeader === 'string' ? this.#sessions.get(sessionHeader) : undefined;
        // Another token's MCP session ID is answered exactly like an unknown one.
        if (!session || !sameGrant(session.grant, grant)) return reply(res, 404, 'session not found', -32001);
      } else if (req.method === 'POST') {
        session = await this.#open(grant);
      } else {
        return reply(res, 400, 'missing session', -32000);
      }

      if (req.method === 'POST') {
        // A taken ID stays taken until the SDK has ended that request, whatever happened to its HTTP
        // response; the new request gets an error of its own instead of the old one's answer.
        const busy = ids.find((id) => session.ids.has(id));
        if (busy !== undefined) return reply(res, 409, 'a request with this ID is still being answered', -32600, JSON.parse(busy) as string | number);
        const taken = ids.map((id) => {
          const entry: TakenId = { dispatched: false };
          session.ids.set(id, entry);
          return [id, entry] as const;
        });
        this.#posts.add(res);
        res.once('close', () => {
          this.#posts.delete(res);
          // Never reached the SDK (refused or failed before dispatch): nothing else will free the ID.
          for (const [id, entry] of taken) if (!entry.dispatched) release(session, id, entry);
        });
      }
      await session.transport.handleRequest(req, res, body);
      // A first POST that was not an initialize leaves a transport without a session: drop it.
      if (session.transport.sessionId === undefined) {
        this.#opening.delete(session);
        await closeQuietly(session);
      }
    } catch {
      this.#options.log?.('[mcp] request-failed');
      if (!res.headersSent) reply(res, 500, 'internal error', -32603);
      else res.end();
    }
  }

  /** A new MCP session for `grant`; registered under its ID once the SDK has initialised it. */
  async #open(grant: TokenGrant): Promise<McpSession> {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize: this.#options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY,
      onsessioninitialized: (id) => {
        this.#opening.delete(session);
        if (!this.#tokens.isCurrent(grant)) {
          void closeQuietly(session);
          return;
        }
        this.#sessions.set(id, session);
        this.#limitSessions(grant.sessionId);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
      },
    });
    const ids = new Map<string, TakenId>();
    const server = this.#buildServer(grant.sessionId, (requestId) => {
      const key = JSON.stringify(requestId);
      const entry = ids.get(key);
      // After the SDK's own handling of the cancelled request, which sends nothing.
      if (entry) setImmediate(() => release(session, key, entry));
    });
    const session: McpSession = { grant, transport, server, ids };
    this.#opening.add(session);
    transport.onclose = () => {
      this.#opening.delete(session);
      if (transport.sessionId !== undefined) this.#sessions.delete(transport.sessionId);
    };
    await server.connect(transport);

    // Follow each request through the SDK: dispatched when the SDK receives it, ended when its response
    // has been sent (to its own stream, or to none when that stream is gone).
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      const key = requestKeyOf(message);
      const entry = key === undefined ? undefined : ids.get(key);
      if (entry) entry.dispatched = true;
      deliver?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      const key = responseKeyOf(message);
      const entry = key === undefined ? undefined : ids.get(key);
      try {
        await send(message, options);
      } finally {
        if (key !== undefined && entry) release(session, key, entry);
      }
    };
    return session;
  }

  /** `onCancelledEnd`: a call's handler ended after the client cancelled it, so the SDK will not answer it. */
  #buildServer(caller: SessionId, onCancelledEnd: (requestId: string | number) => void): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...toolListings] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      try {
        const { name, arguments: args, _meta: meta } = request.params;
        this.#options.onCallMeta?.({ caller, tool: name, metaKeys: Object.keys(meta ?? {}) });
        const tool = McpToolName.safeParse(name);
        if (!tool.success) return errorResult(`Unknown tool. The GUI tools are: ${McpToolName.options.join(', ')}.`);
        const sourceCallRefFn = this.#options.sourceCallRef ?? sourceCallRefOf;
        const sourceCallRef = sourceCallRefFn(meta, { mcpSessionId: extra.sessionId ?? '', requestId: extra.requestId });
        const outcome = await this.#runner.run(caller, tool.data, args, sourceCallRef, extra.signal);
        if (outcome.kind === 'failed') return errorResult('The GUI could not complete this call. Nothing more is known; do not resend it.');
        if (outcome.kind === 'refused') return errorResult('The GUI is keeping too many calls from this session and did not run this one.');
        return { content: [{ type: 'text', text: JSON.stringify(outcome.result) }], isError: outcome.result.status === 'rejected' };
      } finally {
        if (extra.signal.aborted) onCancelledEnd(extra.requestId);
      }
    });
    return server;
  }

  #limitSessions(caller: SessionId): void {
    const max = this.#options.maxMcpSessionsPerCaller ?? 8;
    const own = [...this.#sessions.values()].filter((s) => s.grant.sessionId === caller);
    for (const old of own.slice(0, Math.max(0, own.length - max))) void closeQuietly(old);
  }

  /** Closes every MCP session of `caller`, initialised or not, and drops its calls on record. */
  #endCaller(caller: SessionId): void {
    for (const session of [...this.#sessions.values(), ...this.#opening]) {
      if (session.grant.sessionId !== caller) continue;
      this.#opening.delete(session);
      void closeQuietly(session);
    }
    this.#runner.forget(caller);
  }

  async #drainPosts(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.#posts.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  }
}

const sameGrant = (a: TokenGrant, b: TokenGrant): boolean => a.sessionId === b.sessionId && a.generation === b.generation;

/** Frees an ID only for the request that took it, never for a later one with the same ID. */
const release = (session: McpSession, key: string, entry: TakenId): void => {
  if (session.ids.get(key) === entry) session.ids.delete(key);
};

const idKey = (id: unknown): string | undefined => (typeof id === 'string' || typeof id === 'number' ? JSON.stringify(id) : undefined);

/** The ID of a JSON-RPC request (not a notification or a response). */
const requestKeyOf = (message: unknown): string | undefined =>
  message !== null && typeof message === 'object' && 'method' in message && 'id' in message ? idKey(message.id) : undefined;

/** The ID of a JSON-RPC response or error response (not a request the server sends). */
const responseKeyOf = (message: unknown): string | undefined =>
  message !== null && typeof message === 'object' && !('method' in message) && 'id' in message && ('result' in message || 'error' in message)
    ? idKey(message.id)
    : undefined;

type BodyRead = { kind: 'ok'; value: unknown } | { kind: 'too-large' } | { kind: 'invalid' };

/** Reads a JSON body of at most `max` bytes; past that, stops collecting and discards the rest. */
const readJsonBody = (req: IncomingMessage, max: number): Promise<BodyRead> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return resolve({ kind: 'too-large' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.off('data', onData);
        req.resume();
        resolve({ kind: 'too-large' });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('error', reject);
    req.once('end', () => {
      if (size > max) return;
      try {
        // Strict: an invalid byte sequence is a parse error, never silently replaced before validation.
        resolve({ kind: 'ok', value: JSON.parse(strictUtf8.decode(Buffer.concat(chunks))) as unknown });
      } catch {
        resolve({ kind: 'invalid' });
      }
    });
  });

/** JSON text of the IDs of the requests in a message or batch; `duplicate` when a batch repeats one. */
const requestIdsOf = (body: unknown): string[] | 'duplicate' => {
  const messages = Array.isArray(body) ? (body as unknown[]) : [body];
  const ids = messages.map(requestKeyOf).filter((key) => key !== undefined);
  return new Set(ids).size === ids.length ? ids : 'duplicate';
};

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** A JSON-RPC error body with a fixed message; never anything from the request but its own ID. */
const reply = (res: ServerResponse, status: number, message: string, code = -32000, id: string | number | null = null): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }));
};

const unauthorized = (res: ServerResponse): void => {
  res.setHeader('WWW-Authenticate', 'Bearer');
  reply(res, 401, 'unauthorized');
};

const closeQuietly = async (session: McpSession): Promise<void> => {
  try {
    await session.transport.close();
  } catch {
    // Already closed.
  }
};

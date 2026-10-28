// The GUI's local MCP server (T016; R-03, SP-05): streamable HTTP on 127.0.0.1 with a system-chosen port,
// shared by every Claude and Codex session. A session is identified only by its bearer token; each MCP
// session (`Mcp-Session-Id`) belongs to the token that initialised it and is not found under any other.
// The SDK only speaks JSON-RPC here: authentication, identity, validation and deduplication are ours.
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpToolName, type SessionId } from '../../contracts';
import type { McpMount } from '../../core/ports';
import { CallRunner, sourceCallRefOf } from './calls';
import { SessionTokens, bearerToken } from './tokens';
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
  /** The GUI's own diagnostics. Lines never contain tokens, tool input or handler errors. */
  log?: (message: string) => void;
  /** Default `sourceCallRefOf` with `claudecode/toolUseId`. */
  sourceCallRef?: SourceCallRefOf;
  /** Sees the `_meta` key names of every tool call (never the values), to learn what a client sends. */
  onCallMeta?: (info: { caller: SessionId; tool: string; metaKeys: string[] }) => void;
  /** Largest accepted POST body; larger ones get 413 before any parsing. Default 1 MiB. */
  maxRequestBodyBytes?: number;
  /** MCP sessions kept per GUI session; the oldest is closed beyond this. Default 8. */
  maxMcpSessionsPerCaller?: number;
  /** How long `close()` lets answered calls flush before dropping connections. Default 1000 ms. */
  closeGraceMs?: number;
}

interface McpSession {
  caller: SessionId;
  transport: StreamableHTTPServerTransport;
  server: Server;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

export class GuiMcpServer {
  readonly #options: GuiMcpServerOptions;
  readonly #tokens = new SessionTokens();
  readonly #runner: CallRunner;
  readonly #sessions = new Map<string, McpSession>();
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

  /**
   * The mount for one session's start or resume (`StartSessionOptions.mcp`). Every call issues a new token
   * and ends the session's earlier token and MCP sessions. Never store or log the result (C-07).
   */
  mount(sessionId: SessionId): McpMount {
    if (this.#closing) throw new Error('the GUI MCP server is closed');
    this.#closeSessionsOf(sessionId);
    return { url: this.url, token: this.#tokens.issue(sessionId) };
  }

  /** Ends a session's token and its MCP sessions, e.g. when it is closed. */
  revoke(sessionId: SessionId): void {
    this.#tokens.revoke(sessionId);
    this.#closeSessionsOf(sessionId);
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
      await Promise.allSettled([...this.#sessions.values()].map((s) => s.transport.close()));
      this.#sessions.clear();
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

      const caller = this.#tokens.resolve(bearerToken(req.headers.authorization));
      if (!caller) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return reply(res, 401, 'unauthorized');
      }
      if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== MCP_PATH) return reply(res, 404, 'not found');

      const sessionHeader = req.headers['mcp-session-id'];
      let session: McpSession | undefined;
      if (sessionHeader !== undefined) {
        session = typeof sessionHeader === 'string' ? this.#sessions.get(sessionHeader) : undefined;
        // Another session's MCP session ID is answered exactly like an unknown one.
        if (!session || session.caller !== caller) return reply(res, 404, 'session not found', -32001);
      } else if (req.method === 'POST') {
        session = await this.#open(caller);
      } else {
        return reply(res, 400, 'missing session', -32000);
      }

      if (req.method === 'POST') {
        this.#posts.add(res);
        res.once('close', () => this.#posts.delete(res));
      }
      await session.transport.handleRequest(req, res);
      // A first POST that was not an initialize leaves a transport without a session: drop it.
      if (session.transport.sessionId === undefined) await closeQuietly(session);
    } catch (error) {
      this.#options.log?.(`[mcp] request failed: ${error instanceof Error ? error.name : 'non-error thrown'}`);
      if (!res.headersSent) reply(res, 500, 'internal error', -32603);
      else res.end();
    }
  }

  /** A new MCP session for `caller`; registered under its ID once the SDK has initialised it. */
  async #open(caller: SessionId): Promise<McpSession> {
    const server = this.#buildServer(caller);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize: this.#options.maxRequestBodyBytes ?? DEFAULT_MAX_BODY,
      onsessioninitialized: (id) => {
        this.#sessions.set(id, session);
        this.#limitSessions(caller);
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
      },
    });
    const session: McpSession = { caller, transport, server };
    transport.onclose = () => {
      if (transport.sessionId !== undefined) this.#sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return session;
  }

  #buildServer(caller: SessionId): Server {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...toolListings] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const { name, arguments: args, _meta: meta } = request.params;
      this.#options.onCallMeta?.({ caller, tool: name, metaKeys: Object.keys(meta ?? {}) });
      const tool = McpToolName.safeParse(name);
      if (!tool.success) return errorResult(`Unknown tool. The GUI tools are: ${McpToolName.options.join(', ')}.`);
      const sourceCallRefFn = this.#options.sourceCallRef ?? sourceCallRefOf;
      const sourceCallRef = sourceCallRefFn(meta, { mcpSessionId: extra.sessionId ?? '', requestId: extra.requestId });
      const outcome = await this.#runner.run(caller, tool.data, args, sourceCallRef, extra.signal);
      if (outcome.kind === 'failed') return errorResult('The GUI could not complete this call. Nothing more is known; try again later.');
      return { content: [{ type: 'text', text: JSON.stringify(outcome.result) }], isError: outcome.result.status === 'rejected' };
    });
    return server;
  }

  #limitSessions(caller: SessionId): void {
    const max = this.#options.maxMcpSessionsPerCaller ?? 8;
    const own = [...this.#sessions.values()].filter((s) => s.caller === caller);
    for (const old of own.slice(0, Math.max(0, own.length - max))) void closeQuietly(old);
  }

  #closeSessionsOf(caller: SessionId): void {
    for (const session of [...this.#sessions.values()]) if (session.caller === caller) void closeQuietly(session);
  }

  async #drainPosts(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.#posts.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  }
}

const errorResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** A JSON-RPC error body with a fixed message; never anything from the request. */
const reply = (res: ServerResponse, status: number, message: string, code = -32000): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
};

const closeQuietly = async (session: McpSession): Promise<void> => {
  try {
    await session.transport.close();
  } catch {
    // Already closed.
  }
};

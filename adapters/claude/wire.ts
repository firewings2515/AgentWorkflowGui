// The part of `@anthropic-ai/claude-agent-sdk` 0.3.309 this adapter uses, as structural types. The
// adapter depends on this interface, not on the package, so tests can plug in a fake SDK and recorded
// SDK messages; `sdk.ts` binds the real package to it. SDK messages are read as untrusted data and
// narrowed field by field (see mapping.ts), so only the fields the adapter relies on are listed.

/** `SDKMessageOrigin` subset the adapter may stamp on a dispatched user message (R-03, SP-05). */
export type WireOrigin = { kind: 'human' } | { kind: 'peer'; from: string; fromMode?: 'bypass' | 'prompting'; name?: string };

/** The SDK types message uuids as five dash-separated parts. */
export type WireUuid = `${string}-${string}-${string}-${string}-${string}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isWireUuid = (s: string): s is WireUuid => UUID.test(s);

/** MCP servers the GUI mounts per session (R-03): the local HTTP server, or a stdio command. */
export type WireMcpServer =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; alwaysLoad?: boolean }
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; alwaysLoad?: boolean };

/** `SDKUserMessage` as the adapter writes it into the streaming input. */
export interface WireUserMessage {
  type: 'user';
  /** Client-chosen UUID; echoed as `user_message_uuid(s)` and stored as the transcript entry's uuid (CR2 §4). */
  uuid: WireUuid;
  session_id: string;
  parent_tool_use_id: null;
  message: { role: 'user'; content: string };
  origin?: WireOrigin;
}

export type WireEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface WireHookOutput {
  continue?: boolean;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/** `HookCallback`: the input is narrowed by the adapter (PreToolUseHookInput). */
export type WireHookCallback = (input: unknown, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<WireHookOutput>;

/** The `Options` the adapter sets. Everything else keeps the SDK default. */
export interface WireQueryOptions {
  cwd: string;
  sessionId?: string;
  resume?: string;
  model?: string;
  effort?: WireEffort;
  systemPrompt?: { type: 'preset'; preset: 'claude_code'; append?: string };
  /** Empty: no user/project/local settings files, so the GUI controls the whole session. */
  settingSources: [];
  /** `disableClaudeAiConnectors`: account-level connectors are not covered by settingSources (SP-04). */
  settings: { disableClaudeAiConnectors: true };
  strictMcpConfig: true;
  mcpServers?: Record<string, WireMcpServer>;
  /** R-08: every tool runs without the CLI asking; the PreToolUse hook hands each call to the GUI. */
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  disallowedTools?: string[];
  hooks: { PreToolUse: { hooks: WireHookCallback[]; timeout?: number }[] };
  includePartialMessages: true;
  /** Reliable recovery needs the transcript (CR2_DELIVERY_FIX §4). */
  persistSession: true;
  stderr?: (data: string) => void;
}

export interface WireModelInfo {
  value: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

/** `Query`: an async stream of SDK messages plus control requests. */
export interface WireQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: WireEffort | null }): Promise<void>;
  supportedModels(): Promise<WireModelInfo[]>;
  stopTask(taskId: string): Promise<void>;
  /** Resolves once the CLI answered the initialize request (process up, options accepted). */
  initializationResult(): Promise<unknown>;
}

/** `SessionMessage` from the stored transcript; `timestamp` and `origin` are present at runtime but not typed by the SDK. */
export interface WireSessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id?: string | null;
  timestamp?: string;
  origin?: unknown;
}

/** Stored sessions are kept per cwd, so every read names the session's cwd (SP-01, CR2_DELIVERY_FIX §4). */
export interface WireReadOptions {
  dir: string;
}

export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<WireUserMessage>; options: WireQueryOptions }): WireQuery;
  /** Empty when the session is not found under `dir`. */
  getSessionMessages(sessionId: string, options: WireReadOptions & { includeSystemMessages?: boolean }): Promise<WireSessionMessage[]>;
  listSubagents(sessionId: string, options: WireReadOptions): Promise<string[]>;
  getSubagentMessages(sessionId: string, agentId: string, options: WireReadOptions): Promise<WireSessionMessage[]>;
}

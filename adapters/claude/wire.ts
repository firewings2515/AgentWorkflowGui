// The part of `@anthropic-ai/claude-agent-sdk` 0.3.309 this adapter uses, as structural types. The
// adapter depends on this interface, not on the package, so tests can plug in a fake SDK and recorded
// SDK messages; `sdk.ts` binds the real package to it. SDK messages are read as untrusted data and
// narrowed field by field (see mapping.ts), so only the fields the adapter relies on are listed.
import type { Readable, Writable } from 'node:stream';

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
  /** claude.exe's whole environment (the SDK's default is process.env); `${NAME}` in MCP headers reads it. */
  env?: Record<string, string | undefined>;
  /** R-08: every tool runs without the CLI asking; the PreToolUse hook hands each call to the GUI. */
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  disallowedTools?: string[];
  hooks: { PreToolUse: { hooks: WireHookCallback[]; timeout?: number }[] };
  includePartialMessages: true;
  /** Reliable recovery needs the transcript (CR2_DELIVERY_FIX §4). */
  persistSession: true;
  stderr?: (data: string) => void;
  /** The Claude Code to start: the user's own install (T045). The SDK's built-in executable when absent. */
  pathToClaudeCodeExecutable?: string;
  /** Starts claude.exe; the GUI puts it in the session's Job (T013, R-14). */
  spawnClaudeCodeProcess?: (options: WireSpawnOptions) => WireSpawnedProcess;
}

/** What the SDK hands `spawnClaudeCodeProcess` (its `SpawnOptions`). */
export interface WireSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /** Aborts only after the SDK's stdin-EOF grace period. */
  signal: AbortSignal;
}

/** The process the SDK talks to (its `SpawnedProcess`). */
export interface WireSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
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

/**
 * `SessionMessage` from the stored transcript, after the SDK rebuilt the conversation chain. The SDK
 * keeps one entry per uuid (later lines replace earlier ones) and drops line fields such as `subtype`,
 * so duplicates and compaction boundaries cannot be seen here; see `WireTranscriptEntry`.
 * `timestamp`, `origin` and the flags below are present at runtime but not typed by the SDK.
 */
export interface WireSessionMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id?: string | null;
  timestamp?: string;
  origin?: unknown;
  /** The summary prompt a compaction wrote in place of the earlier conversation. */
  isCompactSummary?: boolean;
  /** A prompt the CLI took in while a turn was running (stored as a queued-command attachment). */
  isQueuedCommand?: boolean;
  is_meta?: boolean;
}

/**
 * One line of the stored transcript as written (JSONL), not deduplicated and with all its fields.
 * Read through the SDK's `importSessionToStore`; used where the chain view hides facts (CR-2).
 */
export interface WireTranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  [field: string]: unknown;
}

/**
 * The raw lines that could be read. `complete: false` when the file holds more than was read (a line
 * the SDK skipped because it does not parse: truncated by a crash, damaged) or changed while reading;
 * such a read proves neither absence nor uniqueness (CR-2).
 */
export interface WireTranscript {
  lines: WireTranscriptEntry[];
  complete: boolean;
  detail?: string;
}

/**
 * Stored sessions are kept per project folder. The SDK finds a session under `dir` and also under
 * other git worktrees of the same repository (SP-07), so a successful read does not prove `dir` is the
 * folder the session ran in; the adapter checks the transcript's own `cwd` where that matters (R-06).
 */
export interface WireReadOptions {
  dir: string;
}

export interface ClaudeSdk {
  query(params: { prompt: AsyncIterable<WireUserMessage>; options: WireQueryOptions }): WireQuery;
  /** Empty when the session is not found. */
  getSessionMessages(sessionId: string, options: WireReadOptions & { includeSystemMessages?: boolean }): Promise<WireSessionMessage[]>;
  listSubagents(sessionId: string, options: WireReadOptions): Promise<string[]>;
  getSubagentMessages(sessionId: string, agentId: string, options: WireReadOptions): Promise<WireSessionMessage[]>;
  /** The main transcript's lines in file order; empty (and complete) when the session is not found. */
  readTranscript(sessionId: string, options: WireReadOptions): Promise<WireTranscript>;
}

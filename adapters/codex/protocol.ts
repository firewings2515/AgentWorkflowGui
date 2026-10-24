// The subset of the Codex app-server 0.160.0 wire protocol this adapter uses. Shapes follow the
// generated types kept with the spike (spike/sp01/codex-protocol/v2); only fields we read are listed,
// and every value from the wire is still treated as untrusted at runtime.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-RPC id; Codex server requests start at 0, so never test it for truthiness. */
export type RpcId = number | string;

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface WireThread {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  model: string | null;
  reasoningEffort: string | null;
  status: { type: string };
  path: string | null;
  cwd: string;
  turns: WireTurn[];
}

export interface WireThreadStartResponse {
  thread: WireThread;
  model: string;
  reasoningEffort: string | null;
}

export interface WireTurnError {
  message: string;
}

export type WireTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface WireTurn {
  id: string;
  items: WireItem[];
  status: WireTurnStatus;
  error: WireTurnError | null;
  /** Unix seconds. */
  startedAt: number | null;
  /** Unix seconds. */
  completedAt: number | null;
}

export type WireUserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'localImage'; path: string }
  | { type: 'mention'; name: string; path: string }
  | { type: string; [key: string]: unknown };

export type WireItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

export type WireItem =
  | { type: 'userMessage'; id: string; clientId: string | null; content: WireUserInput[] }
  | { type: 'agentMessage'; id: string; text: string; phase: string | null }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      processId: string | null;
      status: WireItemStatus;
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: { path: string; kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }; diff: string }[];
      status: WireItemStatus;
    }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: WireItemStatus; arguments: JsonValue }
  | { type: 'dynamicToolCall'; id: string; namespace: string | null; tool: string; status: WireItemStatus; arguments: JsonValue }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'subAgentActivity'; id: string; kind: 'started' | 'interacted' | 'interrupted' | 'completed'; agentThreadId: string; agentPath: string }
  | { type: 'other'; id: string };

export interface WireThreadItemEntry {
  turnId: string;
  item: WireItem;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface WirePage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface WireTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface WireTokenUsage {
  total: WireTokenUsageBreakdown;
  last: WireTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface WireRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface WireModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

/** `item/permissions/requestApproval` asks for these; the answer grants a subset (we grant all or nothing). */
export interface WirePermissionProfile {
  network: { enabled: boolean | null } | null;
  fileSystem: { read: string[] | null; write: string[] | null; [key: string]: unknown } | null;
}

/** Server requests that reach the permission callback. */
export const PERMISSION_METHODS = {
  command: 'item/commandExecution/requestApproval',
  fileChange: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
  mcpElicitation: 'mcpServer/elicitation/request',
} as const;

/**
 * R-08 thread settings: every command and patch is asked for (`untrusted`), answered by the GUI
 * (`approvalsReviewer: user`), writes stay inside the worktree (OS sandbox), and history is persisted
 * (CR-2 reconciliation needs it, so never ephemeral).
 */
export const THREAD_POLICY = {
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  ephemeral: false,
} as const;

/** SP-04 isolation: no user-level MCP servers, apps or plugins on our threads. Callers cannot override these. */
export const ISOLATION_CONFIG: Readonly<Record<string, JsonValue>> = {
  'mcp_servers.node_repl.enabled': false,
  'features.apps': false,
  'features.plugins': false,
};

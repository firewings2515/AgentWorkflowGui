// Normalized turn items and permission requests that adapters emit (T003). Vendor event shapes stay
// inside the adapters; these are the GUI-side forms.
import { z } from 'zod';
import { EscalationId, ItemId, NativeTaskId, PermissionRequestId, SessionId, Timestamp, TurnId } from './common';
import { ruleIssue } from './rules';

const itemShape = {
  id: ItemId,
  sessionId: SessionId,
  turnId: TurnId.optional(),
  /** Set when a native sub-agent produced the item (R-13). */
  nativeTaskId: NativeTaskId.optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
};

const ended = (open: readonly string[]) => (i: { state: string; endedAt?: string | undefined }) => open.includes(i.state) === (i.endedAt === undefined);

/** A shell command the agent ran (Codex commandExecution, Claude Bash). */
export const CommandItem = z
  .strictObject({
    ...itemShape,
    kind: z.literal('command'),
    command: z.string().min(1),
    cwd: z.string().min(1),
    state: z.enum(['running', 'completed', 'failed', 'declined', 'interrupted']),
    exitCode: z.number().int().optional(),
    /**
     * Runtime's own handle for the command's process (Codex `processId`), used to stop exactly this
     * command without touching other sessions on the same host (CR-7). Not an OS PID.
     */
    nativeProcessRef: z.string().min(1).optional(),
    /**
     * Runs in the background (Claude `run_in_background`, Codex background terminal): it can outlive its
     * turn, so file locks wait for it (R-07). Adapters send `item.updated` when it starts and when it ends;
     * a background command whose end the runtime cannot report stays `running` until the session closes.
     */
    background: z.boolean().optional(),
    /** Aggregated output; may be cut to the tail, see `outputTruncated`. */
    output: z.string().default(''),
    outputTruncated: z.boolean().default(false),
  })
  .refine(ended(['running']), ruleIssue('item.ended-at'));

/** A file edit (Codex fileChange, Claude Edit/Write). `proposed` waits for a permission answer (R-07). */
export const FileChangeItem = z
  .strictObject({
    ...itemShape,
    kind: z.literal('fileChange'),
    changes: z
      .array(z.strictObject({ path: z.string().min(1), change: z.enum(['add', 'update', 'delete']), movePath: z.string().min(1).optional() }))
      .min(1),
    state: z.enum(['proposed', 'applied', 'declined', 'failed']),
    diff: z.string().optional(),
  })
  .refine(ended(['proposed']), ruleIssue('item.ended-at'));

/** Any other tool call (MCP tools including the GUI's own, web search, ...). */
export const ToolCallItem = z
  .strictObject({
    ...itemShape,
    kind: z.literal('toolCall'),
    tool: z.string().min(1),
    server: z.string().min(1).optional(),
    summary: z.string(),
    state: z.enum(['running', 'completed', 'failed', 'declined']),
  })
  .refine(ended(['running']), ruleIssue('item.ended-at'));

export const SessionItem = z.discriminatedUnion('kind', [CommandItem, FileChangeItem, ToolCallItem]);
export type SessionItem = z.infer<typeof SessionItem>;

export const PermissionKind = z.enum(['command', 'fileChange', 'permissions', 'mcpElicitation']);

/**
 * Why an answer is deliberately held back. `file-lock`: the Codex file-change request waits for a lock
 * to free, with a deadline (R-07). `awaiting-user`: escalated to root for the user (R-05, R-08).
 */
export const PermissionHold = z
  .strictObject({
    reason: z.enum(['file-lock', 'awaiting-user']),
    until: Timestamp.optional(),
    lockPath: z.string().min(1).optional(),
    escalationId: EscalationId.optional(),
  })
  .refine((h) => h.reason !== 'file-lock' || (h.until !== undefined && h.lockPath !== undefined), ruleIssue('hold.lock-needs-deadline'))
  .refine((h) => h.reason !== 'awaiting-user' || h.escalationId !== undefined, ruleIssue('hold.user-needs-escalation'));

/** Who answered: the auto-approve policy, or the user on the root screen. An agent can never approve (R-05). */
export const PermissionDecision = z
  .strictObject({
    outcome: z.enum(['approve', 'approve-for-session', 'decline', 'cancel']),
    decidedBy: z.enum(['policy', 'user']),
    escalationId: EscalationId.optional(),
    reason: z.string().optional(),
    /** Form answers for an accepted MCP elicitation, matching its `requestedSchema`. */
    content: z.json().optional(),
    at: Timestamp,
  })
  .refine((d) => (d.decidedBy === 'user') === (d.escalationId !== undefined), ruleIssue('decision.user-needs-escalation'))
  .refine((d) => d.content === undefined || d.outcome === 'approve', ruleIssue('decision.content-only-on-approve'));

/**
 * What an MCP server asks the user for (MCP elicitation). `form`: fields described by a JSON schema
 * (passed through as data); `url`: open a page and confirm. The answer goes in `PermissionDecision.content`.
 */
export const McpElicitation = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('form'), serverName: z.string().min(1), message: z.string(), requestedSchema: z.json() }),
  z.strictObject({ mode: z.literal('url'), serverName: z.string().min(1), message: z.string(), url: z.url(), elicitationId: z.string().min(1) }),
]);

/**
 * A runtime approval request handed to the GUI (Codex server requests, Claude PreToolUse hook). The
 * adapter may hold the answer (`held`) instead of replying at once. `withdrawn`: the runtime resolved or
 * dropped it (e.g. turn ended).
 */
export const PermissionRequest = z
  .strictObject({
    id: PermissionRequestId,
    sessionId: SessionId,
    turnId: TurnId.optional(),
    itemId: ItemId.optional(),
    nativeTaskId: NativeTaskId.optional(),
    kind: PermissionKind,
    /**
     * The runtime's own tool name when it has one (Claude `tool_name`, e.g. `Read`, `mcp__gui__handoff`), so
     * the policy and the GUI's own-tool check never parse `summary` (C-04). Codex requests have none.
     */
    tool: z.string().min(1).optional(),
    /** The MCP server the request is about: Claude `mcp__<server>__<tool>`, Codex elicitation `serverName`. */
    server: z.string().min(1).optional(),
    /**
     * The shell `command` runs in when the runtime says so (Claude `Bash` → bash, `PowerShell` → powershell).
     * Absent when unknown; the policy then reads the command both ways (T014).
     */
    shell: z.enum(['bash', 'powershell']).optional(),
    summary: z.string().min(1),
    command: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).default([]),
    /** Escalation-list rule that matched (R-08); absent when the policy allowed it. */
    matchedRule: z.string().min(1).optional(),
    elicitation: McpElicitation.optional(),
    state: z.enum(['pending', 'held', 'answered', 'withdrawn']),
    hold: PermissionHold.optional(),
    decision: PermissionDecision.optional(),
    createdAt: Timestamp,
  })
  .refine((p) => (p.state === 'held') === (p.hold !== undefined), ruleIssue('permission.hold-when-held'))
  .refine((p) => (p.state === 'answered') === (p.decision !== undefined), ruleIssue('permission.decision-when-answered'))
  .refine((p) => (p.kind === 'mcpElicitation') === (p.elicitation !== undefined), ruleIssue('permission.elicitation-kind'))
  .refine((p) => p.elicitation === undefined || p.server === p.elicitation.serverName, ruleIssue('permission.elicitation-server'))
  .refine((p) => p.shell === undefined || p.kind === 'command', ruleIssue('permission.shell-only-command'))
  .refine((p) => p.decision?.content === undefined || p.kind === 'mcpElicitation', ruleIssue('permission.content-only-elicitation'))
  .refine((p) => p.decision?.outcome !== 'approve-for-session' || p.kind !== 'mcpElicitation', ruleIssue('permission.elicitation-once'));
export type PermissionRequest = z.infer<typeof PermissionRequest>;

// Inferred types for schemas that are not typed next to their definition.
export type CommandItem = z.infer<typeof CommandItem>;
export type FileChangeItem = z.infer<typeof FileChangeItem>;
export type ToolCallItem = z.infer<typeof ToolCallItem>;
export type PermissionKind = z.infer<typeof PermissionKind>;
export type PermissionHold = z.infer<typeof PermissionHold>;
export type PermissionDecision = z.infer<typeof PermissionDecision>;
export type McpElicitation = z.infer<typeof McpElicitation>;

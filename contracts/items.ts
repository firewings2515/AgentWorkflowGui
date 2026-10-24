// Normalized turn items and permission requests that adapters emit (T003). Vendor event shapes stay
// inside the adapters; these are the GUI-side forms.
import { z } from 'zod';
import { EscalationId, ItemId, NativeTaskId, PermissionRequestId, SessionId, Timestamp, TurnId } from './common';

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
const endedMessage = { message: 'endedAt is set exactly when the item is finished' };

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
    /** Aggregated output; may be cut to the tail, see `outputTruncated`. */
    output: z.string().default(''),
    outputTruncated: z.boolean().default(false),
  })
  .refine(ended(['running']), endedMessage);

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
  .refine(ended(['proposed']), endedMessage);

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
  .refine(ended(['running']), endedMessage);

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
  .refine((h) => h.reason !== 'file-lock' || (h.until !== undefined && h.lockPath !== undefined), { message: 'a lock hold needs a deadline and a path' })
  .refine((h) => h.reason !== 'awaiting-user' || h.escalationId !== undefined, { message: 'a user hold points at its escalation' });

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
  .refine((d) => (d.decidedBy === 'user') === (d.escalationId !== undefined), { message: 'user decisions come from an escalation' })
  .refine((d) => d.content === undefined || d.outcome === 'approve', { message: 'only an accepted elicitation carries content' });

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
  .refine((p) => (p.state === 'held') === (p.hold !== undefined), { message: 'hold is set exactly when held' })
  .refine((p) => (p.state === 'answered') === (p.decision !== undefined), { message: 'decision is set exactly when answered' })
  .refine((p) => (p.kind === 'mcpElicitation') === (p.elicitation !== undefined), { message: 'elicitation is set exactly for MCP elicitations' })
  .refine((p) => p.decision?.content === undefined || p.kind === 'mcpElicitation', { message: 'only elicitation answers carry content' })
  .refine((p) => p.decision?.outcome !== 'approve-for-session' || p.kind !== 'mcpElicitation', { message: 'an elicitation is answered once' });
export type PermissionRequest = z.infer<typeof PermissionRequest>;

// Inferred types for schemas that are not typed next to their definition.
export type CommandItem = z.infer<typeof CommandItem>;
export type FileChangeItem = z.infer<typeof FileChangeItem>;
export type ToolCallItem = z.infer<typeof ToolCallItem>;
export type PermissionKind = z.infer<typeof PermissionKind>;
export type PermissionHold = z.infer<typeof PermissionHold>;
export type PermissionDecision = z.infer<typeof PermissionDecision>;
export type McpElicitation = z.infer<typeof McpElicitation>;

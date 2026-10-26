// Tools of the GUI's local MCP server (R-03, C-10), mounted on every Claude and Codex session. The caller
// is identified by the session's token, never by anything in the input. Results say what the GUI did;
// they never carry another session's content.
import { z } from 'zod';
import { EscalationId, HandoffId, OperationId, PeerMessageId, SessionId, TaskId } from './common';
import { DeliveryState } from './delivery';
import { addRuleIssue } from './rules';
import { OutputTarget } from './workflow';

/** Why the GUI refused a tool call; the agent may correct and call again. */
export const McpRejection = z.strictObject({
  reason: z.enum([
    'not-connected', // the target node has no edge from the caller's node (R-04)
    'no-matching-rule', // no output rule of the caller's node fits
    'dependency-unmet', // the task's dependencies are not merged yet (R-06)
    'unknown-target', // no such session, node or task
    'not-in-workflow', // a workflow tool called from an ordinary session
    'invalid-input',
    'shutting-down',
  ]),
  detail: z.string(),
});
export type McpRejection = z.infer<typeof McpRejection>;

/**
 * A new tool call that retries an earlier one names the operation it retries (CR2_DELIVERY_FIX §4); the GUI
 * never guesses a retry from equal content, and accepts it only for an operation the same session created.
 * A resend of the same call is recognised by its native call ID instead and needs nothing here.
 */
const retryOf = OperationId.optional();

/** `handoff(ruleId, target, content, taskId)`: a formal handoff to another node or to root (R-04). */
export const HandoffToolInput = z.strictObject({
  ruleId: z.string().min(1),
  target: OutputTarget,
  content: z.string().min(1),
  /** Absent only for the root session, which has no task. */
  taskId: TaskId.optional(),
  retryOf,
});
export type HandoffToolInput = z.infer<typeof HandoffToolInput>;

/**
 * `accepted`: recorded and counted once (R-04 step 3). `duplicate`: a resend of the same tool call, or a
 * `retryOf` with the same payload, target and revision, mapped to the operation it already created
 * (CR2 §4); a `retryOf` that changes any of them is `rejected` as `invalid-input`. `escalated`: over a
 * limit or needing the user (R-05).
 */
export const HandoffToolResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), handoffId: HandoffId, operationId: OperationId, delivery: DeliveryState }),
  z.strictObject({ status: z.literal('duplicate'), handoffId: HandoffId, operationId: OperationId, delivery: DeliveryState }),
  z.strictObject({ status: z.literal('escalated'), escalationId: EscalationId, reason: z.enum(['limit-exceeded', 'needs-confirmation']) }),
  z.strictObject({ status: z.literal('rejected'), rejection: McpRejection }),
]);
export type HandoffToolResult = z.infer<typeof HandoffToolResult>;

/** `create_tasks(tasks[], dependsOn)`: root splits the work into tasks (R-06). Keys name tasks within this call. */
export const CreateTasksToolInput = z
  .strictObject({
    tasks: z
      .array(
        z.strictObject({
          key: z.string().min(1),
          title: z.string().min(1),
          /** Keys of other tasks in this call. */
          dependsOn: z.array(z.string().min(1)).default([]),
          /** Tasks that already exist in the instance. */
          dependsOnExisting: z.array(TaskId).default([]),
        }),
      )
      .min(1),
  })
  .superRefine((input, ctx) => {
    const keys = new Set(input.tasks.map((t) => t.key));
    if (keys.size !== input.tasks.length) addRuleIssue(ctx, 'mcp.create-tasks-ids-unique', ['tasks']);
    input.tasks.forEach((t, i) => {
      if (t.dependsOn.some((d) => d === t.key || !keys.has(d))) addRuleIssue(ctx, 'mcp.create-tasks-dependency', ['tasks', i, 'dependsOn']);
    });
  });
export type CreateTasksToolInput = z.infer<typeof CreateTasksToolInput>;

/** The built-in template asks the user first (O-07), so `awaiting-confirmation` is the default answer. */
export const CreateTasksToolResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('created'), tasks: z.array(z.strictObject({ key: z.string().min(1), taskId: TaskId })) }),
  z.strictObject({ status: z.literal('awaiting-confirmation'), escalationId: EscalationId }),
  z.strictObject({ status: z.literal('rejected'), rejection: McpRejection }),
]);
export type CreateTasksToolResult = z.infer<typeof CreateTasksToolResult>;

/** `send_message(to, content)` to another GUI session, same tool or cross-tool (R-03). */
export const SendMessageToolInput = z.strictObject({ to: SessionId, content: z.string().min(1), retryOf });
export type SendMessageToolInput = z.infer<typeof SendMessageToolInput>;

/** Cross-tool sends outside the caller's instance need the user's confirmation first (R-11). */
export const SendMessageToolResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), peerMessageId: PeerMessageId, operationId: OperationId, delivery: DeliveryState }),
  z.strictObject({ status: z.literal('duplicate'), peerMessageId: PeerMessageId, operationId: OperationId, delivery: DeliveryState }),
  z.strictObject({ status: z.literal('awaiting-confirmation'), escalationId: EscalationId }),
  z.strictObject({ status: z.literal('rejected'), rejection: McpRejection }),
]);
export type SendMessageToolResult = z.infer<typeof SendMessageToolResult>;

/** `report_to_root(content)`: progress or a request for the user's confirmation (R-05). */
export const ReportToRootToolInput = z.strictObject({ content: z.string().min(1), needsUserConfirmation: z.boolean().default(false) });
export type ReportToRootToolInput = z.infer<typeof ReportToRootToolInput>;

export const ReportToRootToolResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('reported'), escalationId: EscalationId.optional() }),
  z.strictObject({ status: z.literal('rejected'), rejection: McpRejection }),
]);
export type ReportToRootToolResult = z.infer<typeof ReportToRootToolResult>;

/** `wait_for_file(path)` in same-folder mode (R-07): returns once the lock is free or the wait times out. */
export const WaitForFileToolInput = z.strictObject({ path: z.string().min(1), timeoutMs: z.number().int().positive().max(600_000).optional() });
export type WaitForFileToolInput = z.infer<typeof WaitForFileToolInput>;

export const WaitForFileToolResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('free') }),
  z.strictObject({ status: z.literal('not-locked') }),
  /** Still locked; the escalation is open when the wait was escalated to root (R-07). */
  z.strictObject({ status: z.literal('timeout'), escalationId: EscalationId.optional() }),
  z.strictObject({ status: z.literal('rejected'), rejection: McpRejection }),
]);
export type WaitForFileToolResult = z.infer<typeof WaitForFileToolResult>;

/** Tool names as the agents see them. */
export const McpToolName = z.enum(['handoff', 'create_tasks', 'send_message', 'report_to_root', 'wait_for_file']);
export type McpToolName = z.infer<typeof McpToolName>;

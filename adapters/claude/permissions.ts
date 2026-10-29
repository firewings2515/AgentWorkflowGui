// PreToolUse hook input → PermissionRequest, and the GUI's answer → hook output (R-07, R-08). The
// adapter does not judge the escalation list; it only translates. Every tool call goes through here,
// because under `bypassPermissions` the hook is the only point that sees cwd-internal reads (SP-04).
import { type PermissionDecision, PermissionRequest, type PermissionRequestId, type Timestamp } from '../../contracts';
import { COMMAND_TOOLS, FILE_TOOLS, isNonEmptyString, isObject, opt, type Placement, placed, splitMcpName, str, toolPaths, toolSummary } from './mapping';
import type { WireHookOutput } from './wire';

export interface PreToolUse {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  cwd?: string;
  /** Set when a native sub-agent made the call (equals its `task_id`). */
  agentId?: string;
}

/** Narrows the hook input; returns why it cannot be used otherwise. */
export const parsePreToolUse = (input: unknown, toolUseIdArg: string | undefined): PreToolUse | string => {
  if (!isObject(input)) return 'hook input is not an object';
  if (input.hook_event_name !== 'PreToolUse') return `unexpected hook event ${String(input.hook_event_name)}`;
  if (!isNonEmptyString(input.tool_name)) return 'tool_name is missing';
  const toolUseId = isNonEmptyString(input.tool_use_id) ? input.tool_use_id : toolUseIdArg;
  if (!isNonEmptyString(toolUseId)) return 'tool_use_id is missing';
  return {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolUseId,
    ...opt('cwd', isNonEmptyString(input.cwd) ? input.cwd : undefined),
    ...opt('agentId', isNonEmptyString(input.agent_id) ? input.agent_id : undefined),
  };
};

/**
 * Shell tools are `command`, edit tools `fileChange`. Every other tool (Read, Grep, MCP tools, ...) is a
 * generic tool permission: contracts have no tool-call kind, so `permissions` is used for them.
 */
export const permissionKindOfTool = (toolName: string): PermissionRequest['kind'] =>
  COMMAND_TOOLS.includes(toolName) ? 'command' : FILE_TOOLS.includes(toolName) ? 'fileChange' : 'permissions';

export const buildPermissionRequest = (call: PreToolUse, ctx: { id: PermissionRequestId; placement: Placement; createdAt: Timestamp }): PermissionRequest => {
  const input = isObject(call.toolInput) ? call.toolInput : {};
  const kind = permissionKindOfTool(call.toolName);
  return PermissionRequest.parse({
    id: ctx.id,
    ...placed(ctx.placement),
    itemId: call.toolUseId,
    kind,
    // C-04: the tool, its MCP server and the shell, as fields; nothing above parses the summary.
    tool: call.toolName,
    ...opt('server', splitMcpName(call.toolName).server),
    ...opt('shell', call.toolName === 'Bash' ? 'bash' : call.toolName === 'PowerShell' ? 'powershell' : undefined),
    summary: toolSummary(call.toolName, input) || call.toolName,
    ...opt('command', kind === 'command' && isNonEmptyString(input.command) ? input.command : undefined),
    ...opt('cwd', call.cwd),
    paths: toolPaths(input),
    state: 'pending',
    createdAt: ctx.createdAt,
  });
};

/**
 * Hook output for an answer. Claude has no per-session grant through the hook, so `approve-for-session`
 * allows this call only; remembering it is the layer above's job. `cancel` denies and stops the agent
 * loop, like Codex's cancel ends the turn.
 */
export const decisionToHookOutput = (decision: PermissionDecision): WireHookOutput => {
  const allow = decision.outcome === 'approve' || decision.outcome === 'approve-for-session';
  const reason = str(decision.reason) ?? (allow ? 'approved by AgentWorkflowGui' : 'declined by AgentWorkflowGui');
  return {
    ...(decision.outcome === 'cancel' && { continue: false, stopReason: reason }),
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: reason },
  };
};

/** Fail-closed answer when no valid decision exists (handler failed, request withdrawn, input unusable). */
export const denyOutput = (reason: string): WireHookOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

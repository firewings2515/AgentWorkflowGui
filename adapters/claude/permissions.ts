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

// A glob segment that matches more than its own text (`*`, `?`, `[a]`, `{a,b}`, extglobs).
const GLOB_SEGMENT = /[*?[\]{}()!+@]/;
// A wildcard segment made only of dots and wildcards (`.*`, `[.][.]`) may match `.` or `..` in some globbers.
const DOTS_ONLY = /^[.*?[\]]*\.[.*?[\]]*$/;
// What a search may not start from: nothing, a root, a drive, the home folder, a bare UNC server or share.
const ROOT = /^(\/*|[a-z]:\/*|~\/*|\/\/[^/]*(\/[^/]*)?\/*)$/i;
// `{a,b}` alternatives past this many are not placed one by one.
const MAX_EXPANSIONS = 64;

/** `{a,b}` groups expanded, as the tool does before it matches; undefined when unbalanced or too many. */
const expandBraces = (text: string): string[] | undefined => {
  const open = text.indexOf('{');
  if (open < 0) return text.includes('}') ? undefined : [text];
  const parts: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === ',' && depth === 1) {
      parts.push(text.slice(from, i));
      from = i + 1;
    } else if (c === '}' && --depth === 0) {
      parts.push(text.slice(from, i));
      const out: string[] = [];
      for (const part of parts) {
        const more = expandBraces(`${text.slice(0, open)}${part}${text.slice(i + 1)}`);
        if (more === undefined || out.push(...more) > MAX_EXPANSIONS) return undefined;
      }
      return out;
    }
  }
  return undefined;
};

/**
 * Where a Glob call reaches beyond its `path` (T042 A11): the pattern's fixed folder part, joined to `path`
 * as the tool joins them, so `C:/Users/x/.ssh/*` or `../../*` is checked like a path. Brace alternatives are
 * placed one by one (`{../far,src}/**`). What cannot be placed — a `..`, a drive or a dots-only wildcard among
 * the wildcards, a search from a root, a bracket or brace that is not closed, too many alternatives — gives the
 * whole pattern, always with a `*` in it: the policy refuses a wildcard path (rule B), and a pattern without one
 * (`{..,src}/{a,b}….txt`) would otherwise be read as a plain path (r2-P1). A plain relative pattern (`**\/*.ts`)
 * adds nothing: the search stays in `path` or the working folder.
 */
export const globReach = (input: Record<string, unknown>): string[] => {
  const raw = str(input.pattern);
  if (raw === undefined || raw === '') return [];
  const pattern = raw.replaceAll('\\', '/');
  const path = str(input.path);
  const joined = (absolute: boolean, part: string) => (absolute || path === undefined || path === '' ? part : `${path}/${part}`);
  const unplaced = joined(/^([a-z]:|\/|~)/i.test(pattern), pattern);
  const whole = [unplaced.includes('*') ? unplaced : `${unplaced}/*`];
  const reach = (alternative: string): string[] | undefined => {
    const segments = alternative.split('/');
    if (segments.some((s) => s.split('[').length !== s.split(']').length || s.split('(').length !== s.split(')').length)) return undefined;
    const wild = segments.findIndex((s) => GLOB_SEGMENT.test(s));
    const fixed = wild < 0 ? segments : segments.slice(0, wild);
    const rest = wild < 0 ? [] : segments.slice(wild);
    const absolute = /^([a-z]:|\/|~)/i.test(alternative);
    if (rest.some((s) => s === '..' || s.includes(':') || DOTS_ONLY.test(s))) return undefined;
    const prefix = fixed.join('/');
    if (absolute && ROOT.test(prefix)) return undefined;
    return prefix === '' ? [] : [joined(absolute, prefix)];
  };
  const alternatives = expandBraces(pattern);
  if (alternatives === undefined) return whole;
  const out = new Set<string>();
  for (const alternative of alternatives) {
    const r = reach(alternative);
    if (r === undefined) return whole;
    for (const p of r) out.add(p);
  }
  return [...out];
};

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
    paths: [...toolPaths(input), ...(call.toolName === 'Glob' ? globReach(input) : [])],
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

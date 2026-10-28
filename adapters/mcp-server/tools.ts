// The five GUI tools (R-03, contracts/mcp.ts): what agents see in `tools/list`, how their input and the
// injected handlers' results are checked, and the handler interface the layer above implements.
import { z } from 'zod';
import {
  CreateTasksToolInput,
  CreateTasksToolResult,
  HandoffToolInput,
  HandoffToolResult,
  issueRule,
  type McpRejection,
  type McpToolName,
  type OperationId,
  ReportToRootToolInput,
  ReportToRootToolResult,
  SendMessageToolInput,
  SendMessageToolResult,
  type SessionId,
  WaitForFileToolInput,
  WaitForFileToolResult,
} from '../../contracts';

/** What every handler is told about the call. Nothing in it comes from the tool input. */
export interface McpCallContext {
  /** The calling session, from its token only. */
  caller: SessionId;
  /**
   * Native identity of this tool call (CR2_DELIVERY_FIX §4): the runtime's tool-call ID when the client
   * sends one in `_meta`, otherwise the MCP session and JSON-RPC request ID. A resend carries the same one.
   */
  sourceCallRef: string;
  /** Aborted when the client cancels the call or the server shuts down; the answer is then discarded. */
  signal: AbortSignal;
}

/**
 * For the tools that start a delivery. `operationId` is fixed by the server for this source call and is
 * the same for every resend of it; for a `retryOf` call it is the operation retried. Pass both it and
 * `sourceCallRef` to `DeliveryStore.accept`, which keeps a second acceptance from counting again.
 */
export interface DeliveryCallContext extends McpCallContext {
  operationId: OperationId;
}

/**
 * The business side of each tool, injected by the layer above (e.g. built on core's delivery service).
 * The server validates the input before calling and the result after; a handler that throws or returns
 * something that does not fit the result schema gives the agent a generic error, and its message is
 * never sent to the agent. A handler is called at most once per source call while its result is kept.
 */
export interface McpToolHandlers {
  handoff(input: HandoffToolInput, ctx: DeliveryCallContext): Promise<HandoffToolResult>;
  create_tasks(input: CreateTasksToolInput, ctx: McpCallContext): Promise<CreateTasksToolResult>;
  send_message(input: SendMessageToolInput, ctx: DeliveryCallContext): Promise<SendMessageToolResult>;
  report_to_root(input: ReportToRootToolInput, ctx: McpCallContext): Promise<ReportToRootToolResult>;
  wait_for_file(input: WaitForFileToolInput, ctx: McpCallContext): Promise<WaitForFileToolResult>;
}

export type McpToolResult = Awaited<ReturnType<McpToolHandlers[McpToolName]>>;

interface ToolSpec {
  description: string;
  input: z.ZodType;
  result: z.ZodType;
  /** Gets an operationId and turns a repeated `accepted` into `duplicate`. */
  delivers: boolean;
}

export const toolSpecs: Record<McpToolName, ToolSpec> = {
  handoff: {
    description:
      'Formally hand your work to the next workflow node, or to root, by naming one of your output rules. ' +
      'The GUI checks the edge, limits and task dependencies and delivers the content; the result says ' +
      'whether it was accepted, escalated or rejected, not whether it was read. To retry an earlier handoff, ' +
      'pass its operationId as retryOf with the same content.',
    input: HandoffToolInput,
    result: HandoffToolResult,
    delivers: true,
  },
  create_tasks: {
    description:
      'Root only: split the work into tasks. Keys name tasks within this call; dependsOn lists other keys ' +
      'in this call, dependsOnExisting lists task IDs that already exist. The user usually confirms first.',
    input: CreateTasksToolInput,
    result: CreateTasksToolResult,
    delivers: false,
  },
  send_message: {
    description:
      'Send a message to another AgentWorkflowGui session, Claude or Codex. Returns the delivery status, ' +
      'not a reply; a reply arrives later as a new message. To retry an earlier message, pass its ' +
      'operationId as retryOf with the same content.',
    input: SendMessageToolInput,
    result: SendMessageToolResult,
    delivers: true,
  },
  report_to_root: {
    description:
      'Report progress to the root session, or ask for the user\'s confirmation with needsUserConfirmation.',
    input: ReportToRootToolInput,
    result: ReportToRootToolResult,
    delivers: false,
  },
  wait_for_file: {
    description:
      'Same-folder mode: wait until another task releases its lock on a file. Returns free, not-locked, ' +
      'or timeout (the wait may then be escalated to root).',
    input: WaitForFileToolInput,
    result: WaitForFileToolResult,
    delivers: false,
  },
};

export const toolNames = Object.keys(toolSpecs) as McpToolName[];

export interface ToolListing {
  name: McpToolName;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

const listingOf = (name: McpToolName): ToolListing => {
  const schema: Record<string, unknown> = z.toJSONSchema(toolSpecs[name].input, { io: 'input', unrepresentable: 'any' });
  delete schema['$schema'];
  return { name, description: toolSpecs[name].description, inputSchema: { ...schema, type: 'object' } };
};

/** The `tools/list` entries, built once. */
export const toolListings: readonly ToolListing[] = toolNames.map(listingOf);

export const rejection = (reason: McpRejection['reason'], detail: string) => ({ status: 'rejected' as const, rejection: { reason, detail } });

/**
 * A short account of why an input failed, made only of paths, issue codes and the contracts' fixed rule
 * messages: never the values the agent sent.
 */
export const describeInputIssues = (error: z.ZodError, limit = 5): string => {
  const shown = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.map(String).join('.') || '(input)';
    const rule = issueRule(issue);
    return rule ? `${path}: ${issue.message}` : `${path}: ${issue.code}`;
  });
  const more = error.issues.length > limit ? `; ${error.issues.length - limit} more` : '';
  return `${shown.join('; ')}${more}`;
};

// Every approval request of every session goes through here (R-05, R-08). The GUI's own MCP tools are let
// through first (T016: Codex asks with an elicitation from server `gui`, Claude asks for ToolSearch and
// then the tool); everything else is the policy's call. `approve` answers at once; `escalate` holds the
// request and opens a permission escalation that only the user's `escalation.respond` can answer.
import {
  type Escalation,
  EscalationId,
  type LogicalSession,
  type PermissionDecision,
  type PermissionRequest,
  type SessionId,
  type Timestamp,
} from '../../contracts';
import type { AppRepositories, PermissionHandle, PermissionPolicy, PolicyContext, PolicyDecision } from '../ports';
import type { WrittenPaths } from './written-paths';

/** The GUI MCP server's tools as Claude names them (`mcp__<server>__<tool>`). */
const GUI_TOOLS = ['handoff', 'create_tasks', 'send_message', 'report_to_root', 'wait_for_file'].map((t) => `mcp__gui__${t}`);

/**
 * The GUI's own tools need no decision: Codex's elicitation for server `gui`, and Claude's ToolSearch (it
 * loads the deferred GUI tools first) and the GUI tools themselves. Claude's requests carry no tool name
 * (contracts gap), so the first word of the summary, which the adapter writes as the tool name, decides.
 */
export const isGuiToolRequest = (request: PermissionRequest): boolean => {
  if (request.kind === 'mcpElicitation') return request.elicitation?.serverName === 'gui';
  if (request.kind !== 'permissions') return false;
  const tool = /^\S+/.exec(request.summary)?.[0];
  return tool === 'ToolSearch' || (tool !== undefined && GUI_TOOLS.includes(tool));
};

/** Fixed titles; the detail is the policy's fixed reason, never request content (R-08). */
const TITLES: Record<string, string> = {
  'write-outside-scope': 'Write outside the session folder',
  'git-remote': 'Git remote operation',
  destructive: 'Destructive command',
  'secret-read': 'Reading a secret or credential',
  unrecognised: 'Command the policy cannot check',
};

export interface PermissionGateOptions {
  repositories: Pick<AppRepositories, 'sessions' | 'escalations'>;
  policy: PermissionPolicy;
  written: WrittenPaths;
  /** Node-side link resolution (junctions, symbolic links); null when it cannot be confirmed. */
  resolveRealPath(absolutePath: string): string | null;
  publish(escalation: Escalation): void;
  now(): Timestamp;
  uuid(): string;
  log?(message: string): void;
}

export type RespondResult = 'answered' | 'not-found' | 'not-open' | 'gone';

export class PermissionGate {
  /** Held requests by their escalation, until the user answers or the runtime withdraws them. */
  private readonly held = new Map<EscalationId, PermissionHandle>();

  constructor(private readonly options: PermissionGateOptions) {}

  /** `RuntimeAdapterHooks.onPermissionRequest`. A throw makes the adapter decline (fail closed). */
  async onPermissionRequest(handle: PermissionHandle): Promise<void> {
    const { request } = handle;
    if (isGuiToolRequest(request)) {
      handle.answer(this.policyDecision('approve'));
      return;
    }
    const session = await this.options.repositories.sessions.get(request.sessionId);
    if (session === undefined) {
      handle.answer(this.policyDecision('decline', 'the session is not known to the GUI'));
      return;
    }
    const decision: PolicyDecision = this.options.policy.evaluate(request, this.context(session));
    if (decision.action === 'approve') {
      if (handle.answer(this.policyDecision('approve')) && (request.kind === 'command' || request.kind === 'fileChange')) {
        this.options.written.add(session.id, request.paths, request.cwd ?? session.cwd);
      }
      return;
    }
    const escalation: Escalation = {
      id: EscalationId.parse(`permission-${this.options.uuid()}`),
      rootSessionId: session.id,
      fromSessionId: session.id,
      kind: 'permission',
      title: TITLES[decision.rule] ?? 'Permission request',
      detail: decision.reason,
      rule: decision.rule,
      ref: { kind: 'permission', permissionRequestId: request.id },
      state: 'open',
      createdAt: this.options.now(),
    };
    await this.options.repositories.escalations.upsert(escalation);
    this.held.set(escalation.id, handle);
    if (!handle.hold({ reason: 'awaiting-user', escalationId: escalation.id }, { matchedRule: decision.rule })) {
      // Withdrawn while the escalation was being written: nothing is left to decide.
      this.held.delete(escalation.id);
      await this.close(escalation, 'resolved');
      return;
    }
    this.options.publish(escalation);
  }

  /** The user's answer (`escalation.respond`); the only way an escalated request is approved (R-05). */
  async respond(
    escalation: Escalation,
    input: {
      decision: 'approve' | 'decline';
      note?: string | undefined;
      content?: PermissionDecision['content'];
    },
  ): Promise<RespondResult> {
    if (escalation.state !== 'open') return 'not-open';
    const handle = this.held.get(escalation.id);
    const answered =
      handle?.answer({
        outcome: input.decision,
        decidedBy: 'user',
        escalationId: escalation.id,
        ...(input.note !== undefined && { reason: input.note }),
        ...(input.content !== undefined && { content: input.content }),
        at: this.options.now(),
      }) ?? false;
    this.held.delete(escalation.id);
    if (!answered) {
      // The runtime withdrew it (turn ended, process exited) or this GUI restarted: nobody can be answered.
      await this.close(escalation, 'resolved');
      return 'gone';
    }
    const { request } = handle!;
    if (input.decision === 'approve' && (request.kind === 'command' || request.kind === 'fileChange')) {
      const session = await this.options.repositories.sessions.get(request.sessionId);
      this.options.written.add(request.sessionId, request.paths, request.cwd ?? session?.cwd ?? '');
    }
    await this.close(escalation, input.decision === 'approve' ? 'approved' : 'declined');
    return 'answered';
  }

  /** A request the runtime withdrew: its open escalation is closed by the system. */
  async withdrawn(request: PermissionRequest): Promise<void> {
    for (const [id, handle] of this.held) {
      if (handle.request.id !== request.id || handle.request.sessionId !== request.sessionId) continue;
      this.held.delete(id);
      const escalation = await this.options.repositories.escalations.get(id);
      if (escalation?.state === 'open') await this.close(escalation, 'resolved');
    }
  }

  /** Builds the policy context of a session (R-08): its scope with real roots, what it wrote, the resolver. */
  context(session: LogicalSession): PolicyContext {
    const { folderScope } = session;
    const real = (root: string) => this.options.resolveRealPath(root);
    const workspaceRoot = real(folderScope.workspaceRoot);
    const writable = folderScope.writableRoots.map(real);
    const readable = folderScope.readableRoots.map(real);
    // A root that cannot be confirmed gives no write scope at all: every write goes to the user.
    const scope =
      workspaceRoot === null || writable.includes(null)
        ? {
            ...folderScope,
            workspaceRoot: workspaceRoot ?? folderScope.workspaceRoot,
            writableRoots: [],
            readableRoots: readable.filter((r): r is string => r !== null),
          }
        : {
            ...folderScope,
            workspaceRoot,
            writableRoots: writable as string[],
            readableRoots: readable.filter((r): r is string => r !== null),
          };
    return {
      folderScope: scope,
      writtenPaths: this.options.written.list(session.id),
      resolveRealPath: (p) => this.options.resolveRealPath(p),
    };
  }

  /** Held requests of a session, e.g. to show them on exit. */
  heldFor(sessionId: SessionId): PermissionRequest[] {
    return [...this.held.values()].filter((h) => h.request.sessionId === sessionId).map((h) => h.request);
  }

  private async close(escalation: Escalation, state: 'approved' | 'declined' | 'resolved'): Promise<void> {
    const closed: Escalation = {
      ...escalation,
      state,
      resolvedBy: state === 'resolved' ? 'system' : 'user',
      resolvedAt: this.options.now(),
    };
    await this.options.repositories.escalations.upsert(closed);
    this.options.publish(closed);
  }

  private policyDecision(outcome: 'approve' | 'decline', reason?: string): PermissionDecision {
    return {
      outcome,
      decidedBy: 'policy',
      ...(reason !== undefined && { reason }),
      at: this.options.now(),
    };
  }
}

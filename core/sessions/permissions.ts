// Every approval request of every session goes through here (R-05, R-08). The GUI's own MCP tools are let
// through first (T016: Codex asks with an elicitation from server `gui`, Claude asks for ToolSearch and
// then the tool); everything else is the policy's call. `approve` answers at once; `escalate` holds the
// request and opens a permission escalation that only the user's `escalation.respond` can answer.
import {
  type Escalation,
  EscalationId,
  type InstanceId,
  type LogicalSession,
  type PermissionDecision,
  type PermissionRequest,
  type SessionId,
  type Timestamp,
} from '../../contracts';
import type { LockCoordinator, LockStep } from '../locks';
import type { AppRepositories, PermissionHandle, PermissionPolicy, PolicyContext, PolicyDecision } from '../ports';
import type { WrittenPaths } from './written-paths';

/** The GUI MCP server's tools as Claude names them (`mcp__<server>__<tool>`). */
const GUI_TOOLS = ['handoff', 'create_tasks', 'send_message', 'report_to_root', 'wait_for_file'].map((t) => `mcp__gui__${t}`);

/**
 * The GUI's own tools need no decision: Codex's elicitation for server `gui`, and Claude's ToolSearch (it
 * loads the deferred GUI tools first) and the GUI tools themselves. Decided by the request's `tool` and
 * `server` fields (C-04), never by its summary.
 */
export const isGuiToolRequest = (request: PermissionRequest): boolean => {
  if (request.kind === 'mcpElicitation') return request.server === 'gui' && request.elicitation?.serverName === 'gui';
  if (request.kind !== 'permissions') return false;
  return request.tool === 'ToolSearch' || (request.server === 'gui' && request.tool !== undefined && GUI_TOOLS.includes(request.tool));
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
  /** True once the GUI began closing: from then on nothing is approved, by the policy or the user (r3-P1-2). */
  isClosing?(): boolean;
  /**
   * Where a session's escalations go (R-05): a workflow session's to its instance's root (T024). Defaults
   * to the session itself, which is right for ordinary sessions.
   */
  rootOf?(session: LogicalSession): Promise<{ rootSessionId: SessionId; instanceId?: InstanceId }>;
  /**
   * Same-folder file locks (R-07): the last step before an approval is answered. Absent: approvals are
   * answered at once (no locks).
   */
  locks?: LockCoordinator;
}

export type RespondResult = 'answered' | 'not-found' | 'not-open' | 'gone';

export class PermissionGate {
  /** Held requests by their escalation, until the user answers or the runtime withdraws them. */
  private readonly held = new Map<EscalationId, PermissionHandle>();

  constructor(private readonly options: PermissionGateOptions) {}

  /** `RuntimeAdapterHooks.onPermissionRequest`. A throw makes the adapter decline (fail closed). */
  async onPermissionRequest(handle: PermissionHandle): Promise<void> {
    const { request } = handle;
    if (this.declinedForClosing(handle)) return;
    if (isGuiToolRequest(request)) {
      handle.answer(this.policyDecision('approve'));
      return;
    }
    const session = await this.options.repositories.sessions.get(request.sessionId);
    // Checked again after every wait: closing may have begun meanwhile (r3-P1-2).
    if (this.declinedForClosing(handle)) return;
    if (session === undefined) {
      handle.answer(this.policyDecision('decline', 'the session is not known to the GUI'));
      return;
    }
    // A write to a file another session holds is refused before anyone is asked (R-07): it would be anyway.
    const locked = this.options.locks?.screen(request, session);
    if (locked !== undefined) {
      handle.answer(this.policyDecision('decline', locked));
      return;
    }
    const decision: PolicyDecision = this.options.policy.evaluate(request, this.context(session));
    if (decision.action === 'approve') {
      if (this.declinedForClosing(handle)) return;
      // The policy's approval stands; the lock may only make it wait or refuse it (R-07).
      const step = await this.approve(handle, this.policyDecision('approve'), session);
      if (step === 'approved' && (request.kind === 'command' || request.kind === 'fileChange')) {
        this.options.written.add(session.id, request.paths, request.cwd ?? session.cwd);
      }
      return;
    }
    const root = (await this.options.rootOf?.(session)) ?? { rootSessionId: session.id };
    if (this.declinedForClosing(handle)) return;
    const escalation: Escalation = {
      id: EscalationId.parse(`permission-${this.options.uuid()}`),
      ...(root.instanceId !== undefined && { instanceId: root.instanceId }),
      rootSessionId: root.rootSessionId,
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
    if (this.declinedForClosing(handle)) {
      await this.close(escalation, 'resolved');
      return;
    }
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
    if (handle !== undefined && this.declinedForClosing(handle)) {
      this.held.delete(escalation.id);
      await this.close(escalation, 'resolved');
      return 'gone';
    }
    const decision: PermissionDecision = {
      outcome: input.decision,
      decidedBy: 'user',
      escalationId: escalation.id,
      ...(input.note !== undefined && { reason: input.note }),
      ...(input.content !== undefined && { content: input.content }),
      at: this.options.now(),
    };
    const session = handle !== undefined ? await this.options.repositories.sessions.get(handle.request.sessionId) : undefined;
    if (handle !== undefined && this.declinedForClosing(handle)) {
      this.held.delete(escalation.id);
      await this.close(escalation, 'resolved');
      return 'gone';
    }
    // The user's approval goes through the locks like the policy's (R-07): a held write is answered later.
    let step: LockStep | Promise<LockStep> = 'gone';
    if (handle !== undefined && input.decision === 'approve' && session !== undefined) step = this.approve(handle, decision, session);
    else if (handle?.answer(decision) === true) step = input.decision === 'approve' ? 'approved' : 'refused';
    this.held.delete(escalation.id);
    if (step === 'gone') {
      // The runtime withdrew it (turn ended, process exited) or this GUI restarted: nobody can be answered.
      await this.close(escalation, 'resolved');
      return 'gone';
    }
    const { request } = handle!;
    const written = () => this.options.written.add(request.sessionId, request.paths, request.cwd ?? session?.cwd ?? '');
    if (input.decision === 'approve' && (request.kind === 'command' || request.kind === 'fileChange')) {
      if (step === 'approved') written();
      else if (step !== 'refused') void step.then((s) => s === 'approved' && written());
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

  /** Answers an approval, through the locks when there are any. */
  private approve(handle: PermissionHandle, decision: PermissionDecision, session: LogicalSession): LockStep | Promise<LockStep> {
    if (this.options.locks !== undefined) return this.options.locks.approve(handle, decision, session);
    return handle.answer(decision) ? 'approved' : 'gone';
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

  /** Declines the request when closing began; true when it did. */
  private declinedForClosing(handle: PermissionHandle): boolean {
    if (this.options.isClosing?.() !== true) return false;
    handle.answer(this.policyDecision('decline', 'the GUI is closing'));
    return true;
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

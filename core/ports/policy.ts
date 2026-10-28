// Permission policy port (T012, C-13): R-08 auto-approval with an escalation list, and CR-1's rule that a
// command the policy cannot understand goes to the user. T014 implements it as pure functions; the
// session service applies the decision (approve now, or hold and escalate to root; R-05).
import type { FolderScope, PermissionRequest } from '../../contracts';

/** The escalation-list entries of R-08 plus `unrecognised` (CR-1). Recorded as `matchedRule`. */
export type PolicyRule =
  | 'write-outside-scope' // write or delete outside the folder scope (isolation)
  | 'git-remote' // git push, force push, changing a remote (external effect)
  | 'destructive' // wide deletes, system settings, global installs (irreversible)
  | 'secret-read' // credentials and secret files such as .env, ~/.ssh (leak)
  | 'unrecognised'; // interpreter one-liners, encoded commands, a script the session just wrote, unknown targets

export interface PolicyContext {
  /** Roots are already real paths (links resolved) when the session service builds the context. */
  folderScope: FolderScope;
  /** Files this session wrote, so running a script it just wrote is recognised (CR-1). */
  writtenPaths: readonly string[];
  /**
   * Resolves junctions and symbolic links in the existing part of an absolute path; a tail that does not
   * exist yet is kept as written. `null` means it cannot be confirmed, which the policy treats as
   * `unrecognised`. Injected by the session service so the policy stays free of Node.
   */
  resolveRealPath(absolutePath: string): string | null;
}

/**
 * `approve`: answer at once (decidedBy `policy`). `escalate`: hold the request for the user on root;
 * `reason` is fixed text that never contains secrets or file contents.
 */
export type PolicyDecision = { action: 'approve' } | { action: 'escalate'; rule: PolicyRule; reason: string };

export interface PermissionPolicy {
  evaluate(request: PermissionRequest, context: PolicyContext): PolicyDecision;
}

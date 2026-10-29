// Request builders for the policy tests (T014). Requests go through the contract schema, as the
// adapters' requests do.
import { PermissionRequest } from '../../../contracts';
import type { PolicyContext, PolicyDecision } from '../../ports';
import { permissionPolicy } from '../policy';

export const ROOT = String.raw`E:\work\proj`;
export const REFS = String.raw`E:\work\refs`;

export const contextFor = (root = ROOT, extra: Partial<PolicyContext> = {}, readOnly = false): PolicyContext => ({
  folderScope: { source: 'task-worktree', workspaceRoot: root, writableRoots: readOnly ? [] : [root], readableRoots: [REFS] },
  writtenPaths: [],
  resolveRealPath: (path) => path,
  ...extra,
});

type Fields = Partial<Omit<PermissionRequest, 'kind' | 'summary'>>;

export const request = (kind: PermissionRequest['kind'], summary: string, fields: Fields = {}): PermissionRequest =>
  PermissionRequest.parse({ id: 'perm-1', sessionId: 'session-1', kind, summary, state: 'pending', createdAt: '2026-10-29T00:00:00Z', cwd: ROOT, ...fields });

/** A shell command as Claude's Bash tool reports it. */
export const command = (cmd: string, fields: Fields = {}) => request('command', `Bash: ${cmd}`, { command: cmd, ...fields });

/** A command inside Codex's PowerShell wrapper. */
export const codex = (script: string, fields: Fields = {}) => {
  const cmd = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${script}"`;
  return request('command', `Run command: ${cmd}`, { command: cmd, ...fields });
};

/**
 * A command as Codex 0.160 reported it on the real machine (T021): the executable in double quotes with
 * doubled backslashes, `-NoProfile`, and a script without `'` in single quotes.
 */
export const CODEX_PS_EXE = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`;
export const codexSingle = (script: string, fields: Fields = {}) => {
  const cmd = `${CODEX_PS_EXE} -NoProfile -Command '${script}'`;
  return request('command', `Run command: ${cmd}`, { command: cmd, ...fields });
};

/** A Claude edit tool call. */
export const edit = (...paths: string[]) => request('fileChange', paths[0] ? `Write ${paths[0]}` : 'Write', { paths });

/** Any other Claude tool call: the summary starts with the tool name. */
export const tool = (name: string, ...paths: string[]) => request('permissions', paths[0] ? `${name} ${paths[0]}` : name, { paths, tool: name });

export const decide = (req: PermissionRequest, context: PolicyContext = contextFor()): PolicyDecision => permissionPolicy.evaluate(req, context);

/** `approve`, or the escalation rule. */
export const verdict = (req: PermissionRequest, context?: PolicyContext): string => {
  const d = decide(req, context);
  return d.action === 'approve' ? 'approve' : d.rule;
};

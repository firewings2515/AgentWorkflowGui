// PermissionPolicy (T014): R-08's escalation list plus CR-1's rule that whatever the policy cannot fully
// read goes to the user on root. A request is approved only when it is completely understood, every
// target lies inside the folder scope and nothing on the list matches. The root AI never answers these
// (R-05); the session service applies the decision.
//
// Shell commands are read twice, as PowerShell and as Git Bash, unless they arrive in Codex's
// `powershell.exe -Command "..."` wrapper. Claude's Bash and PowerShell tools both arrive as `command`
// requests, and the request does not say which shell runs them, so both readings must be safe.
import type { PermissionRequest } from '../../contracts';
import type { PermissionPolicy, PolicyContext, PolicyDecision, PolicyRule } from '../ports';
import { type Effects, handlerFor } from './commands';
import { type Shell, type Word, lex } from './lexer';
import {
  type AbsPath,
  type PathStyle,
  hasWildcard,
  isSecretPath,
  isWithinAny,
  normaliseAbsolute,
  patternMayMatchSecret,
  resolveGlob,
  resolvePath,
} from './paths';
import { type Finding, REASONS, type ReasonKey, finding } from './reasons';

interface Scope {
  writable: AbsPath[];
  readable: AbsPath[];
  written: Set<AbsPath>;
  /** A recorded written path could not be normalised, so no script can be shown not to be one. */
  writtenUnclear: boolean;
}

const scopeOf = ({ folderScope, writtenPaths }: PolicyContext): Scope => {
  const roots = (paths: readonly string[]) => paths.flatMap((p) => normaliseAbsolute(p) ?? []);
  const workspace = normaliseAbsolute(folderScope.workspaceRoot);
  const writable = roots(folderScope.writableRoots);
  const written = new Set<AbsPath>();
  let writtenUnclear = false;
  for (const p of writtenPaths) {
    const abs = resolvePath(p, workspace, 'win');
    if (abs === undefined) writtenUnclear = true;
    else written.add(abs);
  }
  return { writable, readable: [...(workspace ? [workspace] : []), ...writable, ...roots(folderScope.readableRoots)], written, writtenUnclear };
};

type Access = 'read' | 'write' | 'run';

/** Collects findings for one request. `cwds` are the folders a relative path may be relative to (`undefined`: unknown). */
class Checker {
  readonly findings: Finding[] = [];
  constructor(private readonly scope: Scope) {}

  add(rule: PolicyRule, why: ReasonKey) {
    this.findings.push(finding(rule, why));
  }

  private inScope(path: AbsPath, access: Access) {
    if (access === 'write') {
      if (!isWithinAny(path, this.scope.writable)) this.add('write-outside-scope', 'outside-write');
    } else if (!isWithinAny(path, this.scope.readable)) this.add('secret-read', 'outside-read');
  }

  target(w: Word, access: Access, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    for (const cwd of cwds) {
      if (w.wild || hasWildcard(w.text)) {
        const glob = access === 'run' ? undefined : resolveGlob(w.text, cwd, style);
        if (glob === undefined) {
          this.add('unrecognised', 'unknown-target');
          continue;
        }
        if (isSecretPath(glob.folder) || glob.patterns.some(patternMayMatchSecret)) this.add('secret-read', 'secret');
        this.inScope(glob.folder, access);
        continue;
      }
      const path = resolvePath(w.text, cwd, style);
      if (path === undefined) {
        this.add('unrecognised', 'unknown-target');
        continue;
      }
      if (isSecretPath(path)) this.add('secret-read', 'secret');
      this.inScope(path, access);
      if (access === 'run' && (this.scope.writtenUnclear || this.scope.written.has(path))) this.add('unrecognised', 'written-script');
    }
  }

  folder(access: 'read' | 'write', at: Word | undefined, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    for (const cwd of cwds) {
      const base = at === undefined ? cwd : resolvePath(at.text, cwd, style);
      if (base === undefined) this.add('unrecognised', 'unknown-target');
      else this.inScope(base, access);
    }
  }

  effects(fx: Effects, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    this.findings.push(...fx.findings);
    for (const w of fx.reads) this.target(w, 'read', cwds, style);
    for (const w of fx.writes) this.target(w, 'write', cwds, style);
    for (const w of fx.runs) this.target(w, 'run', cwds, style);
    if (fx.folder) this.folder(fx.folder.access, fx.folder.at, cwds, style);
  }

  /** One reading of a shell command, following `cd` from segment to segment. */
  script(text: string, shell: Shell, cwd: AbsPath | undefined) {
    const segments = lex(text, shell);
    if (segments === undefined) return this.add('unrecognised', 'syntax');
    const style: PathStyle = shell === 'ps' ? 'win' : 'sh';
    // A failed `cd` leaves the folder as it was, so every folder it may be in stays possible.
    let cwds: (AbsPath | undefined)[] = [cwd];
    for (const { words, writes } of segments) {
      for (const w of writes) this.target(w, 'write', cwds, style);
      const [head, ...args] = words;
      if (head === undefined) continue;
      if (head.wild || /[\\/:]/.test(head.text)) {
        // A shell named by its full path is still a shell (`C:\...\powershell.exe -EncodedCommand`).
        const base = head.text.split(/[\\/]/).pop()!;
        if (!head.wild && /^(powershell|pwsh|cmd)(\.exe)?$/i.test(base)) {
          this.effects(handlerFor(base, shell)!(args), cwds, style);
          continue;
        }
        // Any other program named by path: never auto-approved, and called out when this session wrote it.
        const path = head.wild ? undefined : resolvePath(head.text, cwds[0], style);
        this.add('unrecognised', path !== undefined && (this.scope.writtenUnclear || this.scope.written.has(path)) ? 'written-script' : 'unknown-program');
        continue;
      }
      const handler = handlerFor(head.text, shell);
      if (handler === undefined) {
        this.add('unrecognised', 'unknown-program');
        continue;
      }
      const fx = handler(args);
      this.effects(fx, cwds, style);
      if (fx.cd) {
        const moved = cwds.map((c) => resolvePath(fx.cd!.text, c, style));
        if (moved.some((c) => c === undefined)) this.add('unrecognised', 'unknown-target');
        else cwds = [...new Set([...cwds, ...moved])];
      }
    }
  }
}

const POWERSHELL_EXE = /^(c:\/windows\/(system32|syswow64)\/windowspowershell\/v1\.0\/powershell\.exe|c:\/program files\/powershell\/\d+(-preview)?\/pwsh\.exe)$/;
const WRAPPER = /^\s*(?:"([^"]+)"|(\S+))\s+((?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*)-(?:Command|c)\s+"([^"]*)"\s*$/i;

/**
 * Codex reports each command inside its shell call: `"C:\...\powershell.exe" -Command "<script>"`. Only
 * that exact form, with the system PowerShell, is opened (once); the script inside is then read as
 * PowerShell. `undefined` when the command is not in this form.
 */
export const unwrapPowerShell = (command: string): string | undefined => {
  const m = WRAPPER.exec(command);
  if (!m) return undefined;
  const exe = normaliseAbsolute(m[1] ?? m[2]!);
  const script = m[4]!;
  // A doubled backslash would be read differently if Bash, not Windows, split this command line.
  if (exe === undefined || !POWERSHELL_EXE.test(exe) || script.includes('\\\\')) return undefined;
  return script;
};

// Read-only Claude tools; their paths are what they read, and without one they search the folder.
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep', 'LS']);
const FOLDER_TOOLS = new Set(['Glob', 'Grep', 'LS']);
// Claude tools with no file or system effect of their own (a sub-agent's tools go through the hook too).
const QUIET_TOOLS = new Set(['TodoWrite', 'Agent', 'Task', 'ToolSearch']);

/**
 * `permissions` requests carry no tool name. Claude's adapter writes the summary as `<Tool> <target>`,
 * and Codex's as `Grant ...`, so the first word identifies a Claude tool. It is used only to approve
 * the read-only and quiet tools above; any other first word escalates.
 */
const checkPermissions = (c: Checker, request: PermissionRequest, cwd: AbsPath | undefined) => {
  const tool = /^[A-Za-z_][\w-]*(?=\s|$)/.exec(request.summary)?.[0];
  if (tool !== undefined && QUIET_TOOLS.has(tool) && request.paths.length === 0) return;
  if (tool === undefined || !READ_TOOLS.has(tool)) return c.add('unrecognised', request.summary.startsWith('Grant ') ? 'grant' : 'unknown-tool');
  if (request.paths.length === 0) {
    if (FOLDER_TOOLS.has(tool)) c.folder('read', undefined, [cwd], 'win');
    else c.add('unrecognised', 'unknown-target');
  }
  for (const p of request.paths) c.target({ text: p, wild: false }, 'read', [cwd], 'win');
};

const PRECEDENCE: readonly PolicyRule[] = ['destructive', 'git-remote', 'secret-read', 'write-outside-scope', 'unrecognised'];
const SECRET_MENTION = /(^|[\s'"/\\=:(])(\.env[\w.-]*|id_(rsa|dsa|ecdsa|ed25519)|\.ssh|\.aws|\.gnupg|\.git-credentials|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)(?=$|[\s'"/\\;|&)])/i;

const decide = (findings: readonly Finding[], request: PermissionRequest): PolicyDecision => {
  if (findings.length === 0) return { action: 'approve' };
  const rank = (f: Finding) => PRECEDENCE.indexOf(f.rule);
  let top = findings.reduce((best, f) => (rank(f) < rank(best) ? f : best));
  // An unreadable command that names a secret is labelled as a secret read, so root shows the real risk.
  if (top.rule === 'unrecognised' && request.command !== undefined && SECRET_MENTION.test(request.command)) top = finding('secret-read', 'secret-mention');
  return { action: 'escalate', rule: top.rule, reason: REASONS[top.why] };
};

export const evaluatePermission = (request: PermissionRequest, context: PolicyContext): PolicyDecision => {
  const c = new Checker(scopeOf(context));
  const cwd = request.cwd === undefined ? undefined : normaliseAbsolute(request.cwd);
  switch (request.kind) {
    case 'mcpElicitation':
      c.add('unrecognised', 'elicitation');
      break;
    case 'fileChange':
      if (request.paths.length === 0) c.add('unrecognised', 'unknown-target');
      for (const p of request.paths) c.target({ text: p, wild: false }, 'write', [cwd], 'win');
      break;
    case 'permissions':
      checkPermissions(c, request, cwd);
      break;
    case 'command': {
      if (request.command === undefined) {
        c.add('unrecognised', 'no-command');
        break;
      }
      const script = unwrapPowerShell(request.command);
      const shells: Shell[] = script === undefined ? ['ps', 'sh'] : ['ps'];
      for (const shell of shells) c.script(script ?? request.command, shell, cwd);
      // Codex's own parse of the command (`commandActions`) adds the paths it reads.
      for (const p of request.paths) c.target({ text: p, wild: false }, 'read', [cwd], 'win');
      break;
    }
  }
  return decide(c.findings, request);
};

/** The R-08 / CR-1 policy. Stateless: everything it needs is in the request and the context. */
export const permissionPolicy: PermissionPolicy = { evaluate: evaluatePermission };

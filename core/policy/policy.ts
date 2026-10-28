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
import { type Effects, type Target, handlerFor } from './commands';
import { type Shell, type Word, lex } from './lexer';
import { type AbsPath, type PathStyle, fileKey, hasWildcard, isSecretPath, isWithinAny, normaliseAbsolute, resolvePath } from './paths';
import { type Finding, REASONS, type ReasonKey, finding } from './reasons';

interface Scope {
  writable: AbsPath[];
  readable: AbsPath[];
}

const scopeOf = ({ folderScope }: PolicyContext): Scope => {
  const roots = (paths: readonly string[]) => paths.flatMap((p) => normaliseAbsolute(p) ?? []);
  const workspace = normaliseAbsolute(folderScope.workspaceRoot);
  const writable = roots(folderScope.writableRoots);
  return { writable, readable: [...(workspace ? [workspace] : []), ...writable, ...roots(folderScope.readableRoots)] };
};

// `run`: executed (scope, secret and written checks); `load`: code or settings taken from it (written check only).
type Access = 'read' | 'write' | 'run' | 'load';

/** Node's lookup for `node x`: the file, then extensions, then index files in a folder (`main` is covered by the folder). */
const NODE_SUFFIXES = ['.js', '.mjs', '.cjs', '.json', '.node', '/index.js', '/index.mjs', '/index.cjs', '/index.json', '/index.node', '/package.json'];

/**
 * Collects findings for one request. `cwds` are the folders a relative path may be relative to
 * (`undefined`: unknown). Every path is checked as written and again after `resolveRealPath`.
 */
class Checker {
  readonly findings: Finding[] = [];
  /** Paths written by the session, or earlier in this request (CR-1), as written and real, as `fileKey`s. */
  private readonly written: string[] = [];

  constructor(
    private readonly scope: Scope,
    private readonly context: PolicyContext,
  ) {
    const workspace = normaliseAbsolute(context.folderScope.workspaceRoot);
    for (const p of context.writtenPaths) {
      const abs = resolvePath(p, workspace, 'win');
      const real = abs === undefined ? undefined : this.real(abs);
      // The port's contract: a path that cannot be confirmed makes the request unrecognised.
      if (abs === undefined || real === undefined) this.add('unrecognised', 'written-unclear');
      else this.written.push(fileKey(abs), fileKey(real));
    }
  }

  add(rule: PolicyRule, why: ReasonKey) {
    this.findings.push(finding(rule, why));
  }

  /** The path with junctions and symbolic links resolved, or `undefined` when that cannot be confirmed. */
  private real(path: AbsPath): AbsPath | undefined {
    const resolved = this.context.resolveRealPath(path);
    return resolved === null ? undefined : normaliseAbsolute(resolved);
  }

  /** Running `path` may run something written: the file itself, a file in a written folder, or a written file in it. */
  private isWritten(path: AbsPath) {
    const key = fileKey(path);
    return this.written.some((w) => w === key || key.startsWith(`${w}/`) || w.startsWith(`${key}/`));
  }

  private inScope(path: AbsPath, access: Access) {
    if (access === 'load') return;
    if (access === 'write') {
      if (!isWithinAny(path, this.scope.writable)) this.add('write-outside-scope', 'outside-write');
    } else if (!isWithinAny(path, this.scope.readable)) this.add('secret-read', 'outside-read');
  }

  /** Checks one path, as written and with its links resolved. */
  private check(path: AbsPath, access: Access) {
    const real = this.real(path);
    if (real === undefined) return this.add('unrecognised', 'unknown-target');
    for (const p of real === path ? [path] : [path, real]) {
      if (access !== 'load' && isSecretPath(p)) this.add('secret-read', 'secret');
      this.inScope(p, access);
      if ((access === 'run' || access === 'load') && this.isWritten(p)) this.add('unrecognised', 'written-script');
    }
    // Later commands in this request may run it; a written folder covers everything put into it.
    if (access === 'write') this.written.push(fileKey(path), fileKey(real));
  }

  /** Resolves a target against each possible working folder, through its own base folder if it has one. */
  target(t: Target, access: Access, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    // Rule B: a wildcard target reaches files that cannot be listed or resolved here.
    if (t.wild || hasWildcard(t.text)) return this.add('unrecognised', 'wildcard');
    for (const cwd of cwds) {
      const base = t.base === undefined ? cwd : resolvePath(t.base, cwd, style);
      // Without a base folder only an absolute path resolves.
      const path = t.base !== undefined && base === undefined ? undefined : resolvePath(t.text, base, style);
      if (path === undefined) {
        this.add('unrecognised', 'unknown-target');
        continue;
      }
      this.check(path, access);
      // Node may load any of these instead; each is resolved and checked like the script itself.
      if (access === 'run' && t.node) for (const suffix of NODE_SUFFIXES) this.check(`${path}${suffix}`, 'run');
    }
  }

  folder(access: 'read' | 'write', at: Word | undefined, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    for (const cwd of cwds) {
      const base = at === undefined ? cwd : resolvePath(at.text, cwd, style);
      const real = base === undefined ? undefined : this.real(base);
      if (base === undefined || real === undefined) this.add('unrecognised', 'unknown-target');
      else for (const p of real === base ? [base] : [base, real]) this.inScope(p, access);
    }
  }

  /** A program named by its path: never auto-approved, and called out when this session wrote it. */
  program(w: Word, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    const path = w.wild ? undefined : resolvePath(w.text, cwds[0], style);
    const real = path === undefined ? undefined : this.real(path);
    const written = path !== undefined && (this.isWritten(path) || real === undefined || this.isWritten(real));
    this.add('unrecognised', written ? 'written-script' : 'unknown-program');
  }

  effects(fx: Effects, cwds: readonly (AbsPath | undefined)[], style: PathStyle) {
    this.findings.push(...fx.findings);
    for (const t of fx.reads) this.target(t, 'read', cwds, style);
    for (const t of fx.runs) this.target(t, 'run', cwds, style);
    for (const t of fx.loads) this.target(t, 'load', cwds, style);
    // After the runs: what a command writes counts as written for the commands after it.
    for (const t of fx.writes) this.target(t, 'write', cwds, style);
    if (fx.folder) this.folder(fx.folder.access, fx.folder.at, cwds, style);
  }

  /** One reading of a shell command, following `cd` from segment to segment. */
  script(text: string, shell: Shell, cwd: AbsPath | undefined) {
    const segments = lex(text, shell);
    if (segments === undefined) return this.add('unrecognised', 'syntax');
    const style: PathStyle = shell === 'ps' ? 'win' : 'sh';
    // A failed `cd` leaves the folder as it was, so every folder it may be in stays possible.
    let cwds: (AbsPath | undefined)[] = [cwd];
    for (const { words, writes, piped } of segments) {
      const [head, ...args] = words;
      if (head === undefined) {
        for (const w of writes) this.target(w, 'write', cwds, style);
        continue;
      }
      if (head.wild || /[\\/:]/.test(head.text)) {
        for (const w of writes) this.target(w, 'write', cwds, style);
        // A shell named by its full path is still a shell (`C:\...\powershell.exe -EncodedCommand`).
        const base = head.text.split(/[\\/]/).pop()!;
        if (!head.wild && /^(powershell|pwsh|cmd)(\.exe)?$/i.test(base)) this.effects(handlerFor(base, shell)!(args), cwds, style);
        else this.program(head, cwds, style);
        continue;
      }
      const handler = handlerFor(head.text, shell);
      if (handler === undefined) {
        for (const w of writes) this.target(w, 'write', cwds, style);
        this.add('unrecognised', 'unknown-program');
        continue;
      }
      const fx = handler(args);
      // The upstream objects' `Path` may become this cmdlet's target, which cannot be known here.
      if (shell === 'ps' && piped && fx.pipedTarget) this.add('unrecognised', 'unknown-target');
      fx.writes.push(...writes);
      this.effects(fx, cwds, style);
      if (fx.cd) {
        const moved = cwds.map((c) => resolvePath(fx.cd!.text, c, style));
        if (fx.cd.wild || moved.some((c) => c === undefined)) this.add('unrecognised', 'unknown-target');
        else cwds = [...new Set([...cwds, ...moved])];
      }
    }
  }
}

const POWERSHELL_EXE = /^(c:\/windows\/(system32|syswow64)\/windowspowershell\/v1\.0\/powershell\.exe|c:\/program files\/powershell\/\d+(-preview)?\/pwsh\.exe)$/;
const WRAPPER = /^\s*(?:"([^"]+)"|(\S+))\s+((?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*)-(?:Command|c)\s+"([^"]*)"\s*$/i;

/**
 * Codex reports each command inside its shell call: `"C:\...\powershell.exe" -Command "<script>"`.
 * Returns the script when the command has that form with the system PowerShell, and whether it may be
 * read as PowerShell alone. The same text may come from Claude's Bash tool, where Bash first expands
 * `$`, backticks and `!` inside the double quotes and joins lines ending in `\`. Rule E: the wrapper is
 * opened only when the script has none of `\`, a line break, `$`, a backtick or `!`.
 */
export const unwrapPowerShell = (command: string): { script: string; safe: boolean } | undefined => {
  const m = WRAPPER.exec(command);
  const exe = m ? normaliseAbsolute(m[1] ?? m[2]!) : undefined;
  if (!m || exe === undefined || !POWERSHELL_EXE.test(exe)) return undefined;
  return { script: m[4]!, safe: !/[\\\r\n$`!]/.test(m[4]!) };
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
// Within one rule, the reasons that say most about the risk come first (two shell readings may differ).
const SPECIFIC: readonly ReasonKey[] = ['written-script', 'written-unclear', 'encoded', 'one-liner', 'nested-shell', 'link', 'wildcard'];
const SECRET_MENTION = /(^|[\s'"/\\=:(])(\.env[\w.-]*|id_(rsa|dsa|ecdsa|ed25519)|\.ssh|\.aws|\.gnupg|\.git-credentials|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)(?=$|[\s'"/\\;|&)])/i;

const decide = (findings: readonly Finding[], request: PermissionRequest): PolicyDecision => {
  if (findings.length === 0) return { action: 'approve' };
  const rank = (f: Finding) => PRECEDENCE.indexOf(f.rule) * 100 + (SPECIFIC.includes(f.why) ? SPECIFIC.indexOf(f.why) : 50);
  let top = findings.reduce((best, f) => (rank(f) < rank(best) ? f : best));
  // An unreadable command that names a secret is labelled as a secret read, so root shows the real risk.
  if (top.rule === 'unrecognised' && request.command !== undefined && SECRET_MENTION.test(request.command)) top = finding('secret-read', 'secret-mention');
  return { action: 'escalate', rule: top.rule, reason: REASONS[top.why] };
};

export const evaluatePermission = (request: PermissionRequest, context: PolicyContext): PolicyDecision => {
  const c = new Checker(scopeOf(context), context);
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
      const wrapped = unwrapPowerShell(request.command);
      if (wrapped === undefined) for (const shell of ['ps', 'sh'] as const) c.script(request.command, shell, cwd);
      else {
        // Not safe to open: never approved, but the script is still read as PowerShell for a clearer rule.
        if (!wrapped.safe) c.add('unrecognised', 'syntax');
        c.script(wrapped.script, 'ps', cwd);
      }
      // Codex's own parse of the command (`commandActions`) adds the paths it reads.
      for (const p of request.paths) c.target({ text: p, wild: false }, 'read', [cwd], 'win');
      break;
    }
  }
  return decide(c.findings, request);
};

/** The R-08 / CR-1 policy. Stateless: everything it needs is in the request and the context. */
export const permissionPolicy: PermissionPolicy = { evaluate: evaluatePermission };

// What each recognised program does, for the permission policy (T014, R-08, CR-1). A handler turns one
// simple command into effects (files read, written or run, the folder it works in) plus findings the
// policy can tell from the words alone. A program missing from the tables is unrecognised.
//
// Arguments are read conservatively: for readers and writers every non-option word, and every option
// value, counts as a target path. A value that is not really a path then resolves inside the working
// folder (harmless) or fails to resolve (escalates); it can never make an outside path look inside.
import type { Shell, Word } from './lexer';
import { mentionsSecret } from './paths';
import { type Finding, type ReasonKey, finding } from './reasons';

export interface Effects {
  findings: Finding[];
  reads: Word[];
  writes: Word[];
  /** Files it executes: refused when this session wrote them (CR-1). */
  runs: Word[];
  /** Works in its folder without naming it (`git status`, `npm test`); `at` moves it first (`git -C`). */
  folder?: { access: 'read' | 'write'; at?: Word };
  /** Moves the working folder for the commands after it (`cd`). */
  cd?: Word;
}

export type Handler = (args: readonly Word[]) => Effects;

const none = (): Effects => ({ findings: [], reads: [], writes: [], runs: [] });
const flagged = (...findings: Finding[]): Effects => ({ ...none(), findings });
const unrecognised = (why: ReasonKey = 'unknown-program') => flagged(finding('unrecognised', why));
const word = (text: string): Word => ({ text, wild: false });

const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;
const FLAG_VALUE = /^(--?[A-Za-z0-9][A-Za-z0-9-]*)[=:](.+)$/s;

interface Args {
  flags: string[];
  positionals: Word[];
  /** Values attached to options (`--file=x`, `-Path:x`). */
  values: Word[];
  /** An option with an attached value in an unclear form (`-t../x`), which may name a target. */
  malformed: boolean;
}

const splitArgs = (args: readonly Word[]): Args => {
  const out: Args = { flags: [], positionals: [], values: [], malformed: false };
  let options = true;
  for (const w of args) {
    if (options && w.text === '--') options = false;
    else if (w.text === '-') continue;
    else if (options && w.text.startsWith('-')) {
      const m = FLAG_VALUE.exec(w.text);
      if (m) {
        out.flags.push(m[1]!);
        out.values.push({ text: m[2]!, wild: /[*?[\]]/.test(m[2]!) });
      } else if (FLAG.test(w.text)) out.flags.push(w.text);
      else out.malformed = true;
    } else out.positionals.push(w);
  }
  return out;
};

const targetsOf = (a: Args) => [...a.positionals, ...a.values];

/** Reads its targets, or its folder when it names none (`ls`, `rg pattern`). */
const reader =
  (forbid?: RegExp, maxPositionals = Infinity): Handler =>
  (args) => {
    const a = splitArgs(args);
    if (a.malformed || (forbid && a.flags.some((f) => forbid.test(f)))) return unrecognised('option');
    if (a.positionals.length > maxPositionals) return unrecognised('option');
    const reads = targetsOf(a);
    return { ...none(), reads, ...(reads.length === 0 && { folder: { access: 'read' as const } }) };
  };

const LINK_TYPE = /^(symboliclink|junction|hardlink)$/i;

/** Writes its targets; with none it would write what the pipeline names, which is unknown. */
const writer: Handler = (args) => {
  const a = splitArgs(args);
  if (a.malformed) return unrecognised('option');
  const writes = targetsOf(a);
  if (writes.some((w) => LINK_TYPE.test(w.text))) return unrecognised('link');
  if (writes.length === 0) return unrecognised('unknown-target');
  return { ...none(), writes };
};

/** `-r`, `-R`, `-rf`, `-fr`, `--recursive`, and PowerShell's `-Recurse` with any prefix (`-rec`). */
const isRecursiveFlag = (flag: string) => {
  const name = flag.toLowerCase();
  return name === '--recursive' || (/^-[a-z]+$/.test(name) && ('-recurse'.startsWith(name) || (name.length <= 5 && name.includes('r'))));
};

const remover: Handler = (args) => {
  const a = splitArgs(args);
  if (a.malformed) return unrecognised('option');
  const writes = targetsOf(a);
  // `del /s`, `rd /s` are cmd's recursive forms.
  if (a.flags.some(isRecursiveFlag) || writes.some((w) => w.wild || /^\/s$/i.test(w.text))) return flagged(finding('destructive', 'wide-delete'));
  if (writes.length === 0) return unrecognised('unknown-target');
  return { ...none(), writes };
};

/** Prints or filters without touching files (`echo`, `Select-Object`). Its redirections are still checked. */
const inert: Handler = () => none();

const cd: Handler = (args) => {
  const a = splitArgs(args);
  const targets = targetsOf(a);
  // Bare `cd` goes home and `cd -` goes back; neither target is known here.
  if (a.malformed || targets.length !== 1 || targets[0]!.wild) return unrecognised('unknown-target');
  return { ...none(), cd: targets[0]! };
};

/** GNU find (and Windows find.exe, whose arguments it reads as start paths). */
const find: Handler = (args) => {
  const first = args.findIndex((w) => /^[-!(]/.test(w.text));
  const starts = first < 0 ? [...args] : args.slice(0, first);
  const expression = first < 0 ? [] : args.slice(first).map((w) => w.text.toLowerCase());
  if (expression.includes('-delete')) return flagged(finding('destructive', 'wide-delete'));
  if (expression.some((t) => /^-(exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(t))) return unrecognised('nested-shell');
  return { ...none(), reads: starts, ...(starts.length === 0 && { folder: { access: 'read' as const } }) };
};

/** Only printing a line range (`sed -n '1,40p' file`): other sed scripts can write (`w`) or run (`e`). */
const sed: Handler = (args) => {
  const a = splitArgs(args);
  const [script, ...files] = a.positionals;
  if (a.malformed || a.values.length > 0 || a.flags.length !== 1 || a.flags[0] !== '-n') return unrecognised('option');
  if (script === undefined || !/^(\d+|\$)?(,(\d+|\$))?p$/.test(script.text)) return unrecognised('option');
  return { ...none(), reads: files };
};

const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'grep',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'check-ignore',
  'count-objects',
  'whatchanged',
  'help',
  'version',
]);
const GIT_WRITE = new Set(['add', 'commit', 'mv']);
// Options that make git write a file, read outside the repository or run a program.
const GIT_RISKY_OPTION = /^(--output|--no-index|--open-files-in-pager|-O|--exec|--upload-pack|--receive-pack|--ext-diff)/;
const GIT_BRANCH_LIST = /^(-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--no-color|--color|--sort=.*|--format=.*)$/;
const REMOTE_KEY = /^(remote\.|url\.|branch\..+\.(remote|pushremote|merge)$)/i;

/** `git config`: reading is allowed; remote keys are git-remote, global and system settings destructive. */
const gitConfig = (rest: readonly Word[], at: Word | undefined): Effects => {
  const texts = rest.map((w) => w.text);
  const positionals = texts.filter((t) => !t.startsWith('-'));
  const read = { ...none(), folder: { access: 'read' as const, ...(at && { at }) } };
  const sub = positionals[0]?.toLowerCase();
  if (sub === 'get' || sub === 'list' || texts.some((t) => /^(--get(-all|-regexp|-urlmatch)?|--list|-l)$/.test(t))) return read;
  const mutating = texts.some((t) => /^(--unset|--add|--replace-all|--rename-section|--remove-section|--edit|-e$)/.test(t));
  const newSyntax = sub !== undefined && ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(sub);
  if (!mutating && !newSyntax && positionals.length === 1) return read;
  const key = (newSyntax ? positionals[1] : positionals[0]) ?? '';
  if (REMOTE_KEY.test(key)) return flagged(finding('git-remote', 'git-remote'));
  if (texts.some((t) => t === '--global' || t === '--system')) return flagged(finding('destructive', 'system-settings'));
  return unrecognised();
};

const git: Handler = (args) => {
  let i = 0;
  let at: Word | undefined;
  // Git options are case-sensitive: `-C` is a folder, `-c` sets configuration (aliases, ssh command).
  for (; i < args.length && args[i]!.text.startsWith('-'); i++) {
    const t = args[i]!.text;
    if (t === '-C' && at === undefined && args[i + 1] !== undefined) at = args[++i];
    else if (['--version', '--help', '-v', '-h'].includes(t)) return none();
    else if (!['--no-pager', '--no-optional-locks', '-P', '--literal-pathspecs', '--no-replace-objects'].includes(t)) return unrecognised('option');
  }
  const subWord = args[i];
  if (subWord === undefined) return none();
  const sub = subWord.text.toLowerCase();
  const rest = args.slice(i + 1);
  const texts = rest.map((w) => w.text);
  const inFolder = (access: 'read' | 'write'): Effects => ({ ...none(), folder: { access, ...(at && { at }) } });

  if (sub === 'push') return flagged(finding('git-remote', 'git-remote'));
  if (sub === 'remote') {
    const op = texts.find((t) => !t.startsWith('-'))?.toLowerCase();
    return op === undefined || op === 'show' || op === 'get-url' ? inFolder('read') : flagged(finding('git-remote', 'git-remote'));
  }
  if (sub === 'config') return gitConfig(rest, at);
  // Revisions and pathspecs are not resolved as paths (`HEAD~1`, `main..HEAD`), but secret names in them are caught.
  if (texts.some(mentionsSecret)) return flagged(finding('secret-read', 'secret'));
  if (texts.some((t) => t.startsWith('-') && t !== '--' && !FLAG.test(t) && !FLAG_VALUE.test(t))) return unrecognised('option');
  if (texts.some((t) => GIT_RISKY_OPTION.test(t))) return unrecognised('option');
  if (sub === 'clean') return flagged(finding('destructive', 'git-discard'));
  if (sub === 'reset' && texts.some((t) => ['--hard', '--merge', '--keep'].includes(t))) return flagged(finding('destructive', 'git-discard'));
  if (sub === 'rm') return texts.some((t) => t.startsWith('-') && isRecursiveFlag(t)) ? flagged(finding('destructive', 'wide-delete')) : inFolder('write');
  if (sub === 'branch') {
    if (texts.some((t) => ['-d', '-D', '--delete'].includes(t) || /^-[a-zA-Z]*[dD]$/.test(t))) return flagged(finding('destructive', 'git-discard'));
    return texts.every((t) => GIT_BRANCH_LIST.test(t)) ? inFolder('read') : unrecognised();
  }
  if (sub === 'tag') return texts.every((t) => ['-l', '--list', '-n'].includes(t)) ? inFolder('read') : unrecognised();
  if (sub === 'stash' || sub === 'worktree') return texts[0] === 'list' || (sub === 'stash' && texts[0] === 'show') ? inFolder('read') : unrecognised();
  if (GIT_READ.has(sub)) return inFolder('read');
  if (GIT_WRITE.has(sub)) return inFolder('write');
  return unrecognised();
};

const INSTALL_SUBS = new Set(['install', 'i', 'in', 'ci', 'add', 'uninstall', 'remove', 'rm', 'un', 'r', 'link', 'ln', 'update', 'up', 'upgrade']);
const SCRIPT_SUBS = new Set(['test', 't', 'tst', 'start', 'stop', 'restart']);
const LOCAL_INSTALL_SUBS = new Set(['install', 'i', 'in', 'ci']);
const INFO_SUBS = new Set(['ls', 'list', 'outdated', 'view', 'info', 'why', 'explain', 'help', '-v', '--version', '-h', '--help']);
// Options that move npm elsewhere or change how it runs scripts.
const PM_RISKY_OPTION = /^(--prefix|-C$|--dir|--cwd|--location|--global-dir|--userconfig|--globalconfig|--script-shell|--node-options|-w$|--workspace|--filter|-r$|--recursive)/i;

/**
 * npm, pnpm, yarn. Running package scripts or installing runs whatever package.json says, so a
 * package.json this session wrote counts as running a written script (CR-1).
 */
const packageManager =
  (name: 'npm' | 'pnpm' | 'yarn'): Handler =>
  (args) => {
    const texts = args.map((w) => w.text);
    // On Windows these are .cmd shims, and cmd.exe reads their arguments again.
    if (texts.some((t) => /[&|<>^%!"]/.test(t))) return unrecognised('syntax');
    const global = texts.some((t) => t === '-g' || /^--global/i.test(t) || /^--location=global$/i.test(t)) || (name === 'yarn' && texts[0] === 'global');
    const sub = (name === 'yarn' && texts[0] === 'global' ? texts[1] : texts[0])?.toLowerCase();
    if (global) return sub !== undefined && INSTALL_SUBS.has(sub) ? flagged(finding('destructive', 'global-install')) : unrecognised();
    if (texts.some((t) => PM_RISKY_OPTION.test(t))) return unrecognised('option');
    const runsScripts: Effects = { ...none(), folder: { access: 'write' }, runs: [word('package.json')] };
    if (sub === undefined) return name === 'yarn' ? runsScripts : unrecognised();
    const rest = args.slice(1);
    if (SCRIPT_SUBS.has(sub)) return runsScripts;
    if (sub === 'run' || sub === 'run-script') return rest[0] !== undefined && !rest[0].text.startsWith('-') ? runsScripts : unrecognised();
    // Installing what the lockfile already names; adding packages brings new code, so it is left to the user.
    if (LOCAL_INSTALL_SUBS.has(sub)) return rest.every((w) => w.text.startsWith('-')) ? runsScripts : unrecognised();
    if (INFO_SUBS.has(sub)) return { ...none(), folder: { access: 'read' } };
    return unrecognised();
  };

const pip: Handler = (args) => {
  const sub = args[0]?.text.toLowerCase();
  if (sub === 'install' || sub === 'uninstall' || sub === 'download') return flagged(finding('destructive', 'global-install'));
  return sub === 'list' || sub === 'show' || sub === 'freeze' || sub === '--version' ? none() : unrecognised();
};

const installsWhen =
  (sub: string): Handler =>
  (args) =>
    args.some((w) => w.text.toLowerCase() === sub) ? flagged(finding('destructive', 'global-install')) : unrecognised();

const ONE_LINER = /^(-e|-p|-c|-r|-E|--eval|--print|--command|-command)$/i;

/** `node script.mjs`, `python x.py`, `bash x.sh`: the script must be readable and not written by this session. */
const interpreter: Handler = (args) => {
  const [first, ...rest] = args;
  // With no script the interpreter runs code from its input.
  if (first === undefined) return unrecognised('one-liner');
  if (first.text.startsWith('-')) {
    if (rest.length === 0 && /^(--version|-v|-V|--help|-h)$/.test(first.text)) return none();
    return unrecognised(ONE_LINER.test(first.text) || /^-[a-z]*e$/.test(first.text) ? 'one-liner' : 'option');
  }
  if (first.wild) return unrecognised('unknown-target');
  return { ...none(), runs: [first] };
};

/** PowerShell's `-EncodedCommand` and its prefixes (`-e`, `-ec`, `-enc`). */
const powershell: Handler = (args) =>
  unrecognised(args.some((w) => /^[-/]e(c|n[a-z]*)?$/i.test(w.text)) ? 'encoded' : 'nested-shell');

const nested: Handler = () => unrecognised('nested-shell');
const system: Handler = () => flagged(finding('destructive', 'system-settings'));
const globalInstall: Handler = () => flagged(finding('destructive', 'global-install'));

const table = (entries: Record<string, Handler>, ...groups: [readonly string[], Handler][]): ReadonlyMap<string, Handler> => {
  const map = new Map(Object.entries(entries));
  for (const [names, handler] of groups) for (const name of names) map.set(name, handler);
  return map;
};

const NESTED = [
  'cmd',
  'start',
  'start-process',
  'saps',
  'invoke-expression',
  'iex',
  'invoke-command',
  'icm',
  'invoke-item',
  'ii',
  'wsl',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'regsvr32',
  'runas',
  'sudo',
  'xargs',
  'env',
  'eval',
  'exec',
  'source',
  '.',
  'call',
  'nohup',
  'timeout',
  'time',
  'watch',
  'conhost',
  'explorer',
  'forfiles',
  'parallel',
];
const SYSTEM = [
  'setx',
  'reg',
  'regedit',
  'netsh',
  'bcdedit',
  'bcdboot',
  'schtasks',
  'sc',
  'wmic',
  'powercfg',
  'tzutil',
  'shutdown',
  'format',
  'diskpart',
  'takeown',
  'icacls',
  'cacls',
  'taskkill',
  'kill',
  'stop-process',
  'spps',
  'set-item',
  'si',
  'set-itemproperty',
  'sp',
  'new-itemproperty',
  'remove-itemproperty',
  'set-executionpolicy',
  'set-service',
  'new-service',
  'remove-service',
  'start-service',
  'stop-service',
  'restart-service',
  'suspend-service',
  'set-mppreference',
  'add-mppreference',
  'remove-mppreference',
  'set-netfirewallrule',
  'new-netfirewallrule',
  'set-acl',
  'set-date',
  'set-timezone',
  'restart-computer',
  'stop-computer',
];
const INSTALLERS = ['choco', 'winget', 'scoop', 'msiexec', 'install-module', 'install-package', 'install-script', 'uninstall-module', 'apt', 'apt-get', 'brew', 'gem'];
const INTERPRETERS = ['node', 'python', 'python3', 'py', 'ruby', 'perl', 'php', 'bash', 'sh'];

/** Programs and names that mean the same in PowerShell and Git Bash, or are equally refused in both. */
const COMMON = table(
  {
    ls: reader(),
    dir: reader(),
    cat: reader(),
    type: reader(),
    head: reader(),
    tail: reader(),
    wc: reader(),
    grep: reader(),
    egrep: reader(),
    fgrep: reader(),
    rg: reader(/^--pre/),
    diff: reader(),
    cmp: reader(),
    file: reader(),
    stat: reader(),
    du: reader(),
    realpath: reader(),
    basename: reader(),
    dirname: reader(),
    cut: reader(),
    nl: reader(),
    md5sum: reader(),
    sha256sum: reader(),
    sort: reader(/^(-[a-zA-Z]*o|--output)/),
    uniq: reader(undefined, 1),
    find,
    sed,
    echo: inert,
    pwd: inert,
    which: inert,
    whoami: inert,
    sleep: inert,
    mkdir: writer,
    touch: writer,
    tee: writer,
    cp: writer,
    mv: writer,
    rm: remover,
    rmdir: remover,
    cd,
    git,
    npm: packageManager('npm'),
    pnpm: packageManager('pnpm'),
    yarn: packageManager('yarn'),
    pip,
    pip3: pip,
    cargo: installsWhen('install'),
    go: installsWhen('install'),
    dotnet: installsWhen('install'),
    powershell,
    pwsh: powershell,
  },
  [NESTED, nested],
  [SYSTEM, system],
  [INSTALLERS, globalInstall],
  [INTERPRETERS, interpreter],
);

/** PowerShell cmdlets and aliases. */
const PS_ONLY = table(
  {
    'get-childitem': reader(),
    gci: reader(),
    'get-content': reader(),
    gc: reader(),
    'select-string': reader(),
    sls: reader(),
    'test-path': reader(),
    'resolve-path': reader(),
    'get-item': reader(),
    gi: reader(),
    'get-filehash': reader(),
    'import-csv': reader(),
    'split-path': reader(),
    'join-path': reader(),
    'set-location': cd,
    sl: cd,
    chdir: cd,
  },
  [['remove-item', 'ri', 'del', 'erase', 'rd'], remover],
  [
    [
      'new-item',
      'ni',
      'md',
      'set-content',
      'add-content',
      'ac',
      'out-file',
      'clear-content',
      'clc',
      'tee-object',
      'export-csv',
      'export-clixml',
      'copy',
      'copy-item',
      'cpi',
      'move',
      'move-item',
      'mi',
      'ren',
      'rename-item',
      'rni',
    ],
    writer,
  ],
  [
    [
      'get-location',
      'gl',
      'write-output',
      'write',
      'write-host',
      'get-date',
      'start-sleep',
      'select-object',
      'select',
      'sort-object',
      'measure-object',
      'measure',
      'group-object',
      'format-table',
      'ft',
      'format-list',
      'fl',
      'out-string',
      'out-null',
      'out-host',
      'convertto-json',
      'convertfrom-json',
      'get-unique',
      'compare-object',
      'get-command',
      'gcm',
    ],
    inert,
  ],
);

const SH_ONLY = table({ printf: inert, true: inert, false: inert, unlink: remover });

// cmd.exe built-ins: not programs, so Git Bash cannot find them.
const CMD_BUILTINS = new Set(['copy', 'move', 'ren', 'del', 'erase', 'rd', 'md']);

/**
 * The handler for a command name in one shell. In Git Bash a PowerShell cmdlet (`Get-Content`) or a cmd
 * built-in is simply not found, so it does nothing there; its redirections are still checked.
 */
export const handlerFor = (name: string, shell: Shell): Handler | undefined => {
  const n = name.toLowerCase().replace(/\.exe$/, '');
  if (shell === 'ps') return PS_ONLY.get(n) ?? COMMON.get(n);
  const known = SH_ONLY.get(n) ?? COMMON.get(n);
  if (known) return known;
  return PS_ONLY.has(n) && (n.includes('-') || CMD_BUILTINS.has(n)) ? inert : undefined;
};

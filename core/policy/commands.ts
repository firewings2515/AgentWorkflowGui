// What each recognised program does, for the permission policy (T014, R-08, CR-1). A handler turns one
// simple command into effects (files read, written or run, the folder it works in) plus findings the
// policy can tell from the words alone. A program missing from the tables is unrecognised.
//
// Every program is parsed against its own option table (review round 2, rule A): which options exist,
// whether each takes a value, and whether that value is text, a number or a path (read, written, a
// folder written into, a new name beside the source). An option that is not in the table, an
// abbreviation of one, or a value in a form the table does not allow makes the command unrecognised.
// GNU and git options follow getopt: short options cluster (`-rf`) and a short option's value may be
// attached (`-n5`, `-f123`); long values come after `=` or as the next word. PowerShell parameters are
// matched by unique prefix as PowerShell does, and an unquoted `-x` is always a parameter name, never a
// value. Paths with wildcards are refused later, by the policy (rule B).
import type { Shell, Word } from './lexer';
import { mentionsSecret } from './paths';
import { type Finding, type ReasonKey, finding } from './reasons';

/**
 * A path a command touches. `base`: the folder it is relative to, itself relative to the working
 * folder (`git -C dir`, Rename-Item's source folder). `node`: run by Node, which also tries extensions
 * and index files.
 */
export interface Target extends Word {
  base?: string;
  node?: boolean;
}

export interface Effects {
  findings: Finding[];
  reads: Target[];
  writes: Target[];
  /** Files it executes: refused when this session wrote them (CR-1). */
  runs: Target[];
  /** Files or folders it takes code or settings from (`.npmrc`, `.husky`): refused only when this session wrote them. */
  loads: Target[];
  /** Works in its folder without naming it (`git status`, `npm test`); `at` moves it first (`git -C`). */
  folder?: { access: 'read' | 'write'; at?: Word };
  /** Moves the working folder for the commands after it (`cd`). */
  cd?: Word;
  /** In PowerShell, when fed by `|`, it would take a target from the upstream objects. */
  pipedTarget?: boolean;
}

export type Handler = (args: readonly Word[]) => Effects;

const none = (): Effects => ({ findings: [], reads: [], writes: [], runs: [], loads: [] });
const flagged = (...findings: Finding[]): Effects => ({ ...none(), findings });
const unrecognised = (why: ReasonKey = 'unknown-program') => flagged(finding('unrecognised', why));
const word = (text: string): Word => ({ text, wild: /[*?[\]]/.test(text) });

// ---- Option tables -------------------------------------------------------------------------------

type Kind = 'flag' | 'text' | 'num' | 'optional' | 'read' | 'write' | 'dest' | 'sibling' | 'child' | 'filter' | 'cd';
const MARKS: Readonly<Record<string, Kind>> = {
  '': 'flag',
  '=': 'text',
  '#': 'num',
  '?': 'optional',
  '@': 'read',
  '>': 'write',
  '/': 'dest',
  '~': 'sibling',
  '^': 'child',
  '%': 'filter',
  '!': 'cd',
};

interface Opt {
  name: string;
  kind: Kind;
  position?: number;
}

interface OptionTable {
  options: Map<string, Opt>;
  aliases: Map<string, string>;
}

/**
 * Reads a table written as `name` (switch), `name=` (text), `name#` (number), `name?` (text only when
 * attached), `name@` (path read), `name>` (path written), `name/` (folder written into), `name~` (new
 * name beside the path), `name^` (name under the path), `name%` (wildcard filter on the targets) or
 * `name!` (folder to move to). A PowerShell position follows the mark (`Path@0`); `alias:name` adds an
 * alias. PowerShell names are case-insensitive, GNU and git names are not (`-C` is not `-c`).
 */
const optionTable = (spec: string, caseSensitive: boolean): OptionTable => {
  const key = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const table: OptionTable = { options: new Map(), aliases: new Map() };
  for (const token of spec.split(/\s+/).filter(Boolean)) {
    const alias = /^([^:]+):(.+)$/.exec(token);
    if (alias) {
      table.aliases.set(key(alias[1]!), key(alias[2]!));
      continue;
    }
    const m = /^([A-Za-z0-9][\w-]*)([=#?@>/~^%!]?)(\d?)$/.exec(token);
    if (!m) throw new Error(`bad option spec: ${token}`);
    table.options.set(key(m[1]!), { name: key(m[1]!), kind: MARKS[m[2]!]!, ...(m[3] && { position: Number(m[3]) }) });
  }
  return table;
};

const valueOk = (kind: Kind, w: Word) => kind !== 'num' || /^[+-]?\d+[kmgb]?$/i.test(w.text);

interface Bound {
  opt: Opt;
  value?: Word;
}

interface Posix {
  short: OptionTable;
  long: OptionTable;
  /** Accepts the old `-NUM` form (`head -5`, `git log -3`). */
  legacyNumber: boolean;
}

const posix = (short: string, long: string, legacyNumber = false): Posix => ({
  short: optionTable(short, true),
  long: optionTable(long, true),
  legacyNumber,
});

interface Parsed {
  bound: Bound[];
  positionals: Word[];
  /** How many positionals came before `--`, when there was one. */
  dashDash?: number;
}

/** getopt-style parsing against a table; `undefined` for anything the table does not allow. */
const parsePosix = (args: readonly Word[], spec: Posix): Parsed | undefined => {
  const out: Parsed = { bound: [], positionals: [] };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (!options || t === '-' || !t.startsWith('-')) {
      out.positionals.push(w);
      continue;
    }
    if (t === '--') {
      options = false;
      out.dashDash = out.positionals.length;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const opt = spec.long.options.get(eq < 0 ? t.slice(2) : t.slice(2, eq));
      if (opt === undefined) return undefined;
      const attached = eq < 0 ? undefined : word(t.slice(eq + 1));
      if (opt.kind === 'flag' && attached !== undefined) return undefined;
      if (opt.kind === 'flag' || opt.kind === 'optional') {
        out.bound.push({ opt, ...(attached && { value: attached }) });
        continue;
      }
      const value = attached ?? args[++i];
      if (value === undefined || !valueOk(opt.kind, value)) return undefined;
      out.bound.push({ opt, value });
      continue;
    }
    if (spec.legacyNumber && /^-\d+$/.test(t)) continue;
    for (let j = 1; j < t.length; j++) {
      const opt = spec.short.options.get(t[j]!);
      if (opt === undefined) return undefined;
      if (opt.kind === 'flag') {
        out.bound.push({ opt });
        continue;
      }
      // A short option with a value takes the rest of the word (`-n5`, `-f123`), or else the next word.
      const rest = t.slice(j + 1);
      const value = rest !== '' ? word(rest) : opt.kind === 'optional' ? undefined : args[++i];
      if (opt.kind !== 'optional' && (value === undefined || !valueOk(opt.kind, value))) return undefined;
      out.bound.push({ opt, ...(value && { value }) });
      break;
    }
  }
  return out;
};

const PS_COMMON =
  'ErrorAction= ea:ErrorAction WarningAction= wa:WarningAction InformationAction= infa:InformationAction ProgressAction= proga:ProgressAction Verbose vb:Verbose Debug db:Debug WhatIf wi:WhatIf Confirm cf:Confirm OutVariable= ov:OutVariable ErrorVariable= ev:ErrorVariable WarningVariable= wv:WarningVariable InformationVariable= iv:InformationVariable OutBuffer# ob:OutBuffer PipelineVariable= pv:PipelineVariable';

/** PowerShell parameter binding against a table: names by unique prefix, then positions. */
const parsePs = (args: readonly Word[], table: OptionTable): Map<string, Word[]> | undefined => {
  const bound = new Map<string, Word[]>();
  const positionals: Word[] = [];
  const lookup = (given: string): Opt | undefined => {
    const exact = table.options.get(given) ?? table.options.get(table.aliases.get(given) ?? '');
    if (exact) return exact;
    const hits = new Set<string>();
    for (const name of table.options.keys()) if (name.startsWith(given)) hits.add(name);
    for (const [alias, name] of table.aliases) if (alias.startsWith(given)) hits.add(name);
    return hits.size === 1 ? table.options.get([...hits][0]!) : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w.quoted || !w.text.startsWith('-')) {
      positionals.push(w);
      continue;
    }
    const m = /^-([A-Za-z][\w-]*)(?::(.+))?$/s.exec(w.text);
    const opt = m ? lookup(m[1]!.toLowerCase()) : undefined;
    if (m === null || opt === undefined || bound.has(opt.name)) return undefined;
    if (opt.kind === 'flag') {
      if (m[2] !== undefined) return undefined;
      bound.set(opt.name, []);
      continue;
    }
    // A missing value, or an unquoted `-x` where the value should be, is an error in PowerShell too.
    const value = m[2] !== undefined ? word(m[2]) : args[++i];
    if (value === undefined || (!value.quoted && value.text.startsWith('-')) || !valueOk(opt.kind, value)) return undefined;
    bound.set(opt.name, [value]);
  }
  const slots = [...table.options.values()].filter((o) => o.position !== undefined && !bound.has(o.name)).sort((a, b) => a.position! - b.position!);
  if (positionals.length > slots.length) return undefined;
  positionals.forEach((w, k) => bound.set(slots[k]!.name, [w]));
  return bound;
};

/** The folder of a path as written (`scripts/a.js` → `scripts`, `a.js` → `.`). */
const folderOf = (text: string) => {
  const p = text.replaceAll('\\', '/').replace(/\/+$/, '');
  const cut = p.lastIndexOf('/');
  return cut < 0 ? (/^[a-z]:/i.test(p) ? p.slice(0, 2) + '/' : '.') : cut === 0 ? '/' : /^[a-z]:$/i.test(p.slice(0, cut)) ? p.slice(0, cut + 1) : p.slice(0, cut);
};

const LINK_TYPE = /^(symboliclink|junction|hardlink)$/i;

/**
 * Where copying or moving one `source` may land. With a destination it is not known whether that is an
 * existing folder, so both `dest` and `dest/<name>` count; without one (PowerShell's default) it is
 * `<name>` in the working folder. Several sources, or a source whose name is unclear, are unrecognised.
 */
const landings = (sources: readonly Target[], dest: Target | undefined): Target[] | Effects => {
  if (sources.length !== 1) return unrecognised(sources.length === 0 ? 'unknown-target' : 'wildcard');
  const source = sources[0]!;
  if (source.wild) return unrecognised('wildcard');
  const name = source.text.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() ?? '';
  if (name === '' || name === '.' || name === '..' || /^[a-z]:$/i.test(name)) return unrecognised('unknown-target');
  if (dest === undefined) return [word(name)];
  return [dest, { ...dest, text: `${dest.text.replace(/[\\/]+$/, '')}/${name}` }];
};

interface CmdletOptions {
  /** What it does with its targets; `remove` makes recursion and filters destructive, `copy` lands the source. */
  mode: 'read' | 'list' | 'write' | 'remove' | 'cd' | 'new' | 'copy';
  /** Destination, new name or value may also come from the pipeline, so piping into it is never understood. */
  pipedAny?: boolean;
}

const PATH_PARAMS = ['path', 'literalpath', 'filepath'];

/** A PowerShell cmdlet with its parameter table. */
const cmdlet = (spec: string, { mode, pipedAny = false }: CmdletOptions): Handler => {
  const table = optionTable(`${spec} ${PS_COMMON}`, false);
  return (args) => {
    // `del /s`, `rd /s`: cmd's recursive delete, typed where PowerShell's aliases run instead.
    if (mode === 'remove' && args.some((w) => /^\/s$/i.test(w.text))) return flagged(finding('destructive', 'wide-delete'));
    const bound = parsePs(args, table);
    if (bound === undefined) return unrecognised('option');
    // NTFS alternate data streams are not followed.
    if (bound.has('stream')) return unrecognised('unknown-target');
    const fx = none();
    const source = PATH_PARAMS.map((p) => bound.get(p)?.[0]).find((w) => w !== undefined);
    let filtered = false;
    let dest: Word | undefined;
    for (const [name, values] of bound) {
      const kind = table.options.get(name)!.kind;
      for (const value of values) {
        if (kind === 'read') fx.reads.push(value);
        else if (kind === 'write') fx.writes.push(value);
        else if (kind === 'dest') dest = value;
        else if (kind === 'filter') filtered = true;
        else if (kind === 'cd') fx.cd = value;
        else if (kind === 'child') fx.writes.push({ ...value, base: source?.text ?? '.' });
        else if (kind === 'sibling') {
          // Rename-Item's new name lands next to the source.
          if (source === undefined || /[\\/:]/.test(value.text)) return unrecognised('unknown-target');
          fx.writes.push({ ...value, base: folderOf(source.text) });
        }
      }
    }
    fx.pipedTarget = pipedAny || source === undefined;
    if (mode === 'copy' && source !== undefined) {
      const landed = landings([source], dest);
      if (!Array.isArray(landed)) return landed;
      fx.writes.push(...landed);
    }
    if (mode === 'remove' && (filtered || bound.has('recurse') || fx.writes.some((w) => w.wild))) return flagged(finding('destructive', 'wide-delete'));
    if (filtered && mode !== 'list') return unrecognised('wildcard');
    if (mode === 'new' && bound.get('itemtype')?.some((w) => LINK_TYPE.test(w.text))) return unrecognised('link');
    if (mode === 'list' && fx.reads.length === 0) fx.folder = { access: 'read' };
    return fx;
  };
};

interface ToolOptions {
  /** What its positional arguments are. `pattern`: the first is a search pattern unless one is given by option. */
  positionals: 'read' | 'write' | 'pattern' | 'copy' | 'none';
  /** Reads its folder when it names no file (`ls`, `rg pattern`). */
  folderWhenEmpty?: boolean;
  /** Options that give the pattern, so every positional is a path. */
  patternOptions?: readonly string[];
  maxPositionals?: number;
  /** Options that make it delete widely. */
  destructive?: readonly string[];
}

/** A GNU-style tool with its option table. */
const tool = (spec: Posix, o: ToolOptions): Handler => (args) => {
  const parsed = parsePosix(args, spec);
  if (parsed === undefined) return unrecognised('option');
  const fx = none();
  let dest: Word | undefined;
  for (const { opt, value } of parsed.bound) {
    if (value === undefined) continue;
    if (opt.kind === 'read') fx.reads.push(value);
    else if (opt.kind === 'write') fx.writes.push(value);
    else if (opt.kind === 'dest') dest = value;
  }
  let positionals = parsed.positionals;
  if (o.maxPositionals !== undefined && positionals.length > o.maxPositionals) return unrecognised('option');
  if (o.positionals === 'pattern' && !parsed.bound.some((b) => o.patternOptions?.includes(b.opt.name))) positionals = positionals.slice(1);
  if (o.positionals === 'read' || o.positionals === 'pattern') fx.reads.push(...positionals);
  if (o.positionals === 'write' || o.positionals === 'copy') fx.writes.push(...positionals);
  if (o.positionals === 'copy') {
    // cp/mv: the folder given by -t, or else the last argument, receives the sources.
    const sources = dest === undefined ? positionals.slice(0, -1) : positionals;
    const landed = landings(sources, dest ?? positionals.at(-1));
    if (!Array.isArray(landed)) return landed;
    fx.writes.push(...landed);
  }
  if (parsed.bound.some((b) => o.destructive?.includes(b.opt.name)) || (o.destructive && fx.writes.some((w) => w.wild))) {
    return flagged(finding('destructive', 'wide-delete'));
  }
  if (o.folderWhenEmpty && fx.reads.length === 0) fx.folder = { access: 'read' };
  return fx;
};

/** Prints or filters without touching files (`echo`, `Select-Object`). Its redirections are still checked. */
const inert: Handler = () => none();

// ---- GNU tools ------------------------------------------------------------------------------------

const ls = tool(
  posix(
    'a A l h R r t S 1 d F G g o p i s U v c u Q N x C m',
    'all almost-all human-readable recursive reverse classify directory color? group-directories-first sort= time= format= indicator-style= ignore= hide= literal quoting-style= width# full-time no-group numeric-uid-gid si size inode',
  ),
  { positionals: 'read', folderWhenEmpty: true },
);
const cat = tool(posix('n b s A E T v e t u', 'number number-nonblank squeeze-blank show-all show-ends show-tabs show-nonprinting'), { positionals: 'read' });
const head = tool(posix('n# c# q v z', 'lines# bytes# quiet silent verbose zero-terminated', true), { positionals: 'read' });
const tail = tool(posix('n# c# q v z f F s#', 'lines# bytes# quiet silent verbose zero-terminated follow? retry pid# sleep-interval#', true), { positionals: 'read' });
const wc = tool(posix('l w c m L', 'lines words bytes chars max-line-length'), { positionals: 'read' });
const GREP = posix(
  'i y v n r R l L c o q s w x E F G P H h a I z U b e= f@ A# B# C# m#',
  'ignore-case no-ignore-case invert-match line-number recursive dereference-recursive files-with-matches files-without-match count only-matching quiet silent no-messages word-regexp line-regexp extended-regexp fixed-strings basic-regexp perl-regexp with-filename no-filename text color? colour? include= exclude= exclude-dir= regexp= file@ after-context# before-context# context# max-count# null null-data binary-files= byte-offset label=',
);
const grep = tool(GREP, { positionals: 'pattern', patternOptions: ['e', 'f', 'regexp', 'file'], folderWhenEmpty: true });
// ripgrep without `--pre`, `--pre-glob`, `--hostname-bin`, `--search-zip` and the other options that start programs.
const RG = posix(
  'n N i S s w x F l c v o H I L u a q U P 0 h e= f@ A# B# C# m# d# g= t= T= j# M# E= r=',
  'line-number no-line-number ignore-case smart-case case-sensitive word-regexp line-regexp fixed-strings files-with-matches files-without-match files count count-matches context# after-context# before-context# glob= iglob= type= type-not= hidden no-ignore no-ignore-vcs follow invert-match only-matching json heading no-heading with-filename no-filename color= max-count# max-depth# sort= sortr= multiline multiline-dotall pcre2 trim vimgrep null column stats quiet max-filesize= text regexp= file@ threads# max-columns# max-columns-preview encoding= no-messages type-list unrestricted binary passthru replace= help version',
);
const rg = tool(RG, { positionals: 'pattern', patternOptions: ['e', 'f', 'regexp', 'file', 'files', 'type-list'], folderWhenEmpty: true });
const sort = tool(posix('r n u f b d h V M R s z k= t=', 'reverse numeric-sort unique ignore-case key= field-separator= version-sort human-numeric-sort stable'), {
  positionals: 'read',
});
const uniq = tool(posix('c d u i f# s#', 'count repeated unique ignore-case skip-fields# skip-chars#'), { positionals: 'read', maxPositionals: 1 });
const cut = tool(posix('d= f= c= b= s', 'delimiter= fields= characters= bytes= complement only-delimited'), { positionals: 'read' });
const diff = tool(
  posix(
    'u U# q r N w b B i y',
    'unified? brief recursive new-file ignore-all-space ignore-space-change ignore-blank-lines ignore-case color? strip-trailing-cr text side-by-side',
  ),
  { positionals: 'read' },
);
const mkdir = tool(posix('p v m=', 'parents verbose mode='), { positionals: 'write' });
const touch = tool(posix('a c m', 'no-create'), { positionals: 'write' });
const tee = tool(posix('a i', 'append ignore-interrupts'), { positionals: 'write' });
const rm = tool(posix('f r R i I v d', 'force recursive interactive? verbose dir one-file-system'), {
  positionals: 'write',
  destructive: ['r', 'R', 'recursive'],
});
const rmdir = tool(posix('p v', 'parents verbose ignore-fail-on-non-empty'), { positionals: 'write' });
const unlink = tool(posix('', ''), { positionals: 'write' });
// cp without `-l` and `-s` (links); `-t` names the folder everything goes into.
const cp = tool(
  posix(
    'r R a f i n p v u L P H T t/',
    'recursive archive force interactive no-clobber preserve? no-preserve= verbose update? target-directory/ no-target-directory parents dereference no-dereference',
  ),
  { positionals: 'copy' },
);
const mv = tool(posix('f i n v u T t/', 'force interactive no-clobber verbose update? target-directory/ no-target-directory'), { positionals: 'copy' });

const cdTool = (spec: Posix | undefined): Handler => (args) => {
  const parsed = spec ? parsePosix(args, spec) : { bound: [], positionals: [...args] };
  // Bare `cd` goes home and `cd -` goes back; neither target is known here.
  if (parsed === undefined || parsed.positionals.length !== 1 || parsed.positionals[0]!.text === '-') return unrecognised('unknown-target');
  return { ...none(), cd: parsed.positionals[0]! };
};

const FIND_VALUE = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-type', '-xtype', '-maxdepth', '-mindepth', '-size', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-regex', '-iregex', '-user', '-group', '-perm', '-links']);
const FIND_FLAG = new Set(['-print', '-print0', '-empty', '-not', '!', '-a', '-o', '-and', '-or', '-true', '-false', '-prune', '-depth', '-readable', '-writable', '-executable', '-quit']);

/** GNU find (and Windows find.exe, whose arguments it reads as start paths). */
const find: Handler = (args) => {
  const first = args.findIndex((w) => /^[-!(]/.test(w.text));
  const starts = first < 0 ? [...args] : args.slice(0, first);
  const fx: Effects = { ...none(), reads: starts, ...(starts.length === 0 && { folder: { access: 'read' as const } }) };
  for (let i = first < 0 ? args.length : first; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-delete') return flagged(finding('destructive', 'wide-delete'));
    if (/^-(exec|execdir|ok|okdir)$/.test(t)) return unrecognised('nested-shell');
    if (t === '-newer' && args[i + 1] !== undefined) fx.reads.push(args[++i]!);
    else if (FIND_VALUE.has(t) && args[i + 1] !== undefined) i++;
    else if (!FIND_FLAG.has(t)) return unrecognised('option');
  }
  return fx;
};

/** Only printing a line range (`sed -n '1,40p' file`): other sed scripts can write (`w`) or run (`e`). */
const sed: Handler = (args) => {
  const [flag, script, ...files] = args;
  if (flag?.text !== '-n' || script === undefined || !/^(\d+|\$)?(,(\d+|\$))?p$/.test(script.text)) return unrecognised('option');
  if (files.some((w) => w.text.startsWith('-'))) return unrecognised('option');
  return { ...none(), reads: files };
};

// ---- git ------------------------------------------------------------------------------------------

const LOG_SHORT = 'p u s z n# S= G= U# i E F P';
const LOG_LONG =
  'oneline graph decorate? no-decorate decorate-refs= all stat? shortstat name-only name-status format= pretty? max-count# skip# since= until= after= before= author= committer= grep= all-match invert-grep regexp-ignore-case extended-regexp fixed-strings perl-regexp patch no-patch patch-with-stat summary reverse first-parent merges no-merges min-parents# max-parents# abbrev-commit no-abbrev-commit abbrev? date= relative-date follow color? no-color numstat full-diff source topo-order date-order left-right boundary cherry-pick cherry-mark ancestry-path simplify-by-decoration full-history branches? tags? remotes? word-diff? diff-filter= unified# ignore-all-space ignore-space-change histogram patience minimal find-renames? no-renames';
const DIFF_SHORT = 'p u U# w b R z a';
const DIFF_LONG =
  'stat? shortstat numstat name-only name-status cached staged color? no-color word-diff? word-diff-regex= color-words? ignore-all-space ignore-space-change ignore-blank-lines ignore-space-at-eol patience histogram minimal unified# diff-filter= relative? exit-code quiet check find-renames? no-renames merge-base text summary patch no-patch abbrev? src-prefix= dst-prefix= no-prefix ita-invisible-in-index function-context dirstat?';

interface GitSub {
  spec: Posix;
  access: 'read' | 'write';
  /**
   * What its positionals are. `paths`: all paths; `mixed`: revisions or paths, so anything that does not
   * look like a revision is checked as a path; `refs`: revisions only. Everything after `--` is a path.
   */
  positionals: 'paths' | 'mixed' | 'refs';
  /** Its positionals are files it writes (`git rm`); `git mv` also lands its source in the last one. */
  writesPositionals?: boolean;
  destructive?: readonly string[];
}

const sub = (short: string, long: string, positionals: GitSub['positionals'], access: 'read' | 'write' = 'read', extra: Partial<GitSub> = {}, legacyNumber = false): GitSub => ({
  spec: posix(short, long, legacyNumber),
  positionals,
  access,
  ...extra,
});

const GIT_SUBS: Readonly<Record<string, GitSub>> = {
  status: sub(
    's b u? z v',
    'short branch porcelain? long untracked-files? ignored? ignore-submodules? column? no-column ahead-behind no-ahead-behind renames no-renames find-renames? show-stash verbose null',
    'paths',
  ),
  log: sub(LOG_SHORT, LOG_LONG, 'mixed', 'read', {}, true),
  whatchanged: sub(LOG_SHORT, LOG_LONG, 'mixed', 'read', {}, true),
  shortlog: sub('s n e c', 'summary numbered email committer all since= until= group= format=', 'mixed'),
  diff: sub(DIFF_SHORT, DIFF_LONG, 'mixed'),
  show: sub(`${LOG_SHORT} w b R a`, `${LOG_LONG} ${DIFF_LONG}`, 'mixed', 'read', {}, true),
  add: sub('A u n v f N', 'all no-all update dry-run verbose force intent-to-add ignore-errors pathspec-from-file@ pathspec-file-nul renormalize ignore-removal chmod= sparse', 'paths', 'write'),
  commit: sub(
    'm= a F@ t@ q v n s e C= c=',
    'message= all file@ template@ quiet verbose no-verify verify signoff no-signoff amend no-edit edit allow-empty allow-empty-message author= date= only include pathspec-from-file@ pathspec-file-nul fixup= squash= reuse-message= reedit-message= cleanup= dry-run short branch porcelain long status no-status untracked-files? reset-author trailer= no-gpg-sign',
    'paths',
    'write',
  ),
  mv: sub('f k n v', 'force dry-run verbose', 'paths', 'write', { writesPositionals: true }),
  rm: sub('r f n q', 'cached recursive force dry-run quiet ignore-unmatch sparse pathspec-from-file@', 'paths', 'write', { writesPositionals: true, destructive: ['r', 'recursive'] }),
  blame: sub(
    'L= w e s l t b c p n f S@',
    'contents@ ignore-revs-file@ ignore-rev= porcelain line-porcelain incremental date= show-name show-number root reverse= first-parent color-lines color-by-age abbrev? show-stats encoding=',
    'mixed',
  ),
  annotate: sub('L= w e s l t b c p n f S@', 'contents@ ignore-revs-file@ ignore-rev= porcelain date= root abbrev? encoding=', 'mixed'),
  'ls-files': sub(
    'c d o i s u k m t v f z X@ x=',
    'cached deleted others ignored stage unmerged killed modified exclude= exclude-from@ exclude-per-directory= exclude-standard full-name error-unmatch directory no-empty-directory eol deduplicate format= recurse-submodules abbrev? sparse',
    'paths',
  ),
  'ls-tree': sub('d r t l z', 'name-only name-status object-only full-name full-tree abbrev? format= long', 'mixed'),
  'rev-parse': sub(
    'q',
    'abbrev-ref? short? verify quiet show-toplevel git-dir git-common-dir absolute-git-dir is-inside-work-tree is-inside-git-dir is-bare-repository is-shallow-repository show-prefix show-cdup symbolic-full-name symbolic all branches? tags? remotes? since= until= default=',
    'refs',
  ),
  'rev-list': sub('n#', 'count max-count# all reverse left-right first-parent no-merges merges since= until= after= before= topo-order date-order', 'mixed', 'read', {}, true),
  describe: sub('', 'tags always abbrev? dirty? broken? long exact-match contains all match= exclude= first-parent candidates#', 'refs'),
  'cat-file': sub('p t s e', 'batch? batch-check? batch-all-objects allow-unknown-type', 'refs'),
  grep: sub(
    'n i l L c w v E F P G h H e= f@ A# B# C# I q a z o',
    'line-number ignore-case files-with-matches files-without-match name-only count word-regexp invert-match extended-regexp fixed-strings perl-regexp basic-regexp untracked cached recurse-submodules all-match max-depth# heading break show-function function-context color? no-color and or not text full-name only-matching quiet threads# exclude-standard no-exclude-standard',
    'mixed',
  ),
  'merge-base': sub('', 'all is-ancestor fork-point independent octopus', 'refs'),
  'name-rev': sub('', 'name-only tags refs= exclude= all no-undefined always', 'refs'),
  'for-each-ref': sub('', 'format= sort= count# shell python perl tcl contains= no-contains= merged? no-merged? points-at= ignore-case', 'refs'),
  'show-ref': sub('d q s', 'heads tags head verify hash? abbrev? quiet dereference exists', 'refs'),
  'check-ignore': sub('q v n z', 'quiet verbose non-matching stdin', 'paths'),
  'count-objects': sub('v H', 'verbose human-readable', 'refs'),
  help: sub('a g', 'all guides', 'refs'),
  version: sub('', 'build-options', 'refs'),
};
// Folders git commit runs hooks from when the repository points `core.hooksPath` into the worktree (husky).
const GIT_HOOK_FOLDERS = ['.husky', '.githooks', '.git/hooks'];
const GIT_CONFIG = posix(
  'f@ l e z',
  'file@ blob= global system local worktree list get get-all get-regexp get-urlmatch unset unset-all add replace-all rename-section remove-section edit show-origin show-scope name-only null type= bool int bool-or-int path expiry-date includes no-includes default= fixed-value',
);
const GIT_BRANCH = posix('a r v l', 'list all remotes verbose show-current no-color color? sort= format= contains= no-contains= merged? no-merged? points-at= column? no-column abbrev? omit-empty');
const GIT_TAG = posix('l n?', 'list sort= contains= no-contains= points-at= merged? no-merged? format= column? no-column ignore-case');
const GIT_STASH_LIST = posix(LOG_SHORT, LOG_LONG);
const GIT_STASH_SHOW = posix(DIFF_SHORT, DIFF_LONG);
const GIT_WORKTREE_LIST = posix('v z', 'porcelain verbose expire=');
const GIT_REMOTE = posix('v', 'verbose');
const GIT_REMOTE_SHOW = posix('n', '');
const GIT_REMOTE_GET_URL = posix('', 'push all');
// A word git reads as a revision: `HEAD~1`, `main^`, `a..b`, `HEAD:path`, `@{u}`, a hash or a special head.
// A `..` next to a slash (`../x`) is a path, not a range.
const REVISION = /[~^:]|[^./\\]\.\.|\.\.[^./\\]|@\{|^@$|^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$|^[0-9a-f]{7,40}$/i;
const REMOTE_KEY = /^(remote\.|url\.|branch\..+\.(remote|pushremote|merge)$)/i;

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
  const name = subWord.text.toLowerCase();
  const rest = args.slice(i + 1);
  const texts = rest.map((w) => w.text);
  // Files named in git's arguments are relative to the folder `-C` moved to.
  const inRepo = (w: Word): Target => (at === undefined ? w : { ...w, base: at.text });
  const parse = (spec: Posix, access: 'read' | 'write', mode: GitSub['positionals'], args: readonly Word[] = rest): Effects => {
    const parsed = parsePosix(args, spec);
    if (parsed === undefined) return unrecognised('option');
    const fx: Effects = { ...none(), folder: { access, ...(at && { at }) } };
    for (const { opt, value } of parsed.bound) if (value !== undefined && opt.kind === 'read') fx.reads.push(inRepo(value));
    const end = parsed.dashDash ?? parsed.positionals.length;
    let positionals = parsed.positionals;
    // `git grep`: the first positional is the pattern unless -e or -f gives it.
    if (name === 'grep' && !parsed.bound.some((b) => ['e', 'f'].includes(b.opt.name))) positionals = positionals.slice(1);
    const offset = parsed.positionals.length - positionals.length;
    positionals.forEach((p, k) => {
      const afterDashDash = k + offset >= end;
      // Before `--` a word that reads as a revision (`HEAD~1`, `a..b`, `HEAD:path`, a hash) is one; any other is checked as a path.
      if (afterDashDash || mode === 'paths' || (mode === 'mixed' && !REVISION.test(p.text))) fx.reads.push(inRepo(p));
    });
    return fx;
  };

  if (name === 'push') return flagged(finding('git-remote', 'git-remote'));
  // Secret names anywhere in the arguments (`HEAD:.env`, `-- .env`) are caught without resolving them.
  if (texts.some(mentionsSecret)) return flagged(finding('secret-read', 'secret'));
  if (name === 'remote') {
    const op = texts.find((t) => !t.startsWith('-'))?.toLowerCase();
    if (op !== undefined && op !== 'show' && op !== 'get-url') return flagged(finding('git-remote', 'git-remote'));
    if (op === undefined) return parse(GIT_REMOTE, 'read', 'refs');
    // `git remote show|get-url [options] <name>`; options before the operation are not accepted.
    if (texts[0]?.toLowerCase() !== op) return unrecognised('option');
    return parse(op === 'show' ? GIT_REMOTE_SHOW : GIT_REMOTE_GET_URL, 'read', 'refs', rest.slice(1));
  }
  if (name === 'clean') return flagged(finding('destructive', 'git-discard'));
  if (name === 'reset') return texts.some((t) => ['--hard', '--merge', '--keep'].includes(t)) ? flagged(finding('destructive', 'git-discard')) : unrecognised();
  if (name === 'branch' || name === 'tag') {
    if (texts.some((t) => ['--delete'].includes(t) || /^-[a-zA-Z]*[dD]/.test(t))) return flagged(finding('destructive', 'git-discard'));
    const fx = parse(name === 'branch' ? GIT_BRANCH : GIT_TAG, 'read', 'refs');
    // A positional creates a branch or tag, except `git tag -l <pattern>`.
    const listing = name === 'tag' && texts.some((t) => t === '-l' || t === '--list');
    return texts.some((t) => !t.startsWith('-')) && !listing ? unrecognised() : fx;
  }
  if (name === 'stash' || name === 'worktree') {
    const op = texts[0];
    const spec = name === 'stash' ? (op === 'list' ? GIT_STASH_LIST : op === 'show' ? GIT_STASH_SHOW : undefined) : op === 'list' ? GIT_WORKTREE_LIST : undefined;
    if (spec === undefined) return unrecognised();
    const parsed = parsePosix(rest.slice(1), spec);
    return parsed === undefined ? unrecognised('option') : { ...none(), folder: { access: 'read', ...(at && { at }) } };
  }
  if (name === 'config') {
    const parsed = parsePosix(rest, GIT_CONFIG);
    if (parsed === undefined) return unrecognised('option');
    const positionals = parsed.positionals.map((w) => w.text);
    const optionNames = new Set(parsed.bound.map((b) => b.opt.name));
    const op = positionals[0]?.toLowerCase();
    const fx: Effects = { ...none(), folder: { access: 'read', ...(at && { at }) } };
    for (const { opt, value } of parsed.bound) if (value !== undefined && opt.kind === 'read') fx.reads.push(inRepo(value));
    const reading = op === 'get' || op === 'list' || ['get', 'get-all', 'get-regexp', 'get-urlmatch', 'list', 'l'].some((o) => optionNames.has(o));
    const mutating = ['unset', 'unset-all', 'add', 'replace-all', 'rename-section', 'remove-section', 'edit', 'e'].some((o) => optionNames.has(o));
    const newSyntax = op !== undefined && ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(op);
    if (reading || (!mutating && !newSyntax && positionals.length === 1)) return fx;
    const key = (newSyntax ? positionals[1] : positionals[0]) ?? '';
    if (REMOTE_KEY.test(key)) return flagged(finding('git-remote', 'git-remote'));
    if (optionNames.has('global') || optionNames.has('system')) return flagged(finding('destructive', 'system-settings'));
    return unrecognised();
  }
  const known = GIT_SUBS[name];
  if (known === undefined) return unrecognised();
  const parsed = parsePosix(rest, known.spec);
  if (parsed?.bound.some((b) => known.destructive?.includes(b.opt.name))) return flagged(finding('destructive', 'wide-delete'));
  if (known.writesPositionals && parsed?.positionals.some((w) => w.wild)) return flagged(finding('destructive', 'wide-delete'));
  const fx = parse(known.spec, known.access, known.positionals);
  if (known.writesPositionals && fx.findings.length === 0) {
    // Its paths are written (removed or moved); `git mv` also lands the source in its last argument.
    fx.writes.push(...parsed!.positionals.map(inRepo));
    if (name === 'mv') {
      const paths = parsed!.positionals.map(inRepo);
      const landed = landings(paths.slice(0, -1), paths.at(-1));
      if (!Array.isArray(landed)) return landed;
      fx.writes.push(...landed);
    }
  }
  if (name === 'commit' && fx.findings.length === 0) fx.loads.push(...GIT_HOOK_FOLDERS.map((f) => inRepo(word(f))));
  return fx;
};

// ---- package managers and interpreters -------------------------------------------------------------

const INSTALL_SUBS = new Set(['install', 'i', 'in', 'ci', 'add', 'uninstall', 'remove', 'rm', 'un', 'r', 'link', 'ln', 'update', 'up', 'upgrade']);
const SCRIPT_SUBS = new Set(['test', 't', 'tst', 'start', 'stop', 'restart']);
const LOCAL_INSTALL_SUBS = new Set(['install', 'i', 'in', 'ci']);
const INFO_SUBS = new Set(['ls', 'list', 'outdated', 'view', 'info', 'why', 'explain', 'help']);
// The only options accepted, by kind of subcommand. npm expands abbreviations and aliases (`--g`,
// `--C=...`, `--script-she=...`), so anything not listed exactly is refused.
const PM_OPTIONS = {
  scripts: new Set(['--silent', '-s', '--if-present']),
  install: new Set(['--frozen-lockfile', '--prefer-offline', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', '--silent', '-s']),
  info: new Set(['--json', '--all', '--long']),
};
// Settings files a package manager loads code or a script shell from, besides package.json.
const PM_SETTINGS = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'];

/**
 * npm, pnpm, yarn. Running package scripts or installing runs whatever package.json says, so a
 * package.json or settings file this session wrote counts as running a written script (CR-1).
 */
const packageManager =
  (name: 'npm' | 'pnpm' | 'yarn'): Handler =>
  (args) => {
    const texts = args.map((w) => w.text);
    // On Windows these are .cmd shims, and cmd.exe reads their arguments again.
    if (texts.some((t) => /[&|<>^%!"]/.test(t))) return unrecognised('syntax');
    const yarnGlobal = name === 'yarn' && texts[0] === 'global';
    const subName = (yarnGlobal ? texts[1] : texts[0])?.toLowerCase();
    if (yarnGlobal || texts.some((t) => t === '-g' || t === '--global')) {
      return subName !== undefined && INSTALL_SUBS.has(subName) ? flagged(finding('destructive', 'global-install')) : unrecognised();
    }
    const runsScripts: Effects = { ...none(), folder: { access: 'write' }, runs: [word('package.json')], loads: PM_SETTINGS.map(word) };
    const rest = args.slice(1);
    const end = rest.findIndex((w) => w.text === '--');
    const options = (end < 0 ? rest : rest.slice(0, end)).filter((w) => w.text.startsWith('-'));
    const allowed = (kind: keyof typeof PM_OPTIONS) => options.every((w) => PM_OPTIONS[kind].has(w.text));
    if (subName === undefined) return name === 'yarn' ? runsScripts : unrecognised();
    if (SCRIPT_SUBS.has(subName)) return allowed('scripts') ? runsScripts : unrecognised('option');
    if (subName === 'run' || subName === 'run-script') {
      if (rest[0] === undefined || rest[0].text.startsWith('-')) return unrecognised();
      return allowed('scripts') ? runsScripts : unrecognised('option');
    }
    // Installing what the lockfile already names; adding packages brings new code, so it is left to the user.
    if (LOCAL_INSTALL_SUBS.has(subName)) {
      if (!rest.every((w) => w.text.startsWith('-'))) return unrecognised();
      return allowed('install') ? runsScripts : unrecognised('option');
    }
    if (INFO_SUBS.has(subName)) return allowed('info') ? { ...none(), folder: { access: 'read' } } : unrecognised('option');
    return texts.length === 1 && /^(-v|--version|-h|--help)$/.test(texts[0]!) ? none() : unrecognised();
  };

const pip: Handler = (args) => {
  const subName = args[0]?.text.toLowerCase();
  if (subName === 'install' || subName === 'uninstall' || subName === 'download') return flagged(finding('destructive', 'global-install'));
  return args.length === 1 && ['list', 'freeze', '--version'].includes(subName!) ? none() : unrecognised();
};

const installsWhen =
  (subName: string): Handler =>
  (args) =>
    args.some((w) => w.text.toLowerCase() === subName) ? flagged(finding('destructive', 'global-install')) : unrecognised();

const ONE_LINER = /^(-e|-p|-c|-r|-E|--eval|--print|--command|-command)$/i;

/** `node script.mjs`, `python x.py`, `bash x.sh`: the script must be readable and not written by this session. */
const interpreter =
  (node: boolean): Handler =>
  (args) => {
    const [first, ...rest] = args;
    // With no script the interpreter runs code from its input.
    if (first === undefined) return unrecognised('one-liner');
    if (first.text.startsWith('-')) {
      if (rest.length === 0 && /^(--version|-v|-V|--help|-h)$/.test(first.text)) return none();
      return unrecognised(ONE_LINER.test(first.text) || /^-[a-z]*e$/.test(first.text) ? 'one-liner' : 'option');
    }
    return { ...none(), runs: [{ ...first, ...(node && { node: true }) }] };
  };

/** PowerShell's `-EncodedCommand` and its prefixes (`-e`, `-ec`, `-enc`). */
const powershell: Handler = (args) =>
  unrecognised(args.some((w) => /^[-/]e(c|n[a-z]*)?$/i.test(w.text)) ? 'encoded' : 'nested-shell');

const nested: Handler = () => unrecognised('nested-shell');
const system: Handler = () => flagged(finding('destructive', 'system-settings'));
const globalInstall: Handler = () => flagged(finding('destructive', 'global-install'));

// ---- PowerShell cmdlets -----------------------------------------------------------------------------

const LITERAL = 'PSPath:LiteralPath LP:LiteralPath';
const getContent = cmdlet(
  `Path@0 LiteralPath@ ${LITERAL} TotalCount# First:TotalCount Head:TotalCount Tail# Last:Tail ReadCount# Raw Encoding= Delimiter= Wait Force Credential= Stream= AsByteStream Filter% Include% Exclude%`,
  { mode: 'read' },
);
const setContent = cmdlet(
  `Path>0 LiteralPath> ${LITERAL} Value=1 Encoding= NoNewline Force Credential= PassThru Stream= AsByteStream Filter% Include% Exclude%`,
  { mode: 'write' },
);
const clearContent = cmdlet(`Path>0 LiteralPath> ${LITERAL} Force Credential= Stream= Filter% Include% Exclude%`, { mode: 'write' });
const outFile = cmdlet(`FilePath>0 Path:FilePath LiteralPath> ${LITERAL} Encoding=1 Append Force NoClobber NoNewline Width# InputObject=`, { mode: 'write' });
const teeObject = cmdlet(`FilePath>0 Path:FilePath LiteralPath> ${LITERAL} Append Encoding= Variable= InputObject=`, { mode: 'write' });
const getChildItem = cmdlet(
  `Path@0 LiteralPath@ ${LITERAL} Filter=1 Include= Exclude= Recurse s:Recurse Depth# Force Name File af:File Directory ad:Directory d:Directory Hidden ah:Hidden h:Hidden ReadOnly ar:ReadOnly System as:System Attributes= FollowSymlink`,
  { mode: 'list' },
);
const selectString = cmdlet(
  `Pattern=0 Path@1 LiteralPath@ ${LITERAL} SimpleMatch CaseSensitive Context= List NotMatch AllMatches Quiet Raw Encoding= Include% Exclude% NoEmphasis InputObject= Culture=`,
  { mode: 'read' },
);
const testPath = cmdlet(`Path@0 LiteralPath@ ${LITERAL} PathType= Type:PathType IsValid Credential= OlderThan= NewerThan= Filter% Include% Exclude%`, { mode: 'read' });
const resolvePathCmdlet = cmdlet(`Path@0 LiteralPath@ ${LITERAL} Relative RelativeBasePath= Credential=`, { mode: 'read' });
const getItem = cmdlet(`Path@0 LiteralPath@ ${LITERAL} Force Credential= Stream= Filter% Include% Exclude%`, { mode: 'read' });
const removeItem = cmdlet(`Path>0 LiteralPath> ${LITERAL} Recurse Force Credential= Filter% Include% Exclude% Stream=`, { mode: 'remove' });
const newItem = cmdlet('Path>0 Name^ ItemType= Type:ItemType Value= Target:Value Force Credential=', { mode: 'new', pipedAny: true });
const copyItem = cmdlet(`Path>0 LiteralPath> ${LITERAL} Destination/1 Recurse Force Container PassThru Credential= Filter% Include% Exclude%`, { mode: 'copy', pipedAny: true });
const renameItem = cmdlet(`Path>0 LiteralPath> ${LITERAL} NewName~1 Force PassThru Credential=`, { mode: 'write', pipedAny: true });
const setLocation = cmdlet(`Path!0 LiteralPath! ${LITERAL} PassThru StackName=`, { mode: 'cd' });

// ---- tables -----------------------------------------------------------------------------------------

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

/** Native programs and refusals, the same in PowerShell and Git Bash. */
const NATIVE = table(
  {
    grep,
    egrep: grep,
    fgrep: grep,
    rg,
    head,
    tail,
    wc,
    find,
    sed,
    touch,
    cut,
    uniq,
    which: inert,
    whoami: inert,
    git,
    npm: packageManager('npm'),
    pnpm: packageManager('pnpm'),
    yarn: packageManager('yarn'),
    pip,
    pip3: pip,
    cargo: installsWhen('install'),
    go: installsWhen('install'),
    dotnet: installsWhen('install'),
    node: interpreter(true),
    powershell,
    pwsh: powershell,
  },
  [['python', 'python3', 'py', 'ruby', 'perl', 'php', 'bash', 'sh'], interpreter(false)],
  [NESTED, nested],
  [SYSTEM, system],
  [INSTALLERS, globalInstall],
);

/** Git Bash built-ins and GNU tools whose names PowerShell gives to its own cmdlets. */
const SH_ONLY = table(
  { ls, dir: ls, cat, sort, diff, mkdir, tee, rm, rmdir, unlink, cp, mv, cd: cdTool(posix('L P', '')), pushd: cdTool(undefined), type: inert },
  [['echo', 'printf', 'pwd', 'true', 'false', 'sleep', 'basename', 'dirname', 'realpath'], inert],
);

/** PowerShell cmdlets and their aliases. */
const PS_ONLY = table(
  {},
  [['get-content', 'gc', 'cat', 'type'], getContent],
  [['set-content', 'add-content', 'ac'], setContent],
  [['clear-content', 'clc'], clearContent],
  [['out-file'], outFile],
  [['tee-object', 'tee'], teeObject],
  [['get-childitem', 'gci', 'ls', 'dir'], getChildItem],
  [['select-string', 'sls'], selectString],
  [['test-path'], testPath],
  [['resolve-path', 'rvpa'], resolvePathCmdlet],
  [['get-item', 'gi'], getItem],
  [['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'], removeItem],
  [['new-item', 'ni', 'md', 'mkdir'], newItem],
  [['copy-item', 'cpi', 'cp', 'copy', 'move-item', 'mi', 'mv', 'move'], copyItem],
  [['rename-item', 'rni', 'ren'], renameItem],
  [['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd'], setLocation],
  [
    [
      'get-location',
      'gl',
      'pwd',
      'write-output',
      'write',
      'echo',
      'write-host',
      'get-date',
      'start-sleep',
      'sleep',
      'select-object',
      'select',
      'sort-object',
      'sort',
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
      'diff',
      'get-command',
      'gcm',
      'split-path',
      'join-path',
    ],
    inert,
  ],
);

// cmd.exe built-ins: not programs, so Git Bash cannot find them.
const CMD_BUILTINS = new Set(['copy', 'move', 'ren', 'del', 'erase', 'rd', 'md']);

/**
 * The handler for a command name in one shell. In Git Bash a PowerShell cmdlet (`Get-Content`) or a cmd
 * built-in is simply not found, so it does nothing there; its redirections are still checked.
 */
export const handlerFor = (name: string, shell: Shell): Handler | undefined => {
  const n = name.toLowerCase().replace(/\.exe$/, '');
  if (shell === 'ps') return PS_ONLY.get(n) ?? NATIVE.get(n);
  const known = SH_ONLY.get(n) ?? NATIVE.get(n);
  if (known) return known;
  return PS_ONLY.has(n) && (n.includes('-') || CMD_BUILTINS.has(n)) ? inert : undefined;
};

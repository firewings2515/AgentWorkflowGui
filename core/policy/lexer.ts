// Shell command lexers for the permission policy (T014, CR-1): one for PowerShell and one for Git Bash.
// Each follows its own shell for the plain cases and refuses (`undefined`) whatever is dynamic or read
// differently than it looks: variables, subexpressions, backticks, braces, comments, input redirection,
// background jobs, smart quotes and unusual quoting. The policy treats a refusal as unrecognised.

export type Shell = 'ps' | 'sh';

export interface Word {
  text: string;
  /** Contains `*`, `?` or `[`. PowerShell expands these in `-Path` even when quoted, so quoting is ignored. */
  wild: boolean;
}

/** One simple command: its words, and the files its output redirections write. */
export interface Segment {
  words: Word[];
  /** Redirection targets that are written; discarded output (`$null`, Bash's `/dev/null`) is left out. */
  writes: Word[];
  /** Fed by `|`: PowerShell may bind the upstream objects' `Path` to a parameter. */
  piped: boolean;
}

const SMART_QUOTES = /[‘’‚‛“”„‟]/;
// PowerShell reads these dashes as `-`, so `–Recurse` is a parameter there.
const PS_DASHES = /[–—―]/;

class Builder {
  readonly segments: Segment[] = [];
  private current: Segment = { words: [], writes: [], piped: false };
  private text: string | undefined;
  private wild = false;
  private quoted = false;
  /** The next word is a redirection target. */
  redirect = false;

  constructor(private readonly shell: Shell) {}

  get inWord() {
    return this.text !== undefined;
  }

  /** The word so far when it could be a stream number (`2>`): unquoted and one character. */
  get streamCandidate() {
    return !this.quoted && this.text?.length === 1 ? this.text : undefined;
  }

  append(s: string, quoted = false) {
    this.text = (this.text ?? '') + s;
    this.wild ||= /[*?[\]]/.test(s);
    this.quoted ||= quoted;
  }

  dropWord() {
    this.text = undefined;
    this.wild = false;
    this.quoted = false;
  }

  endWord() {
    if (this.text === undefined) return;
    const word = { text: this.text, wild: this.wild };
    this.dropWord();
    if (this.redirect) {
      this.redirect = false;
      // Only Bash has /dev/null; PowerShell writes `\dev\null` on the current drive.
      if (this.shell === 'ps' || word.text !== '/dev/null') this.current.writes.push(word);
    } else this.current.words.push(word);
  }

  /**
   * Ends the command. `soft` separators (`;`, newline) may follow an empty command; `|`, `&&`, `||` may
   * not. `pipe`: the next command reads this one's output.
   */
  endSegment(soft: boolean, pipe = false): boolean {
    this.endWord();
    if (this.redirect) return false;
    if (this.current.words.length === 0 && this.current.writes.length === 0) return soft;
    this.segments.push(this.current);
    this.current = { words: [], writes: [], piped: pipe };
    return true;
  }
}

/** Length of a `$null` redirection target at `i`: PowerShell discards; Bash reports an ambiguous redirect and skips the command. */
const nullTarget = (s: string, i: number, shell: Shell) => {
  const m = (shell === 'ps' ? /^\$null(?![A-Za-z0-9_:])/i : /^\$null(?![A-Za-z0-9_])/).exec(s.slice(i));
  return m ? m[0].length : 0;
};

/** Reads `>`, `>>`, `N>`, `N>&M`, `*>` with `i` at `>`. Returns the next index, or -1 when unclear. */
const redirection = (s: string, i: number, b: Builder, shell: Shell): number => {
  if (b.redirect) return -1;
  const stream = b.streamCandidate;
  if (stream !== undefined && (shell === 'sh' ? /^\d$/ : /^[1-6*]$/).test(stream)) b.dropWord();
  else b.endWord();
  let j = i + 1;
  if (s[j] === '>' || (shell === 'sh' && s[j] === '|')) j++;
  if (s[j] === '&') {
    // `2>&1` duplicates a stream. Bash's `>&file` writes a file; it is refused rather than parsed.
    const dup = /^&(\d|-)(?=$|[\s;|&<>])/.exec(s.slice(j));
    return dup ? j + dup[0].length : -1;
  }
  while (s[j] === ' ' || s[j] === '\t') j++;
  const nul = nullTarget(s, j, shell);
  if (nul > 0) return j + nul;
  b.redirect = true;
  return j;
};

const lexPs = (s: string): Segment[] | undefined => {
  const b = new Builder('ps');
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (SMART_QUOTES.test(c) || PS_DASHES.test(c) || '`$(){}@,#<'.includes(c)) return undefined;
    if (c === ' ' || c === '\t') {
      b.endWord();
      i++;
    } else if (c === '\r' || c === '\n' || c === ';') {
      if (c === '\r' && s[i + 1] !== '\n') return undefined;
      if (!b.endSegment(true)) return undefined;
      i += c === '\r' ? 2 : 1;
    } else if (/\s/.test(c)) {
      // PowerShell splits words on other Unicode spaces too.
      return undefined;
    } else if (c === '|' || c === '&') {
      if (c === '&' && s[i + 1] !== '&') return undefined;
      if (!b.endSegment(false, c === '|' && s[i + 1] !== '|')) return undefined;
      i += s[i + 1] === c ? 2 : 1;
    } else if (c === '>') {
      i = redirection(s, i, b, 'ps');
      if (i < 0) return undefined;
    } else if (c === "'" || c === '"') {
      // PowerShell splits `'a'b` into two arguments and joins `a'b'`; both are refused.
      if (b.inWord) return undefined;
      let j = i + 1;
      let content = '';
      for (;;) {
        const d = s[j];
        if (d === undefined || SMART_QUOTES.test(d)) return undefined;
        if (d === c) {
          if (s[j + 1] !== c) break;
          if (c === '"') return undefined;
          content += "'";
          j += 2;
          continue;
        }
        if (c === '"' && (d === '$' || d === '`')) return undefined;
        content += d;
        j++;
      }
      const next = s[j + 1];
      if (next !== undefined && !' \t\r\n;|&>'.includes(next)) return undefined;
      b.append(content, true);
      i = j + 1;
    } else {
      b.append(c);
      i++;
    }
  }
  if (!b.endSegment(true)) return undefined;
  // `--%` stops PowerShell's parsing and passes the rest verbatim.
  return b.segments.some((seg) => seg.words.some((w) => w.text === '--%')) ? undefined : b.segments;
};

const lexSh = (s: string): Segment[] | undefined => {
  const b = new Builder('sh');
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if ('<$`(){}#\r'.includes(c)) return undefined;
    if (c === ' ' || c === '\t') {
      b.endWord();
      i++;
    } else if (c === '\n' || c === ';') {
      if (c === ';' && s[i + 1] === ';') return undefined;
      if (!b.endSegment(true)) return undefined;
      i++;
    } else if (c === '|') {
      if (s[i + 1] === '&') return undefined;
      if (!b.endSegment(false, s[i + 1] !== '|')) return undefined;
      i += s[i + 1] === '|' ? 2 : 1;
    } else if (c === '&') {
      if (s[i + 1] === '&') {
        if (!b.endSegment(false)) return undefined;
        i += 2;
      } else if (s[i + 1] === '>') {
        b.endWord();
        i = redirection(s, i + 1, b, 'sh');
        if (i < 0) return undefined;
      } else return undefined;
    } else if (c === '>') {
      i = redirection(s, i, b, 'sh');
      if (i < 0) return undefined;
    } else if (c === '\\') {
      const next = s[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return undefined;
      b.append(next, true);
      i += 2;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      b.append(s.slice(i + 1, end), true);
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let content = '';
      for (;;) {
        const d = s[j];
        if (d === undefined || d === '$' || d === '`') return undefined;
        if (d === '"') break;
        if (d === '\\') {
          const next = s[j + 1];
          if (next === '"' || next === '\\') {
            content += next;
            j += 2;
            continue;
          }
          if (next === undefined || next === '$' || next === '`' || next === '\n') return undefined;
        }
        content += d;
        j++;
      }
      b.append(content, true);
      i = j + 1;
    } else {
      b.append(c);
      i++;
    }
  }
  return b.endSegment(true) ? b.segments : undefined;
};

/** Splits a command into simple commands, or `undefined` when the shell would read it differently. */
export const lex = (command: string, shell: Shell): Segment[] | undefined => (shell === 'ps' ? lexPs(command) : lexSh(command));


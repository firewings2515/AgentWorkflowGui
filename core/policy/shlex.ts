// Codex's own quoting (T035): codex 0.160 joins a command's argv with shlex 1.3.0 (`try_join`) for the
// `command` of its approval requests. Each argument is cut into chunks, and each chunk is left bare, put in
// single quotes or put in double quotes (with `\` before `$`, a backtick, `"` and `\`), whichever its
// characters allow, preferring them in that order. No `\` in single quotes, no `$`, backtick, `!` or `^`
// in double quotes, and a `^` only right after an opening single quote.

const BARE = 1;
const SINGLE = 2;
const DOUBLE = 4;

const allowed = (c: string) =>
  (/^[+\-./:@\]_0-9A-Za-z]$/.test(c) ? BARE : 0) | (c === "'" || c === '^' || c === '\\' ? 0 : SINGLE) | ('`$!^'.includes(c) ? 0 : DOUBLE);

/** One argument as shlex 1.3.0 quotes it. */
export const shlexQuote = (arg: string): string => {
  if (arg === '') return "''";
  let out = '';
  let rest = arg;
  while (rest.length > 0) {
    let ok = BARE | SINGLE | DOUBLE;
    let i = 0;
    if (rest[0] === '^') {
      ok = SINGLE;
      i = 1;
    }
    for (; i < rest.length; i++) {
      const next = ok & allowed(rest[i]!);
      if (next === 0) break;
      ok = next;
    }
    const chunk = rest.slice(0, i);
    rest = rest.slice(i);
    if (ok & BARE) out += chunk;
    else if (ok & SINGLE) out += `'${chunk}'`;
    else out += `"${chunk.replace(/[$`"\\]/g, '\\$&')}"`;
  }
  return out;
};

// A chunk as Bash reads it: bare characters that expand nothing, single quotes (literal), or double quotes
// whose only escapes are `\\` and `\"` and which hold nothing Bash would expand.
const CHUNK = /^(?:([+\-./:@\]_0-9A-Za-z]+)|'([^']*)'|"((?:[^"\\$`!]|\\[\\"])*)")/;

/**
 * The argument a word stands for, when the word is exactly how shlex 1.3.0 quotes that argument; else
 * undefined. Read this way the word means the same to Bash and to Codex's argv, and only the quoting Codex
 * itself produces is accepted.
 */
export const shlexArgument = (word: string): string | undefined => {
  let arg = '';
  for (let rest = word; rest.length > 0; ) {
    const m = CHUNK.exec(rest);
    if (!m) return undefined;
    arg += m[1] ?? m[2] ?? m[3]!.replace(/\\([\\"])/g, '$1');
    rest = rest.slice(m[0].length);
  }
  return arg !== '' && shlexQuote(arg) === word ? arg : undefined;
};

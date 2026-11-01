// Reading and comparing the versions the runtimes print (T045). `claude --version` prints `2.1.309 (Claude Code)`,
// `codex --version` prints `codex-cli 0.160.0`; some builds print only `0.160.0`.

const VERSION = /(?<![\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\+[0-9A-Za-z.-]+)?(?![\w.])/;

/** The first version number in `--version`'s output, or undefined when there is none (never guessed). */
export const parseVersion = (output: string): string | undefined => VERSION.exec(output)?.[1];

const parts = (version: string): { core: number[]; pre: string | undefined } => {
  const dash = version.indexOf('-');
  const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map((n) => Number.parseInt(n, 10));
  return { core, pre: dash < 0 ? undefined : version.slice(dash + 1) };
};

/** Negative when `a` is older than `b`, 0 when equal, positive when newer; a pre-release is older than its release. */
export const compareVersions = (a: string, b: string): number => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
};

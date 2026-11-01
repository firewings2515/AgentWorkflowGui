// Reading and comparing the versions the runtimes print (T045). `claude --version` prints `2.1.309 (Claude Code)`,
// `codex --version` prints `codex-cli 0.160.0`; some builds print only `0.160.0`. Nothing else is a version: an
// error message that happens to contain a number is not read (review r1), so an unknown output is `failed`.

const NUM = '(?:0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
/** A complete SemVer 2.0.0 version: core, optional pre-release, optional build metadata (dropped). */
const SEMVER = `(${NUM}\\.${NUM}\\.${NUM}(?:-${PRE_ID}(?:\\.${PRE_ID})*)?)(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;

/** Which program printed it: its own line, or `bare` for a version alone (also a folder name). */
export type VersionFormat = 'claude' | 'codex' | 'bare';

const FORMATS: Record<VersionFormat, RegExp[]> = {
  claude: [new RegExp(`^${SEMVER} \\(Claude Code\\)$`), new RegExp(`^${SEMVER}$`)],
  codex: [new RegExp(`^codex-cli ${SEMVER}$`), new RegExp(`^${SEMVER}$`)],
  bare: [new RegExp(`^${SEMVER}$`)],
};

/** The version in `--version`'s output, or undefined unless the whole output is one of the known forms (never guessed). */
export const parseVersion = (format: VersionFormat, output: string): string | undefined => {
  const text = output.trim();
  if (text === '' || /[\r\n]/.test(text)) return undefined;
  for (const pattern of FORMATS[format]) {
    const version = pattern.exec(text)?.[1];
    if (version !== undefined) return version;
  }
  return undefined;
};

const split = (version: string): { core: number[]; pre: string[] | undefined } => {
  const dash = version.indexOf('-');
  const core = (dash < 0 ? version : version.slice(0, dash)).split('.').map((n) => Number.parseInt(n, 10));
  return { core, pre: dash < 0 ? undefined : version.slice(dash + 1).split('.') };
};

const NUMERIC = /^\d+$/;

/** One pre-release identifier against another, as SemVer 2.0.0 §11 orders them. */
const comparePre = (a: string, b: string): number => {
  const na = NUMERIC.test(a);
  const nb = NUMERIC.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1; // a number is older than a name
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0; // names by ASCII, so `B` is older than `a`
};

/** Negative when `a` is older than `b`, 0 when equal, positive when newer (SemVer 2.0.0 precedence). */
export const compareVersions = (a: string, b: string): number => {
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === undefined && y.pre === undefined) return 0;
  if (x.pre === undefined) return 1; // a release is newer than its pre-release
  if (y.pre === undefined) return -1;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const d = comparePre(x.pre[i] as string, y.pre[i] as string);
    if (d !== 0) return d;
  }
  return x.pre.length - y.pre.length; // the shorter list is older
};

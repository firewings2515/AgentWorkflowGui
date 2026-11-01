// Windows path handling for the permission policy (T014, R-08), written as pure functions because core
// may not import node:path. A path that cannot be pinned down to one absolute location returns
// `undefined`, and the policy treats it as unrecognised (CR-1): environment variables, `~`, 8.3 short
// names, device and provider paths, trailing dots or spaces, and drive-relative paths such as `C:x`.

/**
 * How a path string is read. `win`: Win32 rules (tool inputs, PowerShell), where `/x` is the root of
 * the current drive. `sh`: Git Bash, where `/c/x` is the C drive and other rooted paths are MSYS mounts.
 */
export type PathStyle = 'win' | 'sh';

/**
 * A normalised absolute path: `c:/`, `c:/a/b` or `//server/share/a`, with `/` separators. Only ASCII
 * letters are lower-cased, so two paths are equal here only if Windows also treats them as equal
 * (Windows folds other letters with its own table, which `toLowerCase` does not match).
 */
export type AbsPath = string;

// eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected here
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/;
const WILD = /[*?[\]]/;

const foldAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Splits a normalised absolute path into its root (`c:/` or `//server/share`) and segments. */
const splitAbs = (p: AbsPath): { root: string; segments: string[] } => {
  if (p.startsWith('//')) {
    const [server, share, ...rest] = p.slice(2).split('/');
    return { root: `//${server}/${share}`, segments: rest };
  }
  return { root: p.slice(0, 3), segments: p.slice(3).split('/').filter((s) => s !== '') };
};

const joinAbs = (root: string, segments: readonly string[]): AbsPath =>
  root.endsWith('/') ? root + segments.join('/') : segments.length === 0 ? root : `${root}/${segments.join('/')}`;

/** A segment Windows would read differently from its text, or that names something other than a file. */
const badSegment = (s: string) =>
  /^\.{3,}$/.test(s) || /[. ]$/.test(s) || /~\d/.test(s) || RESERVED_DEVICE.test(s) || WILD.test(s);

/** Root and remaining text of an absolute path, or `relative`, or `undefined` when it cannot be placed. */
const rootOf = (p: string, cwd: AbsPath | undefined, style: PathStyle): { root: string; rest: string } | 'relative' | undefined => {
  const drive = /^([a-z]):(.*)$/i.exec(p);
  if (drive) {
    // `C:x` is relative to the C drive's own current folder, which is not known here.
    if (!drive[2]!.startsWith('/')) return undefined;
    return { root: `${foldAscii(drive[1]!)}:/`, rest: drive[2]! };
  }
  if (p.startsWith('//')) {
    if (style === 'sh') return undefined;
    const [server = '', share = ''] = p.slice(2).split('/');
    if (server === '' || share === '' || server === '?' || server === '.' || badSegment(server) || badSegment(share)) return undefined;
    return { root: `//${foldAscii(server)}/${foldAscii(share)}`, rest: p.slice(2 + server.length + 1 + share.length) };
  }
  if (p.startsWith('/')) {
    if (style === 'sh') {
      const mount = /^\/(?:cygdrive\/)?([a-z])(\/.*)?$/i.exec(p);
      return mount ? { root: `${foldAscii(mount[1]!)}:/`, rest: mount[2] ?? '' } : undefined;
    }
    return cwd === undefined ? undefined : { root: splitAbs(cwd).root, rest: p };
  }
  return 'relative';
};

/**
 * Resolves `raw` against `cwd` (itself a normalised absolute path, or `undefined` when unknown). Returns
 * `undefined` for anything that cannot be resolved with certainty, including wildcards.
 */
export const resolvePath = (raw: string, cwd: AbsPath | undefined, style: PathStyle): AbsPath | undefined => {
  if (raw === '' || CONTROL.test(raw) || raw.startsWith('~') || raw.includes('$') || /%[^%]*%/.test(raw)) return undefined;
  const p = raw.replaceAll('\\', '/');
  const placed = rootOf(p, cwd, style);
  if (placed === undefined) return undefined;
  let root: string;
  let segments: string[];
  let text: string;
  if (placed === 'relative') {
    if (cwd === undefined) return undefined;
    // A colon in the first segment is a PowerShell provider (`HKLM:`, `Env:`) or a drive form.
    if (/^[^/]*:/.test(p)) return undefined;
    ({ root, segments } = splitAbs(cwd));
    text = p;
  } else {
    ({ root } = placed);
    segments = [];
    text = placed.rest;
  }
  for (const raw of text.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    const segment = foldAscii(raw);
    if (badSegment(segment)) return undefined;
    segments.push(segment);
  }
  return joinAbs(root, segments);
};

/** Normalises an absolute path (scope roots, recorded paths); relative or unclear paths give `undefined`. */
export const normaliseAbsolute = (raw: string): AbsPath | undefined => resolvePath(raw, undefined, 'win');

/** The folder holding `path`; `undefined` for a root (`c:/`, `//server/share`). */
export const parentOf = (path: AbsPath): AbsPath | undefined => {
  const { root, segments } = splitAbs(path);
  return segments.length === 0 ? undefined : joinAbs(root, segments.slice(0, -1));
};

export const isWithin = (path: AbsPath, root: AbsPath): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

export const isWithinAny = (path: AbsPath, roots: readonly AbsPath[]): boolean => roots.some((root) => isWithin(path, root));

/** True when `raw` contains a wildcard that a shell or PowerShell `-Path` would expand. */
export const hasWildcard = (raw: string): boolean => WILD.test(raw);

// Credentials and secret files (R-08). Every segment is checked, folders included, and a family counts
// whatever follows its stem: an extension never proves a name safe (`.env.production.txt`, `id_rsa.bak`).
const SECRET_STEMS = [
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.password-store',
  'credentials',
  '.git-credentials',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.htpasswd',
  '.vault-token',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'authorized_keys',
  'known_hosts',
];
const SECRET_PATTERNS = [/^id_[a-z0-9_-]+(\.pub)?$/, /\.(pem|key|pfx|p12|keystore|jks|ppk|kdbx|vcrd)(\.|$)/];
// Windows credential stores (DPAPI keys, Credential Manager, the vault), browser profiles and the SAM hive.
const WINDOWS_SECRET =
  /\/appdata\/(local|roaming)\/microsoft\/(vault|protect|credentials|crypto|systemcertificates)(\/|$)|\/appdata\/local\/(google\/chrome|microsoft\/edge)\/user data(\/|$)|\/appdata\/roaming\/mozilla\/firefox(\/|$)|^[a-z]:\/windows\/system32\/config(\/|$)/;

/** A segment that names a secret. An alternate stream (`.env:x`) counts as its file. */
export const isSecretName = (segment: string): boolean => {
  const name = foldAscii(segment).split(':')[0]!;
  return SECRET_STEMS.some((stem) => name.startsWith(stem)) || SECRET_PATTERNS.some((pattern) => pattern.test(name));
};

export const isSecretPath = (path: AbsPath): boolean => splitAbs(path).segments.some(isSecretName) || WINDOWS_SECRET.test(path);

/**
 * Key for "is this the same file" when matching written scripts: Unicode case folding after NFC. It may
 * join names Windows keeps apart, which only adds escalations; it never splits names Windows joins.
 */
export const fileKey = (path: AbsPath): string => path.normalize('NFC').toUpperCase().toLowerCase();

/** Path-like parts of a free-form word (`HEAD:.env`, `src/.env`, `--file=.env`) whose names are secrets. */
export const mentionsSecret = (word: string): boolean =>
  word
    .replaceAll('\\', '/')
    .split(/[/:=]/)
    .some((part) => part !== '' && isSecretName(part));

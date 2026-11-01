// Checks the built app against its THIRD_PARTY_LICENSES.txt: every licence or notice file of a package under
// node_modules in app.asar (unpacked files are listed there too) and in app.asar.unpacked must be in the list,
// as `File: <name>@<version>/<path in the package>`. Packages are told apart by the name and version in their
// own package.json, not by where electron-builder put them. Run by `npm run dist` after electron-builder
// (T044); fails when one is missing.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLicenceFile } from './license-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'release', 'win-unpacked', 'resources');
const listed = join(resources, 'THIRD_PARTY_LICENSES.txt');
if (!existsSync(listed)) throw new Error(`${listed} is not there; run npm run dist first`);
const text = readFileSync(listed, 'utf8');
const { listPackage, extractFile } = createRequire(import.meta.url)('@electron/asar');
const archive = join(resources, 'app.asar');

const inAsar = listPackage(archive).map((p) => p.replace(/\\/g, '/').replace(/^\//, ''));
const unpacked = [];
const walk = (dir, prefix) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
    else unpacked.push(rel);
  }
};
const unpackedRoot = join(resources, 'app.asar.unpacked');
if (existsSync(unpackedRoot)) walk(unpackedRoot, '');

/** `node_modules/a/b/node_modules/@s/p/vendor/x/LICENSE` -> package folder `node_modules/a/b/node_modules/@s/p`. */
const packageFolder = (path) => {
  const parts = path.split('/');
  const at = parts.lastIndexOf('node_modules');
  const size = parts[at + 1].startsWith('@') ? 2 : 1;
  return parts.slice(0, at + 1 + size).join('/');
};

const names = new Map();
const labelOf = (path) => {
  const folder = packageFolder(path);
  if (!names.has(folder)) {
    const pkg = JSON.parse(extractFile(archive, join(...folder.split('/'), 'package.json')).toString('utf8'));
    names.set(folder, `${pkg.name}@${pkg.version}`);
  }
  return `${names.get(folder)}/${path.slice(folder.length + 1)}`;
};

const shipped = [...new Set([...inAsar, ...unpacked])].filter((p) => p.startsWith('node_modules/') && isLicenceFile(p.split('/').at(-1)));
const labels = [...new Set(shipped.map(labelOf))];
const missing = labels.filter((label) => !text.includes(`File: ${label}\n`));
console.log(`${String(labels.length)} licence files in the app, ${String(missing.length)} missing from THIRD_PARTY_LICENSES.txt`);
if (missing.length > 0) {
  for (const label of missing) console.error(`missing: ${label}`);
  process.exit(1);
}

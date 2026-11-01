// Writes build-resources/THIRD_PARTY_LICENSES.txt: every production dependency in package-lock.json that is
// installed here (the renderer's libraries are bundled into the app, so they count), with its licence
// identifier and the text of every licence or notice file the package ships, at its root and in vendored
// folders below it (koffi vendors node-addon-api and node-api-headers). Each text is headed by a
// `File: <name>@<version>/<path in the package>` line that scripts/check-licenses.mjs matches against the
// installer's content (by package, not by install path: electron-builder lays the tree out its own way).
// Run by `npm run dist` before electron-builder (T044).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLicenceFile } from './license-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

/** Licence files of the package at `dir`, nested `node_modules` excluded (the lockfile lists those itself). */
const licenceFiles = (dir) => {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (isLicenceFile(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found.sort();
};

const entries = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (path === '' || meta.dev === true) continue;
  const dir = join(root, path);
  if (!existsSync(join(dir, 'package.json'))) continue; // optional packages of other platforms
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'SEE LICENSE FILE');
  const files = licenceFiles(dir).map((file) => ({ file: `${pkg.name}@${pkg.version}/${relative(dir, file).replace(/\\/g, '/')}`, text: readFileSync(file, 'utf8').trim() }));
  entries.push({ name: pkg.name, version: pkg.version, licence, files });
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const header = [
  'AgentWorkflowGui third-party components',
  '',
  'AgentWorkflowGui itself is licensed under the Apache License 2.0 (LICENSE, NOTICE).',
  'The components below are included in this installer or bundled into the app. Each keeps its own licence.',
  "The Claude Agent SDK and its claude.exe are Anthropic's, under Anthropic's own terms (see their LICENSE.md below).",
  'The Codex CLI is not included; it is a separate program the user installs.',
  '',
  `${String(entries.length)} packages`,
  '='.repeat(72),
];
const rule = '-'.repeat(72);
const body = entries.map((e) => {
  const texts = e.files.length === 0 ? ['(no licence file in the package)'] : e.files.map((f) => `File: ${f.file}\n\n${f.text}`);
  return `\n${e.name}@${e.version}\nLicense: ${e.licence}\n\n${texts.join(`\n\n${rule}\n\n`)}\n\n${rule}`;
});
const out = join(root, 'build-resources', 'THIRD_PARTY_LICENSES.txt');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${[...header, ...body].join('\n')}\n`);
console.log(`${String(entries.length)} packages, ${String(entries.reduce((n, e) => n + e.files.length, 0))} licence files -> ${out}`);

// Writes build-resources/THIRD_PARTY_LICENSES.txt: every production dependency in package-lock.json that is
// installed here (the renderer's libraries are bundled into the app, so they count), with its licence
// identifier and the text of its licence file. Run by `npm run dist` before electron-builder (T044).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

const licenceFile = (dir) => {
  const name = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(f));
  return name === undefined ? undefined : readFileSync(join(dir, name), 'utf8').trim();
};

const entries = [];
for (const [path, meta] of Object.entries(lock.packages)) {
  if (path === '' || meta.dev === true) continue;
  const dir = join(root, path);
  if (!existsSync(join(dir, 'package.json'))) continue; // optional packages of other platforms
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licence = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'SEE LICENSE FILE');
  entries.push({ name: pkg.name, version: pkg.version, licence, text: licenceFile(dir) });
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
const body = entries.map((e) => `\n${e.name}@${e.version}\nLicense: ${e.licence}\n\n${e.text ?? '(no licence file in the package)'}\n\n${'-'.repeat(72)}`);
const out = join(root, 'build-resources', 'THIRD_PARTY_LICENSES.txt');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${[...header, ...body].join('\n')}\n`);
console.log(`${String(entries.length)} packages -> ${out}`);

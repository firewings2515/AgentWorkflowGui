// Regression tests for the round 1 review of T014 (docs/tasks/reviews/T014-r1-result.md). Each P1's
// counterexample escalates, next to the nearby forms that stay approved.
import { describe, expect, it } from 'vitest';
import type { PolicyContext } from '../ports';
import { REASONS } from './reasons';
import { ROOT, codex, command, contextFor, decide, edit, request, tool, verdict } from './testing/requests';

const sh = String.raw;
const POWERSHELL = '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"';
const rows = (cases: [string, string][], context?: PolicyContext) =>
  it.each(cases)('%s → %s', (cmd, expected) => expect(verdict(command(cmd), context)).toBe(expected));

describe('P1-1 the PowerShell wrapper is opened only when Bash would not expand it', () => {
  rows([
    [`${POWERSHELL} -Command "echo '$(git push)'"`, 'unrecognised'],
    [`${POWERSHELL} -Command "echo '\`git push\`'"`, 'unrecognised'],
    [`${POWERSHELL} -Command "Get-Content $HOME/notes.txt"`, 'unrecognised'],
    [`${POWERSHELL} -Command "Get-ChildItem 2>$null"`, 'unrecognised'],
    [sh`${POWERSHELL} -Command "Get-Content \\server\share\x"`, 'secret-read'],
    [`${POWERSHELL} -Command "Get-ChildItem"`, 'approve'],
    [`${POWERSHELL} -Command "git status --short; Get-Content README.md"`, 'approve'],
  ]);
});

describe('P1-2 /dev/null is discarded only by Bash', () => {
  rows([
    ['echo x > /dev/null', 'write-outside-scope'],
    ['git log --oneline -5 2>/dev/null', 'write-outside-scope'],
    ['echo x > nul', 'unrecognised'],
    ['git log --oneline -5 2>$null', 'approve'],
    ['Get-ChildItem | Out-Null', 'approve'],
  ]);
  it('in the Codex wrapper too', () => expect(verdict(codex('echo x > /dev/null'))).toBe('write-outside-scope'));
});

describe('P1-3 a cmdlet that may take its path from the pipeline', () => {
  rows([
    [`echo '{"Path":"E:/outside/a.txt"}' | ConvertFrom-Json | Set-Content -Value x`, 'unrecognised'],
    [`echo '{"Path":"notes.txt"}' | ConvertFrom-Json | Get-Content`, 'unrecognised'],
    ['Get-ChildItem | Remove-Item', 'unrecognised'],
    ['Get-ChildItem src | Copy-Item -Path a.txt', 'unrecognised'],
    ['Get-ChildItem | Select-String -Pattern TODO', 'unrecognised'],
    ['Get-ChildItem | Set-Content -Path list.txt', 'approve'],
    ['Get-ChildItem | Out-File -FilePath list.txt', 'approve'],
    ['git log | Select-Object -First 5', 'approve'],
    ['cat a.txt | grep foo', 'approve'],
  ]);
  it('labels a piped secret as a secret read', () =>
    expect(verdict(command(`echo '{"Path":".env"}' | ConvertFrom-Json | Get-Content`))).toBe('secret-read'));
});

describe('P1-4 a file written earlier in the same request counts as written', () => {
  const written = { action: 'escalate', rule: 'unrecognised', reason: REASONS['written-script'] };
  it.each([
    "echo 'process.exit(0)' > fresh.js; node fresh.js",
    'cp tools/a.js fresh.js && node fresh.js',
    'Set-Content -Path run.py -Value x; python run.py',
    'mkdir out; cp tools/a.js out/; node out/a.js',
    'echo x > build.sh; ./build.sh',
    'echo x > package.json; npm test',
  ])('%s', (cmd) => expect(decide(command(cmd))).toEqual(written));
  rows([
    ['echo hi > log.txt; node scripts/build.mjs', 'approve'],
    ['node scripts/build.mjs > out.txt', 'approve'],
  ]);
});

describe('P1-5 written scripts are matched as Node and Windows would find them', () => {
  const ctx = contextFor(ROOT, { writtenPaths: [sh`E:\work\proj\scripts\fresh.js`, sh`E:\work\proj\lib\index.mjs`, sh`E:\work\proj\scripts\évil.js`] });
  rows(
    [
      ['node scripts/fresh', 'unrecognised'],
      ['node scripts/FRESH', 'unrecognised'],
      ['node lib', 'unrecognised'],
      ['node scripts/Évil.js', 'unrecognised'],
      ['node scripts/ÉVIL.JS', 'unrecognised'],
      ['node scripts/other.js', 'approve'],
      ['node scripts/fresh-old.js', 'approve'],
    ],
    ctx,
  );
});

describe('P1-6 files named by git options are checked', () => {
  rows([
    ['git config --file .env --list', 'secret-read'],
    ['git config --file E:/outside/config --list', 'secret-read'],
    ['git config -f E:/outside/config user.name', 'secret-read'],
    ['git commit -F E:/outside/message.txt', 'secret-read'],
    ['git commit --file=E:/outside/message.txt', 'secret-read'],
    ['git commit -t ../template.txt', 'secret-read'],
    ['git commit -FE:/outside/message.txt', 'secret-read'],
    ['git commit -aFE:/outside/message.txt', 'secret-read'],
    ['git commit -Fmessage.txt', 'approve'],
    ['git commit -aF message.txt', 'approve'],
    ['git blame --contents ../x.ts src/a.ts', 'secret-read'],
    ['git add --pathspec-from-file=E:/outside/list.txt', 'secret-read'],
    ['git log --format=E:/outside/x', 'approve'],
    ['git diff ../other/a.ts', 'secret-read'],
    ['git commit -F message.txt', 'approve'],
    ['git config --file .gitmodules --list', 'approve'],
    ['git log --pretty=format:%h', 'approve'],
    ['git show HEAD:src/a.ts', 'approve'],
    ['git diff origin/main -- src', 'approve'],
  ]);
  it('git commit runs hooks from a hook folder this session wrote into', () => {
    const ctx = contextFor(ROOT, { writtenPaths: [sh`E:\work\proj\.husky\pre-commit`] });
    expect(decide(command('git commit -m done'), ctx)).toMatchObject({ rule: 'unrecognised', reason: REASONS['written-script'] });
    expect(verdict(command('git status'), ctx)).toBe('approve');
  });
});

describe('P1-7 npm accepts only options it lists exactly', () => {
  rows([
    ['npm install --g', 'unrecognised'],
    ['npm install -g=true', 'unrecognised'],
    ['npm test --C=E:/outside', 'unrecognised'],
    ['npm test --script-she=node', 'unrecognised'],
    ['npm run build --prefix=E:/outside', 'unrecognised'],
    ['npm --silent test', 'unrecognised'],
    ['pnpm test --filter x', 'unrecognised'],
    ['npm install -g typescript', 'destructive'],
    ['npm test --silent', 'approve'],
    ['npm run build -- --watch --anything=E:/x', 'approve'],
    ['npm ci --no-audit --no-fund', 'approve'],
    ['npm --version', 'approve'],
  ]);
  it('a settings file this session wrote counts as a written script', () => {
    const ctx = contextFor(ROOT, { writtenPaths: [sh`E:\work\proj\.npmrc`] });
    expect(decide(command('npm test'), ctx)).toMatchObject({ rule: 'unrecognised', reason: REASONS['written-script'] });
  });
});

describe('P1-8 options that start programs', () => {
  const ctx = contextFor(ROOT, { writtenPaths: [sh`E:\work\proj\fresh.exe`] });
  rows(
    [
      ['rg --hostname-bin=./fresh.exe --hyperlink-format=default --color=always x .', 'unrecognised'],
      ['rg --pre=cat x', 'unrecognised'],
      ["rg --pre-glob '*.ts' x", 'unrecognised'],
      ['rg -z x', 'unrecognised'],
      ['rg --search-zip x', 'unrecognised'],
      ['sort --compress-program=./fresh.exe a.txt', 'unrecognised'],
      ['find . -exec ./fresh.exe ;', 'unrecognised'],
      ['git grep -Ofresh.exe x', 'unrecognised'],
      ['rg -n -i "foo" src', 'approve'],
      ['rg -C3 foo src', 'approve'],
      ['rg --files', 'approve'],
      ["rg -g '*.ts' --no-heading foo", 'approve'],
    ],
    ctx,
  );
});

describe('P1-9 existing junctions and symbolic links', () => {
  const links: Record<string, string | null> = { 'e:/work/proj/link': sh`E:\outside`, 'e:/work/proj/keys': sh`C:\Users\me\.ssh`, 'e:/work/proj/odd': null };
  const resolveRealPath = (path: string): string | null => {
    for (const [from, to] of Object.entries(links)) {
      if (path === from || path.startsWith(`${from}/`)) return to === null ? null : to + path.slice(from.length);
    }
    return path;
  };
  const ctx = contextFor(ROOT, { resolveRealPath });
  rows(
    [
      ['Set-Content E:/work/proj/link/a.txt x', 'write-outside-scope'],
      ['echo x > link/a.txt', 'write-outside-scope'],
      ['cat link/notes.md', 'secret-read'],
      ['cat keys/config', 'secret-read'],
      ['cat odd/a.txt', 'unrecognised'],
      ['cd link && npm test', 'secret-read'],
      ['node link/x.js', 'secret-read'],
      ['cat src/a.ts', 'approve'],
      ['echo x > src/a.txt', 'approve'],
    ],
    ctx,
  );
  it.each([
    [edit(sh`E:\work\proj\link\a.txt`), 'write-outside-scope'],
    [edit(sh`E:\work\proj\odd\a.txt`), 'unrecognised'],
    [tool('Read', sh`E:\work\proj\keys\id_ed25519`), 'secret-read'],
    [codex('Get-Content a.txt', { paths: [sh`E:\work\proj\link\a.txt`] }), 'secret-read'],
    [edit(sh`E:\work\proj\src\a.ts`), 'approve'],
  ])('request %#', (req, expected) => expect(verdict(req, ctx)).toBe(expected));
});

// Round 3 (rule B) replaced the round 2 matching: every wildcard target is unrecognised.
describe('P1-10 a wildcard that may match any secret name', () => {
  rows([
    ['Get-Content .e[n]v.production', 'unrecognised'],
    ['cat .e?v.local', 'unrecognised'],
    ['cat .env.*', 'unrecognised'],
    ['cat id_*', 'unrecognised'],
    ['cat certs/*.pem', 'unrecognised'],
    ['cat cred*', 'unrecognised'],
    ['cat config/*', 'unrecognised'],
    ['cat */notes.md', 'unrecognised'],
    ['cat src/*.ts', 'unrecognised'],
    ['ls *.md', 'unrecognised'],
    ['cat .env.ts', 'secret-read'],
    ['cat src/index.ts', 'approve'],
  ]);
});

describe('P1-12 Windows credential stores', () => {
  const home = sh`C:\Users\me`;
  const inHome = contextFor(home);
  const viaRefs: PolicyContext = { ...contextFor(), folderScope: { ...contextFor().folderScope, readableRoots: [sh`C:\Users\me\AppData`] } };
  const read = (path: string) => request('permissions', `Read ${path}`, { paths: [path], cwd: home });
  it.each([
    [read(sh`C:\Users\me\AppData\Local\Microsoft\Vault\abc\123.vcrd`), inHome, 'secret-read'],
    [read(sh`C:\Users\me\AppData\Roaming\Microsoft\Protect\S-1-5-21\123`), inHome, 'secret-read'],
    [read(sh`C:\Users\me\AppData\Roaming\Microsoft\Credentials\ABC`), inHome, 'secret-read'],
    [read(sh`C:\Users\me\AppData\Local\Microsoft\Credentials\ABC`), inHome, 'secret-read'],
    [read(sh`C:\Users\me\AppData\Local\Google\Chrome\User Data\Default\Login Data`), inHome, 'secret-read'],
    [read(sh`C:\Users\me\AppData\Local\Microsoft\Vault\abc\123.vcrd`), viaRefs, 'secret-read'],
    [command('ls AppData/Local/Microsoft/*', { cwd: home }), inHome, 'unrecognised'],
    [command('cat AppData/*/Microsoft/Protect/x', { cwd: home }), inHome, 'unrecognised'],
    [command('ls AppData/Local/Microsoft/Vault', { cwd: home }), inHome, 'secret-read'],
    [read(sh`C:\Users\me\Documents\notes.md`), inHome, 'approve'],
    [read(sh`C:\Users\me\AppData\Local\Temp\build.log`), inHome, 'approve'],
  ])('%#', (req, ctx, expected) => expect(verdict(req, ctx)).toBe(expected));
});

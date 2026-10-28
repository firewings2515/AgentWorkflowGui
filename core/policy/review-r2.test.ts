// Regression tests for the round 2 review of T014 (docs/tasks/reviews/T014-r2-result.md): each P1's
// counterexample, a group of same-kind variants for each structural rule A-E of the round 3 brief, and
// the everyday commands that must stay approved in both Claude's and Codex's form.
import { describe, expect, it } from 'vitest';
import type { PolicyContext } from '../ports';
import { REASONS } from './reasons';
import { ROOT, codex, command, contextFor, decide, edit, verdict } from './testing/requests';

const sh = String.raw;
const POWERSHELL = '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"';
const rows = (cases: [string, string][], context?: PolicyContext) =>
  it.each(cases)('%s → %s', (cmd, expected) => expect(verdict(command(cmd), context)).toBe(expected));
const escalates = (cases: string[], context?: PolicyContext) =>
  it.each(cases)('%s escalates', (cmd) => expect(decide(command(cmd), context).action).toBe('escalate'));

/** A resolver that maps the listed (normalised) paths, and everything under them, elsewhere; `null` for unknown. */
const linked = (links: Record<string, string | null>) => (path: string) => {
  for (const [from, to] of Object.entries(links)) {
    if (path === from || path.startsWith(`${from}/`)) return to === null ? null : to + path.slice(from.length);
  }
  return path;
};
const withLinks = (links: Record<string, string | null>, extra: Partial<PolicyContext> = {}) => contextFor(ROOT, { resolveRealPath: linked(links), ...extra });

describe('round 2 counterexamples', () => {
  it('1. a Bash line continuation inside the PowerShell wrapper', () => {
    expect(decide(command(`${POWERSHELL} -Command "Get-Content .git-credentia\\\nls"`)).action).toBe('escalate');
  });

  it('2. a parameter value that looks like -Path does not bind the path', () => {
    expect(verdict(command(`echo '{"Path":".env"}' | ConvertFrom-Json | Get-Content -Delimiter '-Path'`))).not.toBe('approve');
    expect(verdict(command(`echo '{"Path":"E:/outside/a.txt"}' | ConvertFrom-Json | Set-Content -Value '-Path' -Encoding utf8`))).not.toBe('approve');
  });

  const written = { action: 'escalate', rule: 'unrecognised', reason: REASONS['written-script'] };
  it.each([
    "echo 'process.exit(0)' > scripts/a.js; Rename-Item scripts/a.js b.js; node scripts/b.js",
    "echo 'process.exit(0)' > scripts/a.js; git mv scripts/a.js scripts/b.js; node scripts/b.js",
    "echo 'process.exit(0)' > scripts/a.js; cp -tout scripts/a.js; node out/a.js",
    "echo 'process.exit(0)' > scripts/a.js; mv -tout scripts/a.js; node out/a.js",
  ])('3. %s', (cmd) => expect(decide(command(cmd))).toEqual(written));

  it('4. a Node candidate that links to a written script', () => {
    const ctx = withLinks({ 'e:/work/proj/scripts/fresh.js': sh`E:\work\proj\actual.js` }, { writtenPaths: [sh`E:\work\proj\actual.js`] });
    expect(decide(command('node scripts/fresh'), ctx)).toEqual(written);
  });

  it('5. git file options are relative to the folder -C moved to', () => {
    const ctx = withLinks({ 'e:/work/proj/sub/config.txt': sh`E:\outside\.env`, 'e:/work/proj/sub/msg.txt': sh`E:\outside\msg.txt` });
    expect(verdict(command('git -C sub config --file config.txt --list'), ctx)).toBe('secret-read');
    expect(verdict(command('git -C sub commit -F msg.txt'), ctx)).toBe('secret-read');
  });

  it('6. git long option abbreviations', () => {
    expect(verdict(command('git config --fil=config.txt --list'))).toBe('unrecognised');
  });

  it('7. a wildcard target, whose matches may be links', () => {
    const ctx = withLinks({ 'e:/work/proj/src/link.ts': sh`E:\outside\a.ts` });
    expect(decide(command('Set-Content src/*.ts x'), ctx)).toEqual({ action: 'escalate', rule: 'unrecognised', reason: REASONS.wildcard });
    expect(verdict(command('Get-Content src/*.ts'), ctx)).toBe('unrecognised');
  });

  rows([
    ['Get-Content .env.production.txt', 'secret-read'],
    ['Get-Content *.env.ts', 'unrecognised'],
    ['Get-Content .env*.md', 'unrecognised'],
    ['Get-Content id_rsa*.txt', 'unrecognised'],
    ['Get-Content .e[n]v.production/data.txt', 'unrecognised'],
    ['Get-Content .env.production/data.txt', 'secret-read'],
  ]);

  it('9. rg -f123 reads the pattern file 123', () => {
    const ctx = withLinks({ 'e:/work/proj/123': sh`E:\outside\secret.txt` });
    expect(verdict(command('rg -f123 src'), ctx)).toBe('secret-read');
  });

  it('P2. a written path the resolver cannot confirm makes the request unrecognised', () => {
    const ctx = withLinks({ 'e:/work/proj/odd': null }, { writtenPaths: [sh`E:\work\proj\odd`] });
    expect(decide(command('git status'), ctx)).toEqual({ action: 'escalate', rule: 'unrecognised', reason: REASONS['written-unclear'] });
  });
});

describe('rule A: options come from each program’s table', () => {
  describe('PowerShell parameters bind by name and prefix, values never become names', () => {
    rows([
      ["Get-Content -Delimiter '-Path' a.txt", 'approve'],
      ['Get-Content -Pat a.txt', 'approve'],
      ['Get-Content -LiteralPath a.txt -Tail 5', 'approve'],
      ['Set-Content -Path out.txt -Value done -Encoding utf8', 'approve'],
      ['Get-Content -P a.txt', 'unrecognised'],
      ['Get-Content -Foo a.txt', 'unrecognised'],
      ['Get-Content a.txt b.txt', 'unrecognised'],
      ['Set-Content a.txt -Value x -Bogus', 'unrecognised'],
      ['Set-Content -Value -Path a.txt', 'unrecognised'],
      ['Get-Content -TotalCount x a.txt', 'unrecognised'],
      ['Remove-Item -r build', 'destructive'],
    ]);
    escalates([
      `echo '{"Path":"a"}' | ConvertFrom-Json | Get-Content -Encoding '-LiteralPath'`,
      `echo '{"Path":"a"}' | ConvertFrom-Json | Out-File -Encoding '-FilePath'`,
      `echo '{"Path":"a"}' | ConvertFrom-Json | Remove-Item -Force`,
      `echo '{"Path":"a"}' | ConvertFrom-Json | Rename-Item -Path x -NewName y`,
    ]);
    rows([[`Get-ChildItem | Set-Content -Path out.txt -Value '-Path'`, 'approve']]);
  });

  describe('GNU and git options: exact long names, getopt clusters and attached values', () => {
    rows([
      ['git commit --fil=x', 'unrecognised'],
      ['git commit --mess=done', 'unrecognised'],
      ['git log --onel', 'unrecognised'],
      ['git status --short --branc', 'unrecognised'],
      ['cat --numbe a.txt', 'unrecognised'],
      ['rm --recurs build', 'unrecognised'],
      ['head -n', 'unrecognised'],
      ['head -n5x a.txt', 'unrecognised'],
      ['grep -e', 'unrecognised'],
      ['cp -s a.txt b.txt', 'unrecognised'],
      ['cp -l a.txt b.txt', 'unrecognised'],
      ['rg --pre=cat x', 'unrecognised'],
      ['git status --short --branch', 'approve'],
      ['git log --oneline -n5', 'approve'],
      ['git commit -am done', 'approve'],
      ['head -n5 a.txt', 'approve'],
      ['grep -rn TODO src', 'approve'],
    ]);
    const ctx = withLinks({ 'e:/work/proj/123': sh`E:\outside\secret.txt` });
    rows(
      [
        ['grep -f123 src', 'secret-read'],
        ['rg --file=123 src', 'secret-read'],
        ['rg -e foo -f123', 'secret-read'],
        ['git grep -f123 x', 'secret-read'],
        ['rg -f patterns.txt src', 'approve'],
        ['rg -C3 foo src', 'approve'],
      ],
      ctx,
    );
  });
});

describe('rule B: wildcard targets are unrecognised, search patterns are not targets', () => {
  rows([
    ['Get-Content src/*.ts', 'unrecognised'],
    ['cat src/?.ts', 'unrecognised'],
    ['cp src/*.ts out/', 'unrecognised'],
    ['Copy-Item src/[ab].ts out', 'unrecognised'],
    ['node src/*.js', 'unrecognised'],
    ['ls src/*', 'unrecognised'],
    ['echo x > src/*.txt', 'unrecognised'],
    ['git -C src* status', 'unrecognised'],
    ['rm src/*.ts', 'destructive'],
    ['Remove-Item src/*.log', 'destructive'],
    ['rg "foo.*" src', 'approve'],
    ['grep -r "a*b" src', 'approve'],
    ["rg -g '*.ts' foo src", 'approve'],
    ["Select-String -Pattern 'a.*b' -Path src/a.ts", 'approve'],
    ["find src -name '*.ts'", 'approve'],
  ]);
  it.each([edit(sh`E:\work\proj\src\*.ts`), codex('Get-Content src/*.ts')])('in other request forms %#', (req) => expect(verdict(req)).toBe('unrecognised'));
});

describe('rule C: secret families on every segment, whatever the extension', () => {
  rows([
    ['cat .env.local/x.txt', 'secret-read'],
    ['cat id_rsa.bak', 'secret-read'],
    ['cat id_ed25519_old.pub.txt', 'secret-read'],
    ['cat config/.npmrc.backup', 'secret-read'],
    ['cat .git-credentials.old', 'secret-read'],
    ['cat keys/server.key.txt', 'secret-read'],
    ['cat .netrc.md', 'secret-read'],
    ['cat .pypirc', 'secret-read'],
    ['cat .env.ts', 'secret-read'],
    ['echo x > .env.example', 'secret-read'],
    ['cat environment.ts', 'approve'],
    ['cat src/identity.ts', 'approve'],
    ['cat docs/credential-flow.md', 'approve'],
  ]);
});

describe('rule D: every target from its real base folder, through resolveRealPath', () => {
  const ctx = withLinks(
    {
      'e:/work/proj/scripts/fresh.mjs': sh`E:\outside\x.mjs`,
      'e:/work/proj/lib/index.js': sh`E:\work\proj\actual.js`,
      'e:/work/proj/sub/notes.txt': sh`E:\outside\notes.txt`,
      'e:/work/proj/out': sh`E:\outside\out`,
    },
    { writtenPaths: [sh`E:\work\proj\actual.js`] },
  );
  rows(
    [
      ['node scripts/fresh', 'secret-read'],
      ['node lib', 'unrecognised'],
      ['git -C sub blame --contents notes.txt a.ts', 'secret-read'],
      ['git -C sub log --oneline', 'approve'],
      ['Rename-Item sub/a.txt notes.txt', 'write-outside-scope'],
      ['cp -t out a.txt', 'write-outside-scope'],
      ['mv --target-directory=out a.txt', 'write-outside-scope'],
      ['Copy-Item a.txt -Destination out', 'write-outside-scope'],
      ['node scripts/other.js', 'approve'],
    ],
    ctx,
  );
  const written = { action: 'escalate', rule: 'unrecognised', reason: REASONS['written-script'] };
  it.each([
    "echo x > scripts/a.js; Rename-Item -Path scripts/a.js -NewName b.js; node scripts/b.js",
    "echo x > scripts/a.js; ren scripts/a.js b.js; node scripts/b.js",
    "echo x > scripts/a.js; mv --target-directory=out scripts/a.js; node out/a.js",
    "echo x > scripts/a.js; cp -t out scripts/a.js; node out/a.js",
    "echo x > scripts/a.js; Move-Item scripts/a.js -Destination out; node out/a.js",
    "echo x > scripts/a.js; Copy-Item scripts/a.js out; node out/a.js",
    "echo x > scripts/a.js; git -C scripts mv a.js b.js; node scripts/b.js",
  ])('%s', (cmd) => expect(decide(command(cmd))).toEqual(written));
  rows([['echo x > scripts/a.js; Rename-Item scripts/a.js b.js; node scripts/other.js', 'approve']]);
});

describe('rule E: the wrapper is opened only when Bash leaves it unchanged', () => {
  escalates([
    `${POWERSHELL} -Command "Get-Content a!b.txt"`,
    `${POWERSHELL} -Command "Get-Content src\\a.ts"`,
    `${POWERSHELL} -Command "Get-Content a.txt\nGet-Content b.txt"`,
    `${POWERSHELL} -Command "Get-Content a.txt\r\nls"`,
    `${POWERSHELL} -Command "echo $x"`,
    `${POWERSHELL} -Command "echo \`whoami\`"`,
  ]);
  rows([[`${POWERSHELL} -Command "Get-Content src/a.ts"`, 'approve']]);
});

describe('everyday work stays approved in both forms', () => {
  const both = [
    'Get-Content src/a.ts',
    'Get-Content -Path src/a.ts -TotalCount 20',
    'Set-Content -Path notes.txt -Value done',
    'Set-Content notes.txt done',
    'npm test',
    'npm run build',
    'git status',
    'git status --short',
    'git diff',
    'git diff HEAD~1 -- src/a.ts',
    'git add -A',
    'git add src/a.ts',
    "git commit -m 'done'",
    'git log --oneline -5',
    'rg pattern src',
    "rg -n 'foo' src",
  ];
  it.each(both)('Claude: %s', (cmd) => expect(verdict(command(cmd))).toBe('approve'));
  it.each(both)('Codex: %s', (cmd) => expect(verdict(codex(cmd))).toBe('approve'));
  it.each(['git commit -m "fix: parser"', 'mkdir build', 'echo hi > out.txt', 'cd sub && npm test'])('Claude: %s', (cmd) =>
    expect(verdict(command(cmd))).toBe('approve'),
  );
});

// PermissionPolicy (T014): R-08's escalation list and CR-1's "unrecognised goes to root". Each rule is
// tested from both sides (allowed and escalated); SP-04's cases and the four CR-1 spike commands are
// carried over as they were run.
import { describe, expect, it } from 'vitest';
import { REASONS } from './reasons';
import { ROOT, codex, command, contextFor, decide, edit, request, tool, verdict } from './testing/requests';

const sh = String.raw;

describe('SP-04 cases (spike/sp04/policy.test.mjs)', () => {
  const root = sh`E:\sideproj\AgentWorkflowGui\spike\sandbox\sp04\worktree`;
  const ctx = contextFor(root);
  const at = { cwd: root };
  const ps = (cmd: string) => request('command', `PowerShell: ${cmd}`, { command: cmd, ...at });
  const wrapped = (script: string) => codex(script, at);
  const cases: [string, ReturnType<typeof command>, string][] = [
    ['Write inside', request('fileChange', 'Write', { paths: [`${root}\\a.txt`], ...at }), 'approve'],
    ['Write ..\\outside', request('fileChange', 'Write', { paths: [sh`..\outside\x.txt`], ...at }), 'write-outside-scope'],
    ['Read inside', request('permissions', 'Read', { paths: [`${root}\\README.md`], ...at }), 'approve'],
    ['Read .env', request('permissions', 'Read', { paths: [`${root}\\.env`], ...at }), 'secret-read'],
    ['Read .ssh/id_test', request('permissions', 'Read', { paths: [sh`E:\sideproj\AgentWorkflowGui\spike\sandbox\sp04\outside\.ssh\id_test`], ...at }), 'secret-read'],
    ['git status', command('git status', at), 'approve'],
    ['echo > a.txt', command('echo hi > a.txt', at), 'approve'],
    ['echo > ../outside', command('echo hi > ../outside/x.txt', at), 'write-outside-scope'],
    ['git push', command('git push origin main', at), 'git-remote'],
    ['rm -rf', command('rm -rf ./tmpdir', at), 'destructive'],
    ['npm install -g', command('npm install -g sp04-nonexistent-pkg-zz', at), 'destructive'],
    ['cat .env', command('cat .env', at), 'secret-read'],
    ['Remove-Item -Recurse', ps('Remove-Item -Recurse -Force tmpdir'), 'destructive'],
    ['Get-ChildItem', ps('Get-ChildItem'), 'approve'],
    ['Codex Set-Content; git status', wrapped("Set-Content -LiteralPath a1.txt -Value 'hello' -NoNewline; git status --short"), 'approve'],
    ['Codex Set-Content ..\\outside', wrapped(sh`Set-Content -LiteralPath '..\outside\x.txt' -Value 'x'`), 'write-outside-scope'],
    ['Codex Get-Content .env', wrapped('Get-Content .env'), 'secret-read'],
  ];
  it.each(cases)('%s', (_name, req, expected) => expect(verdict(req, ctx)).toBe(expected));
});

describe('CR-1 spike commands (spike/review-followup/policy-live.mjs) all escalate', () => {
  const root = sh`E:\sandbox\policy-1761200000000`;
  const slash = root.replaceAll('\\', '/');
  const fresh = `${root}\\fresh.mjs`;
  const ctx = contextFor(root, { writtenPaths: [fresh] });
  const at = { cwd: root };
  const encoded = 'UwBlAHQALQBDAG8AbgB0AGUAbgB0ACAALQBMAGkAdABlAHIAYQBsAFAAYQB0AGgAIAAnAEUAOgBcAGUAbgBjAG8AZABlAGQALQBlAGYAZgBlAGMAdAAuAHQAeAB0ACcA';
  const cases: [string, ReturnType<typeof command>, keyof typeof REASONS][] = [
    ['node-inline', command(`node -e "require('fs').writeFileSync('${slash}/node-effect.txt','test')"`, at), 'one-liner'],
    ['computed-secret (Codex)', command(`Get-Content ('${slash}/' + '.e' + 'nv')`, at), 'syntax'],
    ['computed-secret (Claude)', command(`powershell -NoProfile -Command "Get-Content ('${slash}/' + '.e' + 'nv')"`, at), 'nested-shell'],
    ['encoded', command(`powershell -NoProfile -EncodedCommand ${encoded}`, at), 'encoded'],
    ['new-script', command(`node '${slash}/fresh.mjs'`, at), 'written-script'],
    ['new-script (Codex wrapper)', codex(`node '${slash}/fresh.mjs'`, at), 'written-script'],
  ];
  it.each(cases)('%s → unrecognised', (_name, req, why) => {
    expect(decide(req, ctx)).toEqual({ action: 'escalate', rule: 'unrecognised', reason: REASONS[why] });
  });

  it('runs the same script once this session has not written it', () => {
    expect(verdict(command(`node '${slash}/fresh.mjs'`, at), contextFor(root))).toBe('approve');
  });
});

// Each rule from both sides. Commands come as Claude's Bash tool sends them, so both shells' readings count.
const table = (rows: [string, string][]) => it.each(rows)('%s → %s', (cmd, expected) => expect(verdict(command(cmd))).toBe(expected));

describe('write-outside-scope', () => {
  table([
    ['echo hi > a.txt', 'approve'],
    ['echo hi > sub/a.txt', 'approve'],
    ['echo hi >> E:/work/proj/log.txt', 'approve'],
    ['mkdir build/out', 'approve'],
    ['touch src/new.ts', 'approve'],
    ['cp a.txt b.txt', 'approve'],
    ['mv a.txt sub/b.txt', 'approve'],
    ['rm a.txt', 'approve'],
    ['Set-Content -Path notes.txt -Value done', 'approve'],
    ['cd sub && echo hi > a.txt', 'approve'],
    ['echo hi > ../a.txt', 'write-outside-scope'],
    ['echo hi > E:/work/other/a.txt', 'write-outside-scope'],
    ['echo hi > E:/work/proj2/a.txt', 'write-outside-scope'],
    ['echo hi > E:/work/refs/a.txt', 'write-outside-scope'],
    ['cp a.txt ../b.txt', 'write-outside-scope'],
    ['mv a.txt E:/elsewhere/', 'write-outside-scope'],
    ['mkdir ../x', 'write-outside-scope'],
    ['rm ../a.txt', 'write-outside-scope'],
    ['Set-Content -Path ..\\x.txt -Value y', 'write-outside-scope'],
    ['cd .. && echo hi > a.txt', 'write-outside-scope'],
  ]);

  it.each([
    [edit(sh`E:\work\proj\src\a.ts`), 'approve'],
    [edit('src/a.ts'), 'approve'],
    [edit(sh`e:\WORK\Proj\src\a.ts`), 'approve'],
    [edit(sh`..\outside\x.txt`), 'write-outside-scope'],
    [edit(sh`E:\work\refs\a.md`), 'write-outside-scope'],
    [edit(sh`C:\Windows\System32\drivers\etc\hosts`), 'write-outside-scope'],
    [edit(sh`E:\work\proj\a.ts`, sh`E:\work\other\b.ts`), 'write-outside-scope'],
  ])('fileChange %#', (req, expected) => expect(verdict(req)).toBe(expected));

  it('a read-only node (no writable roots) escalates every write, but still reads', () => {
    const readOnly = contextFor(ROOT, {}, true);
    expect(verdict(command('echo x > a.txt'), readOnly)).toBe('write-outside-scope');
    expect(verdict(command('git commit -m done'), readOnly)).toBe('write-outside-scope');
    expect(verdict(command('npm test'), readOnly)).toBe('write-outside-scope');
    expect(verdict(edit('a.txt'), readOnly)).toBe('write-outside-scope');
    expect(verdict(command('cat a.txt'), readOnly)).toBe('approve');
    expect(verdict(command('git status'), readOnly)).toBe('approve');
  });
});

describe('git-remote', () => {
  table([
    ['git status', 'approve'],
    ['git log --oneline -5', 'approve'],
    ['git diff HEAD~1 -- src/a.ts', 'approve'],
    ['git add -A', 'approve'],
    ['git commit -m "fix: parser"', 'approve'],
    ['git remote -v', 'approve'],
    ['git config --get user.name', 'approve'],
    ['git -C sub status', 'approve'],
    ['git push origin main', 'git-remote'],
    ['git push --force', 'git-remote'],
    ['git push -f origin HEAD', 'git-remote'],
    ['git -C sub push', 'git-remote'],
    ['git --no-pager push', 'git-remote'],
    ['git remote add up https://example.com/x.git', 'git-remote'],
    ['git remote set-url origin https://example.com/y.git', 'git-remote'],
    ['git remote remove origin', 'git-remote'],
    ['git config remote.origin.url https://example.com/z.git', 'git-remote'],
    ['git commit -m done && git push', 'git-remote'],
  ]);
});

describe('destructive', () => {
  table([
    ['rm a.txt', 'approve'],
    ['rmdir empty', 'approve'],
    ['Remove-Item -Force a.txt', 'approve'],
    ['npm install', 'approve'],
    ['npm ci', 'approve'],
    ['pip list', 'approve'],
    ['Get-ChildItem -Recurse', 'approve'],
    ['git branch -a', 'approve'],
    ['rm -rf ./tmpdir', 'destructive'],
    ['rm -r build', 'destructive'],
    ['rm -fr build', 'destructive'],
    ['rm --recursive build', 'destructive'],
    ['rm *.log', 'destructive'],
    ['Remove-Item -Recurse -Force tmpdir', 'destructive'],
    ['Remove-Item tmpdir -rec', 'destructive'],
    ['Remove-Item -Path logs -Include *.log', 'destructive'],
    ['del /s /q build', 'destructive'],
    ['rd /s build', 'destructive'],
    ['find . -name "*.tmp" -delete', 'destructive'],
    ['git clean -fdx', 'destructive'],
    ['git reset --hard', 'destructive'],
    ['git branch -D feature', 'destructive'],
    ['git rm -r src', 'destructive'],
    ['npm install -g typescript', 'destructive'],
    ['npm i --global typescript', 'destructive'],
    ['pnpm add -g typescript', 'destructive'],
    ['yarn global add typescript', 'destructive'],
    ['pip install requests', 'destructive'],
    ['choco install git', 'destructive'],
    ['winget install Git.Git', 'destructive'],
    ['Install-Module PSReadLine', 'destructive'],
    ['setx PATH C:/tools', 'destructive'],
    ['reg add HKCU\\Software\\X', 'destructive'],
    ['Set-ItemProperty -Path HKCU:\\Software\\X -Name y -Value 1', 'destructive'],
    ['Set-ExecutionPolicy Bypass', 'destructive'],
    ['git config --global core.editor vim', 'destructive'],
    ['taskkill /F /IM node.exe', 'destructive'],
    ['Stop-Process -Name node', 'destructive'],
  ]);
});

describe('secret-read', () => {
  table([
    ['cat README.md', 'approve'],
    ['Get-Content src/index.ts', 'approve'],
    ['grep -rn TODO src', 'approve'],
    ['cat E:/work/refs/guide.md', 'approve'],
    ['cat .env', 'secret-read'],
    ['cat .ENV', 'secret-read'],
    ['Get-Content .env.local', 'secret-read'],
    ['type .env.example', 'secret-read'],
    ['cat config/secrets.json', 'secret-read'],
    ['cat certs/server.key', 'secret-read'],
    ['cat C:/Users/me/.ssh/id_ed25519', 'secret-read'],
    ['cat ~/.ssh/id_rsa', 'secret-read'],
    ['cat ~/.aws/credentials', 'secret-read'],
    ['cp .env backup.txt', 'secret-read'],
    ['git show HEAD:.env', 'secret-read'],
    ['git log -p -- .env', 'secret-read'],
    ['rg --file=.env x', 'secret-read'],
    ['cat ../other/notes.md', 'secret-read'],
    ['cat C:/Windows/win.ini', 'secret-read'],
  ]);

  it.each([
    [tool('Read', sh`E:\work\proj\README.md`), 'approve'],
    [tool('Read', sh`E:\work\refs\guide.md`), 'approve'],
    [tool('Grep', 'src'), 'approve'],
    [tool('Glob'), 'approve'],
    [tool('Read', sh`E:\work\proj\.env`), 'secret-read'],
    [tool('Read', sh`E:\work\proj\deploy\.ENV.production`), 'secret-read'],
    [tool('Read', sh`C:\Users\me\.ssh\id_rsa`), 'secret-read'],
    [tool('Read', sh`..\..\notes.txt`), 'secret-read'],
    [tool('Grep', sh`C:\Users\me`), 'secret-read'],
    [edit(sh`E:\work\proj\.env`), 'secret-read'],
  ])('tool %#', (req, expected) => expect(verdict(req)).toBe(expected));
});

describe('unrecognised (CR-1)', () => {
  table([
    ['npm test', 'approve'],
    ['npm run build', 'approve'],
    ['node scripts/build.mjs', 'approve'],
    ['python tools/gen.py', 'approve'],
    ['node --version', 'approve'],
    ['python -c "print(1)"', 'unrecognised'],
    ['node -p 1', 'unrecognised'],
    ["perl -ne 'print' a.txt", 'unrecognised'],
    ["bash -c 'ls'", 'unrecognised'],
    ['python -m http.server', 'unrecognised'],
    ['node', 'unrecognised'],
    ['./build.sh', 'unrecognised'],
    ['cat $HOME/notes.txt', 'unrecognised'],
    ['cat "$(echo a.txt)"', 'unrecognised'],
    ['cat `echo a.txt`', 'unrecognised'],
    ['ls | xargs rm', 'unrecognised'],
    ['curl https://example.com -o page.html', 'unrecognised'],
    ['Invoke-WebRequest https://example.com', 'unrecognised'],
    ['npx vitest', 'unrecognised'],
    ['npm install left-pad', 'unrecognised'],
    ['make', 'unrecognised'],
    ['cat < a.txt', 'unrecognised'],
    ['echo x > E:/work/proj/%TEMP%/a', 'unrecognised'],
    ['Get-ChildItem | Remove-Item', 'unrecognised'],
    ['FOO=1 npm test', 'unrecognised'],
  ]);

  it('escalates running any file this session wrote, by interpreter, by path or through package.json', () => {
    const ctx = contextFor(ROOT, { writtenPaths: [sh`E:\work\proj\tools\gen.py`, 'build.sh', sh`E:\work\proj\package.json`] });
    const reason = (req: ReturnType<typeof command>) => decide(req, ctx);
    const written = { action: 'escalate', rule: 'unrecognised', reason: REASONS['written-script'] };
    expect(reason(command('python tools/gen.py'))).toEqual(written);
    expect(reason(command('python TOOLS\\GEN.PY'))).toEqual(written);
    expect(reason(command('./build.sh'))).toEqual(written);
    expect(reason(command('bash build.sh'))).toEqual(written);
    expect(reason(command('npm test'))).toEqual(written);
    expect(reason(command('cd sub && npm run build'))).toEqual(written);
    expect(reason(command('node scripts/build.mjs'))).toEqual({ action: 'approve' });
  });

  it('makes the whole request unrecognised when a written path cannot be placed', () => {
    const ctx = contextFor(ROOT, { writtenPaths: ['%TEMP%\\x.mjs'] });
    expect(decide(command('git status'), ctx)).toMatchObject({ rule: 'unrecognised', reason: REASONS['written-unclear'] });
  });
});

describe('request kinds', () => {
  it('approves plain work outside the list (R-08 default)', () => {
    for (const cmd of [
      'git status',
      'Get-ChildItem -Recurse | Select-Object -First 5',
      'rg -n "useState" app',
      'cd sub && npm test',
      'echo done',
      'git log --oneline -5 2>$null',
      'Get-ChildItem 2>$null',
      "sed -n '1,40p' src/a.ts",
      'git diff --stat; git status --short',
    ]) {
      expect(verdict(command(cmd)), cmd).toBe('approve');
    }
  });

  it('escalates MCP elicitations, sandbox grants and unknown tools', () => {
    const elicitation = request('mcpElicitation', 'Need a token', { elicitation: { mode: 'form', serverName: 'srv', message: 'Need a token', requestedSchema: {} } });
    expect(decide(elicitation)).toEqual({ action: 'escalate', rule: 'unrecognised', reason: REASONS.elicitation });
    expect(decide(request('permissions', sh`Grant write E:\work\proj`, { paths: [ROOT] }))).toMatchObject({ rule: 'unrecognised', reason: REASONS.grant });
    expect(decide(tool('mcp__srv__run'))).toMatchObject({ rule: 'unrecognised', reason: REASONS['unknown-tool'] });
    expect(decide(tool('WebFetch'))).toMatchObject({ rule: 'unrecognised', reason: REASONS['unknown-tool'] });
    expect(verdict(tool('TodoWrite'))).toBe('approve');
    expect(verdict(request('permissions', 'Agent Explore the parser'))).toBe('approve');
  });

  it('escalates requests that lack what the check needs', () => {
    expect(decide(request('command', 'Run a command'))).toMatchObject({ rule: 'unrecognised', reason: REASONS['no-command'] });
    expect(decide(request('fileChange', 'Apply a patch to unknown file(s)'))).toMatchObject({ rule: 'unrecognised', reason: REASONS['unknown-target'] });
    expect(decide(tool('Read'))).toMatchObject({ rule: 'unrecognised', reason: REASONS['unknown-target'] });
  });

  it('needs a working folder for relative paths and implicit folders', () => {
    const noCwd = { cwd: undefined };
    expect(verdict(command('cat a.txt', noCwd))).toBe('unrecognised');
    expect(verdict(command('git status', noCwd))).toBe('unrecognised');
    expect(verdict(command('cat E:/work/proj/a.txt', noCwd))).toBe('approve');
    expect(verdict(tool('Glob'), contextFor())).toBe('approve');
    expect(verdict(request('permissions', 'Glob', { cwd: 'C:\\' }))).toBe('secret-read');
  });

  it("checks the paths of Codex's commandActions as reads", () => {
    expect(verdict(codex('Get-Content a.txt', { paths: [sh`E:\work\proj\a.txt`] }))).toBe('approve');
    expect(verdict(codex('Get-Content a.txt', { paths: [sh`E:\other\x.txt`] }))).toBe('secret-read');
    expect(verdict(codex('Get-Content a.txt', { paths: [sh`E:\work\proj\.env`] }))).toBe('secret-read');
  });
});

describe('decisions', () => {
  const escalations = [
    command('cat .env'),
    command('cat C:/Users/me/.ssh/id_rsa'),
    command('git push https://user:hunter2@example.com/x.git'),
    command('rm -rf E:/secret-project'),
    command('echo hunter2 > ../token.txt'),
    command('node -e "console.log(process.env.API_KEY)"'),
    command('powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA='),
    edit(sh`C:\Users\me\AppData\token.txt`),
    tool('Read', sh`E:\work\proj\.env`),
  ];

  it('always carries a rule and one of the fixed reasons, never text from the request', () => {
    const fixed = new Set<string>(Object.values(REASONS));
    for (const req of escalations) {
      const d = decide(req);
      expect(d.action, req.summary).toBe('escalate');
      if (d.action !== 'escalate') continue;
      expect(fixed.has(d.reason), d.reason).toBe(true);
      for (const leak of ['hunter2', '.env', 'id_rsa', 'API_KEY', 'secret-project', 'token', 'AppData', 'ZQBj']) expect(d.reason).not.toContain(leak);
    }
  });

  it('labels an unreadable command that names a secret as a secret read', () => {
    expect(decide(command('cat $HOME/.ssh/id_rsa'))).toEqual({ action: 'escalate', rule: 'secret-read', reason: REASONS['secret-mention'] });
    expect(decide(command('node -e "require(\'fs\').readFileSync(\'.env\')"'))).toMatchObject({ rule: 'secret-read' });
  });

  it('reports the most serious rule when several match', () => {
    expect(verdict(command('cat ../x.txt; rm -rf build'))).toBe('destructive');
    expect(verdict(command('node -e 1; git push'))).toBe('git-remote');
    expect(verdict(command('echo x > ../a; cat .env'))).toBe('secret-read');
    expect(verdict(command('node -e 1; echo x > ../a'))).toBe('write-outside-scope');
  });

  it('is pure: the same request and context always give the same decision', () => {
    const req = command('git status && echo ok > out.txt');
    expect(decide(req)).toEqual(decide(req));
    expect(decide(req)).toEqual({ action: 'approve' });
  });
});

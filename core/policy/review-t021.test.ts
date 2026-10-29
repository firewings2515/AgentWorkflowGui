// T021 on the real machine: Codex 0.160 reports a script without `'` in single quotes, which the wrapper
// did not open, so every Codex command went to root. The single-quoted form is read only when it is exactly
// one quoted token to the end; everything else stays unrecognised, and what is inside is judged as before.
import { describe, expect, it } from 'vitest';
import { REASONS } from './reasons';
import { CODEX_PS_EXE, ROOT, codex, codexSingle, contextFor, decide, request, verdict } from './testing/requests';

const sh = String.raw;
const raw = (cmd: string) => request('command', `Run command: ${cmd}`, { command: cmd });

describe('T021 the single-quoted Codex wrapper', () => {
  it('T021 the commands of the smoke run, exactly as Codex sent them, are read and approved', () => {
    // x1 used -NoProfile, x2 did not; both with the doubled backslashes of the executable.
    expect(verdict(raw(sh`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command 'Get-Content readme.txt'`))).toBe('approve');
    expect(verdict(raw(sh`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Start-Sleep -Seconds 20'`))).toBe('approve');
    expect(verdict(codexSingle('Set-Content -Path notes.txt -Value ok'))).toBe('approve');
  });

  it('T021 the smoke run’s write outside the folder is escalated as such, not as unreadable', () => {
    const outside = contextFor(sh`C:\Users\u\AppData\Local\Temp\awg-t021\ws-a`);
    const req = codexSingle('Set-Content -Path C:/Users/u/AppData/Local/Temp/awg-t021/outside/codex-approved.txt -Value ok', { cwd: sh`C:\Users\u\AppData\Local\Temp\awg-t021\ws-a` });
    expect(verdict(req, outside)).toBe('write-outside-scope');
  });

  describe('T021 what is inside the quotes is judged as if run directly', () => {
    it.each([
      ['Set-Content -Path ../outside/x.txt -Value x', 'write-outside-scope'],
      ['Get-Content .env', 'secret-read'],
      ['Get-Content C:/Users/u/.ssh/id_rsa', 'secret-read'],
      ['git push origin main', 'git-remote'],
      ['Remove-Item -Recurse -Force tmpdir', 'destructive'],
      ['node -e process.exit(0)', 'unrecognised'],
    ])('T021 %s → %s, as in the double-quoted form', (script, rule) => {
      expect(verdict(codexSingle(script))).toBe(rule);
      expect(verdict(codexSingle(script))).toBe(verdict(codex(script)));
    });

    it('T021 \\, $ and backticks are read as written: the outer quotes expand nothing, the script rules still apply', () => {
      expect(verdict(codexSingle(sh`Get-Content src\a.ts`))).toBe('approve');
      expect(decide(codexSingle('Get-Content $env:USERPROFILE/.ssh/id_rsa')).action).toBe('escalate');
      expect(decide(codexSingle('Write-Output `whoami`')).action).toBe('escalate');
    });
  });

  describe('T021 anything but one whole quoted token to the end stays unrecognised, as before', () => {
    it.each([
      // Harmless tails, so the verdict shows the wrapper was not opened (a destructive tail is escalated as such).
      ['a tail after the token', `${CODEX_PS_EXE} -Command 'Get-Content a.txt' ; Get-Content b.txt`],
      ['a second quoted token', `${CODEX_PS_EXE} -Command 'Get-Content a.txt' 'b.txt'`],
      ['a double-quoted token joined on', `${CODEX_PS_EXE} -Command 'Get-Content a.txt'"b.txt"`],
      ['an unpaired quote', `${CODEX_PS_EXE} -Command 'Get-Content a.txt`],
      ['a lone quote inside', `${CODEX_PS_EXE} -Command 'Get-Content it's.txt'`],
      ['another parameter in front', `${CODEX_PS_EXE} -ExecutionPolicy Bypass -Command 'Get-Content a.txt'`],
      ['a parameter after -Command', `${CODEX_PS_EXE} -Command -NoProfile 'Get-Content a.txt'`],
      ['another executable', sh`"C:\\tools\\powershell-like.exe" -Command 'Get-Content a.txt'`],
      ['a relative powershell.exe', `powershell.exe -Command 'Get-Content a.txt'`],
    ])('T021 %s', (_why, cmd) => {
      expect(verdict(raw(cmd))).toBe('unrecognised');
    });
  });

  describe("T021 '' is one quote to PowerShell but joins two pieces in Bash: both readings must pass", () => {
    it("T021 a quote inside a commit message is approved in both readings", () => {
      expect(verdict(codexSingle("git commit -m ''done''"))).toBe('approve');
    });

    it('T021 a script harmless to PowerShell but destructive as Bash hands it on is escalated', () => {
      // PowerShell: echo 'x; Remove-Item -Recurse -Force src'. Bash: echo x; Remove-Item -Recurse -Force src.
      expect(decide(codexSingle("echo ''x; Remove-Item -Recurse -Force src''"))).toMatchObject({ action: 'escalate', rule: 'destructive' });
    });
  });

  it('T021 the double-quoted form is unchanged: rule E still applies to it', () => {
    expect(decide(codex(sh`Get-Content src\a.ts`))).toEqual({ action: 'escalate', rule: 'unrecognised', reason: REASONS.syntax });
    expect(verdict(codex('Get-Content src/a.ts'))).toBe('approve');
  });

  it('T021 a destructive tail after the token is still escalated', () => {
    expect(decide(raw(`${CODEX_PS_EXE} -Command 'Get-Content a.txt' ; Remove-Item -Recurse x`)).action).toBe('escalate');
  });
});

describe('T021 everyday work stays approved in the single-quoted Codex form too', () => {
  // The list of review-r2's "everyday work"; a quote in a script is written '' as PowerShell would.
  it.each([
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
  ])('T021 Codex single-quoted: %s', (cmd) => expect(verdict(codexSingle(cmd.replaceAll("'", "''")), contextFor(ROOT))).toBe('approve'));
});

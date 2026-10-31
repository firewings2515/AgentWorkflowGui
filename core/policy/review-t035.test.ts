// T035 (T024 r1 P2-2): Codex's ordinary PowerShell writes went to root as unrecognised. Codex 0.160 joins
// its argv with shlex 1.3.0, so a script with `'` and a Windows path comes in double quotes with doubled
// backslashes, which rule E never opened; a script with `!`, `$` or a backtick next to a `'` comes in
// several quoted pieces, which no wrapper form matched. With the executable in double quotes PowerShell
// cannot run the line at all (its parser stops at `-Command`: UnexpectedToken), so only the Bash reading
// and Codex's argv matter, and they agree exactly when the word is what shlex itself produces.
import { describe, expect, it } from 'vitest';
import { REASONS } from './reasons';
import { shlexArgument, shlexQuote } from './shlex';
import { CODEX_PS_EXE, ROOT, codexShlex, contextFor, decide, request, verdict } from './testing/requests';

const sh = String.raw;
const raw = (cmd: string) => request('command', `Run command: ${cmd}`, { command: cmd });
const BARE_EXE = sh`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

// The two writes of the T024 live run, with the workspace as the path (ROOT is E:\work\proj).
const FILE = sh`E:\work\proj\hello.txt`;
const WRITE_TWO_LINES = `Set-Content -LiteralPath '${FILE}' -Value 'hello from awg-t024' -NoNewline; Add-Content -LiteralPath '${FILE}' -Value ''`;
const APPEND = `Add-Content -LiteralPath '${FILE}' -Value 'reviewed: yes'`;

describe('T035 Codex quoting is reproduced exactly (shlex 1.3.0)', () => {
  it('T035 the T021 live commands come out as they were seen', () => {
    expect([BARE_EXE, '-NoProfile', '-Command', 'Get-Content readme.txt'].map(shlexQuote).join(' ')).toBe(
      sh`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command 'Get-Content readme.txt'`,
    );
  });

  it.each([
    // A `'` and a backslash: one double-quoted piece, `\` doubled.
    [WRITE_TWO_LINES, sh`"Set-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'hello from awg-t024' -NoNewline; Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value ''"`],
    [APPEND, sh`"Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'reviewed: yes'"`],
    // A `"` as well: escaped.
    [sh`Add-Content -LiteralPath "E:\work\proj\hello.txt" -Value 'reviewed: yes'`, sh`"Add-Content -LiteralPath \"E:\\work\\proj\\hello.txt\" -Value 'reviewed: yes'"`],
    // `!` cannot be in double quotes and `'` cannot be in single ones: three pieces.
    ["Set-Content -LiteralPath hello.txt -Value 'hello!' -NoNewline; Add-Content -LiteralPath hello.txt -Value ''", `"Set-Content -LiteralPath hello.txt -Value 'hello"'!'"' -NoNewline; Add-Content -LiteralPath hello.txt -Value ''"`],
    // `^` only right after an opening single quote; a bare start before it.
    ['a^b', "a'^b'"],
    ['', "''"],
  ])('T035 %s', (arg, quoted) => {
    expect(shlexQuote(arg)).toBe(quoted);
    if (arg !== '') expect(shlexArgument(quoted)).toBe(arg);
  });
});

describe('T035 the two live writes, as Codex sent them, are read and approved', () => {
  // Before T035 both were `unrecognised` with REASONS.syntax: unwrapPowerShell matched WRAPPER, rule E saw
  // the `\` and returned safe: false, and evaluatePermission added unrecognised/syntax.
  it.each([
    ['Set-Content … -NoNewline; Add-Content … -Value ""', WRITE_TWO_LINES],
    ["Add-Content -LiteralPath … -Value '…'", APPEND],
  ])('T035 %s, with and without -NoProfile', (_what, script) => {
    expect(verdict(codexShlex(script))).toBe('approve');
    expect(verdict(codexShlex(script, false))).toBe('approve');
  });

  it.each([
    ['the path in double quotes (`\\"`)', sh`Add-Content -LiteralPath "E:\work\proj\hello.txt" -Value 'reviewed: yes'`],
    ['the path bare', sh`Add-Content -LiteralPath E:\work\proj\hello.txt -Value 'reviewed: yes'`],
    ['several quoted pieces with an empty string', "Set-Content -LiteralPath hello.txt -Value 'hello!' -NoNewline; Add-Content -LiteralPath hello.txt -Value ''"],
    ['several quoted pieces with a backslash', sh`Add-Content -LiteralPath '${FILE}' -Value 'reviewed!'`],
    ['a relative path with a backslash', sh`Add-Content -LiteralPath 'notes\done.txt' -Value 'yes'`],
    ['a read', sh`Get-Content -LiteralPath '${FILE}' -TotalCount 20`],
  ])('T035 %s', (_what, script) => {
    expect(verdict(codexShlex(script))).toBe('approve');
  });
});

describe('T035 the same forms outside the scope, or doing something risky, are escalated as such', () => {
  const outsideFile = sh`E:\work\outside\hello.txt`;
  it.each([
    ['two lines, outside', WRITE_TWO_LINES.replaceAll(FILE, outsideFile), 'write-outside-scope'],
    ['append, outside', APPEND.replace(FILE, outsideFile), 'write-outside-scope'],
    ['append, up and out', sh`Add-Content -LiteralPath '..\outside\hello.txt' -Value 'reviewed: yes'`, 'write-outside-scope'],
    ['append, outside, in double quotes', sh`Add-Content -LiteralPath "E:\work\outside\hello.txt" -Value 'reviewed: yes'`, 'write-outside-scope'],
    ['append, outside, bare', sh`Add-Content -LiteralPath E:\work\outside\hello.txt -Value 'reviewed: yes'`, 'write-outside-scope'],
    ['pieces, outside', sh`Add-Content -LiteralPath '${outsideFile}' -Value 'reviewed!'`, 'write-outside-scope'],
    ['pieces with an empty string, outside', `Set-Content -LiteralPath '../outside/hello.txt' -Value 'hello!' -NoNewline; Add-Content -LiteralPath hello.txt -Value ''`, 'write-outside-scope'],
    ['only the second write outside', `Set-Content -LiteralPath '${FILE}' -Value 'a' -NoNewline; Add-Content -LiteralPath '${outsideFile}' -Value ''`, 'write-outside-scope'],
    ['a secret', sh`Add-Content -LiteralPath 'E:\work\proj\.env' -Value 'X=1'`, 'secret-read'],
    ['a read outside', sh`Get-Content -LiteralPath 'C:\Users\u\.ssh\id_rsa'`, 'secret-read'],
    ['a recursive delete', sh`Remove-Item -Recurse -Force 'E:\work\proj\src'`, 'destructive'],
    ['a push', sh`git -C 'E:\work\proj' push origin main`, 'git-remote'],
    ['an encoded command', sh`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -EncodedCommand ZQBjAGgAbwA=`, 'unrecognised'],
    ['a variable', sh`Add-Content -LiteralPath $env:TEMP\x.txt -Value 'x'`, 'unrecognised'],
    ['a subexpression', sh`Add-Content -LiteralPath "$(Get-Location)\x.txt" -Value 'x'`, 'unrecognised'],
    ['a tail after the quote of a string', sh`Write-Output "it's"; Remove-Item -Recurse -Force 'E:\work\proj\src'`, 'destructive'],
  ])('T035 %s → %s', (_what, script, rule) => {
    expect(verdict(codexShlex(script))).toBe(rule);
  });

  it('T035 an encoded command is still called out as encoded', () => {
    expect(decide(codexShlex(sh`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -EncodedCommand ZQBjAGgAbwA=`))).toMatchObject({ action: 'escalate', reason: REASONS.encoded });
  });

  it('T035 in a read-only scope the live writes go to root', () => {
    expect(verdict(codexShlex(APPEND), contextFor(ROOT, {}, true))).toBe('write-outside-scope');
  });
});

describe('T035 quoting Codex does not produce stays unopened (unrecognised), as before', () => {
  const pieces = sh`"Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'reviewed"'!'"'"`;
  it.each([
    // Claude's Bash tool writes Windows paths with single backslashes: rule E as before.
    ['a single backslash', sh`${CODEX_PS_EXE} -Command "Add-Content -LiteralPath 'E:\work\proj\hello.txt' -Value 'x'"`],
    ['an escaped dollar', sh`${CODEX_PS_EXE} -Command "Get-Content \$HOME\\a.txt 'x'"`],
    ['a dollar in double quotes', sh`${CODEX_PS_EXE} -Command "Get-Content $HOME\\a.txt 'x'"`],
    ['a backtick in double quotes', `${CODEX_PS_EXE} -Command "Get-Content \`whoami\`\\\\a.txt 'x'"`],
    ['a `!` in double quotes', sh`${CODEX_PS_EXE} -Command "Get-Content 'E:\\work\\proj\\a!.txt'"`],
    ['the same argument, quoted another way', sh`${CODEX_PS_EXE} -Command "Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value "'x'`],
    ['a second word', sh`${CODEX_PS_EXE} -Command "Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'x'" 'y'`],
    ['a tail', sh`${CODEX_PS_EXE} -Command "Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'x'"; Get-Content b.txt`],
    ['an unpaired quote', sh`${CODEX_PS_EXE} -Command "Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'x'`],
    // A bare executable: PowerShell could run the line itself and would read `\"` and `\\` differently.
    ['a bare executable, doubled backslashes', sh`${BARE_EXE} -Command "Add-Content -LiteralPath 'E:\\work\\proj\\hello.txt' -Value 'x'"`],
    ['a bare executable, pieces', `${BARE_EXE} -Command ${pieces}`],
    ['another parameter in front', `${CODEX_PS_EXE} -ExecutionPolicy Bypass -Command ${pieces}`],
    ['another executable', sh`"C:\\tools\\powershell-like.exe" -Command ${pieces}`],
  ])('T035 %s', (_why, cmd) => {
    expect(verdict(raw(cmd))).toBe('unrecognised');
  });

  it('T035 the pieces themselves are opened with the quoted executable', () => {
    expect(verdict(raw(`${CODEX_PS_EXE} -NoProfile -Command ${pieces}`))).toBe('approve');
  });

  it('T035 an escaped quote cannot end the script early: what follows it is part of the string', () => {
    // Bash and Codex: Write-Output "x; Remove-Item -Recurse src". PowerShell cannot run the line at all.
    expect(verdict(raw(sh`${CODEX_PS_EXE} -Command "Write-Output \"x; Remove-Item -Recurse src\" 'y'"`))).toBe('approve');
    expect(verdict(raw(sh`${CODEX_PS_EXE} -Command "Write-Output \"x\" 'y'; Remove-Item -Recurse src"`))).toBe('destructive');
  });
});

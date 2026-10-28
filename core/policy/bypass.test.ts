// Bypass attempts (T014 brief): case, quoting, whitespace, mixed slashes, `..`, 8.3 names, nested shells
// and launchers. None of them may be approved.
import { describe, expect, it } from 'vitest';
import { codex, command, verdict } from './testing/requests';

const attempts: string[] = [
  'RM -RF build',
  'REMOVE-ITEM -RECURSE build',
  'Remove-Item build -rECURSE',
  'GIT PUSH origin main',
  'cat .ENV',
  "Get-Content '.env'",
  "cat '.e'nv",
  'cat ".e""nv"',
  String.raw`cat .e\nv`,
  'git   push',
  'git\tpush',
  'rm\u00a0-rf build',
  'Remove-Item a\u3000-Recurse',
  'Remove-Item \u2013Recurse build',
  "Remove-Item 'x'-Recurse",
  'cat \u2018.env\u2019',
  String.raw`echo x > ..\..\outside.txt`,
  'echo x > sub/../../a.txt',
  'echo x > E:/work/proj/../../../../a',
  'echo x > E:/work/wor\u212A/a.txt',
  'echo x >../a.txt',
  'echo x 2>&1 >>../a.txt',
  'cd sub/../..; echo x > a.txt',
  'echo x > C:/PROGRA~1/x.txt',
  'echo x > E:/work/PROJ~1/a.txt',
  'echo x > "../a.txt."',
  'cat ".env "',
  String.raw`cat \?\C:\secret.txt`,
  'cat %USERPROFILE%/.ssh/id_rsa',
  'cat $env:USERPROFILE/.ssh/id_rsa',
  'echo x > ~/a',
  String.raw`cmd /c del /s /q C:\x`,
  'cmd /c "type .env"',
  'cmd.exe /c dir',
  'pwsh -c "Remove-Item -Recurse x"',
  'pwsh -Command Get-ChildItem',
  'powershell -c "Get-Content .env"',
  'Start-Process notepad',
  'saps cmd',
  'Invoke-Expression "rm -rf x"',
  '& rm -rf x',
  '. ./x.ps1',
  'bash -c "rm -rf /"',
  'git --% push',
  'git -c alias.st=push st',
  'git pu',
  'sort -o../x a.txt',
  'cp -t../x a.txt',
  'rg --pre=sh x',
  String.raw`find . -exec cat x \;`,
  'node --require ./evil.js app.js',
  'env rm -rf x',
  'GIT_SSH_COMMAND=x git push',
  'New-Item -ItemType SymbolicLink -Path l -Target C:/',
  'ln -s / l',
  'Set-Location HKCU:',
  'cd ~; cat .bashrc',
  'echo x >| ../a',
  'echo x &> ../a',
  'Get-ChildItem -Recurse | Remove-Item',
];

describe('bypass attempts are never approved', () => {
  it.each(attempts)('%s', (cmd) => expect(verdict(command(cmd))).not.toBe('approve'));

  it.each([
    String.raw`"E:\work\proj\powershell.exe" -Command "Get-ChildItem"`,
    String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -EncodedCommand ZQBjAGgAbwA=`,
  ])('fake or encoded wrapper %#', (cmd) => expect(verdict(command(cmd))).toBe('unrecognised'));

  it.each(["powershell -c 'Get-ChildItem'", 'Get-ChildItem; git push', 'Remove-Item \u2013Recurse x'])('inside the Codex wrapper: %s', (script) =>
    expect(verdict(codex(script))).not.toBe('approve'),
  );

  it('still approves case variants of in-scope paths (not a bypass)', () => {
    expect(verdict(command('echo x > E:/WORK/PROJ/a.txt'))).toBe('approve');
  });
});

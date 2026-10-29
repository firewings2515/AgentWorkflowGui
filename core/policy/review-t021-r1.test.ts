// T021 review round 1, P1-1: the wrapper's executable token was normalised before its syntax was checked,
// so `;`, `#` and `..` could hide a second command in front of a trusted PowerShell path. Both quote forms.
import { describe, expect, it } from 'vitest';
import { CODEX_PS_EXE, contextFor, decide, request, verdict } from './testing/requests';

const PROJ = 'E:/proj';
// The reviewer's setting: the scope and cwd are E:/proj, and payload.cmd was written by this session.
const written = contextFor(PROJ, { writtenPaths: ['E:/proj/payload.cmd'] });
const raw = (cmd: string) => request('command', `Run command: ${cmd}`, { command: cmd, cwd: PROJ });
const EXE = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const scripts = { single: "'echo ok'", double: '"echo ok"' } as const;

describe('t021-r1-P1-1 the executable token is checked as written, before it is normalised', () => {
  it.each(Object.entries(scripts))("t021-r1-P1-1 the reviewer's counterexample (%s quotes) is escalated, not approved", (_form, script) => {
    const cmd = `C:/Windows/System32/WindowsPowerShell/v1.0/x;E:/proj/payload.cmd;#/../../../powershell.exe -Command ${script}`;
    expect(decide(raw(cmd), written).action).toBe('escalate');
  });

  const hidden: [string, string][] = [
    [';', 'C:/Windows/System32/WindowsPowerShell/v1.0/x;E:/proj/payload.cmd/../../../../powershell.exe'],
    ['&', 'C:/Windows/System32/WindowsPowerShell/v1.0/x&E:/proj/payload.cmd/../../../../powershell.exe'],
    ['|', 'C:/Windows/System32/WindowsPowerShell/v1.0/x|E:/proj/payload.cmd/../../../../powershell.exe'],
    ['#', 'C:/Windows/System32/WindowsPowerShell/v1.0/x#/../powershell.exe'],
    ['a backtick', 'C:/Windows/System32/WindowsPowerShell/v1.0/x`E:/proj/payload.cmd`/../../../../powershell.exe'],
    ['$()', 'C:/Windows/System32/WindowsPowerShell/v1.0/x$(E:/proj/payload.cmd)/../powershell.exe'],
    ['a line break', 'C:/Windows/System32/WindowsPowerShell/v1.0/x\nE:/proj/payload.cmd\n/../../../../powershell.exe'],
    ['NUL', 'C:/Windows/System32/WindowsPowerShell/v1.0/x\u0000E:/proj/payload.cmd/../../../../powershell.exe'],
  ];
  describe.each(Object.entries(scripts))('t021-r1-P1-1 %s quotes', (_form, script) => {
    it.each(hidden)('t021-r1-P1-1 %s in a bare executable token is escalated', (_what, exe) => {
      expect(decide(raw(`${exe} -Command ${script}`), written).action).toBe('escalate');
    });
    it.each(hidden)('t021-r1-P1-1 %s in a double-quoted executable token is escalated', (_what, exe) => {
      expect(decide(raw(`"${exe}" -Command ${script}`), written).action).toBe('escalate');
    });
    it.each([
      ['a . segment', 'C:/Windows/System32/./WindowsPowerShell/v1.0/powershell.exe'],
      ['a .. segment that folds back to the same place', 'C:/Windows/System32/WindowsPowerShell/v1.0/../v1.0/powershell.exe'],
      ['a .. segment with backslashes', String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\..\v1.0\powershell.exe`],
    ])('t021-r1-P1-1 %s is never opened, even when it normalises to PowerShell', (_what, exe) => {
      expect(verdict(raw(`${exe} -Command ${script}`))).toBe('unrecognised');
      expect(verdict(raw(`"${exe}" -Command ${script}`))).toBe('unrecognised');
    });
    it('t021-r1-P1-1 a line break between the executable and -Command is not one command', () => {
      expect(decide(raw(`"${EXE}"\n-Command ${script}`)).action).toBe('escalate');
      expect(decide(raw(`"${EXE}" -NoProfile\n-Command ${script}`)).action).toBe('escalate');
    });
    it('t021-r1-P1-1 a near miss of the known locations is not PowerShell', () => {
      expect(verdict(raw(`C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe.bak -Command ${script}`))).toBe('unrecognised');
      expect(verdict(raw(`D:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command ${script}`))).toBe('unrecognised');
    });
  });

  it('t021-r1-P1-1 the known locations are still opened: bare, quoted, doubled backslashes, pwsh, any case', () => {
    expect(verdict(raw(`${EXE} -Command 'echo ok'`))).toBe('approve');
    expect(verdict(raw(`${EXE} -Command "echo ok"`))).toBe('approve');
    expect(verdict(raw(`${CODEX_PS_EXE} -NoProfile -Command 'echo ok'`))).toBe('approve');
    expect(verdict(raw(`"C:/Program Files/PowerShell/7/pwsh.exe" -Command 'echo ok'`))).toBe('approve');
    expect(verdict(raw(`"c:/WINDOWS/system32/WindowsPowerShell/V1.0/PowerShell.EXE" -Command 'echo ok'`))).toBe('approve');
  });
});

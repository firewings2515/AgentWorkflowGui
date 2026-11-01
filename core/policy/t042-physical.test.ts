// T042 F1: Git Bash (MSYS) follows a link before it takes `..`, so `link/../x` is next to the link's target, and
// its programs run in the real working folder. Win32 and native programs fold `..` as written. Both readings
// are checked; the real-file-system proof is app/main/t042-paths.test.ts.
import { describe, expect, it } from 'vitest';
import type { PolicyContext } from '../ports';
import { codex, codexSingle, command, contextFor, verdict } from './testing/requests';

/** `E:\work\proj\link` is a junction to `E:\far\deep`; nothing else is a link. */
const LINKS: [string, string][] = [['e:/work/proj/link', 'e:/far/deep']];
const resolveRealPath = (path: string): string | null => {
  const p = path.replaceAll('\\', '/').toLowerCase();
  for (const [link, target] of LINKS) if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length);
  return path;
};
const linked: PolicyContext = contextFor(undefined, { resolveRealPath });

describe('T042 F1: `..` after a link in Git Bash', () => {
  it.each([
    ['cat link/../x.txt', 'secret-read'],
    ['cat ./link/../x.txt', 'secret-read'],
    ['cat link/sub/../../x.txt', 'secret-read'],
    ['echo W > link/../w1.txt', 'write-outside-scope'],
    ['echo W >> link/../w1.txt', 'write-outside-scope'],
    ['cp x.txt link/../w2.txt', 'write-outside-scope'],
    ['rm link/../x.txt', 'write-outside-scope'],
    ['cd link && cat ../x.txt', 'secret-read'],
    ['cd link && echo W > ../w.txt', 'write-outside-scope'],
    ['cd -P link/.. && cat x.txt', 'secret-read'],
    ['cd -P link/.. && echo W > x.txt', 'write-outside-scope'],
  ])('%s is not approved', (cmd, rule) => {
    expect(verdict(command(cmd), linked)).toBe(rule);
  });

  it('an absolute path through the link is placed next to its target', () => {
    expect(verdict(command('cat E:/work/proj/link/../x.txt'), linked)).toBe('secret-read');
    expect(verdict(command('cat /e/work/proj/link/../x.txt'), linked)).toBe('secret-read');
  });

  it('a `..` whose real path cannot be confirmed is unrecognised', () => {
    const unsure = contextFor(undefined, { resolveRealPath: (p) => (p.toLowerCase().replaceAll('\\', '/').includes('/odd') ? null : p) });
    expect(verdict(command('cat odd/../x.txt'), unsure)).toBe('unrecognised');
  });

  it('`/c/..` is the MSYS root, not a place the policy knows', () => {
    expect(verdict(command('cat /e/../x.txt'))).not.toBe('approve');
  });

  it('PowerShell (Codex) folds `..` as written, as Windows does: the same text stays inside', () => {
    // Measured: `Get-Content link\..\x.txt` and `cmd /c type ..\x.txt` after `Set-Location link` read the file in the folder.
    expect(verdict(codex('Get-Content link/../x.txt'), linked)).toBe('approve');
    expect(verdict(codexSingle(String.raw`Get-Content link\..\x.txt`), linked)).toBe('approve');
  });

  it('without links, `..` in Bash is approved as before (no new escalation in ordinary work)', () => {
    for (const cmd of ['cat sub/../README.md', 'cat ../proj/README.md','echo x > sub/../out.txt', 'cd sub/.. && cat README.md']) {
      expect(verdict(command(cmd), linked), cmd).toBe('approve');
    }
  });

  it('a `..` that leaves the scope is still refused by the reading as written', () => {
    expect(verdict(command('cat ../x.txt'), linked)).toBe('secret-read');
    expect(verdict(command('echo x > ../x.txt'), linked)).toBe('write-outside-scope');
  });
});

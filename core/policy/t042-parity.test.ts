// T042 (V-04 tool-policy differences, V-22): the same operation, as Claude's Bash tool and as Codex's PowerShell
// wrapper sends it, gets the same decision. Each row is one operation; both forms must come out with its rule.
import { describe, expect, it } from 'vitest';
import { codexSingle, command, contextFor, edit, request, ROOT, tool, verdict } from './testing/requests';

const FAR = 'E:/far';
const written = contextFor(ROOT, { writtenPaths: [String.raw`E:\work\proj\gen.ps1`, String.raw`E:\work\proj\gen.js`, String.raw`E:\work\proj\gen.sh`] });

const rows: [string, string, string, string][] = [
  // operation, Claude (Bash), Codex (PowerShell), rule
  ['read outside', `cat ${FAR}/x.txt`, `Get-Content ${FAR}/x.txt`, 'secret-read'],
  ['write outside', `echo x > ${FAR}/x.txt`, `Set-Content ${FAR}/x.txt x`, 'write-outside-scope'],
  ['copy outside', `cp a.txt ${FAR}/a.txt`, `Copy-Item a.txt ${FAR}/a.txt`, 'write-outside-scope'],
  ['delete outside', `rm ${FAR}/x.txt`, `Remove-Item ${FAR}/x.txt`, 'write-outside-scope'],
  ['read a secret inside', 'cat .env', 'Get-Content .env', 'secret-read'],
  ['read an ssh key', 'cat C:/Users/x/.ssh/id_rsa', 'Get-Content C:/Users/x/.ssh/id_rsa', 'secret-read'],
  ['git push', 'git push origin main', 'git push origin main', 'git-remote'],
  ['force push', 'git push --force origin main', 'git push --force origin main', 'git-remote'],
  ['change a remote', 'git remote set-url origin https://x', 'git remote set-url origin https://x', 'git-remote'],
  ['global install', 'npm install -g typescript', 'npm install -g typescript', 'destructive'],
  ['interpreter one-liner (V-22)', 'node -e "1"', 'node -e "1"', 'unrecognised'],
  ['python one-liner (V-22)', 'python -c "1"', 'python -c "1"', 'unrecognised'],
  ['encoded command (V-22)', 'powershell -EncodedCommand ZQBjAGgAbwA=', 'powershell -EncodedCommand ZQBjAGgAbwA=', 'unrecognised'],
  ['nested shell (V-22)', 'cmd /c "type a.txt"', 'cmd /c "type a.txt"', 'unrecognised'],
  ['make a junction', `cmd /c mklink /J j ${FAR}`, `New-Item -ItemType Junction -Path j -Target ${FAR}`, 'unrecognised'],
  ['unknown program', 'foo-tool --x', 'foo-tool --x', 'unrecognised'],
  ['wildcard target outside', `cat ${FAR}/*.txt`, `Get-Content ${FAR}/*.txt`, 'unrecognised'],
];

describe('T042 B1/B2: Claude and Codex decide the same operation the same way', () => {
  it.each(rows)('%s', (_op, claude, codex, rule) => {
    expect(verdict(command(claude)), `Claude: ${claude}`).toBe(rule);
    expect(verdict(codexSingle(codex)), `Codex: ${codex}`).toBe(rule);
  });

  it('running a script this session wrote is unrecognised in both (V-22, CR-1)', () => {
    for (const [claude, codex] of [
      ['node gen.js', 'node gen.js'],
      ['./gen.sh', '.\\gen.ps1'],
      ['bash gen.sh', 'powershell -File gen.ps1'],
    ]) {
      expect(verdict(command(claude!), written), claude).toBe('unrecognised');
      expect(verdict(codexSingle(codex!), written), codex).toBe('unrecognised');
    }
  });

  it('the file tools match: Claude Write/Edit vs Codex fileChange, Claude Read vs Codex commandActions', () => {
    const out = `${FAR}/x.txt`;
    expect(verdict(edit(out))).toBe('write-outside-scope');
    expect(verdict(request('fileChange', 'apply_patch', { paths: [out] }))).toBe('write-outside-scope');
    expect(verdict(tool('Read', out))).toBe('secret-read');
    expect(verdict(codexSingle('Get-Content x.txt', { paths: [out] }))).toBe('secret-read');
  });

  it('ordinary work is approved in both (no over-caution)', () => {
    for (const [claude, codex] of [
      ['cat a.txt', 'Get-Content a.txt'],
      ['echo x > out.txt', 'Set-Content out.txt x'],
      ['git status', 'git status'],
      ['git diff', 'git diff'],
      ['npm test', 'npm test'],
    ]) {
      expect(verdict(command(claude!)), claude).toBe('approve');
      expect(verdict(codexSingle(codex!)), codex).toBe('approve');
    }
  });
});

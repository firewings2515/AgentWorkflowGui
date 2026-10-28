// Regression tests for the round 3 review of T014 (docs/tasks/reviews/T014-r3-result.md). Test names
// start with the review item (r3-P1-1 ...) so each counterexample can be found by name.
import { describe, expect, it } from 'vitest';
import type { PolicyContext } from '../ports';
import { REASONS } from './reasons';
import { ROOT, codex, command, contextFor, decide, edit, verdict } from './testing/requests';

const sh = String.raw;
const written = { action: 'escalate', rule: 'unrecognised', reason: REASONS['written-script'] };

/** A resolver that maps the listed (normalised) paths, and everything under them, elsewhere; `null` for unknown. */
const withLinks = (links: Record<string, string | null>): PolicyContext =>
  contextFor(ROOT, {
    resolveRealPath: (path) => {
      for (const [from, to] of Object.entries(links)) {
        if (path === from || path.startsWith(`${from}/`)) return to === null ? null : to + path.slice(from.length);
      }
      return path;
    },
  });

describe('r3-P1-1 Copy and Move land where PowerShell and cp/mv put the file', () => {
  it.each([
    "Set-Content src/a.py 'print(1)'; Copy-Item src/a.py; python a.py",
    "Set-Content src/a.py 'print(1)'; Move-Item src/a.py; python a.py",
  ])('r3-P1-1 counterexample (Claude and Codex): %s', (cmd) => {
    expect(decide(command(cmd))).toEqual(written);
    expect(decide(codex(cmd))).toEqual(written);
  });

  it('r3-P1-1 counterexample: Copy-Item src/a.txt out checks out/a.txt through the resolver', () => {
    expect(verdict(command('Copy-Item src/a.txt out'), withLinks({ 'e:/work/proj/out/a.txt': null }))).toBe('unrecognised');
    expect(verdict(command('Copy-Item src/a.txt out'), withLinks({ 'e:/work/proj/out/a.txt': sh`E:\outside\a.txt` }))).toBe('write-outside-scope');
    expect(verdict(command('Copy-Item src/a.txt out'))).toBe('approve');
  });

  it.each([
    "echo x > src/a.py; cp src/a.py .; python a.py",
    "echo x > src/a.py; cp src/a.py out; python out/a.py",
    "echo x > src/a.py; mv src/a.py out; node out/a.py",
    "echo x > src/a.py; cp -t out src/a.py; python out/a.py",
    "echo x > src/a.py; Copy-Item src/a.py -Destination out; python out/a.py",
    "echo x > src/a.py; Move-Item -Path src/a.py -Destination out; python out/a.py",
    "echo x > src/a.py; git mv src/a.py out; python out/a.py",
    "echo x > src/a.py; Rename-Item src/a.py b.py; python src/b.py",
  ])('r3-P1-1 variant: %s', (cmd) => expect(decide(command(cmd))).toEqual(written));

  it.each([
    ['cp a.txt b.txt out/', 'unrecognised'],
    ['mv a.txt', 'unrecognised'],
    ['git mv a.txt b.txt out', 'unrecognised'],
    ['cp -r src out', 'approve'],
    ['cp a.txt b.txt', 'approve'],
    ['Copy-Item src/a.txt -Destination out -Recurse', 'approve'],
    ['git mv src/a.ts src/b.ts', 'approve'],
  ])('r3-P1-1 sources and destinations: %s → %s', (cmd, expected) => expect(verdict(command(cmd))).toBe(expected));
  it('r3-P1-1 cp -r is approved in the Codex form too (PowerShell binds -r to -Recurse)', () => expect(verdict(codex('cp -r src out'))).toBe('approve'));
});

describe('r3-P1-2 git positionals are paths unless they read as revisions', () => {
  const unknown = withLinks({ 'e:/work/proj/src/a.ts': null });
  it.each(['git diff -- src/a.ts', 'git blame src/a.ts', 'git add src/a.ts'])('r3-P1-2 counterexample (resolver null): %s', (cmd) =>
    expect(verdict(command(cmd), unknown)).toBe('unrecognised'),
  );
  it.each(['git diff -- src/*.ts', 'git add src/*.ts'])('r3-P1-2 counterexample (wildcard): %s', (cmd) =>
    expect(decide(command(cmd))).toMatchObject({ rule: 'unrecognised', reason: REASONS.wildcard }),
  );
  const outside = withLinks({ 'e:/work/proj/src/a.ts': sh`E:\outside\a.ts` });
  it.each([
    ['git log -- src/a.ts', 'secret-read'],
    ['git diff src/a.ts', 'secret-read'],
    ['git commit src/a.ts -m done', 'secret-read'],
    ['git ls-files src/a.ts', 'secret-read'],
    ['git grep foo -- src/a.ts', 'secret-read'],
    ['git grep foo src/a.ts', 'secret-read'],
  ])('r3-P1-2 variant (link outside): %s → %s', (cmd, expected) => expect(verdict(command(cmd), outside)).toBe(expected));
  it.each([
    ['git log -- ../x.ts', 'secret-read'],
    ['git add .env', 'secret-read'],
    ['git status src/*.ts', 'unrecognised'],
    ['git add .', 'approve'],
    ['git add src/a.ts', 'approve'],
    ['git diff', 'approve'],
    ['git status', 'approve'],
    ['git diff HEAD~1 -- src/a.ts', 'approve'],
    ['git log main..HEAD', 'approve'],
    ['git show HEAD:src/a.ts', 'approve'],
    ['git diff origin/main', 'approve'],
    ['git blame src/a.ts', 'approve'],
    ['git grep foo', 'approve'],
  ])('r3-P1-2 everyday git: %s → %s', (cmd, expected) => expect(verdict(command(cmd))).toBe(expected));
  // Main session check: an absolute path holds a `:` but is not a revision; `git diff <outside> <file>` diffs the
  // outside file without --no-index.
  const viaLink = withLinks({ 'e:/work/proj/lnk': sh`E:\outside` });
  it.each([
    ['git diff E:/outside/a.txt src/a.ts', 'secret-read', undefined],
    ['git diff E:/outside/a.txt', 'secret-read', undefined],
    ['git blame E:/outside/a.ts', 'secret-read', undefined],
    ['git show E:/outside/a.ts', 'secret-read', undefined],
    ['git grep foo E:/outside', 'secret-read', undefined],
    ['git rev-parse ../x', 'secret-read', undefined],
    ['git diff E:/work/proj/lnk/a.ts', 'secret-read', viaLink],
    ['git blame E:/work/proj/lnk/a.ts', 'secret-read', viaLink],
    ['git diff E:/work/proj/src/a.ts', 'approve', undefined],
    ['git log ..origin/main', 'approve', undefined],
  ] as const)('r3-P1-2 main session check (absolute paths): %s → %s', (cmd, expected, context) =>
    expect(verdict(command(cmd), context)).toBe(expected),
  );
});

describe('r3-P1-3 NTFS alternate data streams', () => {
  it('r3-P1-3 counterexample: -Stream write then running the stream', () => {
    expect(verdict(command("Set-Content scripts/a.txt -Stream payload.py -Value 'print(1)'; python scripts/a.txt:payload.py"))).toBe('unrecognised');
  });
  it.each([
    ['Set-Content a.txt -Stream x -Value y', 'unrecognised'],
    ['Get-Content a.txt -Stream x', 'unrecognised'],
    ['Get-Item a.txt -Stream *', 'unrecognised'],
    ['cat a.txt:x', 'unrecognised'],
    ['echo x > a.txt:x', 'unrecognised'],
    ['python scripts/a.txt:payload.py', 'unrecognised'],
    ['cat .env:x', 'secret-read'],
    ['cat E:/work/proj/a.txt', 'approve'],
  ])('r3-P1-3 variant: %s → %s', (cmd, expected) => expect(verdict(command(cmd))).toBe(expected));
  it('r3-P1-3 variant: a fileChange on a stream', () => expect(verdict(edit(sh`E:\work\proj\a.txt:x`))).toBe('unrecognised'));
});

describe('r3-P2-1 git remote show / get-url use option tables', () => {
  it.each([
    ['git remote get-url --madeup origin', 'unrecognised'],
    ['git remote show --madeup origin', 'unrecognised'],
    ['git remote -v show origin', 'unrecognised'],
    ['git remote get-url origin', 'approve'],
    ['git remote get-url --push origin', 'approve'],
    ['git remote show origin', 'approve'],
    ['git remote show -n origin', 'approve'],
    ['git remote -v', 'approve'],
    ['git remote add up https://example.com/x.git', 'git-remote'],
  ])('r3-P2-1: %s → %s', (cmd, expected) => expect(verdict(command(cmd))).toBe(expected));
});

describe('r3-P2-2 the working folder and cd targets go through the resolver', () => {
  const nothing = contextFor(ROOT, { resolveRealPath: () => null });
  it('r3-P2-2 counterexample: echo ok with an unresolvable working folder', () => expect(verdict(command('echo ok'), nothing)).toBe('unrecognised'));
  it('r3-P2-2 counterexample: cd sub; echo ok with an unresolvable cd target', () => {
    expect(verdict(command('cd sub; echo ok'), nothing)).toBe('unrecognised');
    expect(verdict(command('cd sub; echo ok'), withLinks({ 'e:/work/proj/sub': null }))).toBe('unrecognised');
    expect(verdict(command('Set-Location sub; echo ok'), withLinks({ 'e:/work/proj/sub': null }))).toBe('unrecognised');
    expect(verdict(command('Push-Location sub; echo ok'), withLinks({ 'e:/work/proj/sub': null }))).toBe('unrecognised');
  });
  it('r3-P2-2: with a working resolver both stay approved', () => {
    expect(verdict(command('echo ok'))).toBe('approve');
    expect(verdict(command('cd sub; echo ok'))).toBe('approve');
  });
});

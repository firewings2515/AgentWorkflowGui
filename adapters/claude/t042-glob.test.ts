// T042 A11: a Glob pattern that reaches outside the folder. The pattern is not one of the tool's path fields, so
// before T042 the policy saw only the working folder and approved `C:/Users/x/.ssh/*`.
import { describe, expect, it } from 'vitest';
import { PermissionRequestId, SessionId, Timestamp } from '../../contracts';
import { contextFor } from '../../core/policy/testing/requests';
import { permissionPolicy } from '../../core/policy';
import { buildPermissionRequest, globReach } from './permissions';

const CWD = String.raw`E:\work\proj`;
const glob = (input: Record<string, unknown>) =>
  buildPermissionRequest(
    { toolName: 'Glob', toolInput: input, toolUseId: 'toolu_1', cwd: CWD },
    { id: PermissionRequestId.parse('perm-1'), placement: { sessionId: SessionId.parse('session-1') }, createdAt: Timestamp.parse('2026-11-01T00:00:00Z') },
  );
const verdict = (input: Record<string, unknown>) => {
  const d = permissionPolicy.evaluate(glob(input), contextFor(CWD));
  return d.action === 'approve' ? 'approve' : d.rule;
};

describe('T042 A11: Glob patterns that leave the folder', () => {
  it.each([
    [{ pattern: 'C:/Users/x/.ssh/*' }, 'secret-read'],
    [{ pattern: String.raw`C:\Users\x\Documents\*.txt` }, 'secret-read'],
    [{ pattern: '../../**/*' }, 'secret-read'],
    [{ pattern: '../other/*.ts' }, 'secret-read'],
    [{ path: 'src', pattern: '../../../*' }, 'secret-read'],
    [{ path: String.raw`E:\work\proj\src`, pattern: '../../*' }, 'secret-read'],
    [{ pattern: '/Users/x/*' }, 'secret-read'],
    [{ pattern: '**/../../*' }, 'unrecognised'],
    [{ pattern: 'src/*/../../../*' }, 'unrecognised'],
    [{ pattern: 'C:*.txt' }, 'unrecognised'],
    [{ pattern: '~/.ssh/*' }, 'unrecognised'],
    [{ pattern: '//server/share/x/*' }, 'secret-read'],
    // r1-P1-1: a search from a root, brace alternatives, a backslash UNC pattern beside a relative `path`.
    [{ pattern: '/*' }, 'unrecognised'],
    [{ pattern: '/**/id_rsa' }, 'unrecognised'],
    [{ pattern: 'C:/*' }, 'unrecognised'],
    [{ pattern: String.raw`C:\**\*.pem` }, 'unrecognised'],
    [{ pattern: '~/*' }, 'unrecognised'],
    [{ pattern: '//server/share/*' }, 'unrecognised'],
    [{ path: 'src', pattern: String.raw`\\server\share\*` }, 'unrecognised'],
    [{ pattern: '{../far,src}/**' }, 'secret-read'],
    [{ pattern: 'src/{a,{b,../../far}}/*' }, 'secret-read'],
    [{ pattern: '{C:/Users/x,src}/*' }, 'secret-read'],
    [{ pattern: '{.,x}./*' }, 'secret-read'],
    [{ pattern: '{../far/*' }, 'unrecognised'],
    [{ pattern: 'x}/../*' }, 'unrecognised'],
    [{ pattern: '[/]Users/*' }, 'unrecognised'],
    [{ pattern: '**/[.][.]/*' }, 'unrecognised'],
    [{ pattern: '.*/*' }, 'unrecognised'],
    [{ pattern: '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/*' }, 'unrecognised'],
    // r2-P1: what cannot be expanded is refused even with no wildcard of the policy's own in it.
    [{ pattern: '{..,src}/{a,b}{a,b}{a,b}{a,b}{a,b}.txt' }, 'secret-read'],
    [{ pattern: '{..,src}/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}.txt' }, 'unrecognised'],
    [{ path: 'src', pattern: '{..,src}/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}.txt' }, 'unrecognised'],
    [{ pattern: '{../x.txt' }, 'unrecognised'],
    [{ pattern: '{..,src/x.txt' }, 'unrecognised'],
    [{ pattern: 'x}/../a.txt' }, 'unrecognised'],
    [{ pattern: '../x(.txt' }, 'unrecognised'],
    [{ pattern: '/' }, 'unrecognised'],
    [{ pattern: 'C:' }, 'unrecognised'],
  ])('%j is not approved', (input, rule) => {
    expect(verdict(input)).toBe(rule);
  });

  it.each([
    [{ pattern: '**/*.ts' }],
    [{ pattern: 'src/**/*.ts' }],
    [{ pattern: 'src/**' }],
    [{ pattern: '*.{ts,tsx}' }],
    [{ pattern: '**/*.{ts,tsx,js}' }],
    [{ pattern: '{src,lib}/**/*.ts' }],
    [{ pattern: 'app/[id]/page.tsx' }],
    [{ pattern: '**/.env*' }],
    [{ path: String.raw`E:\work\proj\src`, pattern: '*.ts' }],
    [{ pattern: 'E:/work/proj/src/**/*.ts' }],
    [{ path: 'src', pattern: '../lib/*.ts' }],
  ])('%j inside the folder is still approved', (input) => {
    expect(verdict(input)).toBe('approve');
  });

  it('adds only what the pattern reaches; other tools are unchanged', () => {
    expect(globReach({ pattern: '**/*.ts' })).toEqual([]);
    expect(globReach({ pattern: 'src/**/*.ts' })).toEqual(['src']);
    expect(globReach({ path: 'lib', pattern: '../x/*' })).toEqual(['lib/../x']);
    expect(globReach({ path: 'lib', pattern: 'C:/x/*' })).toEqual(['C:/x']);
    expect(globReach({ pattern: '{../far,src}/**' })).toEqual(['../far', 'src']);
    expect(globReach({ pattern: '**/*.{ts,tsx}' })).toEqual([]);
    expect(globReach({ path: 'src', pattern: String.raw`\\server\share\*` })).toEqual(['//server/share/*']);
    expect(globReach({ pattern: '/*' })).toEqual(['/*']);
    expect(globReach({ pattern: '{../x.txt' })).toEqual(['{../x.txt/*']);
    expect(globReach({ path: 'src', pattern: '{..,a}/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}.txt' })).toEqual(['src/{..,a}/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}.txt/*']);
    expect(glob({ pattern: '**/*.ts' }).paths).toEqual([]);
    expect(
      buildPermissionRequest(
        { toolName: 'Grep', toolInput: { pattern: '../../*', path: 'src' }, toolUseId: 'toolu_2', cwd: CWD },
        { id: PermissionRequestId.parse('perm-2'), placement: { sessionId: SessionId.parse('session-1') }, createdAt: Timestamp.parse('2026-11-01T00:00:00Z') },
      ).paths,
    ).toEqual(['src']);
  });
});

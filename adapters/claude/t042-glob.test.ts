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
    [{ pattern: '//server/share/*' }, 'secret-read'],
  ])('%j is not approved', (input, rule) => {
    expect(verdict(input)).toBe(rule);
  });

  it.each([
    [{ pattern: '**/*.ts' }],
    [{ pattern: 'src/**/*.ts' }],
    [{ pattern: '*.{ts,tsx}' }],
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
    expect(glob({ pattern: '**/*.ts' }).paths).toEqual([]);
    expect(
      buildPermissionRequest(
        { toolName: 'Grep', toolInput: { pattern: '../../*', path: 'src' }, toolUseId: 'toolu_2', cwd: CWD },
        { id: PermissionRequestId.parse('perm-2'), placement: { sessionId: SessionId.parse('session-1') }, createdAt: Timestamp.parse('2026-11-01T00:00:00Z') },
      ).paths,
    ).toEqual(['src']);
  });
});

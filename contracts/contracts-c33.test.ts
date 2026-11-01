// C-33 (T045): runtime status. Rule codes carry no input values, as for every other refinement.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppEvent, Command, issueRule, RuntimeStatus, Snapshot } from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const at = '2026-11-01T19:00:00+08:00';
const MARKER = 'SENSITIVE_INPUT_MARKER';
const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const rules = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  expect(JSON.stringify(r.error?.issues ?? [])).not.toContain(MARKER);
  return (r.error?.issues ?? []).map(issueRule).filter((rule) => rule !== undefined);
};
const available = {
  runtime: 'claude',
  state: 'available',
  executable: 'C:/Users/u/.local/bin/claude.exe',
  source: 'path',
  version: '2.1.309',
  requiredVersion: '2.1.309',
  auth: 'subscription',
  modelCount: 13,
  checkedAt: at,
};

describe('C-33 runtime status', () => {
  it('describes a runtime found, too old, signed out, failed or missing', () => {
    expect(ok(RuntimeStatus, available)).toBe(true);
    expect(ok(RuntimeStatus, { ...available, auth: 'api-key' })).toBe(true);
    expect(ok(RuntimeStatus, { ...available, auth: 'unknown' })).toBe(true);
    expect(ok(RuntimeStatus, { ...available, state: 'too-old', version: '2.0.1', modelCount: 0, detail: '請更新 Claude Code。' })).toBe(true);
    expect(ok(RuntimeStatus, { ...available, state: 'signed-out', auth: 'signed-out', modelCount: 0 })).toBe(true);
    expect(ok(RuntimeStatus, { ...available, state: 'failed', version: undefined, auth: 'unknown', modelCount: 0 })).toBe(true);
    expect(ok(RuntimeStatus, { runtime: 'codex', state: 'not-installed', requiredVersion: '0.160.0', auth: 'unknown', modelCount: 0, checkedAt: at })).toBe(true);
  });

  it('keeps the executable, source, version, sign-in and model count consistent with the state', () => {
    expect(rules(RuntimeStatus, { ...available, state: 'not-installed', modelCount: 0 })).toEqual(['runtime-status.executable']);
    expect(rules(RuntimeStatus, { ...available, executable: undefined })).toContain('runtime-status.executable');
    expect(rules(RuntimeStatus, { ...available, source: undefined })).toEqual(['runtime-status.source']);
    expect(rules(RuntimeStatus, { ...available, version: undefined })).toEqual(['runtime-status.version']);
    expect(rules(RuntimeStatus, { ...available, state: 'signed-out', auth: 'subscription', modelCount: 0 })).toEqual(['runtime-status.signed-out']);
    expect(rules(RuntimeStatus, { ...available, auth: 'signed-out' })).toEqual(['runtime-status.available-signed-in']);
    expect(rules(RuntimeStatus, { ...available, state: 'too-old' })).toEqual(['runtime-status.models-only-available']);
  });

  it('says how the runtime signs in only as a category, never an account or a key', () => {
    expect(ok(RuntimeStatus, { ...available, auth: MARKER })).toBe(false);
    expect(ok(RuntimeStatus, { ...available, account: 'someone@example.com' })).toBe(false);
    expect(ok(RuntimeStatus, { ...available, apiKey: 'sk-ant-xxxx' })).toBe(false);
    expect(ok(RuntimeStatus, { ...available, detail: 'x'.repeat(501) })).toBe(false);
  });

  it('is in the Snapshot once per runtime, defaults to none, and is updated by runtime.status', () => {
    expect(fixtureSnapshot.runtimes.map((r) => [r.runtime, r.state])).toEqual([['claude', 'available'], ['codex', 'too-old']]);
    const before: Record<string, unknown> = { ...fixtureSnapshotInput };
    delete before['runtimes'];
    expect(Snapshot.parse(before).runtimes).toEqual([]);
    expect(rules(Snapshot, { ...fixtureSnapshotInput, runtimes: [available, available] })).toEqual(['snapshot.runtime-unique']);
    expect(ok(AppEvent, { type: 'runtime.status', status: available })).toBe(true);
  });

  it('can be asked to look again, for one runtime or both, and nothing else', () => {
    expect(ok(Command, { type: 'runtime.detect', requestId: 'r-1' })).toBe(true);
    expect(ok(Command, { type: 'runtime.detect', requestId: 'r-1', runtime: 'codex' })).toBe(true);
    expect(ok(Command, { type: 'runtime.detect', requestId: 'r-1', runtime: 'claude', path: 'C:/elsewhere/claude.exe' })).toBe(false);
    expect(ok(Command, { type: 'runtime.detect', requestId: 'r-1', runtime: 'gemini' })).toBe(false);
  });
});

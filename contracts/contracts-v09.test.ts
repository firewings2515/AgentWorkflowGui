// Contracts 0.9 (T050, U2, Q-9): the sidebar's pinned lists and renaming a run. Everything 0.8 stored still reads.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AppEvent, Command, PINNED_LIMIT, PinnedLists, pinnedOf, ruleMessage, Snapshot, UiPreferences, WorkflowInstance } from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);
const rulesOf = (schema: z.ZodType, input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => (i as { params?: { rule?: string } }).params?.rule);
};

describe('contracts 0.9', () => {
  it('preferences saved before 0.9 have no pinned lists and read as both empty', () => {
    const old = UiPreferences.parse({ theme: 'light', supervisor: { idleCloseMinutes: 20, maxOpenRuntimes: 4 }, workFolderRoot: 'D:\\Work' });
    expect(old.pinned).toBeUndefined();
    expect(pinnedOf(old)).toEqual({ chat: [], workflow: [] });
    expect(pinnedOf(UiPreferences.parse({}))).toEqual({ chat: [], workflow: [] });
    // The 0.8 Snapshot fixture (no pinned) still reads.
    expect(ok(Snapshot, fixtureSnapshotInput)).toBe(true);
    expect(pinnedOf(fixtureSnapshot.preferences)).toEqual({ chat: [], workflow: [] });
  });

  it('pinned: one list per mode, in order, up to 50 IDs each', () => {
    const pinned = { chat: ['s-2', 's-1'], workflow: ['i-1'] };
    const saved = UiPreferences.parse({ pinned });
    expect(saved.pinned).toEqual(pinned);
    expect(pinnedOf(saved)).toEqual(pinned);
    expect(PINNED_LIMIT).toBe(50);
    expect(ok(PinnedLists, { chat: ids('s', 50), workflow: ids('i', 50) })).toBe(true);
    expect(ok(PinnedLists, { chat: ids('s', 51), workflow: [] })).toBe(false);
    expect(ok(PinnedLists, { chat: [], workflow: ids('i', 51) })).toBe(false);
    expect(ok(PinnedLists, { chat: [], workflow: [] })).toBe(true);
  });

  it('pinned: a repeated ID is refused with its rule, never merged', () => {
    expect(rulesOf(PinnedLists, { chat: ['s-1', 's-2', 's-1'], workflow: [] })).toEqual(['preferences.pinned-unique']);
    expect(rulesOf(PinnedLists, { chat: [], workflow: ['i-1', 'i-1'] })).toEqual(['preferences.pinned-unique']);
    expect(ruleMessage('preferences.pinned-unique')).not.toContain('s-1');
    // Each list on its own: the same ID in both is not a repeat.
    expect(ok(PinnedLists, { chat: ['x'], workflow: ['x'] })).toBe(true);
  });

  it('WB-11: the workflow list mixes runs and node sessions; nothing tells which an ID is, a repeat is still refused', () => {
    const runId = fixtureSnapshot.instances[0]!.id;
    const nodeSession = fixtureSnapshot.sessions.find((s) => s.kind === 'workflow')!.id;
    const mixed = { chat: [], workflow: [runId, nodeSession, 'not-loaded-yet'] };
    expect(PinnedLists.parse(mixed)).toEqual(mixed);
    expect(ok(PinnedLists, { chat: [], workflow: [nodeSession, runId, nodeSession] })).toBe(false);
    expect(ok(PinnedLists, { chat: [], workflow: [...ids('x', 49), runId, nodeSession] })).toBe(false);
    expect(ok(PinnedLists, { chat: [], workflow: [...ids('x', 48), runId, nodeSession] })).toBe(true);
  });

  it('pinned: both lists, nothing else, no empty IDs', () => {
    expect(ok(UiPreferences, { pinned: { chat: [] } })).toBe(false);
    expect(ok(UiPreferences, { pinned: { workflow: [] } })).toBe(false);
    expect(ok(UiPreferences, { pinned: { chat: [], workflow: [], routines: [] } })).toBe(false);
    expect(ok(UiPreferences, { pinned: { chat: [''], workflow: [] } })).toBe(false);
    expect(ok(UiPreferences, { pinned: null })).toBe(false);
  });

  it('preferences.set and preferences.updated carry the pinned lists; a bad list fails the whole command', () => {
    const preferences = { theme: 'dark', pinned: { chat: ['s-1'], workflow: ['i-1'] } };
    expect(ok(Command, { type: 'preferences.set', requestId: 'r1', preferences })).toBe(true);
    expect(ok(Command, { type: 'preferences.set', requestId: 'r1', preferences: { pinned: { chat: ids('s', 51), workflow: [] } } })).toBe(false);
    expect(ok(Command, { type: 'preferences.set', requestId: 'r1', preferences: { pinned: { chat: ['s-1', 's-1'], workflow: [] } } })).toBe(false);
    const event = AppEvent.parse({ type: 'preferences.updated', preferences, at: '2026-11-04T00:00:00.000Z' });
    expect(event.type === 'preferences.updated' && event.preferences.pinned).toEqual(preferences.pinned);
  });

  it('workflow.rename carries the run, the revision it renames and the title; the length is checked by the core', () => {
    const rename = { type: 'workflow.rename', requestId: 'r1', instanceId: 'i-1', expectedRevision: 3, title: 'Release' };
    expect(ok(Command, rename)).toBe(true);
    expect(ok(Command, { ...rename, title: '' })).toBe(true);
    const without = (key: string) => Object.fromEntries(Object.entries(rename).filter(([k]) => k !== key));
    const noRevision = without('expectedRevision');
    const noTitle = without('title');
    expect(ok(Command, noRevision)).toBe(false);
    expect(ok(Command, noTitle)).toBe(false);
    expect(ok(Command, { ...rename, instanceId: '' })).toBe(false);
    expect(ok(Command, { ...rename, extra: true })).toBe(false);
  });

  it('a run stored under 0.8 reads unchanged', () => {
    for (const run of fixtureSnapshotInput.instances) expect(ok(WorkflowInstance, run)).toBe(true);
  });
});

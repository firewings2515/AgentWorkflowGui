// Contracts 0.10 (T059, U4): archiving conversations and runs, and the auto-archive's days. Everything 0.9 stored still reads.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AUTO_ARCHIVE_DEFAULT_DAYS,
  autoArchiveDaysOf,
  Command,
  CommandRefusal,
  CommandResult,
  CONTRACTS_VERSION,
  countsAsLastMessage,
  LogicalSession,
  ruleMessage,
  Snapshot,
  UiPreferences,
  WorkflowInstance,
} from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const rulesOf = (schema: z.ZodType, input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => (i as { params?: { rule?: string } }).params?.rule);
};
const at = '2026-11-05T10:00:00.000Z';
const ordinary = fixtureSnapshotInput.sessions.find((s) => s.kind === 'ordinary')!;
const workflowSession = fixtureSnapshotInput.sessions.find((s) => s.kind === 'workflow')!;
const run = fixtureSnapshotInput.instances[0]!;
/** The fixture's run, ended, with nothing of it left in progress. */
const endedRun = { ...run, state: 'completed', endedAt: at, tasks: [], rounds: [], mergeQueue: [], taskPlans: [] };

describe('contracts 0.10', () => {
  it('is version 0.10.0', () => {
    expect(CONTRACTS_VERSION).toBe('0.10.0');
  });

  it('0.9 data reads: no archivedAt is not archived, no autoArchiveDays is 14', () => {
    expect(ok(Snapshot, fixtureSnapshotInput)).toBe(true);
    for (const s of fixtureSnapshot.sessions) expect(s).not.toHaveProperty('archivedAt');
    for (const i of fixtureSnapshot.instances) expect(i.archivedAt).toBeUndefined();
    expect(fixtureSnapshot.preferences.autoArchiveDays).toBeUndefined();
    expect(autoArchiveDaysOf(fixtureSnapshot.preferences)).toBe(14);
    expect(AUTO_ARCHIVE_DEFAULT_DAYS).toBe(14);
    expect(autoArchiveDaysOf(UiPreferences.parse({ theme: 'light', pinned: { chat: [], workflow: [] } }))).toBe(14);
  });

  it('archivedAt: on an ordinary session; never on a workflow session; an ISO time', () => {
    expect(LogicalSession.parse({ ...ordinary, archivedAt: at })).toMatchObject({ archivedAt: at });
    expect(ok(LogicalSession, { ...workflowSession, archivedAt: at })).toBe(false);
    expect(ok(LogicalSession, { ...ordinary, archivedAt: 'yesterday' })).toBe(false);
    expect(ok(LogicalSession, { ...ordinary, archivedAt: null })).toBe(false);
  });

  it('archivedAt on a run: only an ended one (instance.archived-ended)', () => {
    expect(ok(WorkflowInstance, endedRun)).toBe(true);
    expect(WorkflowInstance.parse({ ...endedRun, archivedAt: at })).toMatchObject({ archivedAt: at });
    expect(ok(WorkflowInstance, { ...endedRun, state: 'cancelled', archivedAt: at })).toBe(true);
    expect(rulesOf(WorkflowInstance, { ...run, archivedAt: at })).toContain('instance.archived-ended');
    expect(rulesOf(WorkflowInstance, { ...run, state: 'blocked', archivedAt: at })).toContain('instance.archived-ended');
    expect(ruleMessage('instance.archived-ended')).not.toContain(at);
  });

  it('autoArchiveDays: 1 to 365 whole days, or null for off', () => {
    for (const days of [1, 14, 365]) expect(autoArchiveDaysOf(UiPreferences.parse({ autoArchiveDays: days }))).toBe(days);
    expect(autoArchiveDaysOf(UiPreferences.parse({ autoArchiveDays: null }))).toBeNull();
    for (const days of [0, 366, 1.5, -1, '14']) expect(ok(UiPreferences, { autoArchiveDays: days })).toBe(false);
    expect(ok(Command, { type: 'preferences.set', requestId: 'r1', preferences: { autoArchiveDays: null } })).toBe(true);
    expect(ok(Command, { type: 'preferences.set', requestId: 'r1', preferences: { autoArchiveDays: 0 } })).toBe(false);
  });

  it('the four commands carry their target and the revision they change; nothing else', () => {
    const commands = [
      { type: 'session.archive', requestId: 'r1', sessionId: 's-1', expectedRevision: 3 },
      { type: 'session.unarchive', requestId: 'r1', sessionId: 's-1', expectedRevision: 3 },
      { type: 'workflow.archive', requestId: 'r1', instanceId: 'i-1', expectedRevision: 3 },
      { type: 'workflow.unarchive', requestId: 'r1', instanceId: 'i-1', expectedRevision: 3 },
    ];
    for (const command of commands) {
      expect(ok(Command, command)).toBe(true);
      const without = Object.fromEntries(Object.entries(command).filter(([k]) => k !== 'expectedRevision'));
      expect(ok(Command, without)).toBe(false);
      expect(ok(Command, { ...command, extra: true })).toBe(false);
      expect(ok(Command, { ...command, expectedRevision: -1 })).toBe(false);
    }
    expect(ok(Command, { ...commands[0], sessionId: '' })).toBe(false);
    expect(ok(Command, { ...commands[2], instanceId: '' })).toBe(false);
    // A run is named by its instance, a conversation by its session.
    expect(ok(Command, { type: 'session.archive', requestId: 'r1', instanceId: 'i-1', expectedRevision: 3 })).toBe(false);
  });

  it('a refusal carries its reason; every reason is listed; results without one (before 0.10) still read', () => {
    expect(CommandRefusal.options).toEqual(['not-top-level', 'workflow-session', 'turn-running', 'escalation-open', 'run-not-ended', 'archived']);
    const refusal = { ok: false, requestId: 'r1', code: 'invalid_transition', message: 'x', retryable: true, mayHaveSideEffects: false };
    for (const reason of CommandRefusal.options) expect(CommandResult.parse({ ...refusal, reason })).toMatchObject({ reason });
    expect(ok(CommandResult, refusal)).toBe(true);
    expect(ok(CommandResult, { ...refusal, reason: 'busy' })).toBe(false);
    expect(ok(CommandResult, { ok: true, requestId: 'r1', created: [], reason: 'archived' })).toBe(false);
  });

  it('the last-message rule (Q-17): user and assistant messages of the main conversation', () => {
    expect(countsAsLastMessage({ role: 'user' })).toBe(true);
    expect(countsAsLastMessage({ role: 'assistant' })).toBe(true);
    expect(countsAsLastMessage({ role: 'system' })).toBe(false);
    expect(countsAsLastMessage({ role: 'assistant', nativeTaskId: 'nt-1' })).toBe(false);
  });

  it('the Snapshot carries the marks as the records hold them', () => {
    const snapshot = {
      ...fixtureSnapshotInput,
      sessions: fixtureSnapshotInput.sessions.map((s) => (s.id === ordinary.id ? { ...s, archivedAt: at } : s)),
      instances: [endedRun, ...fixtureSnapshotInput.instances.slice(1)].map((i, n) => (n === 0 ? { ...i, archivedAt: at } : i)),
      preferences: { ...fixtureSnapshotInput.preferences, autoArchiveDays: 30 },
    };
    const parsed = Snapshot.parse(snapshot);
    expect(parsed.sessions.find((s) => s.id === ordinary.id)).toMatchObject({ archivedAt: at });
    expect(parsed.instances[0]).toMatchObject({ archivedAt: at });
    expect(parsed.preferences.autoArchiveDays).toBe(30);
  });
});

// Contracts 0.8 (T048, U-01, U-02, Q-1, Q-4, Q-8): sessions without an Agent or a folder, rename, the default work
// folder location and a run's two folders. Everything 0.7 stored still reads.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AUTO_TITLE_MAX_LENGTH,
  Command,
  DEFAULT_SESSION_TITLE,
  LogicalSession,
  Snapshot,
  titleFromMessage,
  UiPreferences,
  WorkflowInstance,
} from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const omit = <T extends object>(record: T, ...keys: string[]) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
const model = { runtime: 'codex', model: 'gpt-6-luna' };

describe('contracts 0.8', () => {
  it('session.create: the Agent and the folder are optional; a folder given is not empty', () => {
    const bare = { type: 'session.create', requestId: 'r1', sessionId: 's-1', kind: 'ordinary', model };
    expect(ok(Command, bare)).toBe(true);
    expect(ok(Command, { ...bare, agentId: 'a', cwd: 'E:/w' })).toBe(true);
    expect(ok(Command, { ...bare, cwd: '' })).toBe(false);
    expect(ok(Command, { ...bare, agentId: '' })).toBe(false);
  });

  it('session.setAgent takes null for no Agent; session.rename carries the revision it renames', () => {
    const set = { type: 'session.setAgent', requestId: 'r1', sessionId: 's-1', expectedRevision: 2 };
    expect(ok(Command, { ...set, agentId: null })).toBe(true);
    expect(ok(Command, { ...set, agentId: 'a' })).toBe(true);
    expect(ok(Command, set)).toBe(false);
    const rename = { type: 'session.rename', requestId: 'r2', sessionId: 's-1', expectedRevision: 2, title: 'Plan' };
    expect(ok(Command, rename)).toBe(true);
    expect(ok(Command, omit(rename, 'expectedRevision'))).toBe(false);
  });

  it('workflow.start: a work folder and a project folder, both optional; the 0.7 `cwd` is gone', () => {
    const start = { type: 'workflow.start', requestId: 'r1', instanceId: 'i1', rootSessionId: 's-root', workflowId: 'w', workflowRevision: 1, title: 't', firstMessage: 'go', crossToolConsent: true };
    expect(ok(Command, start)).toBe(true);
    expect(ok(Command, { ...start, workFolder: 'E:/reports', projectFolder: 'E:/repo' })).toBe(true);
    expect(ok(Command, { ...start, projectFolder: '' })).toBe(false);
    expect(ok(Command, { ...start, cwd: 'E:/w' })).toBe(false);
  });

  it('an ordinary session needs no Agent, a workflow session does; autoTitle is only ever true', () => {
    const base = fixtureSnapshot.sessions.find((s) => s.kind === 'ordinary')!;
    const noAgent = omit(base, 'agent');
    expect(ok(LogicalSession, noAgent)).toBe(true);
    expect(ok(LogicalSession, { ...noAgent, title: DEFAULT_SESSION_TITLE, autoTitle: true })).toBe(true);
    expect(ok(LogicalSession, { ...noAgent, autoTitle: false })).toBe(false);
    const workflow = fixtureSnapshot.sessions.find((s) => s.kind === 'workflow')!;
    expect(ok(LogicalSession, omit(workflow, 'agent'))).toBe(false);
    // Every session 0.7 stored (each with an Agent, none with autoTitle) still reads.
    for (const s of fixtureSnapshotInput.sessions) expect(ok(LogicalSession, s)).toBe(true);
  });

  it('preferences: workFolderRoot is optional (absent: the default location), never empty; 0.7 preferences read', () => {
    expect(UiPreferences.parse({ theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } }).workFolderRoot).toBeUndefined();
    expect(UiPreferences.parse({ workFolderRoot: 'D:\\Work' }).workFolderRoot).toBe('D:\\Work');
    expect(ok(UiPreferences, { workFolderRoot: '' })).toBe(false);
  });

  it('the Snapshot names the default work folder location', () => {
    expect(fixtureSnapshot.defaultWorkFolderRoot).toBe('C:/Users/demo/AgentWorkflowGui');
    expect(ok(Snapshot, omit(fixtureSnapshotInput, 'defaultWorkFolderRoot'))).toBe(false);
  });

  it('a run records its two folders; a run stored before 0.8 has neither and reads', () => {
    const run = fixtureSnapshot.instances[0]!;
    expect(ok(WorkflowInstance, run)).toBe(true);
    expect(run.workFolder).toBeUndefined();
    expect(ok(WorkflowInstance, { ...run, workFolder: 'E:/reports', projectFolder: 'E:/repo' })).toBe(true);
    expect(ok(WorkflowInstance, { ...run, projectFolder: '' })).toBe(false);
  });

  it('titleFromMessage: the first non-blank line, trimmed, cut to 40 whole characters; the placeholder when blank', () => {
    expect(titleFromMessage('  Plan the page \nmore')).toBe('Plan the page');
    expect(titleFromMessage('\r\n \r\n Second\r\n')).toBe('Second');
    expect(titleFromMessage('   \n\t')).toBe(DEFAULT_SESSION_TITLE);
    const emoji = '😀'.repeat(50);
    expect(Array.from(titleFromMessage(emoji))).toHaveLength(AUTO_TITLE_MAX_LENGTH);
    // Never half of a surrogate pair.
    expect(titleFromMessage(emoji)).toBe('😀'.repeat(AUTO_TITLE_MAX_LENGTH));
    expect(titleFromMessage(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });
});

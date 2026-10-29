// Contracts 0.5 (T020): the new or changed schemas (BATCH4_PLAN C-01 to C-14). Rule codes of the new
// refinements carry no input values, as in 0.4.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppEvent,
  CONTRACTS_VERSION,
  Escalation,
  issueRule,
  LogicalSession,
  McpRejection,
  PermissionRequest,
  Snapshot,
  WorkflowInstance,
} from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const at = '2026-10-29T10:00:00+08:00';
const MARKER = 'SENSITIVE_INPUT_MARKER';
const pick = <T>(xs: readonly T[] | undefined, i: number): T => {
  const x = xs?.[i];
  if (x === undefined) throw new Error(`fixture has no entry ${i}`);
  return x;
};
const ruleIssues = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []).map((i) => ({ rule: issueRule(i), message: i.message }));
};
const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;

describe('contracts 0.5', () => {
  it('is version 0.5.0', () => {
    expect(CONTRACTS_VERSION).toBe('0.5.0');
  });

  it('C-03: a session may carry its native binding', () => {
    const session = pick(fixtureSnapshotInput.sessions, 0);
    expect(ok(LogicalSession, { ...session, nativeSessionRef: 'thread-1' })).toBe(true);
    expect(ok(LogicalSession, { ...session, nativeSessionRef: '' })).toBe(false);
  });

  describe('C-04: tool, server and shell of a permission request', () => {
    const command = pick(fixtureSnapshotInput.permissionRequests, 1);
    const elicitation = fixtureSnapshotInput.permissionRequests.find((p) => p.kind === 'mcpElicitation');

    it('names the shell only for commands', () => {
      expect(command.kind).toBe('command');
      expect(ok(PermissionRequest, { ...command, tool: 'Bash', shell: 'bash' })).toBe(true);
      const read = { ...command, kind: 'permissions', command: undefined, tool: 'Read', shell: 'bash' };
      expect(ruleIssues(PermissionRequest, read)).toEqual([{ rule: 'permission.shell-only-command', message: 'only command requests name a shell' }]);
    });

    it('an elicitation names its server in `server`, the same as the elicitation', () => {
      if (elicitation === undefined) throw new Error('fixture has no elicitation');
      expect(ok(PermissionRequest, elicitation)).toBe(true);
      const issues = ruleIssues(PermissionRequest, { ...elicitation, server: MARKER });
      expect(issues).toEqual([{ rule: 'permission.elicitation-server', message: 'an elicitation names its server in server' }]);
      expect(JSON.stringify(issues)).not.toContain(MARKER);
      expect(ruleIssues(PermissionRequest, { ...elicitation, server: undefined }).map((i) => i.rule)).toEqual(['permission.elicitation-server']);
    });
  });

  it('C-05: agent, workflow and snapshot-invalidated events', () => {
    const agent = pick(fixtureSnapshot.agents, 0);
    const workflow = pick(fixtureSnapshot.workflows, 0);
    expect(ok(AppEvent, { type: 'agent.updated', agent })).toBe(true);
    expect(ok(AppEvent, { type: 'agent.deleted', agentId: agent.id, at })).toBe(true);
    expect(ok(AppEvent, { type: 'workflow.updated', workflow })).toBe(true);
    expect(ok(AppEvent, { type: 'snapshot.invalidated', reason: 'event-write-failed', at })).toBe(true);
    expect(ok(AppEvent, { type: 'snapshot.invalidated', reason: MARKER, at })).toBe(false);
  });

  it('C-06: the Snapshot says whether the data could be opened; ready by default', () => {
    expect(fixtureSnapshot.app).toEqual({ status: 'ready' });
    const damaged = { ...fixtureSnapshotInput, app: { status: 'damaged', reason: 'StoredDataError: agent (body.json)', location: 'C:/Users/me/AppData/Roaming/awg/awg.sqlite' } };
    expect(Snapshot.parse(damaged).app).toMatchObject({ status: 'damaged' });
    expect(ok(Snapshot, { ...fixtureSnapshotInput, app: { status: 'damaged' } })).toBe(false);
  });

  it('C-07: MCP rejections for another owner, a changed resend, capacity and unsupported tools', () => {
    for (const reason of ['not-owner', 'resend-mismatch', 'busy', 'unsupported']) expect(ok(McpRejection, { reason, detail: 'fixed text' })).toBe(true);
  });

  describe('C-02, C-13: escalation refs', () => {
    const escalation = pick(fixtureSnapshotInput.escalations, 0);
    const base = { ...escalation, kind: 'delivery-unknown', rule: undefined };

    it('a user message whose delivery stayed unknown can be escalated and resolved', () => {
      expect(ok(Escalation, { ...base, ref: { kind: 'message', operationId: 'op-m1', messageId: 'm-1' } })).toBe(true);
    });

    it('a report that asks for confirmation points at its delivery', () => {
      expect(ok(Escalation, { ...base, kind: 'confirmation', ref: { kind: 'report', operationId: 'op-r1' } })).toBe(true);
      // A report is not a delivery the user resolves.
      expect(ruleIssues(Escalation, { ...base, ref: { kind: 'report', operationId: 'op-r1' } }).map((i) => i.rule)).toEqual(['escalation.delivery-ref']);
    });
  });

  it('C-12, C-13: an instance has a compare-and-set revision and the rework limit it started with', () => {
    const instance = pick(fixtureSnapshotInput.instances, 0);
    expect(ok(WorkflowInstance, instance)).toBe(true);
    expect(ok(WorkflowInstance, { ...instance, revision: undefined })).toBe(false);
    expect(ok(WorkflowInstance, { ...instance, reworkLimit: undefined })).toBe(false);
    expect(ok(WorkflowInstance, { ...instance, reworkLimit: -1 })).toBe(false);
  });
});

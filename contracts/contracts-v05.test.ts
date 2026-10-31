// Contracts 0.5 (T020): the new or changed schemas (BATCH4_PLAN C-01 to C-14). Rule codes of the new
// refinements carry no input values, as in 0.4.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppEvent,
  Escalation,
  Handoff,
  issueRule,
  LogicalSession,
  McpRejection,
  Message,
  PermissionRequest,
  Snapshot,
  TransferProposal,
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

  it('C-12, C-13: an instance has a compare-and-set revision and keeps the template it started with', () => {
    const instance = pick(fixtureSnapshotInput.instances, 0);
    expect(ok(WorkflowInstance, instance)).toBe(true);
    expect(ok(WorkflowInstance, { ...instance, revision: undefined })).toBe(false);
    expect(ok(WorkflowInstance, { ...instance, template: undefined })).toBe(false);
  });

  it('T020 r1 P1-1: the pinned template is the started revision, so a later edit cannot change the run', () => {
    const instance = pick(fixtureSnapshotInput.instances, 0);
    const template = pick(fixtureSnapshotInput.workflows, 0);
    expect(ruleIssues(WorkflowInstance, { ...instance, template: { ...template, revision: 4, name: MARKER } })).toEqual([
      { rule: 'instance.template-pinned', message: 'the pinned template is the started workflow revision' },
    ]);
    expect(ruleIssues(WorkflowInstance, { ...instance, template: { ...template, id: 'wf-other' } }).map((i) => i.rule)).toEqual(['instance.template-pinned']);
    // The run keeps its own nodes and rework limit, whatever the stored template becomes.
    expect(WorkflowInstance.parse(instance).template.reworkLimit).toBe(template.reworkLimit);
  });
});

describe('T020 r2: transfer lifecycle after approval, rework on handoffs', () => {
  const proposal = pick(fixtureSnapshotInput.transfers, 0);
  it('r2-P1 an approved proposal can later fail or be cancelled with a newer revision, keeping its approval', () => {
    expect(proposal.state).toBe('approved');
    const failed = { ...proposal, revision: (proposal.revision ?? 0) + 1, state: 'failed', failure: { message: 'target creation failed' }, provision: undefined, createdSessionId: undefined, delivery: undefined };
    expect(ok(TransferProposal, failed)).toBe(true);
    const cancelled = { ...proposal, revision: (proposal.revision ?? 0) + 1, state: 'cancelled', cancelledAt: at };
    expect(ok(TransferProposal, cancelled)).toBe(true);
    // While approved the approval is the current revision; an approval never runs ahead of the record.
    expect(ruleIssues(TransferProposal, { ...proposal, revision: (proposal.revision ?? 0) + 1 }).map((i) => i.rule)).toContain('transfer.approval-revision');
    expect(ruleIssues(TransferProposal, { ...cancelled, approvedRevision: cancelled.revision + 1 }).map((i) => i.rule)).toContain('transfer.approval-revision');
  });

  it('r2-P2 a handoff says whether it is rework; old records read as not', () => {
    const handoff = pick(fixtureSnapshotInput.handoffs, 1);
    expect(Handoff.parse(handoff).rework).toBe(false);
    expect(Handoff.parse({ ...handoff, rework: true }).rework).toBe(true);
  });

  it('T023 G-1: a transfer payload is a user-role message from the transfer, never a system one', () => {
    const message = { id: 'm-transfer', sessionId: 's-target', role: 'user', text: 'payload', createdAt: at };
    const origin = { kind: 'transfer', fromSessionId: 's-source', transferId: 'transfer-1' };
    expect(ok(Message, { ...message, origin })).toBe(true);
    expect(ruleIssues(Message, { ...message, role: 'system', origin })).toContainEqual(expect.objectContaining({ rule: 'message.origin-role' }));
    expect(ruleIssues(Message, { ...message, role: 'assistant', origin })).toContainEqual(expect.objectContaining({ rule: 'message.origin-role' }));
    expect(ok(Message, { ...message, origin: { kind: 'transfer', fromSessionId: 's-source' } })).toBe(false);
  });
});

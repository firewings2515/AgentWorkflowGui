// Contracts 0.4 (T012): rule codes (C-04) and the new or changed schemas (C-01 to C-11). That every rule
// code is used is checked in tests/contract-rules.test.ts, which may read files.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppEvent,
  Command,
  CommandItem,
  CommandResult,
  CreateTasksToolInput,
  Escalation,
  Handoff,
  HandoffToolInput,
  HandoffToolResult,
  issueRule,
  OwnedProcess,
  PeerMessage,
  TransferProposal,
  WorkflowInstance,
  WorkflowTemplate,
} from './index';
import { fixtureSnapshotInput } from './fixtures/snapshot';

const at = '2026-10-24T10:00:00+08:00';
const MARKER = 'SENSITIVE_INPUT_MARKER';
const pick = <T>(xs: readonly T[] | undefined, i: number): T => {
  const x = xs?.[i];
  if (x === undefined) throw new Error(`fixture has no entry ${i}`);
  return x;
};

/** Parses `input` expecting failure, and returns the issues of contract rules. */
const ruleIssues = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  const issues = r.error?.issues ?? [];
  return issues.map((i) => ({ rule: issueRule(i), path: i.path.join('.'), message: i.message }));
};

describe('contract rule codes (C-04)', () => {
  it('a workflow refinement names the rule and the field, never the input values', () => {
    const wf = pick(fixtureSnapshotInput.workflows, 0);
    const bad = { ...wf, edges: [...wf.edges, { source: wf.nodes[0]!.id, target: MARKER }] };
    const issues = ruleIssues(WorkflowTemplate, bad);
    expect(issues).toContainEqual({ rule: 'workflow.edge-missing-node', path: `edges.${wf.edges.length}`, message: expect.any(String) as string });
    expect(JSON.stringify(issues)).not.toContain(MARKER);
  });

  it('an output rule without an edge points at the rule target', () => {
    const wf = pick(fixtureSnapshotInput.workflows, 0);
    const issues = ruleIssues(WorkflowTemplate, { ...wf, edges: [] });
    expect(issues.some((i) => i.rule === 'workflow.output-needs-edge' && /^nodes\.\d+\.outputRules\.\d+\.target$/.test(i.path))).toBe(true);
  });

  it('instance, peer message, handoff and transfer rules carry codes without values', () => {
    const inst = pick(fixtureSnapshotInput.instances, 0);
    const t0 = pick(inst.tasks, 0);
    const instIssues = ruleIssues(WorkflowInstance, { ...inst, tasks: [{ ...t0, dependsOn: [MARKER] }, ...inst.tasks.slice(1)] });
    expect(instIssues.map((i) => i.rule)).toContain('instance.task-invalid-dependency');

    const pm = pick(fixtureSnapshotInput.peerMessages, 0);
    expect(ruleIssues(PeerMessage, { ...pm, toSessionId: pm.fromSessionId }).map((i) => i.rule)).toContain('peer.not-self');

    const h = pick(fixtureSnapshotInput.handoffs, 0);
    expect(ruleIssues(Handoff, { ...h, toNodeId: h.fromNodeId }).map((i) => i.rule)).toContain('handoff.not-self');

    const tr = pick(fixtureSnapshotInput.transfers, 0);
    const trIssues = ruleIssues(TransferProposal, { ...tr, approvedRevision: tr.revision + 1 });
    expect(trIssues.map((i) => i.rule)).toContain('transfer.approval-revision');

    for (const issues of [instIssues, trIssues]) {
      expect(JSON.stringify(issues)).not.toContain(MARKER);
      expect(issues.every((i) => i.rule !== undefined)).toBe(true);
    }
  });

  it('a non-contract issue has no rule code', () => {
    const r = WorkflowTemplate.safeParse({});
    expect(r.error?.issues.map(issueRule).every((rule) => rule === undefined)).toBe(true);
  });
});

describe('ipc changes (C-01 to C-03)', () => {
  it('agent.delete needs the agent and its revision', () => {
    expect(Command.safeParse({ type: 'agent.delete', requestId: 'r1', agentId: 'a-1', expectedRevision: 2 }).success).toBe(true);
    expect(Command.safeParse({ type: 'agent.delete', requestId: 'r1', agentId: 'a-1' }).success).toBe(false);
  });

  it('a failure may have no requestId, a success may not', () => {
    const failure = { ok: false, requestId: null, code: 'internal_error', message: 'Internal error.', retryable: false, mayHaveSideEffects: true };
    expect(CommandResult.safeParse(failure).success).toBe(true);
    expect(CommandResult.safeParse({ ok: true, requestId: null }).success).toBe(false);
  });

  it('preferences.updated carries the saved preferences', () => {
    expect(AppEvent.safeParse({ type: 'preferences.updated', preferences: { theme: 'light' }, at }).success).toBe(true);
  });
});

describe('records (C-05 to C-07, C-11)', () => {
  it('a handoff can record that it was cancelled apart from delivery', () => {
    const h = pick(fixtureSnapshotInput.handoffs, 0);
    expect(Handoff.safeParse({ ...h, outcome: { kind: 'cancelled', detail: 'provision cancelled', at } }).success).toBe(true);
    expect(Handoff.safeParse({ ...h, outcome: { kind: 'expired', detail: '', at } }).success).toBe(false);
  });

  it('a delivery escalation may point at a provision and what it blocks', () => {
    const esc = fixtureSnapshotInput.escalations?.find((e) => e.kind === 'delivery-unknown');
    if (!esc) throw new Error('fixture has no delivery escalation');
    const ref = { kind: 'provision', operationId: 'op-create', blocked: ['op-payload'] };
    expect(Escalation.safeParse({ ...esc, ref }).success).toBe(true);
    expect(ruleIssues(Escalation, { ...esc, ref: { kind: 'task', taskId: 't-1' } }).map((i) => i.rule)).toContain('escalation.delivery-ref');
  });

  it('a command can be marked as running in the background', () => {
    const cmd = { id: 'i-1', sessionId: 's-1', kind: 'command', command: 'npm run dev', cwd: 'C:\\w', state: 'running', background: true, startedAt: at };
    expect(CommandItem.parse(cmd).background).toBe(true);
  });

  it('an owned process is identified by PID and creation time', () => {
    const p = { pid: 4242, startedAt: at, sessionId: 's-1', runtime: 'codex', kind: 'runtime-host', jobRef: 'job-s-1', recordedAt: at };
    expect(OwnedProcess.safeParse(p).success).toBe(true);
    expect(OwnedProcess.safeParse({ ...p, pid: 0 }).success).toBe(false);
  });
});

describe('MCP tools (C-10)', () => {
  it('handoff targets a node or root, never both', () => {
    expect(HandoffToolInput.safeParse({ ruleId: 'r', target: { kind: 'root' }, content: 'done' }).success).toBe(true);
    expect(HandoffToolInput.safeParse({ ruleId: 'r', target: { kind: 'node', nodeId: 'n-2' }, content: 'x', taskId: 't-1' }).success).toBe(true);
    expect(HandoffToolInput.safeParse({ ruleId: 'r', target: 'n-2', content: 'x' }).success).toBe(false);
  });

  it('a resend maps to the operation it already created', () => {
    const r = HandoffToolResult.parse({ status: 'duplicate', handoffId: 'h-1', operationId: 'op-1', delivery: 'sent' });
    expect(r.status).toBe('duplicate');
  });

  it('create_tasks keys are unique and dependencies stay inside the call', () => {
    expect(CreateTasksToolInput.safeParse({ tasks: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B', dependsOn: ['a'] }] }).success).toBe(true);
    expect(ruleIssues(CreateTasksToolInput, { tasks: [{ key: 'a', title: 'A' }, { key: 'a', title: 'A2' }] }).map((i) => i.rule)).toContain('mcp.create-tasks-ids-unique');
    const missing = ruleIssues(CreateTasksToolInput, { tasks: [{ key: 'a', title: 'A', dependsOn: [MARKER] }] });
    expect(missing).toContainEqual({ rule: 'mcp.create-tasks-dependency', path: 'tasks.0.dependsOn', message: expect.any(String) as string });
    expect(JSON.stringify(missing)).not.toContain(MARKER);
  });
});

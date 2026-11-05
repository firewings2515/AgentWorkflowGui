// Contracts 0.11 (T063): deleting a workflow template, adding the starter set, and the refusal `template-in-use`. Nothing
// stored changes shape: everything 0.10 stored reads once its version is moved (storage migration v14).
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { AgentId, Command, CommandRefusal, CommandResult, CONTRACTS_VERSION, Snapshot, STARTER_AGENT_IDS, STARTER_WORKFLOW_ID, WorkflowId } from './index';
import { fixtureSnapshotInput } from './fixtures/snapshot';

const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;

describe('contracts 0.11', () => {
  it('is version 0.11.0', () => {
    expect(CONTRACTS_VERSION).toBe('0.11.0');
  });

  it('0.10 data reads: the Snapshot and its records keep their shape', () => {
    expect(ok(Snapshot, fixtureSnapshotInput)).toBe(true);
    const parsed = Snapshot.parse(fixtureSnapshotInput);
    expect(parsed.workflows.map((w) => w.id)).toEqual(fixtureSnapshotInput.workflows.map((w) => w.id));
    for (const instance of parsed.instances) expect(instance.template.id).toBe(instance.workflowId);
  });

  it('workflow.delete carries the template and the revision it deletes; nothing else', () => {
    const command = { type: 'workflow.delete', requestId: 'r1', workflowId: 'wf-1', expectedRevision: 2 };
    expect(ok(Command, command)).toBe(true);
    expect(ok(Command, { ...command, expectedRevision: null })).toBe(false);
    expect(ok(Command, { ...command, expectedRevision: -1 })).toBe(false);
    expect(ok(Command, { ...command, workflowId: '' })).toBe(false);
    expect(ok(Command, { type: 'workflow.delete', requestId: 'r1', workflowId: 'wf-1' })).toBe(false);
    expect(ok(Command, { ...command, extra: true })).toBe(false);
  });

  it('workflow.addStarter takes nothing', () => {
    expect(ok(Command, { type: 'workflow.addStarter', requestId: 'r1' })).toBe(true);
    expect(ok(Command, { type: 'workflow.addStarter', requestId: 'r1', workflowId: 'wf-1' })).toBe(false);
  });

  it('template-in-use is a refusal; results without a reason (before 0.10) still read', () => {
    expect(CommandRefusal.options).toContain('template-in-use');
    const refusal = { ok: false, requestId: 'r1', code: 'invalid_transition', message: 'x', retryable: false, mayHaveSideEffects: false };
    expect(CommandResult.parse({ ...refusal, reason: 'template-in-use' })).toMatchObject({ reason: 'template-in-use' });
    expect(ok(CommandResult, refusal)).toBe(true);
  });

  it('the starter IDs are fixed, distinct and valid IDs', () => {
    expect(WorkflowId.parse(STARTER_WORKFLOW_ID)).toBe('starter-workflow-plan-implement-review');
    const agents = Object.values(STARTER_AGENT_IDS);
    expect(new Set(agents).size).toBe(3);
    for (const id of agents) expect(AgentId.parse(id)).toBe(id);
  });
});

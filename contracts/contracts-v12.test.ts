// Contracts 0.12 (T070): the template library. `workflow.addStarter` takes an optional template key (absent: the starter
// set, as in 0.11); the eight built-in templates and their Agents have fixed IDs. Nothing stored changes shape: everything
// 0.11 stored reads once its version is moved (storage migration v15).
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AgentId,
  BUILTIN_AGENT_IDS,
  BUILTIN_WORKFLOW_IDS,
  BuiltinTemplateKey,
  Command,
  CONTRACTS_VERSION,
  Snapshot,
  STARTER_AGENT_IDS,
  STARTER_WORKFLOW_ID,
  WorkflowId,
} from './index';
import { fixtureSnapshotInput } from './fixtures/snapshot';

const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
const add = (extra: Record<string, unknown> = {}) => ({ type: 'workflow.addStarter', requestId: 'r1', ...extra });

describe('contracts 0.12', () => {
  it('is version 0.12.0', () => {
    expect(CONTRACTS_VERSION).toBe('0.12.0');
  });

  it('0.11 data reads: the Snapshot and its records keep their shape', () => {
    expect(ok(Snapshot, fixtureSnapshotInput)).toBe(true);
    const parsed = Snapshot.parse(fixtureSnapshotInput);
    expect(parsed.workflows.map((w) => w.id)).toEqual(fixtureSnapshotInput.workflows.map((w) => w.id));
    expect(parsed.agents.map((a) => a.id)).toEqual(fixtureSnapshotInput.agents.map((a) => a.id));
  });

  it('workflow.addStarter: the 0.11 call as it was, and every library key', () => {
    expect(ok(Command, add())).toBe(true);
    for (const template of BuiltinTemplateKey.options) expect(Command.parse(add({ template }))).toMatchObject({ type: 'workflow.addStarter', template });
    expect(Command.parse(add())).not.toHaveProperty('template');
  });

  it('workflow.addStarter refuses an unknown key, an empty one, another type and other fields', () => {
    expect(ok(Command, add({ template: 'unknown' }))).toBe(false);
    expect(ok(Command, add({ template: '' }))).toBe(false);
    expect(ok(Command, add({ template: 3 }))).toBe(false);
    expect(ok(Command, add({ template: null }))).toBe(false);
    expect(ok(Command, add({ template: BUILTIN_WORKFLOW_IDS.tdd }))).toBe(false);
    expect(ok(Command, add({ workflowId: 'wf-1' }))).toBe(false);
    expect(ok(Command, add({ template: 'tdd', agents: [] }))).toBe(false);
  });

  it('nine keys, the starter first; one fixed template ID each, the starter\'s as in 0.11', () => {
    expect(BuiltinTemplateKey.options).toEqual(['starter', 'evaluator-optimizer', 'tdd', 'spec-parallel', 'parallel-review', 'routing', 'docs-review', 'safe-refactor', 'cross-review']);
    expect(BUILTIN_WORKFLOW_IDS.starter).toBe(STARTER_WORKFLOW_ID);
    const ids = Object.values(BUILTIN_WORKFLOW_IDS);
    expect(Object.keys(BUILTIN_WORKFLOW_IDS)).toEqual(BuiltinTemplateKey.options);
    expect(new Set(ids).size).toBe(9);
    for (const id of ids) expect(WorkflowId.parse(id)).toBe(id);
    expect(BUILTIN_WORKFLOW_IDS.tdd).toBe('builtin-workflow-tdd');
  });

  it('the built-in Agents: fixed, distinct, valid, none of the starter set\'s', () => {
    expect(Object.keys(BUILTIN_AGENT_IDS)).toEqual(BuiltinTemplateKey.options.filter((k) => k !== 'starter'));
    const ids = Object.values(BUILTIN_AGENT_IDS).flatMap((roles) => Object.values(roles));
    // 3 + 4 + 3 + 4 + 4 + 3 + 4 + 4: the cross review's two reviewing nodes share one Agent.
    expect(ids).toHaveLength(29);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(AgentId.parse(id)).toBe(id);
    for (const id of Object.values(STARTER_AGENT_IDS)) expect(ids).not.toContain(id);
    expect(BUILTIN_AGENT_IDS.tdd.verifier).toBe('builtin-agent-tdd-verifier');
  });
});

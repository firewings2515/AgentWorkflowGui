// The starter set (T063, 0.11): three Agents and the template 「規劃 → 實作 → 審查」 that a first start adds once, and that
// `workflow.addStarter` adds on request. Their IDs are fixed, so a repeat or a start after a crash finds what is there, and
// the views can tell whether the starter template is still there. The contents are made by the core.
//
// The built-in templates (T070, 0.12): eight more templates of the template library, each with its own Agents, added only
// when the user asks (`workflow.addStarter` with `template`). Their IDs are fixed the same way; the contents are the core's.
import { z } from 'zod';
import { AgentId, WorkflowId } from './common';

export const STARTER_WORKFLOW_ID = WorkflowId.parse('starter-workflow-plan-implement-review');
export const STARTER_AGENT_IDS = {
  plan: AgentId.parse('starter-agent-plan'),
  implement: AgentId.parse('starter-agent-implement'),
  review: AgentId.parse('starter-agent-review'),
} as const;

/** A template of the template library (T070): the starter template and the eight built-in ones, in the library's order. */
export const BuiltinTemplateKey = z.enum([
  'starter',
  'evaluator-optimizer',
  'tdd',
  'spec-parallel',
  'parallel-review',
  'routing',
  'docs-review',
  'safe-refactor',
  'cross-review',
]);
export type BuiltinTemplateKey = z.infer<typeof BuiltinTemplateKey>;

const workflowId = (key: Exclude<BuiltinTemplateKey, 'starter'>) => WorkflowId.parse(`builtin-workflow-${key}`);

/** The fixed template ID of each library template; the starter template keeps its own. */
export const BUILTIN_WORKFLOW_IDS: Readonly<Record<BuiltinTemplateKey, WorkflowId>> = {
  starter: STARTER_WORKFLOW_ID,
  'evaluator-optimizer': workflowId('evaluator-optimizer'),
  tdd: workflowId('tdd'),
  'spec-parallel': workflowId('spec-parallel'),
  'parallel-review': workflowId('parallel-review'),
  routing: workflowId('routing'),
  'docs-review': workflowId('docs-review'),
  'safe-refactor': workflowId('safe-refactor'),
  'cross-review': workflowId('cross-review'),
};

const agents = <const R extends string>(key: Exclude<BuiltinTemplateKey, 'starter'>, roles: readonly R[]) =>
  Object.fromEntries(roles.map((role) => [role, AgentId.parse(`builtin-agent-${key}-${role}`)])) as Record<R, AgentId>;

/** The fixed Agent IDs of each built-in template (its own Agents, by role); the starter set's are STARTER_AGENT_IDS. */
export const BUILTIN_AGENT_IDS = {
  'evaluator-optimizer': agents('evaluator-optimizer', ['lead', 'writer', 'judge']),
  tdd: agents('tdd', ['lead', 'tester', 'builder', 'verifier']),
  'spec-parallel': agents('spec-parallel', ['lead', 'builder', 'reviewer']),
  'parallel-review': agents('parallel-review', ['lead', 'correctness', 'robustness', 'merger']),
  routing: agents('routing', ['lead', 'fixer', 'feature', 'reviewer']),
  'docs-review': agents('docs-review', ['lead', 'writer', 'checker']),
  'safe-refactor': agents('safe-refactor', ['lead', 'analyst', 'refactorer', 'verifier']),
  'cross-review': agents('cross-review', ['lead', 'reviewer', 'fixer', 'verifier']),
} as const;

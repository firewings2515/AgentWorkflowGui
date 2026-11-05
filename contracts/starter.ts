// The starter set (T063, 0.11): three Agents and the template 「規劃 → 實作 → 審查」 that a first start adds once, and that
// `workflow.addStarter` adds on request. Their IDs are fixed, so a repeat or a start after a crash finds what is there, and
// the views can tell whether the starter template is still there. The contents are made by the core.
import { AgentId, WorkflowId } from './common';

export const STARTER_WORKFLOW_ID = WorkflowId.parse('starter-workflow-plan-implement-review');
export const STARTER_AGENT_IDS = {
  plan: AgentId.parse('starter-agent-plan'),
  implement: AgentId.parse('starter-agent-implement'),
  review: AgentId.parse('starter-agent-review'),
} as const;

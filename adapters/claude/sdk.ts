// The only module that imports `@anthropic-ai/claude-agent-sdk` (proprietary licence, pinned 0.3.309).
// Everything else in the adapter depends on the structural `ClaudeSdk` interface in wire.ts, so the SDK
// can be isolated or replaced here alone.
import { getSessionMessages, getSubagentMessages, listSubagents, query } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSdk } from './wire';

export const claudeAgentSdk: ClaudeSdk = {
  query: ({ prompt, options }) => query({ prompt, options }),
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options),
  listSubagents: (sessionId, options) => listSubagents(sessionId, options),
  getSubagentMessages: (sessionId, agentId, options) => getSubagentMessages(sessionId, agentId, options),
};

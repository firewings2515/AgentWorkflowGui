// The only module that imports `@anthropic-ai/claude-agent-sdk` (proprietary licence, pinned 0.3.309).
// Everything else in the adapter depends on the structural `ClaudeSdk` interface in wire.ts, so the SDK
// can be isolated or replaced here alone.
import {
  getSessionMessages,
  getSubagentMessages,
  importSessionToStore,
  listSubagents,
  query,
  type SessionKey,
  type SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSdk, WireTranscriptEntry } from './wire';

/**
 * `importSessionToStore` copies the session file line by line into a store without deduplicating, so a
 * store that only collects the main transcript gives the raw lines. It throws when there is no such
 * session, which is reported as an empty transcript.
 */
const readTranscript: ClaudeSdk['readTranscript'] = async (sessionId, { dir }) => {
  const entries: WireTranscriptEntry[] = [];
  const collector: SessionStore = {
    append: (key, batch) => {
      if (key.subpath === undefined) entries.push(...batch);
      return Promise.resolve();
    },
    load: () => Promise.resolve(null),
  };
  try {
    await importSessionToStore(sessionId, collector, { dir, includeSubagents: false });
  } catch (error) {
    if (error instanceof Error && /^Session \S+ not found$/.test(error.message)) return [];
    throw error;
  }
  return entries;
};

export const claudeAgentSdk: ClaudeSdk = {
  query: ({ prompt, options }) => query({ prompt, options }),
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options),
  listSubagents: (sessionId, options) => listSubagents(sessionId, options),
  getSubagentMessages: (sessionId, agentId, options) => getSubagentMessages(sessionId, agentId, options),
  readTranscript,
};

/** Stored transcripts held in memory: the main lines and each sub-agent's lines, per session. */
export interface TranscriptSource {
  main(sessionId: string): WireTranscriptEntry[] | undefined;
  subagents(sessionId: string): Record<string, WireTranscriptEntry[]>;
}

/**
 * The SDK's own readers over in-memory transcripts (its `sessionStore` option), so tests see the real
 * chain rebuilding, deduplication and compaction handling instead of a re-implementation. Folder
 * matching is the caller's: the store answers for any project key.
 */
export const transcriptReaders = (source: TranscriptSource): Pick<ClaudeSdk, 'getSessionMessages' | 'listSubagents' | 'getSubagentMessages'> => {
  const store: SessionStore & { listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> } = {
    append: () => Promise.resolve(),
    load: (key: SessionKey) => {
      if (key.subpath === undefined) return Promise.resolve(source.main(key.sessionId) ?? null);
      const agentId = /^subagents\/agent-(.+)$/.exec(key.subpath)?.[1];
      return Promise.resolve(agentId === undefined ? null : (source.subagents(key.sessionId)[agentId] ?? null));
    },
    listSubkeys: ({ sessionId }) => Promise.resolve(Object.keys(source.subagents(sessionId)).map((id) => `subagents/agent-${id}`)),
  };
  return {
    getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, { ...options, sessionStore: store }),
    listSubagents: (sessionId, options) => listSubagents(sessionId, { ...options, sessionStore: store }),
    getSubagentMessages: (sessionId, agentId, options) => getSubagentMessages(sessionId, agentId, { ...options, sessionStore: store }),
  };
};

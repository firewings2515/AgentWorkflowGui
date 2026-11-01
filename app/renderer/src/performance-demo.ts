import type { Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { longConversation } from '../../../contracts/fixtures/long-conversation';

let cached: Snapshot | undefined;
/** Opt-in preview fixture at ?demo=long; generation is excluded from interaction timing. */
export function performanceSnapshot(): Snapshot {
  if (cached) return cached;
  const sessionId = fixtureSnapshot.sessions[0]!.id;
  const page = longConversation({ sessionId, turns: 2000 });
  cached = { ...fixtureSnapshot, messages: page.messages, turns: page.turns, items: page.items,
    nativeTasks: [], permissionRequests: [], artifacts: [], escalations: [], locks: [],
    historyPages: [{ sessionId, olderCursor: null }] };
  return cached;
}

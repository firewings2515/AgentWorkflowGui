import type { AppEvent, Command, CommandResult, LogicalSession, Snapshot } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import type { EventBus } from './event-bus';

/**
 * What the IPC layer needs from the application core. Today a fake answers; later the core does, so
 * nothing in `app-ipc.ts` changes. A facade may throw: the IPC layer turns that into a failed result.
 */
export interface AppFacade {
  /** State as of `EventBus.seq`: every event up to that seq is already reflected in it. */
  snapshot(): Snapshot;
  execute(command: Command): CommandResult | Promise<CommandResult>;
}

type Failure = Extract<CommandResult, { ok: false }>;

export function failure(
  requestId: Failure['requestId'],
  code: Failure['code'],
  message: string,
  flags: { retryable?: boolean; mayHaveSideEffects?: boolean } = {},
): Failure {
  return { ok: false, requestId, code, message, retryable: flags.retryable ?? false, mayHaveSideEffects: flags.mayHaveSideEffects ?? false };
}

/**
 * Fake facade over the contract fixtures, kept in memory only. Implements `preferences.set` (kept for the
 * life of the process) and `session.reparent` (changes the tree and publishes `session.updated`); every
 * other command answers `unsupported`.
 */
export function createFakeFacade(deps: { bus: Pick<EventBus, 'seq' | 'publish'>; now?: () => Date }): AppFacade {
  const { bus } = deps;
  const now = deps.now ?? (() => new Date());
  let state: Snapshot = structuredClone(fixtureSnapshot);

  function reparent(command: Extract<Command, { type: 'session.reparent' }>): CommandResult {
    const { requestId, sessionId, parentId, expectedRevision } = command;
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return failure(requestId, 'not_found', 'Unknown session');
    // A workflow session's parent is the session that created it; only the ordinary tree can be reorganised (WB-01).
    if (session.kind !== 'ordinary') return failure(requestId, 'invalid_transition', 'Only ordinary sessions can be moved in the tree');
    if (session.revision !== expectedRevision) {
      return failure(requestId, 'stale_revision', 'The session has changed since it was loaded', { retryable: true });
    }
    if (parentId !== null) {
      if (!state.sessions.some((s) => s.id === parentId)) return failure(requestId, 'not_found', 'Unknown parent session');
      // Walking up from the new parent must never reach the session itself.
      let cursor: string | undefined = parentId;
      while (cursor !== undefined) {
        if (cursor === sessionId) return failure(requestId, 'invalid_request', 'A session cannot sit below itself');
        const above: string = cursor;
        cursor = state.sessions.find((s) => s.id === above)?.parentId;
      }
    }
    const next: LogicalSession = { ...session, revision: session.revision + 1, updatedAt: now().toISOString() };
    if (parentId === null) delete next.parentId;
    else next.parentId = parentId;
    state = { ...state, sessions: state.sessions.map((s) => (s.id === sessionId ? next : s)) };
    bus.publish({ type: 'session.updated', session: next } satisfies AppEvent);
    return { ok: true, requestId, revision: next.revision, created: [] };
  }

  return {
    snapshot: () => ({ ...state, seq: bus.seq }),
    execute(command) {
      switch (command.type) {
        case 'preferences.set':
          state = { ...state, preferences: command.preferences };
          return { ok: true, requestId: command.requestId, created: [] };
        case 'session.reparent':
          return reparent(command);
        default:
          return failure(command.requestId, 'unsupported', `${command.type} is not available yet`);
      }
    },
  };
}

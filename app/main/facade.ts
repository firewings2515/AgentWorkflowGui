import type { Command, CommandResult, Snapshot } from '../../contracts';

/**
 * What the IPC layer needs from the application core (backend.ts puts the session service behind it). A
 * facade may throw: the IPC layer turns that into a failed result.
 */
export interface AppFacade {
  /** State as of `EventBus.seq`: every event up to that seq is already reflected in it. */
  snapshot(): Snapshot | Promise<Snapshot>;
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

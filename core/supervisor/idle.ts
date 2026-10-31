// When a session's runtime may be closed for being idle (T036, HC-04, R-14): nothing of it runs, waits or is on
// its way. Every fact comes from what the GUI itself observed and stored (R-14: never from the agent's own
// account), plus the processes still alive in the session's Job.
import type { NativeTask, SessionActivity, SessionItem, Turn } from '../../contracts';

export interface IdleFacts {
  activity: SessionActivity;
  turns: readonly Turn[];
  items: readonly SessionItem[];
  nativeTasks: readonly NativeTask[];
  /** Turns a dispatch's ack named that were not seen to end yet (T023 r1-P1-4). */
  ackedTurns: number;
  /** A formal handoff's turn is still waited for (SP-05). */
  handoffTurn: boolean;
  /** Permission requests held for the user or a lock (R-05, R-07). */
  heldRequests: number;
  /** Deliveries to the session still pending, or sent with an unknown outcome (CR-2), that nobody gave up on. */
  deliveries: { pending: number; unknown: number };
  /** File locks it holds or waits for (R-07). */
  locks: number;
  /**
   * Live processes in its Job other than the runtime host and helpers: a background command, or a Codex
   * `Start-Process` child that outlives its app-server (R-14). Ending the Job would end them.
   */
  ownedCommands: number;
}

export type BusyReason =
  | 'busy-activity'
  | 'turn-running'
  | 'turn-acked'
  | 'handoff-turn'
  | 'command-running'
  | 'native-task-running'
  | 'held-request'
  | 'delivery-pending'
  | 'delivery-unknown'
  | 'lock-held'
  | 'owned-process';

/** Why the session is not idle; empty when it is. */
export const busyReasons = (f: IdleFacts): BusyReason[] => {
  const reasons: BusyReason[] = [];
  if (f.activity === 'running' || f.activity === 'waiting-user' || f.activity === 'waiting-lock' || f.activity === 'reconciling') reasons.push('busy-activity');
  // Sub-agent turns count too: a background sub-agent keeps the session busy (R-13).
  if (f.turns.some((t) => t.state === 'running')) reasons.push('turn-running');
  if (f.ackedTurns > 0) reasons.push('turn-acked');
  if (f.handoffTurn) reasons.push('handoff-turn');
  // An item without its end is still open (contracts: open state ⇔ no endedAt): a running command, a Claude
  // background command until its task ends (T033), a proposed file change, a running tool call.
  if (f.items.some((i) => i.endedAt === undefined)) reasons.push('command-running');
  if (f.nativeTasks.some((t) => t.state === 'running')) reasons.push('native-task-running');
  if (f.heldRequests > 0) reasons.push('held-request');
  if (f.deliveries.pending > 0) reasons.push('delivery-pending');
  if (f.deliveries.unknown > 0) reasons.push('delivery-unknown');
  if (f.locks > 0) reasons.push('lock-held');
  if (f.ownedCommands > 0) reasons.push('owned-process');
  return reasons;
};

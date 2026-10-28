import { Command, CommandResult, type EventEnvelope, RequestId, Snapshot } from '../../contracts';
import { COMMAND_CHANNEL, EVENT_CHANNEL, SNAPSHOT_CHANNEL } from '../preload/channels';
import type { EventBus } from './event-bus';
import { failure, type AppFacade } from './facade';
import { handleTrusted } from './ipc';
import type { TrustedSender } from './ipc-guard';
import { describeIssues } from './issues';

/** Used when a malformed command carries no usable requestId, so the reply is still a valid CommandResult. */
export const UNKNOWN_REQUEST_ID = RequestId.parse('unknown');

function requestIdOf(raw: unknown): RequestId {
  if (typeof raw !== 'object' || raw === null) return UNKNOWN_REQUEST_ID;
  const parsed = RequestId.safeParse((raw as { requestId?: unknown }).requestId);
  return parsed.success ? parsed.data : UNKNOWN_REQUEST_ID;
}

/**
 * Runs one command from the renderer. Never throws: a malformed command, a facade that throws and a facade
 * that answers with something outside the contract all come back as a failed CommandResult.
 */
export async function runCommand(facade: AppFacade, raw: unknown): Promise<CommandResult> {
  const requestId = requestIdOf(raw);
  const command = Command.safeParse(raw);
  if (!command.success) return failure(requestId, 'invalid_request', `Invalid command. ${describeIssues(command.error)}`);
  try {
    const result = CommandResult.safeParse(await facade.execute(command.data));
    if (result.success && result.data.requestId === command.data.requestId) return result.data;
    // The command ran, so a side effect may have happened even though the answer is unusable.
    return failure(requestId, 'runtime_unavailable', 'The backend answered with an invalid result', { mayHaveSideEffects: true });
  } catch {
    return failure(requestId, 'runtime_unavailable', 'The backend failed while running the command', { mayHaveSideEffects: true });
  }
}

/** What the renderer sees when no valid Snapshot can be produced; the reason stays in the main process log. */
export const SNAPSHOT_UNAVAILABLE = 'The state snapshot is not available';

/**
 * The Snapshot, checked against the contract before it leaves the main process. Electron hands a handler's
 * thrown message to the renderer, so a failure is logged here (field paths only) and rethrown as fixed text.
 */
export async function readSnapshot(facade: AppFacade, log: (message: string) => void = console.error): Promise<Snapshot> {
  let raw: unknown;
  let failed = false;
  try {
    raw = await facade.snapshot();
  } catch (error) {
    log(`[ipc] the backend failed to produce a snapshot (${error instanceof Error ? error.name : 'non-error thrown'})`);
    failed = true;
  }
  if (failed) throw new Error(SNAPSHOT_UNAVAILABLE);
  const parsed = Snapshot.safeParse(raw);
  if (!parsed.success) {
    log(`[ipc] the backend produced an invalid snapshot: ${describeIssues(parsed.error)}`);
    throw new Error(SNAPSHOT_UNAVAILABLE);
  }
  return parsed.data;
}

/** The part of `WebContents` that event forwarding needs. */
export interface EventTarget {
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, envelope: EventEnvelope): void;
}

/** Pushes every envelope to the window, but only while it is alive and still showing one of our pages. */
export function forwardEvents(
  bus: Pick<EventBus, 'subscribe'>,
  getTarget: () => EventTarget | null,
  isTrustedUrl: (url: string) => boolean,
): () => void {
  return bus.subscribe((envelope) => {
    const target = getTarget();
    if (target === null || target.isDestroyed() || !isTrustedUrl(target.getURL())) return;
    target.send(EVENT_CHANNEL, envelope);
  });
}

export interface AppIpcOptions {
  facade: AppFacade;
  bus: Pick<EventBus, 'subscribe'>;
  getTrustedSender: () => TrustedSender | null;
  getEventTarget: () => EventTarget | null;
  isTrustedUrl: (url: string) => boolean;
}

/** Registers the snapshot and command handlers and starts forwarding events. Returns the function that stops forwarding. */
export function registerAppIpc(options: AppIpcOptions): () => void {
  const { facade, bus, getTrustedSender, getEventTarget, isTrustedUrl } = options;
  handleTrusted(SNAPSHOT_CHANNEL, getTrustedSender, () => readSnapshot(facade));
  handleTrusted(COMMAND_CHANNEL, getTrustedSender, (raw: unknown) => runCommand(facade, raw));
  return forwardEvents(bus, getEventTarget, isTrustedUrl);
}

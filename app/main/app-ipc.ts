import { Command, CommandResult, type EventEnvelope, RequestId, Snapshot } from '../../contracts';
import { COMMAND_CHANNEL, EVENT_CHANNEL, SNAPSHOT_CHANNEL } from '../preload/channels';
import type { EventBus } from './event-bus';
import { failure, type AppFacade } from './facade';
import { handleTrusted } from './ipc';
import type { TrustedSender } from './ipc-guard';

/** Used when a malformed command carries no usable requestId, so the reply is still a valid CommandResult. */
export const UNKNOWN_REQUEST_ID = RequestId.parse('unknown');

/** Names the offending fields without echoing their values (a bad command may hold large or private text). */
function describeIssues(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const shown = error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.') || '(command)'}: ${i.message}`);
  const more = error.issues.length - shown.length;
  return `Invalid command. ${shown.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}`;
}

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
  if (!command.success) return failure(requestId, 'invalid_request', describeIssues(command.error));
  try {
    const result = CommandResult.safeParse(await facade.execute(command.data));
    if (result.success && result.data.requestId === command.data.requestId) return result.data;
    // The command ran, so a side effect may have happened even though the answer is unusable.
    return failure(requestId, 'runtime_unavailable', 'The backend answered with an invalid result', { mayHaveSideEffects: true });
  } catch {
    return failure(requestId, 'runtime_unavailable', 'The backend failed while running the command', { mayHaveSideEffects: true });
  }
}

/** The Snapshot, checked against the contract before it leaves the main process. */
export function readSnapshot(facade: AppFacade): Snapshot {
  return Snapshot.parse(facade.snapshot());
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

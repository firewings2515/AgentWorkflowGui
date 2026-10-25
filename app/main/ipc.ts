import { ipcMain } from 'electron';
import { isTrustedSender, type IpcSenderEvent, type TrustedSender } from './ipc-guard';

/** Wraps a handler so it runs only for the trusted sender; anything else is rejected before the handler sees the arguments. */
export function guardHandler<Args extends unknown[], Result>(
  channel: string,
  getTrustedSender: () => TrustedSender | null,
  handler: (...args: Args) => Result,
): (event: IpcSenderEvent, ...args: unknown[]) => Result {
  return (event, ...args) => {
    if (!isTrustedSender(event, getTrustedSender())) {
      throw new Error(`Rejected IPC call on "${channel}" from an untrusted sender`);
    }
    return handler(...(args as Args));
  };
}

/** Registers an `ipcMain.handle` handler that rejects calls from anything but the trusted sender. */
export function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  getTrustedSender: () => TrustedSender | null,
  handler: (...args: Args) => Result,
): void {
  ipcMain.handle(channel, guardHandler(channel, getTrustedSender, handler));
}

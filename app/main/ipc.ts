import { ipcMain } from 'electron';
import { isTrustedSender, type TrustedSender } from './ipc-guard';

/** Registers an `ipcMain.handle` handler that rejects calls from anything but the trusted sender. */
export function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  getTrustedSender: () => TrustedSender | null,
  handler: (...args: Args) => Result,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event, getTrustedSender())) {
      throw new Error(`Rejected IPC call on "${channel}" from an untrusted sender`);
    }
    return handler(...(args as Args));
  });
}

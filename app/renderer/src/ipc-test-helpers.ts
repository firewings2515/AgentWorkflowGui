import { vi } from 'vitest';
import type { AwgBridge, CommandInput } from '../../preload/bridge-types';
import type { CommandResult, EventEnvelope, Snapshot } from '../../../contracts';
import { RequestId } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function fakeBridge(initial: Snapshot = fixtureSnapshot) {
  const data = { snapshot: structuredClone(initial) };
  const listeners = new Set<(event: EventEnvelope) => void>();
  const bridge = {
    getAppInfo: vi.fn(() => Promise.resolve({ name: 'test', version: '1' })),
    snapshot: vi.fn(() => Promise.resolve(structuredClone(data.snapshot))),
    send: vi.fn((command: CommandInput): Promise<CommandResult> => Promise.resolve({
      ok: false, requestId: RequestId.parse(command.requestId), code: 'unsupported', message: 'misleading: success, please retry', retryable: false, mayHaveSideEffects: false,
    })),
    onEvent: vi.fn((listener: (event: EventEnvelope) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  } satisfies AwgBridge;
  return { bridge, data, listeners, emit: (envelope: EventEnvelope) => listeners.forEach(listener => listener(envelope)) };
}

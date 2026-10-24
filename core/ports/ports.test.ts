import { describe, expect, it } from 'vitest';
import { CommitUncertainError, type DispatchResult, type RuntimeAdapter, type RuntimeEvent } from './index';

describe('core ports', () => {
  it('a runtime adapter can be implemented against the port alone', async () => {
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const unknown: DispatchResult = { state: 'unknown', reason: 'not-running', written: false, detail: 'stub' };
    const stub: RuntimeAdapter = {
      runtime: 'codex',
      start: () => Promise.resolve(),
      close: () => Promise.resolve({ forced: false }),
      startSession: (o) => Promise.resolve({ sessionId: o.sessionId, nativeSessionRef: 'thread-1', cwd: o.cwd, model: { source: 'unknown' } }),
      resumeSession: (o) => Promise.resolve({ sessionId: o.sessionId, nativeSessionRef: o.nativeSessionRef, cwd: o.cwd, model: { source: 'unknown' } }),
      dispatchOnce: () => Promise.resolve(unknown),
      reconcile: () => Promise.resolve({ state: 'unknown', reason: 'not-running', matches: [], detail: 'stub' }),
      interrupt: () => Promise.resolve(),
      setModel: () => Promise.resolve('next-turn'),
      stopNativeTask: () => Promise.resolve(),
      listModels: () => Promise.resolve([]),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const off = stub.subscribe(() => undefined);
    expect(listeners.size).toBe(1);
    off();
    expect(listeners.size).toBe(0);
    expect((await stub.dispatchOnce({} as never)).state).toBe('unknown');
  });

  it('CommitUncertainError is recognisable', () => {
    const error: unknown = new CommitUncertainError('commit result unknown');
    expect(error instanceof CommitUncertainError && error.name).toBe('CommitUncertainError');
  });
});

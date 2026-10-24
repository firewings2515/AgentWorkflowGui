import { describe, expect, it } from 'vitest';
import type { OperationId, SessionId } from '../../contracts';
import { type AcceptInput, CommitUncertainError, type DispatchResult, type ResumeSessionOptions, type RuntimeAdapter, type RuntimeEvent } from './index';

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
      readHistory: () => Promise.resolve({ entries: [], nativeTasks: [], complete: false }),
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

describe('delivery port records', () => {
  it('payloads carry their dispatch context and provisions their create spec', () => {
    const base = { operationId: 'op-1' as OperationId, payloadHash: `sha256:${'a'.repeat(64)}`, proposalRevision: 0, target: {}, at: '2026-10-25T03:00:00+08:00' };
    const payload: AcceptInput = {
      ...base,
      kind: 'handoff',
      payload: 'do it',
      context: { runtime: 'codex', cwd: 'E:/w', entry: { kind: 'insert' }, session: { model: { runtime: 'codex', model: 'gpt-6-astra' }, readOnly: false } },
    };
    const provision: AcceptInput = {
      ...base,
      kind: 'provision',
      spec: { runtime: 'claude', sessionId: 's-new' as SessionId, cwd: 'E:/w', model: { runtime: 'claude', model: 'claude-sonnet-5-5' }, readOnly: true },
    };
    expect([payload.kind, provision.kind]).toEqual(['handoff', 'provision']);
  });
});

describe('recovery from the delivery record alone', () => {
  it('a pending payload to an existing session can be resumed after a restart (no provision)', () => {
    const context = {
      runtime: 'claude' as const,
      cwd: 'E:/w',
      entry: { kind: 'new-turn' as const },
      session: { model: { runtime: 'claude' as const, model: 'claude-opus-5-5' }, readOnly: true, instructions: 'review only' },
    };
    const resume: ResumeSessionOptions = { sessionId: 's-1' as SessionId, nativeSessionRef: 'native-1', cwd: context.cwd, ...context.session };
    expect(resume.readOnly).toBe(true);
    expect(resume.model.model).toBe('claude-opus-5-5');
  });
});

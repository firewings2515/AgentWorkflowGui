import { type Mock, describe, expect, it, vi } from 'vitest';
import type { HandoffId, HandoffToolResult, SessionId } from '../../contracts';
import { CallRunner, sourceCallRefOf } from './calls';
import { SessionTokens, bearerToken } from './tokens';
import type { DeliveryCallContext, McpToolHandlers } from './tools';

const A = 'session-a' as SessionId;
const B = 'session-b' as SessionId;

const handoffArgs = { ruleId: 'done', target: { kind: 'root' }, content: 'the work', taskId: 'task-1' };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const accepted = (ctx: DeliveryCallContext): HandoffToolResult => ({
  status: 'accepted',
  handoffId: `handoff-${ctx.operationId}` as HandoffId,
  operationId: ctx.operationId,
  delivery: 'pending',
});

type Fakes = { [K in keyof McpToolHandlers]: Mock<McpToolHandlers[K]> };

const notExpected = () => Promise.reject(new Error('not expected'));

const makeHandlers = (overrides: Partial<Fakes> = {}): Fakes => ({
  handoff: vi.fn<McpToolHandlers['handoff']>((_input, ctx) => Promise.resolve(accepted(ctx))),
  create_tasks: vi.fn<McpToolHandlers['create_tasks']>(notExpected),
  send_message: vi.fn<McpToolHandlers['send_message']>(notExpected),
  report_to_root: vi.fn<McpToolHandlers['report_to_root']>(() => Promise.resolve({ status: 'reported' })),
  wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>(notExpected),
  ...overrides,
});

const runner = (handlers: McpToolHandlers, log?: (m: string) => void) => {
  let n = 0;
  return new CallRunner({ handlers, uuid: () => `op-${++n}`, ...(log && { log }) });
};

const live = () => new AbortController().signal;

describe('CallRunner', () => {
  it('gives every new source call its own operationId and passes the caller from the token', async () => {
    const handlers = makeHandlers();
    const calls = runner(handlers);
    const one = await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const two = await calls.run(A, 'handoff', handoffArgs, 'meta:x:2', live());
    expect(one).toMatchObject({ kind: 'result', result: { status: 'accepted', operationId: 'op-1' } });
    expect(two).toMatchObject({ kind: 'result', result: { status: 'accepted', operationId: 'op-2' } });
    expect(handlers.handoff.mock.calls[0]?.[1]).toMatchObject({ caller: A, sourceCallRef: 'meta:x:1', operationId: 'op-1' });
  });

  it('answers a resend of a finished call from memory, as a duplicate with the same operationId', async () => {
    const handlers = makeHandlers();
    const calls = runner(handlers);
    await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const again = await calls.run(A, 'handoff', { taskId: 'task-1', content: 'the work', target: { kind: 'root' }, ruleId: 'done' }, 'meta:x:1', live());
    expect(again).toMatchObject({ kind: 'result', result: { status: 'duplicate', operationId: 'op-1', handoffId: 'handoff-op-1' } });
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
  });

  it('joins a resend that arrives while the first call is still running', async () => {
    const gate = deferred<void>();
    const handlers = makeHandlers({
      handoff: vi.fn<McpToolHandlers['handoff']>(async (_input, ctx) => {
        await gate.promise;
        return accepted(ctx);
      }),
    });
    const calls = runner(handlers);
    const first = calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const resend = calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    expect(calls.inFlight).toBe(1);
    gate.resolve();
    expect(await first).toMatchObject({ result: { status: 'accepted', operationId: 'op-1' } });
    expect(await resend).toMatchObject({ result: { status: 'duplicate', operationId: 'op-1' } });
    expect(handlers.handoff).toHaveBeenCalledTimes(1);
  });

  it('keeps resends of different sessions apart even with the same native call ID', async () => {
    const handlers = makeHandlers();
    const calls = runner(handlers);
    await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const other = await calls.run(B, 'handoff', handoffArgs, 'meta:x:1', live());
    expect(other).toMatchObject({ result: { status: 'accepted', operationId: 'op-2' } });
  });

  it('refuses the same source call with other input', async () => {
    const calls = runner(makeHandlers());
    await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const changed = await calls.run(A, 'handoff', { ...handoffArgs, content: 'other' }, 'meta:x:1', live());
    expect(changed).toMatchObject({ result: { status: 'rejected', rejection: { reason: 'invalid-input' } } });
  });

  it('uses the retried operationId for retryOf and refuses one that another session created', async () => {
    const handlers = makeHandlers();
    const calls = runner(handlers);
    await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    const retry = await calls.run(A, 'handoff', { ...handoffArgs, retryOf: 'op-1' }, 'meta:x:2', live());
    expect(retry).toMatchObject({ result: { operationId: 'op-1' } });
    const foreign = await calls.run(B, 'handoff', { ...handoffArgs, retryOf: 'op-1' }, 'meta:x:3', live());
    expect(foreign).toMatchObject({ result: { status: 'rejected', rejection: { reason: 'unknown-target' } } });
    expect(JSON.stringify(foreign)).not.toContain(A);
    // Unknown here: left to the handler, which checks the store.
    const unknown = await calls.run(B, 'handoff', { ...handoffArgs, retryOf: 'op-from-before-restart' }, 'meta:x:4', live());
    expect(unknown).toMatchObject({ result: { operationId: 'op-from-before-restart' } });
  });

  it('validates input against the contracts without echoing it, and never calls the handler', async () => {
    const handlers = makeHandlers();
    const calls = runner(handlers);
    const secret = 'SECRET-CONTENT-123';
    const bad = await calls.run(A, 'handoff', { ...handoffArgs, ruleId: '', extra: secret }, 'meta:x:1', live());
    expect(bad).toMatchObject({ result: { status: 'rejected', rejection: { reason: 'invalid-input' } } });
    expect(JSON.stringify(bad)).not.toContain(secret);
    const cycle = await calls.run(A, 'create_tasks', { ruleId: 'split', tasks: [{ key: 'a', title: 't', dependsOn: ['a'] }] }, 'meta:x:2', live());
    expect(cycle).toMatchObject({ result: { rejection: { reason: 'invalid-input' } } });
    expect(JSON.stringify(cycle)).toContain('tasks.0.dependsOn: a task depends on itself');
    expect(handlers.handoff).not.toHaveBeenCalled();
    expect(handlers.create_tasks).not.toHaveBeenCalled();
  });


  // Review r1 P1-5: a handler that did its work and then failed must not run again on a resend.
  it('keeps a failure on record, so a resend gets the same failure without running the handler again', async () => {
    let created = 0;
    const create_tasks = vi.fn<McpToolHandlers['create_tasks']>(() => {
      created++;
      return Promise.reject(new Error('created, then the answer failed'));
    });
    const handoff = vi.fn<McpToolHandlers['handoff']>(() => Promise.resolve({ status: 'bogus' } as unknown as HandoffToolResult));
    const calls = runner(makeHandlers({ create_tasks, handoff }));
    const tasks = { ruleId: 'split', tasks: [{ key: 'a', title: 'A' }] };
    expect(await calls.run(A, 'create_tasks', tasks, 'meta:x:1', live())).toEqual({ kind: 'failed' });
    expect(await calls.run(A, 'create_tasks', tasks, 'meta:x:1', live())).toEqual({ kind: 'failed' });
    expect(created).toBe(1);
    expect(await calls.run(A, 'handoff', handoffArgs, 'meta:x:2', live())).toEqual({ kind: 'failed' });
    expect(await calls.run(A, 'handoff', handoffArgs, 'meta:x:2', live())).toEqual({ kind: 'failed' });
    expect(handoff).toHaveBeenCalledTimes(1);
    // A real retry is a new tool call; for a delivery it names the operation it retries.
    await calls.run(A, 'handoff', { ...handoffArgs, retryOf: 'op-1' }, 'meta:x:3', live());
    expect(handoff.mock.calls.map((c) => c[1].operationId)).toEqual(['op-1', 'op-1']);
  });

  // Review r1 P1-7: the error's name and message are the handler's strings; neither reaches the log.
  it('logs only a fixed category and the tool name for a failing handler', async () => {
    const log = vi.fn<(m: string) => void>();
    const error = Object.assign(new Error('MESSAGE-MARKER token=abc'), { name: 'NAME-MARKER' });
    const handoff = vi.fn<McpToolHandlers['handoff']>(() => Promise.reject(error));
    const send_message = vi.fn<McpToolHandlers['send_message']>(() => Promise.resolve({ status: 'RESULT-MARKER' } as never));
    const calls = runner(makeHandlers({ handoff, send_message }), log);
    await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    await calls.run(A, 'send_message', { to: 'session-b', content: 'hi' }, 'meta:x:2', live());
    expect(log.mock.calls.map((c) => c[0])).toEqual(['[mcp] handoff: handler-threw', '[mcp] send_message: invalid-result']);
  });

  it('answers waiting calls with shutting-down, aborts handlers and refuses new calls after shutdown', async () => {
    let seen: AbortSignal | undefined;
    const calls = runner(
      makeHandlers({
        wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>((_input, ctx) => {
          seen = ctx.signal;
          return new Promise<never>(() => {});
        }),
      }),
    );
    const waiting = calls.run(A, 'wait_for_file', { path: 'a.txt' }, 'meta:x:1', live());
    await Promise.resolve();
    calls.shutdown();
    expect(await waiting).toMatchObject({ result: { status: 'rejected', rejection: { reason: 'shutting-down' } } });
    expect(seen?.aborted).toBe(true);
    expect(await calls.run(A, 'report_to_root', { content: 'x' }, 'meta:x:2', live())).toMatchObject({
      result: { rejection: { reason: 'shutting-down' } },
    });
  });

  // Review r1 P1-6: cancelling the only waiter must not leave a later resend without an answer at shutdown.
  it('does not abort the handler when a waiter cancels, and answers a later resend at shutdown', async () => {
    let seen: AbortSignal | undefined;
    const wait_for_file = vi.fn<McpToolHandlers['wait_for_file']>((_input, ctx) => {
      seen = ctx.signal;
      return new Promise<never>(() => {});
    });
    const calls = runner(makeHandlers({ wait_for_file }));
    const cancelled = new AbortController();
    const first = calls.run(A, 'wait_for_file', { path: 'a.txt' }, 'meta:x:1', cancelled.signal);
    cancelled.abort();
    expect(await first).toEqual({ kind: 'failed' });
    expect(seen?.aborted).toBe(false);
    const resend = calls.run(A, 'wait_for_file', { path: 'a.txt' }, 'meta:x:1', live());
    calls.shutdown();
    expect(await resend).toMatchObject({ result: { status: 'rejected', rejection: { reason: 'shutting-down' } } });
    expect(seen?.aborted).toBe(true);
    expect(wait_for_file).toHaveBeenCalledTimes(1);
  });

  it('lets a resend receive the answer after the first waiter cancelled', async () => {
    const gate = deferred<void>();
    const handoff = vi.fn<McpToolHandlers['handoff']>(async (_input, ctx) => {
      await gate.promise;
      return accepted(ctx);
    });
    const calls = runner(makeHandlers({ handoff }));
    const cancelled = new AbortController();
    const first = calls.run(A, 'handoff', handoffArgs, 'meta:x:1', cancelled.signal);
    cancelled.abort();
    await first;
    const resend = calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live());
    gate.resolve();
    expect(await resend).toMatchObject({ result: { status: 'duplicate', operationId: 'op-1' } });
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  // Review r1 P1-1: finished calls beyond the capacity were forgotten and accepted again.
  it('never forgets a call on record: past the capacity, new calls are refused instead', async () => {
    const handlers = makeHandlers();
    const calls = new CallRunner({ handlers, uuid: (() => { let n = 0; return () => `op-${++n}`; })(), maxCallsPerCaller: 2 });
    expect(await calls.run(A, 'handoff', handoffArgs, 'r1', live())).toMatchObject({ result: { status: 'accepted', operationId: 'op-1' } });
    await calls.run(A, 'handoff', handoffArgs, 'r2', live());
    expect(await calls.run(A, 'handoff', handoffArgs, 'r3', live())).toEqual({ kind: 'refused' });
    expect(await calls.run(A, 'handoff', handoffArgs, 'r1', live())).toMatchObject({ result: { status: 'duplicate', operationId: 'op-1' } });
    expect(handlers.handoff).toHaveBeenCalledTimes(2);
    // The capacity is per caller.
    expect(await calls.run(B, 'handoff', handoffArgs, 'r3', live())).toMatchObject({ result: { status: 'accepted' } });
  });

  // Review r1 P1-2: with the capacity taken by calls in progress, a new call ran untracked, twice.
  it('refuses new calls while the capacity is taken by calls in progress, and shutdown covers those', async () => {
    const signals: AbortSignal[] = [];
    const handoff = vi.fn<McpToolHandlers['handoff']>((_input, ctx) => {
      signals.push(ctx.signal);
      return new Promise<never>(() => {});
    });
    const calls = new CallRunner({ handlers: makeHandlers({ handoff }), uuid: (() => { let n = 0; return () => `op-${++n}`; })(), maxCallsPerCaller: 2 });
    const one = calls.run(A, 'handoff', handoffArgs, 'r1', live());
    const two = calls.run(A, 'handoff', handoffArgs, 'r2', live());
    expect(await calls.run(A, 'handoff', handoffArgs, 'r3', live())).toEqual({ kind: 'refused' });
    expect(await calls.run(A, 'handoff', handoffArgs, 'r3', live())).toEqual({ kind: 'refused' });
    expect(handoff).toHaveBeenCalledTimes(2);
    expect(calls.inFlight).toBe(2);
    calls.shutdown();
    expect(await one).toMatchObject({ result: { rejection: { reason: 'shutting-down' } } });
    expect(await two).toMatchObject({ result: { rejection: { reason: 'shutting-down' } } });
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('drops a forgotten caller: its waiters stop, its handlers are aborted, other callers are untouched', async () => {
    const signals: AbortSignal[] = [];
    const wait_for_file = vi.fn<McpToolHandlers['wait_for_file']>((_input, ctx) => {
      signals.push(ctx.signal);
      return new Promise<never>(() => {});
    });
    const handlers = makeHandlers({ wait_for_file });
    const calls = runner(handlers);
    await calls.run(A, 'handoff', handoffArgs, 'r1', live());
    const waitingA = calls.run(A, 'wait_for_file', { path: 'a' }, 'r2', live());
    const waitingB = calls.run(B, 'wait_for_file', { path: 'a' }, 'r2', live());
    calls.forget(A);
    expect(await waitingA).toEqual({ kind: 'failed' });
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    calls.shutdown();
    expect(await waitingB).toMatchObject({ result: { rejection: { reason: 'shutting-down' } } });
  });
});

describe('sourceCallRefOf', () => {
  it('prefers the native tool-call ID and falls back to the MCP session and request ID', () => {
    expect(sourceCallRefOf({ 'claudecode/toolUseId': 'toolu_1' }, { mcpSessionId: 's', requestId: 3 })).toBe('meta:claudecode/toolUseId:toolu_1');
    expect(sourceCallRefOf({ progressToken: 1, callId: 'call_1', itemId: 'i' }, { mcpSessionId: 's', requestId: 3 })).toBe('meta:callId:call_1');
    expect(sourceCallRefOf(undefined, { mcpSessionId: 's', requestId: 3 })).toBe('rpc:s:3');
    expect(sourceCallRefOf({ other: 1 }, { mcpSessionId: 's', requestId: '3' })).toBe('rpc:s:"3"');
  });
});

describe('SessionTokens', () => {
  it('maps each token to its session only, and replaces a session token on reissue', () => {
    const tokens = new SessionTokens();
    const a = tokens.issue(A);
    const b = tokens.issue(B);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    const grantA = tokens.resolve(a);
    expect(grantA?.sessionId).toBe(A);
    expect(tokens.resolve(b)?.sessionId).toBe(B);
    expect(tokens.resolve(`${a}x`)).toBeUndefined();
    expect(tokens.resolve(undefined)).toBeUndefined();
    expect(tokens.resolve('x'.repeat(10_000))).toBeUndefined();
    const a2 = tokens.issue(A);
    expect(tokens.resolve(a)).toBeUndefined();
    const grantA2 = tokens.resolve(a2);
    expect(grantA2?.sessionId).toBe(A);
    // The same session's later token is another generation: what was bound to the first is not current.
    expect(grantA2?.generation).not.toBe(grantA?.generation);
    expect(tokens.isCurrent(grantA!)).toBe(false);
    expect(tokens.isCurrent(grantA2!)).toBe(true);
    expect(tokens.revoke(A)).toBe(true);
    expect(tokens.resolve(a2)).toBeUndefined();
    expect(tokens.isCurrent(grantA2!)).toBe(false);
    expect(tokens.revoke(A)).toBe(false);
  });

  it('reads only a well-formed bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

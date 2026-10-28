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
    const cycle = await calls.run(A, 'create_tasks', { tasks: [{ key: 'a', title: 't', dependsOn: ['a'] }] }, 'meta:x:2', live());
    expect(cycle).toMatchObject({ result: { rejection: { reason: 'invalid-input' } } });
    expect(JSON.stringify(cycle)).toContain('tasks.0.dependsOn: a task depends on itself');
    expect(handlers.handoff).not.toHaveBeenCalled();
    expect(handlers.create_tasks).not.toHaveBeenCalled();
  });

  it('does not keep a failed or invalid answer, so a resend runs again with the same operationId', async () => {
    const log = vi.fn();
    const handoff = vi
      .fn<McpToolHandlers['handoff']>()
      .mockRejectedValueOnce(new Error('store down: token=abc'))
      .mockResolvedValueOnce({ status: 'bogus' } as unknown as HandoffToolResult)
      .mockImplementationOnce((_input, ctx) => Promise.resolve(accepted(ctx)));
    const calls = runner(makeHandlers({ handoff }), log);
    expect(await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live())).toEqual({ kind: 'failed' });
    expect(await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live())).toEqual({ kind: 'failed' });
    expect(await calls.run(A, 'handoff', handoffArgs, 'meta:x:1', live())).toMatchObject({ result: { status: 'accepted', operationId: 'op-1' } });
    expect(handoff.mock.calls.map((c) => c[1].operationId)).toEqual(['op-1', 'op-1', 'op-1']);
    expect(log.mock.calls.join('\n')).not.toContain('token=abc');
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

  it('aborts the handler once every request waiting for it is cancelled', async () => {
    let seen: AbortSignal | undefined;
    const calls = runner(
      makeHandlers({
        wait_for_file: vi.fn<McpToolHandlers['wait_for_file']>((_input, ctx) => {
          seen = ctx.signal;
          return new Promise<never>(() => {});
        }),
      }),
    );
    const one = new AbortController();
    const two = new AbortController();
    const first = calls.run(A, 'wait_for_file', { path: 'a.txt' }, 'meta:x:1', one.signal);
    const resend = calls.run(A, 'wait_for_file', { path: 'a.txt' }, 'meta:x:1', two.signal);
    await Promise.resolve();
    one.abort();
    expect(await first).toEqual({ kind: 'failed' });
    expect(seen?.aborted).toBe(false);
    two.abort();
    expect(await resend).toEqual({ kind: 'failed' });
    expect(seen?.aborted).toBe(true);
  });

  it('forgets the oldest finished calls beyond its limit', async () => {
    const handlers = makeHandlers();
    const calls = new CallRunner({ handlers, uuid: (() => { let n = 0; return () => `op-${++n}`; })(), maxEntries: 2 });
    for (const ref of ['r1', 'r2', 'r3']) await calls.run(A, 'report_to_root', { content: ref }, ref, live());
    await calls.run(A, 'report_to_root', { content: 'r3' }, 'r3', live());
    expect(handlers.report_to_root).toHaveBeenCalledTimes(3);
    await calls.run(A, 'report_to_root', { content: 'r1' }, 'r1', live());
    expect(handlers.report_to_root).toHaveBeenCalledTimes(4);
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
    expect(tokens.resolve(a)).toBe(A);
    expect(tokens.resolve(b)).toBe(B);
    expect(tokens.resolve(`${a}x`)).toBeUndefined();
    expect(tokens.resolve(undefined)).toBeUndefined();
    expect(tokens.resolve('x'.repeat(10_000))).toBeUndefined();
    const a2 = tokens.issue(A);
    expect(tokens.resolve(a)).toBeUndefined();
    expect(tokens.resolve(a2)).toBe(A);
    expect(tokens.revoke(A)).toBe(true);
    expect(tokens.resolve(a2)).toBeUndefined();
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

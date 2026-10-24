// Scenarios no spike recorded (reroute, permission grants, withdrawn requests, crashes of the handler),
// scripted with the protocol 0.160.0 shapes on top of the SP-01 handshake.
import { describe, expect, it } from 'vitest';
import { EscalationId } from '../../contracts';
import { FakeAppServer, loadFixture, notify, out, outResponse, recordedResult, reply, type ReplayRecord, serverRequest } from './testing/fake-app-server';
import { CodexAdapter, type PermissionHandle } from './adapter';
import { expectValidEvents, SESSION, setup, until } from './testing/harness';

const sp01 = loadFixture('sp01-create.jsonl');
const THREAD_ID = '01a16795-2bff-74f2-9fd1-6198ee6b4ee7';
const TURN_ID = '01a16795-3172-7802-a04e-3b9e5974a6f9';
const AT = '2026-10-24T12:00:00.000Z';

const handshake = (): ReplayRecord[] => [
  out('initialize', 1),
  reply(1, recordedResult(sp01, 'initialize')),
  out('initialized'),
  out('thread/resume', 2),
  reply(2, recordedResult(sp01, 'thread/start')),
];

const started = async (records: ReplayRecord[], options: Parameters<typeof setup>[1] = {}) => {
  const h = setup([...handshake(), ...records], options);
  await h.adapter.start();
  await h.adapter.resumeThread({ sessionId: SESSION, threadId: THREAD_ID });
  return h;
};

const turnStarted = notify('turn/started', {
  threadId: THREAD_ID,
  turn: { id: TURN_ID, items: [], status: 'inProgress', error: null, startedAt: 1792739193, completedAt: null },
});
const turnCompleted = (status: string) =>
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: TURN_ID, items: [], status, error: null, startedAt: 1792739193, completedAt: 1792739196 } });

describe('model reroute and limits', () => {
  it('reports model/rerouted as an observed reroute and maps only the weekly limit window', async () => {
    const h = await started([
      turnStarted,
      notify('model/rerouted', { threadId: THREAD_ID, turnId: TURN_ID, fromModel: 'gpt-6-luna', toModel: 'gpt-6-safe', reason: 'highRiskCyberActivity' }),
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793293777 }, secondary: null } }),
      notify('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1793293777 }, secondary: null } }),
    ]);
    await until(() => h.fake.finished && h.of('usage.limits').length === 1, 'notifications');
    expect(h.of('model.observed')).toEqual([
      { type: 'model.observed', sessionId: SESSION, observed: { source: 'rerouted', from: 'gpt-6-luna', to: 'gpt-6-safe', reason: 'highRiskCyberActivity', observedAt: AT } },
    ]);
    expect(h.of('usage.limits')[0]).toMatchObject({ codexWeekly: { percentUsed: 12.5, resetsAt: new Date(1793293777000).toISOString() } });
    expectValidEvents(h.events);
  });
});

describe('permission requests', () => {
  const permissionsParams = {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId: 'perm-item',
    environmentId: 'local',
    startedAtMs: 1792739195000,
    cwd: 'E:\\work\\task',
    reason: 'needs network to fetch dependencies',
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['E:\\work\\cache'] } },
  };

  it('grants the requested permission profile for the session on approve-for-session', async () => {
    const h = await started([turnStarted, serverRequest(7, 'item/permissions/requestApproval', permissionsParams), outResponse(7)]);
    await until(() => h.permissions.length === 1, 'request');
    expect(h.permissions[0]!.request).toMatchObject({ kind: 'permissions', paths: ['E:\\work\\cache'], summary: 'needs network to fetch dependencies', turnId: TURN_ID });
    h.permissions[0]!.answer({ outcome: 'approve-for-session', decidedBy: 'user', escalationId: EscalationId.parse('esc-1'), at: AT });
    expect(h.fake.received.at(-1)).toEqual({
      id: 7,
      result: { permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['E:\\work\\cache'] } }, scope: 'session' },
    });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });

  it('withdraws a held request when the runtime resolves it, and drops a late answer', async () => {
    let handle: PermissionHandle | undefined;
    const h = await started(
      [turnStarted, serverRequest(8, 'item/permissions/requestApproval', permissionsParams), notify('serverRequest/resolved', { threadId: THREAD_ID, requestId: 8 })],
      {
        onPermissionRequest: (request) => {
          handle = request;
          request.hold({ reason: 'awaiting-user', escalationId: EscalationId.parse('esc-2') });
        },
      },
    );
    await until(() => h.of('permission.updated').at(-1)?.request.state === 'withdrawn', 'withdrawn');
    expect(h.of('permission.updated').map((e) => e.request.state)).toEqual(['pending', 'held', 'withdrawn']);
    expect(h.of('permission.updated').at(-1)!.request.hold).toBeUndefined();
    expect(handle!.answer({ outcome: 'decline', decidedBy: 'policy', at: AT })).toBe(false);
    expect(h.fake.received.some((m) => m.id === 8 && m.method === undefined)).toBe(false);
    expect(h.adapter.openPermissions()).toEqual([]);
    expectValidEvents(h.events);
  });

  it('withdraws requests still open when their turn ends', async () => {
    const h = await started([
      turnStarted,
      serverRequest(9, 'item/commandExecution/requestApproval', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-9', startedAtMs: 1, command: 'ls', cwd: 'E:\\w' }),
      turnCompleted('interrupted'),
    ]);
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'interrupted'), 'turn end');
    expect(h.of('permission.updated').at(-1)!.request.state).toBe('withdrawn');
  });

  it('maps a URL elicitation and answers cancel', async () => {
    const h = await started([
      serverRequest(10, 'mcpServer/elicitation/request', {
        threadId: THREAD_ID,
        turnId: null,
        serverName: 'docs',
        mode: 'url',
        _meta: null,
        message: 'Sign in to continue',
        url: 'https://example.com/login',
        elicitationId: 'el-1',
      }),
      outResponse(10),
    ]);
    await until(() => h.permissions.length === 1, 'elicitation');
    expect(h.permissions[0]!.request).toMatchObject({ kind: 'mcpElicitation', elicitation: { mode: 'url', url: 'https://example.com/login', elicitationId: 'el-1' } });
    expect(h.permissions[0]!.request.turnId).toBeUndefined();
    h.permissions[0]!.answer({ outcome: 'cancel', decidedBy: 'policy', at: AT });
    expect(h.fake.received.at(-1)).toEqual({ id: 10, result: { action: 'cancel', content: null, _meta: null } });
  });

  it('declines without asking when the thread is not bound, and fails closed when the handler throws', async () => {
    const h = await started(
      [
        serverRequest(11, 'item/commandExecution/requestApproval', { threadId: 'someone-else', turnId: 't', itemId: 'x', startedAtMs: 1, command: 'ls', cwd: 'E:\\w' }),
        outResponse(11),
        serverRequest(12, 'item/fileChange/requestApproval', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'patch-1', startedAtMs: 1, reason: null, grantRoot: null }),
        outResponse(12),
      ],
      {
        onPermissionRequest: () => {
          throw new Error('policy module crashed');
        },
      },
    );
    await until(() => h.fake.finished, 'script');
    await h.fake.idle();
    expect(h.fake.received.filter((m) => m.method === undefined && m.id !== undefined && m.result !== undefined).slice(-2)).toEqual([
      { id: 11, result: { decision: 'decline' } },
      { id: 12, result: { decision: 'decline' } },
    ]);
    expect(h.of('permission.updated').at(-1)!.request).toMatchObject({ kind: 'fileChange', state: 'answered', decision: { outcome: 'decline', decidedBy: 'policy' } });
    expect(h.fake.mismatches).toEqual([]);
  });

  it('answers server requests it does not support with a JSON-RPC error instead of leaving them hanging', async () => {
    const h = await started([serverRequest(13, 'item/tool/requestUserInput', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'q', questions: [], isBlocking: true }), outResponse(13)]);
    await until(() => h.fake.finished, 'script');
    await h.fake.idle();
    expect(h.fake.received.at(-1)).toMatchObject({ id: 13, error: { code: -32601 } });
    expect(h.permissions).toHaveLength(0);
  });
});

describe('command output', () => {
  it('keeps only the tail of long output and marks it truncated', async () => {
    const command = { type: 'commandExecution', id: 'exec-long', command: 'build', cwd: 'E:\\w', processId: null, status: 'inProgress', aggregatedOutput: null, exitCode: null };
    const h = await started(
      [
        turnStarted,
        notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1792739195000, item: command }),
        notify('item/commandExecution/outputDelta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-long', delta: '0123456789' }),
        notify('item/commandExecution/outputDelta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-long', delta: 'abcdef' }),
        notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1792739196000, item: { ...command, status: 'completed', exitCode: 0 } }),
      ],
      { maxOutputChars: 8 },
    );
    await until(() => h.of('item.updated').length === 2, 'item');
    expect(h.of('item.outputDelta').map((e) => e.delta)).toEqual(['0123456789', 'abcdef']);
    expect(h.of('item.updated')[1]!.item).toMatchObject({ state: 'completed', output: '89abcdef', outputTruncated: true, exitCode: 0, endedAt: new Date(1792739196000).toISOString() });
    expectValidEvents(h.events);
  });
});

describe('shutdown', () => {
  it('kills the app-server when it does not exit after stdin closes', async () => {
    const fake = new FakeAppServer([out('initialize', 1), reply(1, recordedResult(sp01, 'initialize')), out('initialized')], { exitOnStdinEnd: false });
    const adapter = new CodexAdapter({ spawn: () => fake, onPermissionRequest: () => undefined });
    await adapter.start();
    expect(await adapter.close(20)).toMatchObject({ forced: true, signal: 'SIGTERM' });
    expect(adapter.running).toBe(false);
  });

  it('rejects start when the process cannot be spawned', async () => {
    const adapter = new CodexAdapter({ spawnOptions: { command: 'definitely-not-codex-awg-test' }, onPermissionRequest: () => undefined });
    await expect(adapter.start()).rejects.toThrow(/connection closed/);
    expect(adapter.running).toBe(false);
  });
});

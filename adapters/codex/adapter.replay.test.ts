// Replays app-server conversations recorded by the spikes (fixtures/*.jsonl, Codex CLI 0.160.0).
import { describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, ModelOption, SessionId } from '../../contracts';
import { ISOLATION_CONFIG } from './protocol';
import { RpcError } from './rpc';
import { loadFixture, recordedText } from './testing/fake-app-server';
import { expectValidEvents, SESSION, sentParams, setup, until } from './testing/harness';

const decide = (outcome: 'approve' | 'decline') => ({ outcome, decidedBy: 'policy' as const, at: '2026-10-24T12:00:00.000Z' });

describe('lifecycle and streaming (SP-01)', () => {
  it('initializes, starts a policy-isolated thread, streams two turns and closes by ending stdin', async () => {
    const rec = loadFixture('sp01-create.jsonl');
    const h = setup(rec);
    const init = await h.adapter.start();
    expect(init.userAgent).toContain('0.160.0');
    expect(h.fake.received.slice(0, 2).map((m) => m.method)).toEqual(['initialize', 'initialized']);

    const info = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\task' });
    expect(info.threadId).toBe('01a16795-2bff-74f2-9fd1-6198ee6b4ee7');
    expect(info.configuredModel).toMatchObject({ source: 'configured', model: 'gpt-6-luna' });
    expect(info.rolloutPath).toMatch(/rollout-.*\.jsonl$/);
    // R-08 policy and SP-04 isolation; never ephemeral, because CR-2 reconciliation reads the history.
    expect(sentParams(h.fake, 'thread/start')).toEqual({
      cwd: 'E:\\work\\task',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      ephemeral: false,
      sandbox: 'workspace-write',
      config: ISOLATION_CONFIG,
    });

    const turn1 = await h.adapter.startTurn({ threadId: info.threadId, text: recordedText(rec, 'turn/start', 0), effort: 'low' });
    expect(turn1).toMatchObject({ sessionId: SESSION, state: 'running' });
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'first turn');
    await h.adapter.startTurn({ threadId: info.threadId, text: recordedText(rec, 'turn/start', 1) });
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 2, 'second turn');

    expect(h.of('message.delta').map((e) => e.delta)).toEqual(['OK', '8']);
    const messages = h.of('message.completed').map((e) => [e.message.role, e.message.text]);
    expect(messages).toEqual([
      ['user', 'Remember the number 7. Reply with only: OK'],
      ['assistant', 'OK'],
      ['user', 'What number did I ask you to remember? Reply with only that number plus 1.'],
      ['assistant', '8'],
    ]);
    expect(h.of('turn.updated').map((e) => e.turn.state)).toEqual(['running', 'completed', 'running', 'completed']);

    // `last` is this call, `total` the running sum; the total is never added up again (HC-20).
    const usage = h.of('usage.tokens').at(-1)!.usage;
    expect(usage.latest).toMatchObject({ input: 16749, cachedInput: 16512, output: 5, total: 16754 });
    expect(usage.cumulative).toMatchObject({ input: 33469, output: 10, total: 33479 });
    expect(usage.contextWindow).toBe(258400);
    expect(h.of('usage.limits').at(-1)).toMatchObject({ codexWeekly: { percentUsed: 7 } });

    const exit = await h.adapter.close();
    expect(exit).toMatchObject({ code: 0, forced: false });
    expect(h.of('runtime.exited')).toEqual([expect.objectContaining({ expected: true, code: 0 })]);
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });

  it('surfaces the runtime error when resuming a thread that does not exist', async () => {
    const rec = loadFixture('sp01-bogus-resume.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const error: unknown = await h.adapter.resumeThread({ sessionId: SESSION, threadId: '1f5dd9ca-61b9-40a3-887c-47c6f52728c5' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-32600);
    expect(sentParams(h.fake, 'thread/resume')).toMatchObject({ excludeTurns: true, approvalPolicy: 'untrusted', config: ISOLATION_CONFIG });
  });
});

describe('approvals, steer and elicitation (SP-05)', () => {
  it('holds a command approval until the upper layer answers, then steers and answers an MCP elicitation', async () => {
    const rec = loadFixture('sp05-busy-steer.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const { threadId } = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\task' });
    const turn = await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 0) });

    await until(() => h.permissions.length === 1, 'command approval');
    const command = h.permissions[0]!;
    expect(command.request).toMatchObject({ kind: 'command', state: 'pending', turnId: turn.id, itemId: expect.stringMatching(/^exec-/) as unknown });
    expect(command.request.command).toContain('Start-Sleep -Seconds 20');
    const running = h.of('item.updated').at(-1)!.item;
    expect(running).toMatchObject({ kind: 'command', state: 'running' });

    // R-07: the answer may wait. The runtime keeps waiting for us; nothing is sent while held.
    expect(command.hold({ reason: 'file-lock', until: '2026-10-24T12:00:09.000Z', lockPath: 'E:\\work\\task\\a.txt' })).toBe(true);
    expect(h.of('permission.updated').at(-1)!.request.state).toBe('held');
    await h.fake.idle();
    expect(h.fake.expecting).toMatchObject({ id: 0 });
    expect(h.fake.received.some((m) => m.id === 0 && m.method === undefined)).toBe(false);
    expect(command.answer(decide('approve'))).toBe(true);
    expect(command.answer(decide('approve'))).toBe(false);
    expect(h.of('permission.updated').at(-1)!.request).toMatchObject({ state: 'answered', decision: { outcome: 'approve' } });
    expect(h.of('permission.updated').at(-1)!.request.hold).toBeUndefined();
    expect(h.fake.received.find((m) => m.id === 0 && m.method === undefined)).toEqual({ id: 0, result: { decision: 'accept' } });

    // A busy-session message goes into the running turn (SP-05), as a CR-2 dispatch.
    await h.fake.idle();
    const steer = await h.adapter.dispatchOnce({
      threadId,
      attempt: {
        state: 'unknown',
        attemptId: AttemptId.parse('attempt-1'),
        clientMessageId: ClientMessageId.parse('0b6c3c2e-7f43-4a55-9d7e-4f0c0a7f2b11'),
        dispatchStartedAt: '2026-10-24T12:00:00.000Z',
      },
      text: recordedText(rec, 'turn/steer', 0),
      entry: { kind: 'insert', expectedTurnId: turn.id },
    });
    expect(steer).toMatchObject({ state: 'sent', nativeRef: { sessionRef: threadId, turnRef: turn.id }, evidence: { kind: 'live-ack' } });
    expect(sentParams(h.fake, 'turn/steer')).toMatchObject({ expectedTurnId: turn.id, clientUserMessageId: '0b6c3c2e-7f43-4a55-9d7e-4f0c0a7f2b11' });

    await until(() => h.permissions.length === 2, 'elicitation');
    const elicitation = h.permissions[1]!;
    expect(elicitation.request).toMatchObject({ kind: 'mcpElicitation', elicitation: { mode: 'form', serverName: 'gui' } });
    elicitation.answer(decide('approve'));
    expect(h.fake.received.find((m) => m.id === 1 && m.method === undefined)).toEqual({ id: 1, result: { action: 'accept', content: null, _meta: null } });

    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'first turn end');
    const tool = h.of('item.updated').filter((e) => e.item.kind === 'toolCall').at(-1)!.item;
    expect(tool).toMatchObject({ kind: 'toolCall', tool: 'send_message', server: 'gui', state: 'failed' });
    const done = h.of('item.updated').filter((e) => e.item.kind === 'command').at(-1)!.item;
    expect(done).toMatchObject({ state: 'completed', exitCode: 0 });
    expect(h.of('message.completed').map((e) => e.message.text)).toContain('DONE-SLEEP STEER-OK');

    // Second turn plus a queued message delivered as a new turn once the target is idle.
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 1) });
    await until(() => h.permissions.length === 3, 'second approval');
    h.permissions[2]!.answer(decide('approve'));
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 2, 'second turn end');
    const queued = await h.adapter.dispatchOnce({
      threadId,
      attempt: {
        state: 'unknown',
        attemptId: AttemptId.parse('attempt-2'),
        clientMessageId: ClientMessageId.parse('5f1d0e65-3d0a-4c1b-8c55-2d7a7f6f1e02'),
        dispatchStartedAt: '2026-10-24T12:00:00.000Z',
      },
      text: recordedText(rec, 'turn/start', 2),
      entry: { kind: 'new-turn' },
    });
    expect(queued).toMatchObject({ state: 'sent', nativeRef: { sessionRef: threadId }, evidence: { kind: 'live-ack' } });
    await until(() => h.permissions.length === 4, 'queued turn elicitation');
    h.permissions[3]!.answer(decide('approve'));
    expect(h.fake.received.find((m) => m.id === 3 && m.method === undefined)).toEqual({ id: 3, result: { action: 'accept', content: null, _meta: null } });
    await until(() => h.fake.finished, 'script end');
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 3, 'third turn end');

    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});

describe('file changes (SP-06)', () => {
  it('passes the patch paths announced by item/started with the approval request', async () => {
    const rec = loadFixture('sp06-file-change.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const { threadId } = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\shared' });
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 0) });
    await until(() => h.permissions.length === 1, 'file change approval');
    const request = h.permissions[0]!.request;
    expect(request).toMatchObject({ kind: 'fileChange', paths: [expect.stringMatching(/shared\.txt$/) as unknown] });
    const proposed = h.of('item.updated').at(-1)!.item;
    expect(proposed).toMatchObject({ kind: 'fileChange', state: 'proposed', changes: [{ change: 'update' }] });
    expect(proposed.endedAt).toBeUndefined();

    h.permissions[0]!.answer(decide('approve'));
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'turn end');
    const applied = h.of('item.updated').filter((e) => e.item.kind === 'fileChange').at(-1)!.item;
    expect(applied).toMatchObject({ state: 'applied', diff: expect.stringContaining('+line 1 edited by B') as unknown });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});

describe('interrupt (SP-08)', () => {
  it('reports the interrupted turn and closes the command Codex left open', async () => {
    const rec = loadFixture('sp08-interrupt.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const { threadId } = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\task' });
    const turn = await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 0) });
    await until(() => h.permissions.length === 1, 'approval');
    h.permissions[0]!.answer(decide('approve'));
    await h.fake.idle();

    const read = await h.adapter.readThread(threadId, { includeTurns: true });
    expect(read.turns.map((t) => t.state)).toEqual(['running']);
    await h.adapter.interruptTurn(threadId, turn.id);
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'interrupted'), 'interrupted turn');

    const command = h.of('item.updated').filter((e) => e.item.kind === 'command').at(-1)!.item;
    expect(command).toMatchObject({ state: 'interrupted', endedAt: expect.any(String) as unknown });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});

describe('native sub-agents (SP-03)', () => {
  it('binds child threads to the session as native tasks and keeps their turns and tokens out of the session', async () => {
    const rec = loadFixture('sp03-subagents.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const { threadId } = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\task' });
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 0) });
    await until(() => h.permissions.length === 1, 'first child approval');
    expect(h.permissions[0]!.request.nativeTaskId).toBe('01a167fc-e864-7db0-917f-fc6f6164bc7d');
    expect(h.permissions[0]!.request.turnId).toBeUndefined();
    h.permissions[0]!.answer(decide('approve'));
    await until(() => h.permissions.length === 2, 'second child approval');
    h.permissions[1]!.answer(decide('approve'));
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'parent turn end');

    const tasks = h.of('nativeTask.updated').map((e) => [e.task.label, e.task.state]);
    expect(tasks).toEqual([
      ['/root/read_a', 'running'],
      ['/root/read_b', 'running'],
      ['/root/read_a', 'completed'],
      ['/root/read_b', 'completed'],
    ]);
    expect(h.of('turn.updated').every((e) => e.turn.id === h.of('turn.updated')[0]!.turn.id)).toBe(true);
    const childItems = h.of('item.updated').map((e) => e.item);
    expect(childItems.length).toBeGreaterThan(0);
    expect(childItems.every((i) => i.nativeTaskId !== undefined && i.turnId === undefined)).toBe(true);
    const childAnswer = h.of('message.completed').find((e) => e.message.text.includes('HERON') && e.message.nativeTaskId !== undefined);
    expect(childAnswer?.message.role).toBe('assistant');
    expect(h.of('usage.tokens').every((e) => e.usage.turnId === undefined || e.usage.turnId === h.of('turn.updated')[0]!.turn.id)).toBe(true);

    expect(await h.adapter.listLoadedThreads()).toHaveLength(3);

    // Stopping one sub-agent is turn/interrupt on its own thread (R-13).
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 1) });
    await until(() => h.permissions.length === 3, 'third child approval');
    const child = h.permissions[2]!.request;
    h.permissions[2]!.answer(decide('approve'));
    await h.fake.idle();
    const childTask = h.of('nativeTask.updated').at(-1)!.task;
    expect(childTask.nativeRef).toBe(child.nativeTaskId);
    await h.adapter.interruptTurn(childTask.nativeRef, '01a167fd-0f09-7f10-b499-85674fe07a1c');
    await until(() => h.fake.finished, 'script end');
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 2, 'parent turn end');
    // Review r1 P1-4: the interrupted child turn ends the task; no subAgentActivity follows it.
    const slow = h.of('nativeTask.updated').filter((e) => e.task.nativeRef === childTask.nativeRef);
    expect(slow.map((e) => e.task.state)).toEqual(['running', 'stopped']);
    expect(slow.at(-1)!.task).toMatchObject({ label: '/root/slow_command', lastActivity: 'turn interrupted', endedAt: expect.any(String) as unknown });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});

describe('models (SP-02)', () => {
  it('lists models, records the requested model per turn, reads the configured model and reports a failed turn', async () => {
    const rec = loadFixture('sp02-models.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const models = await h.adapter.listModels();
    expect(models.length).toBeGreaterThan(1);
    for (const m of models) ModelOption.parse(m);
    expect(models.find((m) => m.model === 'gpt-6.1-sol')).toMatchObject({ displayName: 'GPT-6.1-Sol', efforts: expect.arrayContaining(['low', 'high']) as unknown });
    expect(sentParams(h.fake, 'model/list')).toEqual({ includeHidden: true });

    const { threadId } = await h.adapter.startThread({ sessionId: SESSION, cwd: 'E:\\work\\task' });
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 0), effort: 'low' });
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 1, 'turn 1');
    await h.adapter.readThread(threadId);

    const switched = await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 1), model: 'gpt-6.1-sol', effort: 'low' });
    expect(switched.requestedModel).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 2, 'turn 2');
    expect(h.of('turn.updated').filter((e) => e.turn.id === switched.id).map((e) => e.turn.requestedModel?.model)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    const read = await h.adapter.readThread(threadId);
    expect(read.configuredModel).toMatchObject({ source: 'configured' });

    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 2) });
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 3, 'turn 3');
    await h.adapter.readThread(threadId);
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 3), model: 'gpt-nonexistent-xyz' });
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'failed'), 'failed turn');
    const failed = h.of('turn.updated').find((e) => e.turn.state === 'failed')!.turn;
    expect(failed.failure?.message).toContain('gpt-nonexistent-xyz');
    await h.adapter.startTurn({ threadId, text: recordedText(rec, 'turn/start', 4), model: 'gpt-6-luna' });
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 4, 'recovered turn');
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });

  it('resumes a closed thread with a new model', async () => {
    const rec = loadFixture('sp02-resume-model.jsonl');
    const h = setup(rec);
    await h.adapter.start();
    const other = SessionId.parse('session-b');
    const info = await h.adapter.resumeThread({ sessionId: other, threadId: '01a167fa-2bf2-7532-89f8-8abc59fc4ac7', model: 'gpt-6.1-sol' });
    expect(sentParams(h.fake, 'thread/resume')).toMatchObject({ threadId: info.threadId, model: 'gpt-6.1-sol', excludeTurns: true });
    expect(info).toMatchObject({ sessionId: other, configuredModel: { source: 'configured', model: 'gpt-6.1-sol' } });
    await h.adapter.startTurn({ threadId: info.threadId, text: recordedText(rec, 'turn/start', 0) });
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'turn');
    expect(h.of('message.completed').at(-1)!.message).toMatchObject({ sessionId: other, text: '7' });
    expect(h.fake.mismatches).toEqual([]);
    expectValidEvents(h.events);
  });
});

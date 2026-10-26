// Replays SDK messages recorded by the spikes (fixtures/*.jsonl, SDK 0.3.309 / Claude Code 2.1.309).
import { describe, expect, it } from 'vitest';
import { expectValidEvents, loadMessages, REF, SESSION, settle, started, turnsOf, until } from './testing/harness';
import type { WireQueryOptions } from './wire';

describe('process (T013, R-14)', () => {
  it('starts each session’s claude.exe through the injected spawn, so it runs in the session’s Job', async () => {
    const asked: unknown[] = [];
    const spawn: NonNullable<WireQueryOptions['spawnClaudeCodeProcess']> = () => {
      throw new Error('not started in this test');
    };
    const h = await started({ spawnProcess: (info) => (asked.push(info), spawn) });
    expect(h.sdk.last.options.spawnClaudeCodeProcess).toBe(spawn);
    expect(asked).toEqual([{ sessionId: SESSION }]);
  });
});

describe('streaming turns (SP-01)', () => {
  it('opens a policy-isolated session, streams two turns and closes by interrupting first', async () => {
    const h = await started({ mcpServers: ({ sessionId }) => ({ gui: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: `Bearer ${sessionId}` } } }) });
    const q = h.sdk.last;
    // R-08 and SP-04: hook-based permissions, no settings files, no account connectors, only the GUI MCP.
    expect(q.options).toMatchObject({
      cwd: 'E:\\work\\task-1',
      sessionId: REF,
      model: 'haiku',
      settingSources: [],
      settings: { disableClaudeAiConnectors: true },
      strictMcpConfig: true,
      mcpServers: { gui: { type: 'http' } },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      persistSession: true,
    });
    expect(q.options.resume).toBeUndefined();
    expect(q.options.disallowedTools).toBeUndefined();
    expect(q.options.hooks.PreToolUse[0]?.timeout).toBe(7 * 24 * 3600);

    q.emit(...loadMessages('sp01-live.jsonl'));
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 2, 'two turns');

    expect(h.of('turn.updated').map((e) => e.turn.state)).toEqual(['running', 'completed', 'running', 'completed']);
    expect(h.of('session.activity').map((e) => e.activity)).toEqual(['running', 'idle', 'running', 'idle']);
    expect(h.of('message.delta').map((e) => e.delta)).toEqual(['O', 'K', '5']);
    expect(h.of('message.delta')[0]).toMatchObject({ messageId: 'msg_011CgJk9iVF2DWJUW7xnmfHu', turnId: h.of('turn.updated')[0]!.turn.id });
    expect(h.of('message.completed').map((e) => [e.message.id, e.message.text, e.message.observedModel])).toEqual([
      ['msg_011CgJk9iVF2DWJUW7xnmfHu', 'OK', 'claude-haiku-5-5'],
      ['msg_011CgJk9xzcbk9WX9GvEgiyP', '5', 'claude-haiku-5-5'],
    ]);
    // R-12: the model of each reply, reported once while it does not change.
    expect(h.of('model.observed').map((e) => e.observed)).toEqual([{ source: 'per-message', model: 'claude-haiku-5-5', observedAt: '2026-10-25T12:00:00.000Z' }]);

    // `latest` is one model call (the API message, final counts from message_delta); `cumulative` sums
    // result.modelUsage, which already runs across turns.
    const usage = h.of('usage.tokens').map((e) => e.usage);
    expect(usage.map((x) => [x.latest ? 'latest' : 'cumulative', x.turnId])).toEqual([
      ['latest', h.of('turn.updated')[0]!.turn.id],
      ['cumulative', h.of('turn.updated')[0]!.turn.id],
      ['latest', h.of('turn.updated')[2]!.turn.id],
      ['cumulative', h.of('turn.updated')[2]!.turn.id],
    ]);
    expect(usage[0]!.latest).toEqual({ input: 2 + 1883 + 2643, cachedInput: 2643, output: 4, reasoningOutput: 0, total: 4532 });
    expect(usage[1]).toMatchObject({ contextWindow: 1_000_000 });
    expect(usage[3]!.cumulative).toEqual({ input: 4 + 5548 + 3557, cachedInput: 5548, output: 7, reasoningOutput: 0, total: 9116 });
    expect(h.of('usage.limits')[0]).toMatchObject({ claude5h: { percentUsed: 16, resetsAt: '2026-10-23T10:20:00.000Z' }, claudeWeekly: { percentUsed: 2 } });

    expect(await h.adapter.close()).toEqual({ forced: false });
    // R-14: interrupt() before close(); close alone leaves claude.exe running (SP-08).
    expect(q.calls.filter((c) => c === 'interrupt' || c === 'close')).toEqual(['interrupt', 'close']);
    expect(h.of('runtime.exited')).toEqual([expect.objectContaining({ runtime: 'claude', sessionIds: ['session-a'], expected: true })]);
    expect(h.of('session.activity').at(-1)!.activity).toBe('closed');
    expectValidEvents(h.events);
  });
});

describe('models (SP-02, R-12)', () => {
  it('reports the model of every reply, also when it changes inside a turn', async () => {
    const h = await started();
    h.sdk.last.emit(...loadMessages('sp02-models.jsonl'));
    await until(() => h.of('turn.updated').filter((e) => e.turn.state === 'completed').length === 4, 'four turns');

    expect(h.of('model.observed').map((e) => e.observed.source === 'per-message' && e.observed.model)).toEqual([
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(h.of('message.completed').map((e) => [e.message.text, e.message.observedModel])).toEqual([
      ['OK', 'claude-haiku-5-5'],
      ['7', 'claude-sonnet-5-5'],
      ['SLEPT', 'claude-haiku-5-5'],
      ['NEXT', 'claude-haiku-5-5'],
    ]);
    // The PowerShell call ran in the foreground; its `local_bash` task is not a native sub-agent.
    const command = h.of('item.updated').map((e) => e.item).filter((i) => i.kind === 'command');
    expect(command.map((i) => i.state)).toEqual(['running', 'completed']);
    expect(command[1]).toMatchObject({ command: 'Start-Sleep -Seconds 12', cwd: 'E:\\work\\task-1', output: '(PowerShell completed with no output)' });
    expect(h.of('nativeTask.updated')).toEqual([]);

    // Review r1 P1-4: the third turn made two model calls; `latest` reports each, not the turn's sum
    // (result.usage of that turn counts 64,265 input tokens; its last call read 32,306).
    const third = h.of('turn.updated').filter((e) => e.turn.state === 'completed')[2]!.turn.id;
    const calls = h.of('usage.tokens').filter((e) => e.usage.turnId === third && e.usage.latest).map((e) => e.usage.latest!.input);
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toBe(32_306);
    expectValidEvents(h.events);
  });

  it('fails the turn of an unknown model without taking <synthetic> as the model (R-12)', async () => {
    const h = await started();
    h.sdk.last.emit(...loadMessages('sp02-bad-model.jsonl'));
    await until(() => h.of('turn.updated').length === 2, 'turn end');
    const turn = h.of('turn.updated')[1]!.turn;
    expect(turn.state).toBe('failed');
    expect(turn.failure?.message).toContain('issue with the selected model');
    expect(h.of('model.observed')).toEqual([]);
    expect(h.of('message.completed')[0]!.message.observedModel).toBe('<synthetic>');
    expectValidEvents(h.events);
  });
});

describe('native sub-agents (SP-03, R-13)', () => {
  it('maps task events to native tasks, places their frames on the task, and shows the self-started turn (R-05)', async () => {
    const h = await started();
    h.sdk.last.emit(...loadMessages('sp03-subagents.jsonl'));
    await until(() => h.of('turn.updated').filter((e) => e.turn.state !== 'running').length === 4, 'four turns');
    await settle();

    const tasks = new Map(h.of('nativeTask.updated').map((e) => [e.task.nativeRef, e.task]));
    expect([...tasks.values()].map((t) => [t.nativeRef, t.label, t.agentType, t.state, t.background])).toEqual([
      ['ab136d00f928b2a8a', 'Summarize a.txt', 'researcher', 'completed', false],
      ['a4d8612ba8437fc81', 'Summarize b.txt', 'researcher', 'completed', false],
      ['a097110e26c651907', 'Run X sleep command', 'slowpoke', 'stopped', false],
      ['a90d827b1c02b3b15', 'Run Y sleep command', 'slowpoke', 'completed', false],
      ['a493644594a535e2d', 'Summarize a.txt in background', 'researcher', 'completed', true],
    ]);
    expect(tasks.get('ab136d00f928b2a8a')).toMatchObject({ parentRef: 'toolu_01BUpGMPYagYoq8bnR6TypPV', id: 'ab136d00f928b2a8a' });
    expect(tasks.get('ab136d00f928b2a8a')!.endedAt).toBeDefined();
    expect(tasks.get('a4d8612ba8437fc81')!.lastActivity).toContain('last tool: Read');

    // A sub-agent's calls and replies belong to its task, not to a session turn.
    const reads = h.of('item.updated').map((e) => e.item).filter((i) => i.kind === 'toolCall' && i.tool === 'Read' && i.endedAt);
    expect(reads.map((i) => [i.nativeTaskId, i.turnId, i.state])).toEqual([
      ['a4d8612ba8437fc81', undefined, 'completed'],
      ['ab136d00f928b2a8a', undefined, 'completed'],
      ['a493644594a535e2d', undefined, 'completed'],
    ]);
    const subReplies = h.of('message.completed').filter((e) => e.message.nativeTaskId === 'a493644594a535e2d');
    expect(subReplies.map((e) => e.message.role)).toEqual(['assistant']);
    // The blocked PowerShell calls of the slowpoke agents failed; the interrupted Agent call is interrupted-as-failed.
    const shells = h.of('item.updated').map((e) => e.item).filter((i) => i.kind === 'command' && i.endedAt);
    expect(shells.map((i) => [i.nativeTaskId, i.state])).toEqual([
      ['a097110e26c651907', 'failed'],
      ['a90d827b1c02b3b15', 'failed'],
    ]);

    // The fourth turn started without any dispatched payload: the background agent woke the session.
    const turns = h.of('turn.updated').filter((e) => e.turn.state === 'completed').map((e) => e.turn);
    expect(turns).toHaveLength(4);
    expect(new Set(turns.map((t) => t.id)).size).toBe(4);
    const last = h.of('message.completed').at(-1)!.message;
    expect(last).toMatchObject({ role: 'assistant', turnId: turns[3]!.id });
    expect(last.text).toContain('background summary');
    expectValidEvents(h.events);
  });

  it('stops one sub-agent with stopTask', async () => {
    const h = await started();
    await h.adapter.stopNativeTask(REF, 'a097110e26c651907');
    expect(h.sdk.last.stoppedTasks).toEqual(['a097110e26c651907']);
  });
});

describe('interrupt (SP-08, R-14)', () => {
  it('ends the turn as interrupted and the running command with it', async () => {
    const h = await started();
    const q = h.sdk.last;
    const [first, second] = turnsOf(loadMessages('sp08-interrupt.jsonl'));
    const cut = first!.findIndex((m) => m.subtype === 'task_started') + 1;
    q.emit(...first!.slice(0, cut));
    await until(() => h.of('item.updated').some((e) => e.item.kind === 'command'), 'command started');
    await h.adapter.interrupt(REF);
    expect(q.calls).toContain('interrupt');
    q.emit(...first!.slice(cut));
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'interrupted'), 'interrupted turn');

    const command = h.of('item.updated').map((e) => e.item).filter((i) => i.kind === 'command');
    expect(command.map((i) => i.state)).toEqual(['running', 'interrupted']);
    expect(h.of('session.activity').map((e) => e.activity)).toEqual(['running', 'interrupted']);

    // The next turn is an ordinary one: the interrupt does not stick.
    q.emit(...second!);
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'next turn');
    expectValidEvents(h.events);
  });
});

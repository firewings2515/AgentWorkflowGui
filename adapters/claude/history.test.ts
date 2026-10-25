// Stored history (getSessionMessages / listSubagents / getSubagentMessages, CR-6), from the transcript
// SP-03 left behind. Read-only: nothing is resumed and no query is started.
import { describe, expect, it } from 'vitest';
import { NativeTaskId, SessionId } from '../../contracts';
import type { HistoryEntry } from '../../core/ports';
import { AppEvent } from '../../contracts';
import { loadStored, setup } from './testing/harness';
import type { WireSessionMessage } from './wire';

const fx = loadStored('sp03-history.json');
const SESSION = SessionId.parse('session-sp03');

const kinds = (entries: HistoryEntry[]) => entries.map((e) => (e.kind === 'turn' ? `turn:${e.turn.state}` : e.kind === 'message' ? `${e.message.role}` : `${e.item.kind}:${e.item.state}`));

/** Each entry is valid as the event the GUI would show it with. */
const expectValid = (entries: HistoryEntry[]) => {
  for (const e of entries) {
    const event = e.kind === 'turn' ? { type: 'turn.updated', turn: e.turn } : e.kind === 'message' ? { type: 'message.completed', message: e.message } : { type: 'item.updated', item: e.item };
    const parsed = AppEvent.safeParse(event);
    expect(parsed.success, parsed.error?.message).toBe(true);
  }
};

describe('readHistory', () => {
  it('rebuilds turns, messages, tool calls and native tasks of a stored session', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.messages, fx.subagents);
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: fx.cwd });
    expect(h.sdk.queries).toEqual([]);
    expect(history.complete).toBe(true);
    expectValid(history.entries);

    // Prompts start turns: three typed prompts and the background agent's notification (R-05).
    const turns = history.entries.flatMap((e) => (e.kind === 'turn' ? [e.turn] : []));
    // Turn 2 stopped one sub-agent but went on, so it completed.
    expect(turns.map((t) => [t.id, t.state])).toEqual([
      ['99be6393-b8c6-4aed-8211-7b02e0cda2de', 'completed'],
      ['009ad0a6-af87-40aa-8d27-b3204d9a9c0b', 'completed'],
      ['c531c513-b95b-4433-b416-d3ad6444528c', 'completed'],
      ['ea521ddc-ac72-4afe-b239-9c3260d6de06', 'completed'],
    ]);
    expect(turns.every((t) => t.endedAt !== undefined)).toBe(true);

    expect(kinds(history.entries)).toEqual([
      'turn:completed',
      'user',
      'toolCall:completed',
      'toolCall:completed',
      'assistant',
      'turn:completed',
      'user',
      'toolCall:failed',
      'toolCall:completed',
      'assistant',
      'turn:completed',
      'user',
      'toolCall:completed',
      'assistant',
      'turn:completed',
      'system',
      'assistant',
    ]);
    const messages = history.entries.flatMap((e) => (e.kind === 'message' ? [e.message] : []));
    expect(messages[0]).toMatchObject({ role: 'user', origin: { kind: 'user' }, turnId: turns[0]!.id, createdAt: '2026-10-23T08:58:13.721Z' });
    expect(messages.find((m) => m.role === 'system')).toMatchObject({ origin: { kind: 'system' }, text: 'Agent "Summarize a.txt in background" finished', turnId: turns[3]!.id });
    expect(messages.filter((m) => m.role === 'assistant').every((m) => m.observedModel === 'claude-haiku-5-5')).toBe(true);
    const agentCall = history.entries.find((e) => e.kind === 'item')!;
    expect(agentCall).toMatchObject({ item: { kind: 'toolCall', tool: 'Agent', summary: 'Agent Summarize a.txt', id: 'toolu_01BUpGMPYagYoq8bnR6TypPV' } });

    expect(history.nativeTasks.map((t) => [t.nativeRef, t.parentRef, t.label, t.state, t.background])).toEqual([
      ['a097110e26c651907', 'toolu_01YZZU2bbtKZxGT44CMc1w5p', 'Run X sleep command', 'stopped', false],
      ['a493644594a535e2d', 'toolu_019RT4tbQ1iDgAftpQcKNi25', 'Summarize a.txt in background', 'completed', true],
      ['a4d8612ba8437fc81', 'toolu_01W3aqZfafWDiBUTzjvwQWW3', 'Summarize b.txt', 'completed', false],
      ['a90d827b1c02b3b15', 'toolu_01A56cTeEsDeuFVNuXN7kXu8', 'Run Y sleep command', 'completed', false],
      ['ab136d00f928b2a8a', 'toolu_01BUpGMPYagYoq8bnR6TypPV', 'Summarize a.txt', 'completed', false],
    ]);
    expect(history.nativeTasks.find((t) => t.background)).toMatchObject({ summary: 'Agent "Summarize a.txt in background" finished', endedAt: '2026-10-23T08:58:54.236Z' });
  });

  it("reads one sub-agent's own conversation, placed on its task (CR-6)", async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.messages, fx.subagents);
    const nativeTaskId = NativeTaskId.parse('ab136d00f928b2a8a');
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: fx.cwd, nativeTask: { nativeTaskId, nativeRef: 'ab136d00f928b2a8a' } });
    expectValid(history.entries);
    expect(kinds(history.entries)).toEqual(['user', 'toolCall:completed', 'assistant']);
    for (const e of history.entries) {
      const placed = e.kind === 'message' ? e.message : e.kind === 'item' ? e.item : undefined;
      expect(placed).toMatchObject({ nativeTaskId: 'ab136d00f928b2a8a' });
      expect(placed?.turnId).toBeUndefined();
    }
    expect(history.nativeTasks).toEqual([]);
  });

  it('needs the original cwd: another folder has no such session', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.messages, fx.subagents);
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: 'E:\\elsewhere' });
    expect(history).toEqual({ entries: [], nativeTasks: [], complete: true });
  });

  it('marks the history incomplete after compaction or for a sub-agent it cannot place', async () => {
    const h = setup();
    const boundary: WireSessionMessage = { type: 'system', uuid: 'b1', session_id: fx.sessionId, message: { subtype: 'compact_boundary' }, parent_tool_use_id: null };
    h.sdk.store(fx.cwd, fx.sessionId, [boundary, ...fx.messages.slice(-2)], { 'a-unknown': [] });
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: fx.cwd });
    expect(history.complete).toBe(false);
    expect(history.nativeTasks).toEqual([]);
  });

  it('shows calls the GUI refused or did not answer in time as declined (live, T009)', async () => {
    const h = setup();
    const at = '2026-10-25T11:00:00.000Z';
    const write = (id: string): WireSessionMessage => ({ type: 'assistant', uuid: `a-${id}`, session_id: 's', message: { id: `msg_${id}`, model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: 'E:\\w\\x.txt', content: 'hi' } }] }, parent_tool_use_id: null, timestamp: at });
    const refused = (id: string, text: string): WireSessionMessage => ({ type: 'user', uuid: `r-${id}`, session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] }, parent_tool_use_id: null, timestamp: at });
    h.sdk.store('E:\\w', 's', [
      { type: 'user', uuid: '11111111-0000-4000-8000-000000000001', session_id: 's', message: { role: 'user', content: 'write it' }, parent_tool_use_id: null, timestamp: at },
      write('t1'),
      refused('t1', 'PreToolUse:Write hook error: declined by AgentWorkflowGui'),
      write('t2'),
      refused('t2', 'PreToolUse hook did not respond before its timeout (host client may be unreachable). The tool call was not executed; other configured hooks may not have completed.'),
      write('t3'),
      refused('t3', 'EACCES: permission denied'),
    ]);
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: 's', cwd: 'E:\\w' });
    expect(kinds(history.entries)).toEqual(['turn:completed', 'user', 'fileChange:declined', 'fileChange:declined', 'fileChange:failed']);
  });

  it('skips CLI-local command output and keeps an interrupted turn interrupted', async () => {
    const h = setup();
    const at = '2026-10-25T11:00:00.000Z';
    const user = (uuid: string, content: unknown): WireSessionMessage => ({ type: 'user', uuid, session_id: 's', message: { role: 'user', content }, parent_tool_use_id: null, timestamp: at });
    h.sdk.store('E:\\w', 's', [
      user('11111111-0000-4000-8000-000000000001', 'run the tests'),
      { type: 'assistant', uuid: 'a1', session_id: 's', message: { id: 'msg_1', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'npm test' } }] }, parent_tool_use_id: null, timestamp: at },
      user('11111111-0000-4000-8000-000000000002', [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: '[Request interrupted by user for tool use]' }]),
      user('11111111-0000-4000-8000-000000000003', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      user('11111111-0000-4000-8000-000000000004', '<local-command-stdout>Set model to `haiku`</local-command-stdout>'),
    ]);
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: 's', cwd: 'E:\\w' });
    expect(kinds(history.entries)).toEqual(['turn:interrupted', 'user', 'command:interrupted']);
    expectValid(history.entries);
  });
});

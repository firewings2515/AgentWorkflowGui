// Stored history (getSessionMessages / listSubagents / getSubagentMessages, CR-6). The fake SDK keeps raw
// transcript lines and reads them with the SDK's own readers, so chain rebuilding, deduplication and
// compaction behave as in production. Read-only: nothing is resumed and no query is started.
import { describe, expect, it } from 'vitest';
import { AppEvent, NativeTaskId, SessionId } from '../../contracts';
import type { HistoryEntry } from '../../core/ports';
import { loadStored, promptLine, replyLine, setup, toolResultLine, transcript, u } from './testing/harness';
import type { WireTranscriptEntry } from './wire';

const fx = loadStored('sp03-transcript.json');
const SESSION = SessionId.parse('session-sp03');
const REF = '22222222-2222-4222-8222-222222222222';
const DIR = 'D:\\demo\\w';

const kinds = (entries: HistoryEntry[]) => entries.map((e) => (e.kind === 'turn' ? `turn:${e.turn.state}` : e.kind === 'message' ? `${e.message.role}` : `${e.item.kind}:${e.item.state}`));

/** Each entry is valid as the event the GUI would show it with. */
const expectValid = (entries: HistoryEntry[]) => {
  for (const e of entries) {
    const event = e.kind === 'turn' ? { type: 'turn.updated', turn: e.turn } : e.kind === 'message' ? { type: 'message.completed', message: e.message } : { type: 'item.updated', item: e.item };
    const parsed = AppEvent.safeParse(event);
    expect(parsed.success, parsed.error?.message).toBe(true);
  }
};

const read = async (lines: WireTranscriptEntry[], subagents: Record<string, WireTranscriptEntry[]> = {}) => {
  const h = setup();
  h.sdk.store(DIR, REF, lines, { subagents });
  return h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: REF, cwd: DIR });
};
const bash = (n: number, command: string, id = `toolu_${n}`) => replyLine(u(n), { type: 'tool_use', id, name: 'Bash', input: { command } }, { stop: 'tool_use' });

describe('readHistory', () => {
  it('rebuilds turns, messages, tool calls and native tasks of a stored session', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries, { subagents: fx.subagents });
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: fx.cwd });
    expect(h.sdk.queries).toEqual([]);
    expect(history.complete).toBe(true);
    expectValid(history.entries);

    // Prompts start turns: three typed prompts and the background agent's notification (R-05). Each ends
    // with a final assistant message; turn 2 stopped one sub-agent but went on.
    const turns = history.entries.flatMap((e) => (e.kind === 'turn' ? [e.turn] : []));
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
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries, { subagents: fx.subagents });
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

  it('finds nothing from an unrelated folder', async () => {
    const h = setup();
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries, { subagents: fx.subagents });
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: fx.sessionId, cwd: 'E:\\elsewhere' });
    expect(history).toEqual({ entries: [], nativeTasks: [], complete: true });
  });

  it('keeps a turn without an end running and says the history is incomplete (review r1 P1-3)', async () => {
    // The last turn is still running a command (or the process died there): no completion evidence.
    const running = await read(transcript(REF, DIR, [promptLine(u(1), 'Run the tests.'), bash(2, 'npm test')]));
    expect(kinds(running.entries)).toEqual(['turn:running', 'user', 'command:running']);
    expect(running.entries[0]).toMatchObject({ kind: 'turn', turn: { state: 'running' } });
    expect(running.entries[0]!.kind === 'turn' && running.entries[0]!.turn.endedAt).toBeUndefined();
    expect(running.complete).toBe(false);
    expectValid(running.entries);

    // A cancelled turn (hook_stopped, live T009) has no end in the transcript either, even with a later turn.
    const cancelled = await read(
      transcript(REF, DIR, [
        promptLine(u(1), 'Write marker.txt.'),
        replyLine(u(2), { type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: 'D:\\demo\\w\\marker.txt', content: 'hi' } }, { stop: 'tool_use' }),
        toolResultLine(u(3), 'toolu_w', 'PreToolUse:Write hook error: declined by AgentWorkflowGui', true),
        promptLine(u(4), 'Say hi.'),
        replyLine(u(5), { type: 'text', text: 'hi' }),
      ]),
    );
    expect(kinds(cancelled.entries)).toEqual(['turn:running', 'user', 'fileChange:declined', 'turn:completed', 'user', 'assistant']);
    expect(cancelled.complete).toBe(false);
  });

  it('puts a prompt taken in mid-turn into that turn, as live (live, T009)', async () => {
    const queued = { type: 'attachment', uuid: u(4), attachment: { type: 'queued_command', prompt: 'Also say PEER-OK.', source_uuid: u(9), commandMode: 'prompt' } };
    const history = await read(
      transcript(REF, DIR, [promptLine(u(1), 'Sleep, then say SLEPT.'), bash(2, 'Start-Sleep -Seconds 15'), toolResultLine(u(3), 'toolu_2', '(PowerShell completed with no output)'), queued, replyLine(u(5), { type: 'text', text: 'SLEPT PEER-OK' })]),
    );
    expect(kinds(history.entries)).toEqual(['turn:completed', 'user', 'command:completed', 'user', 'assistant']);
    const prompts = history.entries.flatMap((e) => (e.kind === 'message' && e.message.role === 'user' ? [e.message] : []));
    expect(prompts.map((m) => [m.id, m.turnId])).toEqual([
      [u(1), u(1)],
      [u(9), u(1)],
    ]);
    expect(history.complete).toBe(true);
  });

  it('marks the history incomplete after a compaction (review r1 P1-2)', async () => {
    // A compaction as the CLI writes it: a boundary line, then the summary prompt chained to it.
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: u(5), parentUuid: null, logicalParentUuid: u(4), content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 150000 } };
    const summary = promptLine(u(6), 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
    const lines = transcript(REF, DIR, [promptLine(u(1), 'first'), replyLine(u(2), { type: 'text', text: 'one' }), promptLine(u(3), 'second'), replyLine(u(4), { type: 'text', text: 'two' }), boundary, summary, promptLine(u(7), 'third'), replyLine(u(8), { type: 'text', text: 'three' })]);
    const history = await read(lines);
    expect(history.complete).toBe(false);
    // The earlier prompts are gone from the SDK's chain; the summary is not shown as a prompt.
    const prompts = history.entries.flatMap((e) => (e.kind === 'message' && e.message.role === 'user' ? [e.message.text] : []));
    expect(prompts).toEqual(['third']);

    // The raw boundary alone is enough, even when the summary line is missing.
    const boundaryOnly = await read(transcript(REF, DIR, [promptLine(u(1), 'first'), replyLine(u(2), { type: 'text', text: 'one' }), boundary, promptLine(u(7), 'third', { parentUuid: u(5) }), replyLine(u(8), { type: 'text', text: 'three' })]));
    expect(boundaryOnly.complete).toBe(false);
  });

  it("does not close one turn's open call when a later turn ends (review r2 P2)", async () => {
    const history = await read(
      transcript(REF, DIR, [promptLine(u(1), 'Run the tests.'), bash(2, 'npm test'), promptLine(u(3), 'Say hi.'), replyLine(u(4), { type: 'text', text: 'hi' })]),
    );
    expect(kinds(history.entries)).toEqual(['turn:running', 'user', 'command:running', 'turn:completed', 'user', 'assistant']);
    const command = history.entries[2]!;
    expect(command.kind === 'item' && command.item.endedAt).toBeUndefined();
    expect(history.complete).toBe(false);
    expectValid(history.entries);
  });

  it('marks the history incomplete when the raw read missed lines (review r2 P1-1)', async () => {
    const h = setup();
    h.sdk.store(DIR, REF, transcript(REF, DIR, [promptLine(u(1), 'hi'), replyLine(u(2), { type: 'text', text: 'hello' })]));
    h.sdk.incompleteRead = 'read 600 of 700 transcript bytes; some lines did not parse';
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: REF, cwd: DIR });
    expect(history.complete).toBe(false);
  });

  it('marks the history incomplete for a sub-agent it cannot place', async () => {
    const history = await read(transcript(REF, DIR, [promptLine(u(1), 'hi'), replyLine(u(2), { type: 'text', text: 'hello' })]), { 'a-unknown': [] });
    expect(history.complete).toBe(false);
    expect(history.nativeTasks).toEqual([]);
  });

  it('shows calls the GUI refused or did not answer in time as declined (live, T009)', async () => {
    const write = (n: number) => replyLine(u(n), { type: 'tool_use', id: `t${n}`, name: 'Write', input: { file_path: 'D:\\demo\\w\\x.txt', content: 'hi' } }, { stop: 'tool_use' });
    const history = await read(
      transcript(REF, DIR, [
        promptLine(u(1), 'write it'),
        write(2),
        toolResultLine(u(3), 't2', 'PreToolUse:Write hook error: declined by AgentWorkflowGui', true),
        write(4),
        toolResultLine(u(5), 't4', 'PreToolUse hook did not respond before its timeout (host client may be unreachable). The tool call was not executed; other configured hooks may not have completed.', true),
        write(6),
        toolResultLine(u(7), 't6', 'EACCES: permission denied', true),
        replyLine(u(8), { type: 'text', text: 'FAILED' }),
      ]),
    );
    expect(kinds(history.entries)).toEqual(['turn:completed', 'user', 'fileChange:declined', 'fileChange:declined', 'fileChange:failed', 'assistant']);
  });

  it('fails a turn the CLI answered with its own error message (R-12) and keeps interrupts', async () => {
    const synthetic = await read(transcript(REF, DIR, [promptLine(u(1), 'hi'), replyLine(u(2), { type: 'text', text: 'There is an issue with the selected model.' }, { model: '<synthetic>', stop: 'stop_sequence' })]));
    expect(synthetic.entries[0]).toMatchObject({ kind: 'turn', turn: { state: 'failed', failure: { message: 'There is an issue with the selected model.' } } });

    const interrupted = await read(
      transcript(REF, DIR, [
        promptLine(u(1), 'run the tests'),
        bash(2, 'npm test'),
        toolResultLine(u(3), 'toolu_2', '[Request interrupted by user for tool use]', true),
        promptLine(u(4), [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
        promptLine(u(5), '<local-command-stdout>Set model to `haiku`</local-command-stdout>'),
      ]),
    );
    expect(kinds(interrupted.entries)).toEqual(['turn:interrupted', 'user', 'command:interrupted']);
    expect(interrupted.complete).toBe(true);
    expectValid(interrupted.entries);
  });
});

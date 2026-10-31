// T033 (R-07, SP-06 W3): a Bash call sent to the background returns at once, but its command item stays
// running until its `local_bash` task ends, so the session's file locks wait for it. Seen live in V-24 run 1:
// without this the lock went with the turn while `sleep 40` still ran.
import { describe, expect, it } from 'vitest';
import { echo, expectValidEvents, init, REF, result, started, until } from './testing/harness';

const bashCall = (id: string, input: Record<string, unknown>) =>
  echo('x', '', { message: { id: `m-${id}`, role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
const toolResult = (id: string, text: string, structured: Record<string, unknown>) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] },
  tool_use_result: structured,
  parent_tool_use_id: null,
  uuid: `u-${id}`,
  session_id: REF,
});
const task = (subtype: string, extra: Record<string, unknown>) => ({ type: 'system', subtype, session_id: REF, uuid: `t-${subtype}-${String(Math.random())}`, ...extra });

describe('background shell commands (Claude)', () => {
  it('keeps the command running after its tool result, until its task ends', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(
      init(),
      bashCall('toolu_bg', { command: 'sleep 40', run_in_background: true }),
      task('task_started', { task_id: 'b1', tool_use_id: 'toolu_bg', task_type: 'local_bash', description: 'sleep 40', is_backgrounded: true }),
      toolResult('toolu_bg', 'Command running in background with ID: b1', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }),
      result(),
    );
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'turn end');
    const states = () => h.of('item.updated').map((e) => [e.item.state, e.item.kind === 'command' && e.item.background]);
    expect(states()).toEqual([
      ['running', true],
      ['running', true],
    ]);
    // No native task for a shell command.
    expect(h.of('nativeTask.updated')).toEqual([]);
    q.emit(task('task_updated', { task_id: 'b1', patch: { status: 'completed', end_time: 1793000000000 } }), task('task_notification', { task_id: 'b1', tool_use_id: 'toolu_bg', status: 'completed', output_file: 'x', summary: 'done' }));
    await until(() => h.of('item.updated').length === 3, 'command end');
    expect(h.of('item.updated')[2]!.item).toMatchObject({ state: 'completed', background: true, endedAt: new Date(1793000000000).toISOString() });
    expectValidEvents(h.events);
  });

  it('ends at once when its task ended before the tool result, and a foreground call that moved to the background waits too', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(
      init(),
      bashCall('toolu_fast', { command: 'echo hi', run_in_background: true }),
      task('task_started', { task_id: 'b2', tool_use_id: 'toolu_fast', task_type: 'local_bash', description: 'echo' }),
      task('task_notification', { task_id: 'b2', tool_use_id: 'toolu_fast', status: 'failed', output_file: 'x', summary: 'exit 1' }),
      toolResult('toolu_fast', 'started', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b2' }),
      // Claude moves a long foreground command to the background on its own (SP-06 W3).
      bashCall('toolu_moved', { command: 'sleep 99' }),
      toolResult('toolu_moved', 'moved to the background', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b3' }),
      result(),
    );
    await until(() => h.of('turn.updated').some((e) => e.turn.state === 'completed'), 'turn end');
    const byId = (id: string) => h.of('item.updated').filter((e) => e.item.id === id).map((e) => e.item.state);
    expect(byId('toolu_fast')).toEqual(['running', 'failed']);
    expect(byId('toolu_moved')).toEqual(['running', 'running']);
    q.emit(task('task_updated', { task_id: 'b3', patch: { status: 'killed' } }));
    await until(() => byId('toolu_moved').length === 3, 'moved command end');
    expect(byId('toolu_moved')).toEqual(['running', 'running', 'interrupted']);
    expectValidEvents(h.events);
  });
});

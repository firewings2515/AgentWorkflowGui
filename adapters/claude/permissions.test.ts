// PreToolUse hook → permission handle (R-07, R-08): every tool call is handed to the layer above, may be
// held, is answered once, and fails closed.
import { describe, expect, it } from 'vitest';
import { EscalationId, type PermissionDecision } from '../../contracts';
import { echo, expectValidEvents, init, REF, settle, started, until } from './testing/harness';

const AT = '2026-10-25T12:00:00.000Z';
const decide = (outcome: PermissionDecision['outcome'], reason?: string): PermissionDecision => ({ outcome, decidedBy: 'policy', at: AT, ...(reason && { reason }) });
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_1', cwd: 'E:\\work\\task-1', ...extra });

describe('permission requests', () => {
  it('hands a shell call to the layer above and allows it on approve', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    const { output } = q.callHook(bash('git status'));
    await until(() => h.permissions.length === 1, 'request');
    const request = h.permissions[0]!.request;
    expect(request).toMatchObject({
      sessionId: 'session-a',
      turnId: h.of('turn.updated')[0]!.turn.id,
      itemId: 'toolu_1',
      kind: 'command',
      command: 'git status',
      cwd: 'E:\\work\\task-1',
      summary: 'Bash: git status',
      state: 'pending',
    });
    expect(h.permissions[0]!.answer(decide('approve'))).toBe(true);
    expect(await output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'approved by AgentWorkflowGui' } });
    expect(h.permissions[0]!.answer(decide('decline'))).toBe(false);
    expect(h.of('permission.updated').map((e) => e.request.state)).toEqual(['pending', 'answered']);
    expectValidEvents(h.events);
  });

  it('classifies edits and reads, with their paths', async () => {
    const h = await started();
    const q = h.sdk.last;
    void q.callHook({ tool_name: 'Edit', tool_input: { file_path: 'E:\\work\\task-1\\a.ts', old_string: 'a', new_string: 'b' }, tool_use_id: 't-edit' });
    void q.callHook({ tool_name: 'Read', tool_input: { file_path: 'E:\\work\\task-1\\.env' }, tool_use_id: 't-read' });
    void q.callHook({ tool_name: 'mcp__gui__send_message', tool_input: { to: 'b' }, tool_use_id: 't-mcp' });
    await until(() => h.permissions.length === 3, 'requests');
    expect(h.permissions.map((p) => [p.request.kind, p.request.paths, p.request.summary])).toEqual([
      ['fileChange', ['E:\\work\\task-1\\a.ts'], 'Edit E:\\work\\task-1\\a.ts'],
      ['permissions', ['E:\\work\\task-1\\.env'], 'Read E:\\work\\task-1\\.env'],
      ['permissions', [], 'mcp__gui__send_message'],
    ]);
  });

  it('can hold an answer as long as needed, then deny with the reason (R-07 lock, R-05 escalation)', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init(), echo('x', '', { message: { id: 'm1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git push' } }] } }));
    await until(() => h.of('item.updated').length === 1, 'item');
    const { output } = q.callHook(bash('git push'));
    await until(() => h.permissions.length === 1, 'request');
    const handle = h.permissions[0]!;
    const escalationId = EscalationId.parse('esc-1');
    expect(handle.hold({ reason: 'awaiting-user', escalationId }, { matchedRule: 'git-push' })).toBe(true);
    let answered = false;
    void output.then(() => (answered = true));
    await settle();
    expect(answered).toBe(false);
    expect(handle.answer({ outcome: 'decline', decidedBy: 'user', escalationId, reason: 'push is not allowed in a task', at: AT }, { matchedRule: 'git-push' })).toBe(true);
    expect(await output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'push is not allowed in a task' } });
    expect(h.of('permission.updated').map((e) => [e.request.state, e.request.matchedRule])).toEqual([
      ['pending', undefined],
      ['held', 'git-push'],
      ['answered', 'git-push'],
    ]);
    // The CLI then reports the call as an error result: the item is declined, not failed.
    q.emit({ type: 'user', parent_tool_use_id: null, session_id: REF, uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'PreToolUse hook denied' }] } });
    await until(() => h.of('item.updated').length === 2, 'item end');
    expect(h.of('item.updated')[1]!.item.state).toBe('declined');
    expectValidEvents(h.events);
  });

  it('cancel denies and stops the agent loop; the turn ends as interrupted', async () => {
    const h = await started();
    const q = h.sdk.last;
    q.emit(init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    const { output } = q.callHook(bash('rm -rf build'));
    await until(() => h.permissions.length === 1, 'request');
    h.permissions[0]!.answer(decide('cancel'));
    expect(await output).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: 'deny' } });
    // Live (T009): the CLI then ends the turn with a successful result and terminal_reason hook_stopped.
    q.emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'tool_use', terminal_reason: 'hook_stopped', session_id: REF });
    await until(() => h.of('turn.updated').length === 2, 'turn end');
    expect(h.of('turn.updated')[1]!.turn.state).toBe('interrupted');
    expect(h.of('session.activity').at(-1)!.activity).toBe('interrupted');
    expectValidEvents(h.events);
  });

  it('rejects an invalid answer without answering the runtime', async () => {
    const h = await started();
    const { output } = h.sdk.last.callHook(bash('ls'));
    await until(() => h.permissions.length === 1, 'request');
    // A user decision must come from an escalation (R-05).
    expect(() => h.permissions[0]!.answer({ outcome: 'approve', decidedBy: 'user', at: AT })).toThrow();
    expect(() => h.permissions[0]!.hold({ reason: 'file-lock' } as never)).toThrow();
    expect(h.permissions[0]!.request.state).toBe('pending');
    h.permissions[0]!.answer(decide('approve'));
    expect(await output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('fails closed when the handler throws or rejects', async () => {
    const throwing = await started({
      onPermissionRequest: () => {
        throw new Error('policy crashed');
      },
    });
    expect(await throwing.sdk.last.callHook(bash('ls')).output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'permission handler failed' } });
    expect(throwing.of('permission.updated').at(-1)!.request).toMatchObject({ state: 'answered', decision: { outcome: 'decline', decidedBy: 'policy' } });

    const rejecting = await started({ onPermissionRequest: () => Promise.reject(new Error('lock table gone')) });
    expect(await rejecting.sdk.last.callHook(bash('ls')).output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });

    // A handler that answers and then throws keeps its answer.
    const late = await started({
      onPermissionRequest: (handle) => {
        handle.answer(decide('approve'));
        throw new Error('after answering');
      },
    });
    expect(await late.sdk.last.callHook(bash('ls')).output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
  });

  it('withdraws the request when the runtime aborts it, and denies unusable input', async () => {
    const h = await started();
    const call = h.sdk.last.callHook(bash('sleep 100'));
    await until(() => h.permissions.length === 1, 'request');
    call.abort();
    expect(await call.output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(h.of('permission.updated').at(-1)!.request.state).toBe('withdrawn');
    expect(h.permissions[0]!.answer(decide('approve'))).toBe(false);

    expect(await h.sdk.last.callHook({ tool_input: {}, tool_use_id: 'x' }).output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(h.permissions).toHaveLength(1);
  });

  it('places a sub-agent call on its native task (R-13) and withdraws open requests when the session ends', async () => {
    const h = await started();
    const q = h.sdk.last;
    const { output } = q.callHook(bash('npm test', { agent_id: 'ab136d00f928b2a8a', tool_use_id: 'toolu_sub' }));
    await until(() => h.permissions.length === 1, 'request');
    expect(h.permissions[0]!.request).toMatchObject({ nativeTaskId: 'ab136d00f928b2a8a', itemId: 'toolu_sub' });
    expect(h.permissions[0]!.request.turnId).toBeUndefined();
    q.end(new Error('crash'));
    expect(await output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    await until(() => h.of('runtime.exited').length === 1, 'exit');
    expect(h.of('permission.updated').at(-1)!.request.state).toBe('withdrawn');
    expectValidEvents(h.events);
  });
});

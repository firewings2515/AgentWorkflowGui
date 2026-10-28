// The ordinary-session service (T017) on memory ports and fake adapters: commands, the CR-2 delivery path,
// the MCP mount, permissions (R-05, R-08), runtime events, send_message, restart and exit.
import { describe, expect, it } from 'vitest';
import {
  AppEvent,
  CommandResult,
  ItemId,
  LogicalSession,
  MessageId,
  NativeTaskId,
  PermissionRequestId,
  type Escalation,
  OperationId,
  type SessionId,
  TurnId,
} from '../../contracts';
import { FakeHandle, permissionRequest } from './testing/fake-adapter';
import { AGENT, CWD, REAL_CWD, agent, created, rid, session, settle, world, type World } from './testing/harness';

const send = (w: World, sessionId: SessionId, text: string, messageId = `m-${text}`, revision = 0) =>
  w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse(messageId), expectedRevision: revision, text, attachments: [] });

const failed = (result: CommandResult) => (result.ok ? undefined : result.code);
const latest = async (w: World, id: string) => (await session(w, id)).revision;
const escalations = (w: World) => [...w.repositories.escalationRecords.values()];
const ask = (w: World, sessionId: SessionId, extra: Parameters<typeof permissionRequest>[1] = {}) => w.codex.get(sessionId)!.ask(permissionRequest(sessionId, extra));

describe('session.create', () => {
  it('stores an ordinary session with its real folder scope and starts its runtime session as a provision, with a fresh MCP mount', async () => {
    const w = await world();
    const { result, sessionId } = await created(w);
    expect(result).toMatchObject({ ok: true, revision: 0, created: [{ kind: 'session', id: 'session-a' }] });
    const s = await session(w, 'session-a');
    expect(LogicalSession.parse(s)).toBeTruthy();
    expect(s).toMatchObject({ kind: 'ordinary', title: 'Reviewer', cwd: CWD, folderScope: { source: 'session-cwd', workspaceRoot: REAL_CWD, writableRoots: [REAL_CWD] }, activity: 'idle' });
    const codex = w.codex.get(sessionId)!;
    expect(codex.started).toHaveLength(1);
    expect(codex.started[0]).toMatchObject({ sessionId, cwd: CWD, model: { runtime: 'codex', model: 'gpt-6-luna' }, instructions: 'Review carefully.', mcp: w.mounts[0]!.mount });
    // The provision is stored without the token (C-07).
    const provision = await w.store.get(OperationId.parse(`provision:${sessionId}`));
    expect(provision?.delivery.state).toBe('sent');
    expect(JSON.stringify(provision)).not.toContain(w.mounts[0]!.mount.token);
  });

  it('pre-allocates the Claude session ID and uses the one shared Claude adapter', async () => {
    const w = await world();
    await created(w, 'claude', 'c-1');
    await created(w, 'claude', 'c-2');
    expect(w.claude.started.map((s) => s.preallocatedRef)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(w.claude.calls.filter((c) => c === 'start')).toHaveLength(1);
  });

  it('refuses a repeated ID, an unknown agent or parent, and a folder that cannot be resolved', async () => {
    const w = await world();
    await created(w);
    expect(failed((await created(w)).result)).toBe('already_exists');
    expect(failed((await created(w, 'codex', 'b', { agentId: 'nope' as typeof AGENT })).result)).toBe('not_found');
    expect(failed((await created(w, 'codex', 'c', { parentId: 'nope' as SessionId })).result)).toBe('not_found');
    expect(failed((await created(w, 'codex', 'd', { cwd: 'C:\\elsewhere' })).result)).toBe('invalid_request');
  });

  it('leaves a lost create response unknown, escalates it, and never creates the session again on its own', async () => {
    const w = await world();
    w.configure = (adapter) => adapter.startModes.push('lost');
    const { result, sessionId } = await created(w);
    expect(result.ok).toBe(true);
    expect((await w.store.get(OperationId.parse(`provision:${sessionId}`)))?.delivery.state).toBe('unknown');
    const [escalation] = escalations(w);
    expect(escalation).toMatchObject({ kind: 'delivery-unknown', state: 'open', ref: { kind: 'provision', operationId: `provision:${sessionId}` } });
    // A send now does not create it again.
    expect(failed(await send(w, sessionId, 'hi', 'm-1', await latest(w, 'session-a')))).toBe('unknown_outcome');
    expect(w.codex.get(sessionId)!.started).toHaveLength(1);

    // Only the user's retry, with the duplicate risk acknowledged, creates it again.
    const refused = await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: false });
    expect(failed(refused)).toBe('invalid_request');
    expect((await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation!.id, decision: 'retry', acceptDuplicateRisk: true })).ok).toBe(true);
    expect(w.codex.get(sessionId)!.started).toHaveLength(2);
    expect((await w.store.get(OperationId.parse(`provision:${sessionId}`)))?.delivery.state).toBe('sent');
    expect(w.repositories.escalationRecords.get(escalation!.id)).toMatchObject({ state: 'resolved', resolvedBy: 'user' });
  });
});

describe('session.send (CR-2)', () => {
  it('stores the message under the renderer’s ID and sends it once through the delivery service, as the user', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const result = await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'));
    expect(result).toMatchObject({ ok: true, created: [{ kind: 'message', id: 'm-1' }] });
    const codex = w.codex.get(sessionId)!;
    expect(codex.dispatched).toHaveLength(1);
    expect(codex.dispatched[0]).toMatchObject({ text: 'hello', entry: { kind: 'new-turn' }, origin: { kind: 'user' } });
    const record = await w.store.get(OperationId.parse('user-message:m-1'));
    expect(record?.delivery.state).toBe('sent');
    expect((await w.repositories.conversations.get(sessionId)).messages).toMatchObject([{ id: 'm-1', role: 'user', origin: { kind: 'user' }, text: 'hello' }]);

    // The runtime's echo of the same message is not stored a second time.
    codex.emit({ type: 'message.completed', message: { id: MessageId.parse('echo-1'), sessionId, role: 'user', origin: { kind: 'user' }, text: 'hello', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' } });
    await settle();
    expect((await w.repositories.conversations.get(sessionId)).messages).toHaveLength(1);

    // The same command again is the same operation: nothing is sent twice.
    expect((await send(w, sessionId, 'hello', 'm-1', await latest(w, 'session-a'))).ok).toBe(true);
    expect(codex.dispatched).toHaveLength(1);
    expect(failed(await send(w, sessionId, 'other text', 'm-1', await latest(w, 'session-a')))).toBe('invalid_request');
  });

  it('inserts into the running turn when the session is busy', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.codex.get(sessionId)!.emit({ type: 'session.activity', sessionId, activity: 'running', at: '2026-10-29T01:00:00.000Z' });
    await settle();
    await send(w, sessionId, 'more', 'm-2', await latest(w, 'session-a'));
    expect(w.codex.get(sessionId)!.dispatched[0]?.entry).toEqual({ kind: 'insert' });
  });

  it('answers unknown_outcome for an unknown delivery, never resends it, and shows the session as reconciling', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.dispatchModes.push('lost');
    const result = await send(w, sessionId, 'maybe', 'm-3', await latest(w, 'session-a'));
    expect(result).toMatchObject({ ok: false, code: 'unknown_outcome', mayHaveSideEffects: true });
    await settle();
    expect(codex.dispatched).toHaveLength(1);
    expect(codex.reconciled).toHaveLength(1);
    expect((await w.store.get(OperationId.parse('user-message:m-3')))?.delivery.state).toBe('unknown');
    expect((await session(w, 'session-a')).activity).toBe('reconciling');
    // Contracts have no escalation ref for a user's own message; nothing is opened.
    expect(escalations(w)).toEqual([]);
    // A resend of the same command never dispatches it again.
    expect(failed(await send(w, sessionId, 'maybe', 'm-3', await latest(w, 'session-a')))).toBe('unknown_outcome');
    expect(codex.dispatched).toHaveLength(1);
  });

  it('an unknown answer that the runtime’s history shows is reconciled to sent at once', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.codex.get(sessionId)!.dispatchModes.push('unknown');
    expect((await send(w, sessionId, 'stored', 'm-6', await latest(w, 'session-a'))).ok).toBe(true);
    expect((await w.store.get(OperationId.parse('user-message:m-6')))?.delivery.state).toBe('sent');
  });

  it('refuses a stale revision, attachments, and an unknown session', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    expect(failed(await send(w, sessionId, 'x', 'm-4', 99))).toBe('stale_revision');
    const withAttachment = await w.run({
      type: 'session.send',
      requestId: rid(),
      sessionId,
      messageId: MessageId.parse('m-5'),
      expectedRevision: await latest(w, 'session-a'),
      text: 'x',
      attachments: [{ kind: 'file', path: 'E:\\a.txt', name: 'a.txt' }],
    });
    expect(failed(withAttachment)).toBe('unsupported');
    expect(failed(await send(w, 'nope' as SessionId, 'x'))).toBe('not_found');
    expect(w.codex.get(sessionId)!.dispatched).toHaveLength(0);
  });
});

describe('other session commands', () => {
  it('interrupts an open session and does nothing for one that is not open', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    expect((await w.run({ type: 'session.interrupt', requestId: rid(), sessionId })).ok).toBe(true);
    expect(w.codex.get(sessionId)!.calls).toContain('interrupt');
  });

  it('changes the model within the runtime only, and tells the open session', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const model = { runtime: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' };
    const result = await w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), model });
    expect(result.ok).toBe(true);
    expect((await session(w, 'session-a')).requestedModel).toEqual(model);
    expect(w.codex.get(sessionId)!.models).toEqual([{ ref: 'thread-1', model }]);
    const other = await w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), model: { runtime: 'claude', model: 'opus' } });
    expect(failed(other)).toBe('invalid_request');
    expect(failed(await w.run({ type: 'session.setModel', requestId: rid(), sessionId, expectedRevision: 0, model }))).toBe('stale_revision');
  });

  it('changes the agent of an ordinary session and reparents it within the ordinary tree', async () => {
    const w = await world();
    await w.repositories.agents.save(agent({ id: 'agent-2' as typeof AGENT, name: 'Writer' }), null);
    const { sessionId } = await created(w);
    const { sessionId: parent } = await created(w, 'codex', 'session-p');
    const setAgent = await w.run({ type: 'session.setAgent', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), agentId: 'agent-2' as typeof AGENT });
    expect(setAgent.ok).toBe(true);
    expect((await session(w, 'session-a')).agent).toEqual({ id: 'agent-2', revision: 0 });
    expect((await w.run({ type: 'session.reparent', requestId: rid(), sessionId, expectedRevision: await latest(w, 'session-a'), parentId: parent })).ok).toBe(true);
    expect((await session(w, 'session-a')).parentId).toBe(parent);
    const loop = await w.run({ type: 'session.reparent', requestId: rid(), sessionId: parent, expectedRevision: await latest(w, 'session-p'), parentId: sessionId });
    expect(failed(loop)).toBe('invalid_request');
  });

  it('stops a running native task of the session only', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const task = { id: NativeTaskId.parse('task-1'), sessionId, runtime: 'codex' as const, parentRef: 'thread-1', nativeRef: 'child-1', label: 'worker', state: 'running' as const, background: false, startedAt: '2026-10-29T01:00:00.000Z' };
    w.codex.get(sessionId)!.emit({ type: 'nativeTask.updated', task });
    await settle();
    expect((await w.run({ type: 'nativeTask.stop', requestId: rid(), sessionId, nativeTaskId: task.id })).ok).toBe(true);
    expect(w.codex.get(sessionId)!.stoppedTasks).toEqual([{ ref: 'thread-1', taskRef: 'child-1' }]);
    expect(failed(await w.run({ type: 'nativeTask.stop', requestId: rid(), sessionId, nativeTaskId: NativeTaskId.parse('other') }))).toBe('not_found');
  });

  it('saves agents with compare-and-set and keeps one that a session uses', async () => {
    const w = await world();
    expect(failed(await w.run({ type: 'agent.save', requestId: rid(), agent: agent({ name: 'New' }), expectedRevision: null }))).toBe('stale_revision');
    expect((await w.run({ type: 'agent.save', requestId: rid(), agent: agent({ name: 'New' }), expectedRevision: 0 })).ok).toBe(true);
    await created(w);
    expect(failed(await w.run({ type: 'agent.delete', requestId: rid(), agentId: AGENT, expectedRevision: 1 }))).toBe('invalid_transition');
  });

  it('saves preferences and pushes them; workflow and transfer commands are not available yet', async () => {
    const w = await world();
    expect((await w.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'light' } })).ok).toBe(true);
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'preferences.updated', preferences: { theme: 'light' } }));
    expect(failed(await w.run({ type: 'transfer.cancel', requestId: rid(), transferId: 't' as never }))).toBe('unsupported');
  });
});

describe('permissions (R-05, R-08)', () => {
  it('lets the GUI’s own MCP tools through without the policy: Codex elicitation from gui, Claude ToolSearch and mcp__gui__*', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const { sessionId: claudeId } = await created(w, 'claude', 'c-1');
    const elicitation = ask(w, sessionId, { kind: 'mcpElicitation', summary: 'gui wants input', elicitation: { mode: 'form', serverName: 'gui', message: 'm', requestedSchema: {} } });
    const toolSearch = w.claude.ask(permissionRequest(claudeId, { kind: 'permissions', summary: 'ToolSearch select:mcp__gui__send_message' }));
    const tool = w.claude.ask(permissionRequest(claudeId, { kind: 'permissions', summary: 'mcp__gui__report_to_root' }));
    const other = ask(w, sessionId, { kind: 'mcpElicitation', summary: 'x', elicitation: { mode: 'form', serverName: 'other', message: 'm', requestedSchema: {} } });
    w.decide = () => ({ action: 'escalate', rule: 'unrecognised', reason: 'not understood' });
    await settle();
    for (const h of [elicitation, toolSearch, tool]) expect(h.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });
    expect(other.decision).toBeUndefined();
    expect(other.holdState).toMatchObject({ reason: 'awaiting-user' });
    expect(w.contexts).toHaveLength(1);
  });

  it('answers what the policy approves, and holds what it escalates until the user decides on root', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const approved = ask(w, sessionId);
    await settle();
    expect(approved.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });

    w.decide = () => ({ action: 'escalate', rule: 'git-remote', reason: 'git push changes a remote' });
    const held = ask(w, sessionId, { id: PermissionRequestId.parse('perm-2'), command: 'git push', summary: 'Bash: git push' });
    await settle();
    expect(held.decision).toBeUndefined();
    expect(held.matchedRule).toBe('git-remote');
    const [escalation] = escalations(w);
    expect(escalation).toMatchObject({ kind: 'permission', state: 'open', rule: 'git-remote', rootSessionId: sessionId, ref: { kind: 'permission', permissionRequestId: 'perm-2' } });
    expect(escalation?.detail).not.toContain('git push changes a remote origin');
    expect(held.holdState).toEqual({ reason: 'awaiting-user', escalationId: escalation!.id });

    const respond = await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation!.id, decision: 'approve', note: 'ok' });
    expect(respond.ok).toBe(true);
    expect(held.decision).toMatchObject({ outcome: 'approve', decidedBy: 'user', escalationId: escalation!.id });
    expect(w.repositories.escalationRecords.get(escalation!.id)).toMatchObject({ state: 'approved', resolvedBy: 'user' });
    // Answered once: a second answer is refused.
    expect(failed(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: escalation!.id, decision: 'decline' }))).toBe('invalid_transition');
  });

  it('closes the escalation of a request the runtime withdrew, and refuses to answer it', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.decide = () => ({ action: 'escalate', rule: 'destructive', reason: 'fixed' });
    const held: FakeHandle = ask(w, sessionId);
    await settle();
    held.withdraw();
    w.codex.get(sessionId)!.emit({ type: 'permission.updated', request: { ...permissionRequest(sessionId), state: 'withdrawn' } });
    await settle();
    const [escalation] = escalations(w);
    expect(escalation).toMatchObject({ state: 'resolved', resolvedBy: 'system' });
  });

  it('builds the policy context: real roots, the injected resolver, and what the session wrote', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.emit({
      type: 'item.updated',
      item: { id: ItemId.parse('fc-1'), sessionId, kind: 'fileChange', changes: [{ path: 'src\\a.py', change: 'add' }], state: 'applied', startedAt: '2026-10-29T01:00:00.000Z', endedAt: '2026-10-29T01:00:01.000Z' },
    });
    await settle();
    ask(w, sessionId, { paths: ['E:\\work\\project\\out\\b.txt'], cwd: CWD });
    await settle();
    w.service.workspaceChanged(sessionId, REAL_CWD, `${REAL_CWD}\\.git\\hooks\\pre-commit`);
    ask(w, sessionId, { id: PermissionRequestId.parse('perm-3') });
    await settle();
    const context = w.contexts.at(-1)!;
    expect(context.folderScope).toMatchObject({ workspaceRoot: 'E:\\real\\project', writableRoots: ['E:\\real\\project'] });
    expect(context.writtenPaths).toEqual(expect.arrayContaining([`${CWD}\\src\\a.py`, 'E:\\work\\project\\out\\b.txt', `${REAL_CWD}\\.git\\hooks\\pre-commit`]));
    expect(context.resolveRealPath('E:\\work\\x')).toBe('E:\\real\\x');

    // A root that cannot be confirmed gives no write scope.
    w.realPath = () => null;
    ask(w, sessionId, { id: PermissionRequestId.parse('perm-4') });
    await settle();
    expect(w.contexts.at(-1)!.folderScope.writableRoots).toEqual([]);
  });
});

describe('runtime events', () => {
  it('stores turns, items, native tasks and completed messages, pushes everything, and stores no deltas', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    const turn = { id: TurnId.parse('turn-1'), sessionId, state: 'running' as const, startedAt: '2026-10-29T01:00:00.000Z' };
    codex.emit({ type: 'turn.updated', turn });
    codex.emit({ type: 'message.delta', sessionId, messageId: MessageId.parse('a-1'), delta: 'He' });
    codex.emit({ type: 'message.completed', message: { id: MessageId.parse('a-1'), sessionId, role: 'assistant', origin: { kind: 'agent' }, text: 'Hello', attachments: [], createdAt: '2026-10-29T01:00:00.000Z' } });
    codex.emit({ type: 'usage.tokens', usage: { sessionId, latest: { input: 1, output: 2, total: 3 }, at: '2026-10-29T01:00:00.000Z' } });
    codex.emit({ type: 'session.activity', sessionId, activity: 'idle', at: '2026-10-29T01:00:00.000Z' });
    await settle();
    const conversation = await w.repositories.conversations.get(sessionId);
    expect(conversation.turns).toEqual([turn]);
    expect(conversation.messages.map((m) => m.text)).toEqual(['Hello']);
    expect(w.events.map((e) => e.type)).toEqual(expect.arrayContaining(['turn.updated', 'message.delta', 'message.completed', 'usage.tokens']));
    for (const event of w.events) expect(AppEvent.safeParse(event).success).toBe(true);
  });

  it('marks the sessions of a runtime that exited as closed (expected) or error (crash)', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.codex.get(sessionId)!.emit({ type: 'runtime.exited', runtime: 'codex', sessionIds: [sessionId], expected: false, code: 1, signal: null, at: '2026-10-29T01:00:00.000Z' });
    await settle();
    expect((await session(w, 'session-a')).activity).toBe('error');
    expect(w.service.runtimes.isOpen('thread-1')).toBe(false);
    expect(w.closed).toContain(sessionId);
    // The dead host is not reused: the next send resumes the session on a new adapter.
    const crashed = w.codex.get(sessionId)!;
    expect((await send(w, sessionId, 'again', 'm-7', await latest(w, 'session-a'))).ok).toBe(true);
    expect(w.codex.get(sessionId)).not.toBe(crashed);
    expect(w.codex.get(sessionId)!.resumed).toMatchObject([{ nativeSessionRef: 'thread-1' }]);
  });
});

describe('send_message (R-03, R-11)', () => {
  const call = (w: World, caller: SessionId, to: string, content = 'ping', operationId = 'op-1') =>
    w.service.sendMessage({ to: to as SessionId, content }, { caller, operationId: OperationId.parse(operationId), sourceCallRef: `call-${operationId}` });

  it('delivers to a session of the same tool at once, marked as a peer message, and maps a resend to the same operation', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    const result = await call(w, a, b);
    expect(result).toMatchObject({ status: 'accepted', operationId: 'op-1', delivery: 'sent' });
    expect(w.codex.get(b)!.dispatched[0]).toMatchObject({ text: 'ping', origin: { kind: 'peer', fromSessionId: a } });
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'peerMessage.updated' }));
    expect(await call(w, a, b)).toMatchObject({ status: 'duplicate', delivery: 'sent' });
    expect(w.codex.get(b)!.dispatched).toHaveLength(1);
  });

  it('asks the user before a message goes to another tool, and sends it only when approved', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: c } = await created(w, 'claude', 'session-c');
    const result = await call(w, a, c, 'cross');
    expect(result).toMatchObject({ status: 'awaiting-confirmation' });
    expect(w.claude.dispatched).toHaveLength(0);
    const escalationId = result.status === 'awaiting-confirmation' ? result.escalationId : ('' as never);
    expect(w.repositories.escalationRecords.get(escalationId)).toMatchObject({ kind: 'confirmation', state: 'open' });
    expect((await w.run({ type: 'escalation.respond', requestId: rid(), escalationId, decision: 'approve' })).ok).toBe(true);
    expect(w.claude.dispatched).toMatchObject([{ text: 'cross', origin: { kind: 'peer', fromSessionId: a } }]);
  });

  it('rejects an unknown target and a message to itself', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    expect(await call(w, a, 'nobody')).toMatchObject({ status: 'rejected', rejection: { reason: 'unknown-target' } });
    expect(await call(w, a, a)).toMatchObject({ status: 'rejected', rejection: { reason: 'invalid-input' } });
  });
});

describe('restart and exit', () => {
  it('after a restart: sessions are closed, held requests withdrawn with their escalations, and a pending message is sent after resuming', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.decide = () => ({ action: 'escalate', rule: 'destructive', reason: 'fixed' });
    const req = permissionRequest(sessionId);
    w.codex.get(sessionId)!.emit({ type: 'permission.updated', request: req });
    ask(w, sessionId);
    await settle();
    // A message accepted but not dispatched before the crash.
    await w.service.delivery.accept({
      kind: 'user-message',
      operationId: OperationId.parse('user-message:m-9'),
      payloadHash: (await import('../delivery/testing/fixtures')).hashOf('later'),
      payload: 'later',
      proposalRevision: 0,
      target: { sessionId, nativeSessionRef: 'thread-1' },
      at: '2026-10-29T01:00:00.000Z',
      context: { runtime: 'codex', cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime: 'codex', model: 'gpt-6-luna' }, readOnly: false } },
    });

    const after = w.restart();
    const report = await after.service.start();
    expect(report.dispatched).toMatchObject([{ operationId: 'user-message:m-9', outcome: { status: 'sent' } }]);
    const codex = after.codex.get(sessionId)!;
    // Resumed first (prepareTarget), with a new mount, then sent once as the user's.
    expect(codex.resumed).toMatchObject([{ sessionId, nativeSessionRef: 'thread-1', cwd: CWD, mcp: after.mounts[0]!.mount }]);
    expect(codex.dispatched).toMatchObject([{ text: 'later', origin: { kind: 'user' } }]);
    expect(escalations(after).every((e: Escalation) => e.state === 'resolved')).toBe(true);
    expect((await after.repositories.conversations.get(sessionId)).permissionRequests.every((r) => r.state === 'withdrawn')).toBe(true);
  });

  it('after a restart an unknown delivery is only reconciled: never dispatched again, and escalated once', async () => {
    const w = await world();
    w.configure = (adapter) => adapter.startModes.push('lost');
    const { sessionId } = await created(w);
    expect(escalations(w)).toHaveLength(1);
    const after = w.restart();
    after.configure = () => undefined;
    await after.service.start();
    await settle();
    expect(after.codex.get(sessionId)?.started ?? []).toHaveLength(0);
    expect((await after.store.get(OperationId.parse(`provision:${sessionId}`)))?.delivery.state).toBe('unknown');
    expect(escalations(after).filter((e) => e.kind === 'delivery-unknown')).toHaveLength(1);
  });

  it('on exit closes every open session (the main process then ends its Job) and refuses new commands', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    await created(w, 'claude', 'c-1');
    await w.service.shutdown();
    expect(w.codex.get(sessionId)!.closedSessions).toEqual(['thread-1']);
    expect(w.claude.closedSessions).toHaveLength(1);
    expect(w.closed).toEqual(expect.arrayContaining([sessionId, 'c-1']));
    expect(w.claude.calls).toContain('close');
    expect((await session(w, 'session-a')).activity).toBe('closed');
    expect(failed(await send(w, sessionId, 'late'))).toBe('runtime_unavailable');
  });
});

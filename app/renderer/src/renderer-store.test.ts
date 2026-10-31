import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command, CONTRACTS_VERSION, ItemId, MessageId, NativeTaskId, RequestId } from '../../../contracts';
import type { CommandResult, EventEnvelope, Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { COMMAND_HISTORY_LIMIT, commandTarget, createRendererStore } from './renderer-store';
import { agentDeleteCommand, agentSaveCommand, createIpcAgentRepository } from './agent-repository';
import { createIpcWorkflowRepository, workflowSaveCommand } from './workflow-repository';
import { deferred, fakeBridge } from './ipc-test-helpers';

const planner = fixtureSnapshot.agents[0]!;
const envelope = (seq: number, event: EventEnvelope['event']): EventEnvelope => ({ schemaVersion: CONTRACTS_VERSION, seq, event });
afterEach(() => vi.useRealTimers());

describe('renderer IPC store', () => {
  it('updates projects and replaces the lock list from authoritative events without dispatching commands', async () => {
    const fake = fakeBridge(); const store = createRendererStore(fake.bridge); await store.start();
    const project = { ...fixtureSnapshot.projects[0]!, name: '最新專案' };
    fake.emit(envelope(fixtureSnapshot.seq + 1, { type: 'project.updated', project }));
    expect(store.getSnapshot().snapshot!.projects).toEqual([project]);
    fake.emit(envelope(fixtureSnapshot.seq + 2, { type: 'locks.updated', locks: [], at: project.updatedAt }));
    expect(store.getSnapshot().snapshot!.locks).toEqual([]);
    fake.emit(envelope(fixtureSnapshot.seq + 3, { type: 'locks.updated', locks: fixtureSnapshot.locks, at: project.updatedAt }));
    expect(store.getSnapshot().snapshot!.locks).toEqual(fixtureSnapshot.locks);
    expect(fake.bridge.send).not.toHaveBeenCalled(); store.dispose();
  });

  it('isolates uncertain cleanup receipts by both task and instance ID', async () => {
    const fake = fakeBridge(); const store = createRendererStore(fake.bridge); await store.start();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'unknown_outcome', message: '', retryable: true, mayHaveSideEffects: true }));
    const first = Command.parse({ type: 'task.retryCleanup', requestId: 'clean-1', instanceId: 'inst-login', taskId: 'task-d' });
    const next = Command.parse({ type: 'task.retryCleanup', requestId: 'clean-2', instanceId: 'inst-login', taskId: 'task-e' });
    await store.send(first); await store.send(next);
    expect(commandTarget(first)).not.toBe(commandTarget(next));
    expect(fake.bridge.send).toHaveBeenCalledTimes(2);
    await store.send(Command.parse({ ...first, requestId: 'clean-3' }));
    expect(fake.bridge.send).toHaveBeenCalledTimes(2); store.dispose();
  });
  it('cancels a subscription during loading and ignores its late snapshot after remount', async () => {
    const fake = fakeBridge();
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const store = createRendererStore(fake.bridge);
    const first = store.start();
    await Promise.resolve();
    const oldListener = [...fake.listeners][0]!;
    store.dispose();
    expect(fake.listeners.size).toBe(0);
    await store.start();
    const state = store.getSnapshot();
    load.resolve({ ...fixtureSnapshot, seq: 100 });
    oldListener(envelope(101, { type: 'session.updated', session: { ...fixtureSnapshot.sessions[0]!, title: 'stale callback' } }));
    await first;
    expect(store.getSnapshot()).toBe(state);
    expect(fake.listeners.size).toBe(1);
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('subscribes before loading, buffers and sorts newer events, ignores duplicate and old seq', async () => {
    const fake = fakeBridge();
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const store = createRendererStore(fake.bridge);
    const starting = store.start();
    await Promise.resolve();
    expect(fake.listeners.size).toBe(1);
    const session = fixtureSnapshot.sessions[0]!;
    fake.emit(envelope(12, { type: 'session.updated', session: { ...session, title: 'newest' } }));
    fake.emit(envelope(11, { type: 'session.updated', session: { ...session, title: 'older' } }));
    load.resolve({ ...fixtureSnapshot, seq: 10 });
    await starting;
    expect(store.getSnapshot().snapshot?.sessions[0]?.title).toBe('newest');
    const state = store.getSnapshot();
    fake.emit(envelope(12, { type: 'session.updated', session }));
    fake.emit(envelope(2, { type: 'session.updated', session }));
    expect(store.getSnapshot()).toBe(state);
    expect(state.snapshot?.seq).toBe(12);
    store.dispose();
  });

  it('reconnects from a fresh snapshot, ignores callbacks from the old subscription, and never sends', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const oldListener = [...fake.listeners][0]!;
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const reconnecting = store.reconnect();
    await Promise.resolve();
    const preferences = { ...fixtureSnapshot.preferences, theme: 'light' as const };
    oldListener(envelope(100, { type: 'preferences.updated', preferences, at: '2026-10-26T00:00:00Z' }));
    fake.emit(envelope(52, { type: 'preferences.updated', preferences, at: '2026-10-26T00:00:00Z' }));
    load.resolve({ ...fixtureSnapshot, seq: 51 });
    await reconnecting;
    expect(fake.listeners.size).toBe(1);
    expect(store.getSnapshot().snapshot).toMatchObject({ seq: 52, preferences });
    await store.start();
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('retains prior data on read failure, permits read recovery, and does not fall back to demo', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const snapshot = store.getSnapshot().snapshot;
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    await store.reconnect();
    expect(store.getSnapshot()).toMatchObject({ snapshot, connection: 'error' });
    await store.reconnect();
    expect(store.getSnapshot().connection).toBe('ready');
    store.dispose();
  });

  it('times out a stalled snapshot and can reconnect without accepting its late result', async () => {
    vi.useFakeTimers();
    const fake = fakeBridge();
    const stalled = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(stalled.promise);
    const store = createRendererStore(fake.bridge, 50);
    const loading = store.start();
    await vi.advanceTimersByTimeAsync(50);
    await loading;
    expect(store.getSnapshot().connection).toBe('error');
    await store.reconnect();
    stalled.resolve({ ...fixtureSnapshot, seq: 999 });
    await Promise.resolve();
    expect(store.getSnapshot().snapshot?.seq).toBe(fixtureSnapshot.seq);
    store.dispose();
  });

  it('shares authoritative Agent and Workflow snapshots after successful saves', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    fake.bridge.send.mockImplementation(async input => {
      await Promise.resolve();
      const command = Command.parse(input);
      if (command.type === 'agent.save') fake.data.snapshot.agents = [{ ...command.agent, revision: 2 }];
      if (command.type === 'workflow.save') fake.data.snapshot.workflows = [{ ...command.workflow, revision: 2 }];
      return { ok: true, requestId: command.requestId, revision: 2, created: [] };
    });
    const agents = createIpcAgentRepository(store);
    const workflows = createIpcWorkflowRepository(store);
    await agents.save(agentSaveCommand(planner, planner.revision));
    await workflows.save(workflowSaveCommand(fixtureSnapshot.workflows[0]!, 1));
    expect(agents.getSnapshot()).toBe(store.getSnapshot().snapshot?.agents);
    expect(workflows.getSnapshot()).toBe(store.getSnapshot().snapshot?.workflows);
    expect(agents.getSnapshot()[0]?.revision).toBe(2);
    expect(workflows.getSnapshot()[0]?.revision).toBe(2);
    store.dispose();
  });

  it('refreshes again after a save completes during an earlier snapshot read', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const command = agentSaveCommand(planner, planner.revision);
    const sending = store.send(command);
    await Promise.resolve();
    const read = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(read.promise);
    const refreshing = store.reconnect();
    await Promise.resolve();
    fake.data.snapshot.agents = [{ ...planner, revision: 2 }];
    response.resolve({ ok: true, requestId: command.requestId, revision: 2, created: [] });
    read.resolve(fixtureSnapshot);
    await refreshing;
    await sending;
    expect(store.getSnapshot().snapshot?.agents[0]?.revision).toBe(2);
    store.dispose();
  });

  it('preserves null requestId failures and treats mismatched receipts or rejection as unknown', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    fake.bridge.send.mockResolvedValueOnce({ ok: false, requestId: null, code: 'invalid_request', message: 'ignored', retryable: false, mayHaveSideEffects: false });
    expect(await store.send(agentSaveCommand(planner, 1))).toMatchObject({ requestId: null, code: 'invalid_request' });
    fake.bridge.send.mockResolvedValueOnce({ ok: true, requestId: RequestId.parse('wrong-request'), created: [] });
    expect(await store.send(agentSaveCommand(planner, 1))).toMatchObject({ code: 'unknown_outcome', mayHaveSideEffects: true });
    fake.bridge.send.mockRejectedValueOnce(new Error('lost transport'));
    expect(await store.send(workflowSaveCommand(fixtureSnapshot.workflows[0]!, 1))).toMatchObject({ code: 'unknown_outcome' });
    store.dispose();
  });

  it('blocks pending/unknown targets across reconnects and resolves a late receipt without replay', async () => {
    vi.useFakeTimers();
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge, 50);
    await store.start();
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const command = agentSaveCommand(planner, 1);
    const sending = store.send(command);
    expect(store.isBlocked('agent.save', `agent:${planner.id}`)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await sending).toMatchObject({ code: 'unknown_outcome' });
    await store.reconnect();
    expect(await store.send(agentSaveCommand(planner, 1))).toMatchObject({ code: 'runtime_unavailable', mayHaveSideEffects: false });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    response.resolve({ ok: true, requestId: command.requestId, revision: 2, created: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.isBlocked('agent.save', `agent:${planner.id}`)).toBe(false);
    expect(await store.send(command)).toMatchObject({ code: 'runtime_unavailable', mayHaveSideEffects: false });
    expect(fake.bridge.send).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it('does not apply events after read failure or invalid input, including an invalid event during a read', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const snapshot = store.getSnapshot().snapshot;
    const update = envelope(fixtureSnapshot.seq + 1, { type: 'session.updated', session: { ...fixtureSnapshot.sessions[0]!, title: 'must not apply' } });
    fake.bridge.snapshot.mockRejectedValueOnce(new Error('offline'));
    await store.reconnect();
    fake.emit(update);
    expect(store.getSnapshot().snapshot).toBe(snapshot);
    await store.reconnect();
    const ready = store.getSnapshot().snapshot;
    fake.emit({ ...update, seq: -1 });
    fake.emit(update);
    expect(store.getSnapshot()).toMatchObject({ connection: 'error', snapshot: ready });
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const refreshing = store.reconnect();
    await Promise.resolve();
    fake.emit({ ...update, seq: -1 });
    load.resolve({ ...fixtureSnapshot, seq: 100 });
    await refreshing;
    expect(store.getSnapshot()).toMatchObject({ connection: 'error', snapshot: ready });
    store.dispose();
  });

  it('automatically reads a snapshot for a sequence gap and applies only contiguous buffered events', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const session = fixtureSnapshot.sessions[0]!;
    fake.emit(envelope(fixtureSnapshot.seq + 2, { type: 'session.updated', session: { ...session, title: 'after gap' } }));
    expect(store.getSnapshot().connection).toBe('loading');
    expect(store.getSnapshot().snapshot?.sessions[0]?.title).toBe(session.title);
    load.resolve({ ...fixtureSnapshot, seq: fixtureSnapshot.seq + 1 });
    await store.start();
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ connection: 'ready', snapshot: { seq: fixtureSnapshot.seq + 2 } });
    expect(store.getSnapshot().snapshot?.sessions[0]?.title).toBe('after gap');
    expect(fake.bridge.send).not.toHaveBeenCalled();
    store.dispose();
  });

  it('retries a gap found in buffered events once, without applying an incomplete sequence', async () => {
    const fake = fakeBridge();
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const store = createRendererStore(fake.bridge);
    const starting = store.start();
    await Promise.resolve();
    const session = { ...fixtureSnapshot.sessions[0]!, title: 'fresh snapshot' };
    fake.emit(envelope(fixtureSnapshot.seq + 3, { type: 'session.updated', session }));
    fake.data.snapshot = { ...fixtureSnapshot, seq: fixtureSnapshot.seq + 3, sessions: [session] };
    load.resolve(fixtureSnapshot);
    await starting;
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ connection: 'ready', snapshot: fake.data.snapshot });
    store.dispose();
  });

  it('allows interrupt and native task stops after send timeout, and only unlocks resending after acknowledgement', async () => {
    vi.useFakeTimers();
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge, 50);
    await store.start();
    const session = fixtureSnapshot.sessions[0]!;
    const command: Command = { type: 'session.send', requestId: RequestId.parse('send-timeout'), sessionId: session.id, messageId: MessageId.parse('new-message'), expectedRevision: session.revision, text: 'hello', attachments: [] };
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const sending = store.send(command);
    store.acknowledge(command.type, commandTarget(command));
    expect(store.isBlocked(command.type, commandTarget(command))).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await sending).toMatchObject({ code: 'unknown_outcome' });
    const retry = { ...command, requestId: RequestId.parse('send-after-check') };
    expect(await store.send(retry)).toMatchObject({ code: 'runtime_unavailable', mayHaveSideEffects: false });
    await store.send({ type: 'session.interrupt', requestId: RequestId.parse('interrupt'), sessionId: session.id });
    await store.send({ type: 'nativeTask.stop', requestId: RequestId.parse('stop'), sessionId: session.id, nativeTaskId: NativeTaskId.parse('task') });
    expect(fake.bridge.send).toHaveBeenCalledTimes(3);
    store.acknowledge(command.type, commandTarget(command));
    expect(store.isBlocked(command.type, commandTarget(command))).toBe(false);
    await store.send(retry);
    expect(fake.bridge.send).toHaveBeenCalledTimes(4);
    response.resolve({ ok: false, requestId: command.requestId, code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.isBlocked(command.type, commandTarget(command))).toBe(false);
    store.dispose();
  });

  it('scopes stop locks to each native task and save locks independently of delete', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: false, requestId: RequestId.parse(command.requestId), code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true }));
    const stop: Command = { type: 'nativeTask.stop', requestId: RequestId.parse('stop-a'), sessionId: fixtureSnapshot.sessions[0]!.id, nativeTaskId: NativeTaskId.parse('task-a') };
    await store.send(stop);
    expect(await store.send({ ...stop, requestId: RequestId.parse('stop-a-again') })).toMatchObject({ code: 'runtime_unavailable', mayHaveSideEffects: false });
    await store.send({ ...stop, requestId: RequestId.parse('stop-b'), nativeTaskId: NativeTaskId.parse('task-b') });
    await store.send(agentSaveCommand(planner, 1));
    await store.send(agentDeleteCommand(planner));
    expect(fake.bridge.send).toHaveBeenCalledTimes(4);
    store.dispose();
  });

  it('refreshes only successful catalog edits and preserves streams across the refresh', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const sessionId = fixtureSnapshot.sessions[0]!.id;
    const messageId = MessageId.parse('ongoing');
    const itemId = ItemId.parse('ongoing-output');
    fake.emit(envelope(fixtureSnapshot.seq + 1, { type: 'message.delta', sessionId, messageId, delta: 'first' }));
    fake.emit(envelope(fixtureSnapshot.seq + 2, { type: 'item.outputDelta', sessionId, itemId, delta: 'output' }));
    fake.data.snapshot.seq += 2;
    fake.bridge.send.mockImplementation(command => Promise.resolve({ ok: true, requestId: RequestId.parse(command.requestId), created: [] }));
    await store.send({ type: 'session.interrupt', requestId: RequestId.parse('interrupt'), sessionId });
    await store.send({ type: 'preferences.set', requestId: RequestId.parse('prefs'), preferences: fixtureSnapshot.preferences });
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(1);
    const load = deferred<Snapshot>();
    fake.bridge.snapshot.mockReturnValueOnce(load.promise);
    const saving = store.send(agentSaveCommand(planner, 1));
    await vi.waitFor(() => expect(store.getSnapshot().connection).toBe('loading'));
    expect(Object.values(store.getSnapshot().messageStreams)[0]?.delta).toBe('first');
    fake.emit(envelope(fake.data.snapshot.seq + 1, { type: 'message.delta', sessionId, messageId, delta: ' second' }));
    load.resolve(fake.data.snapshot);
    await saving;
    expect(Object.values(store.getSnapshot().messageStreams)[0]?.delta).toBe('first second');
    expect(Object.values(store.getSnapshot().itemStreams)[0]?.delta).toBe('output');
    fake.data.snapshot.seq++;
    await store.send(agentDeleteCommand(planner));
    await store.send(workflowSaveCommand(fixtureSnapshot.workflows[0]!, 1));
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(4);
    fake.bridge.send.mockResolvedValueOnce({ ok: false, requestId: null, code: 'stale_revision', message: '', retryable: false, mayHaveSideEffects: false });
    await store.send(agentSaveCommand(planner, 1));
    expect(fake.bridge.snapshot).toHaveBeenCalledTimes(4);
    fake.data.snapshot.messages.push({ ...fixtureSnapshot.messages[0]!, id: messageId, sessionId, text: 'complete' });
    await store.reconnect();
    expect(Object.values(store.getSnapshot().messageStreams)).toHaveLength(0);
    store.dispose();
  });

  it('bounds history without dropping unresolved protection, replay protection, or resurrecting late history', async () => {
    vi.useFakeTimers();
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge, 50);
    await store.start();
    const response = deferred<CommandResult>();
    fake.bridge.send.mockReturnValueOnce(response.promise);
    const command = agentSaveCommand(planner, 1);
    const sending = store.send(command);
    await vi.advanceTimersByTimeAsync(50);
    await sending;
    for (let i = 0; i < COMMAND_HISTORY_LIMIT + 3; i++) {
      await store.send({ type: 'preferences.set', requestId: RequestId.parse(`history-${i}`), preferences: fixtureSnapshot.preferences });
    }
    expect(Object.keys(store.getSnapshot().commands)).toHaveLength(COMMAND_HISTORY_LIMIT);
    expect(store.getSnapshot().commands[command.requestId]).toBeUndefined();
    expect(store.isBlocked('agent.save', `agent:${planner.id}`)).toBe(true);
    store.acknowledge('agent.save', `agent:${planner.id}`);
    expect(store.isBlocked('agent.save', `agent:${planner.id}`)).toBe(false);
    expect(await store.send(command)).toMatchObject({ code: 'runtime_unavailable', mayHaveSideEffects: false });
    response.resolve({ ok: false, requestId: command.requestId, code: 'unknown_outcome', message: '', retryable: false, mayHaveSideEffects: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().commands[command.requestId]).toBeUndefined();
    expect(Object.keys(store.getSnapshot().commands)).toHaveLength(COMMAND_HISTORY_LIMIT);
    expect(store.isBlocked('agent.save', `agent:${planner.id}`)).toBe(false);
    store.dispose();
  });

  it('keeps incomplete streaming text separate and updates scoped observations', async () => {
    const fake = fakeBridge();
    const store = createRendererStore(fake.bridge);
    await store.start();
    const message = fixtureSnapshot.messages[0]!;
    const session = fixtureSnapshot.sessions[0]!;
    let seq = fixtureSnapshot.seq;
    const emit = (event: EventEnvelope['event']) => fake.emit(envelope(++seq, event));
    emit({ type: 'message.delta', sessionId: session.id, messageId: message.id, delta: '+' });
    expect(store.getSnapshot().snapshot?.messages[0]?.text).toBe(message.text + '+');
    emit({ type: 'message.completed', message });
    expect(store.getSnapshot().snapshot?.messages[0]?.text).toBe(message.text);
    const streamingId = MessageId.parse('streaming-message');
    emit({ type: 'message.delta', sessionId: session.id, messageId: streamingId, delta: '片段一' });
    emit({ type: 'message.delta', sessionId: session.id, messageId: streamingId, delta: '片段二' });
    expect(store.getSnapshot().snapshot?.messages.some(item => item.id === streamingId)).toBe(false);
    expect(Object.values(store.getSnapshot().messageStreams)[0]?.delta).toBe('片段一片段二');
    emit({ type: 'message.completed', message: { ...message, id: streamingId, sessionId: session.id, text: '完整訊息' } });
    expect(Object.values(store.getSnapshot().messageStreams)).toHaveLength(0);
    expect(store.getSnapshot().snapshot?.messages.at(-1)?.text).toBe('完整訊息');
    const usage = { sessionId: session.id, latest: { input: 1, output: 2, total: 3 }, at: session.updatedAt };
    emit({ type: 'usage.tokens', usage });
    emit({ type: 'model.observed', sessionId: session.id, observed: { source: 'unknown' }, at: session.updatedAt });
    const before = store.getSnapshot().snapshot?.peerMessages;
    emit({ type: 'runtime.exited', runtime: 'claude', sessionIds: [session.id], expected: false, code: 1, signal: null, at: session.updatedAt });
    expect(store.getSnapshot().snapshot?.sessions[0]?.tokenUsage).toEqual(usage);
    expect(store.getSnapshot().snapshot?.peerMessages).toBe(before);
    expect(store.getSnapshot().runtimeExits.claude?.expected).toBe(false);
    store.dispose();
  });
});

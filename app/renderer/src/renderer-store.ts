import { Command, CommandResult, EventBatch, EventEnvelope, MERGEABLE_EVENT_TYPES, Snapshot } from '../../../contracts';
import type { AppEvent } from '../../../contracts';
import type { AwgBridge } from '../../preload/bridge-types';
import { blocksResubmit, unknownResult } from './command-feedback';
import { mergeHistory, queryBridge, queryId } from './query-bridge';
import type { RendererBridge } from './query-bridge';
import type { SessionId } from '../../../contracts';

const isDelta = (event: AppEvent): event is Extract<AppEvent, { type: (typeof MERGEABLE_EVENT_TYPES)[number] }> =>
  (MERGEABLE_EVENT_TYPES as readonly string[]).includes(event.type);

export interface CommandActivity {
  command: Command; result: CommandResult | null; reviewed?: boolean;
  createCheck?: 'found' | 'missing';
  interruptRetryReady?: boolean;
}
export const COMMAND_HISTORY_LIMIT = 50;
export const INTERRUPT_WAIT_MS = 10000;
export interface RendererState {
  snapshot: Snapshot | null;
  connection: 'idle' | 'loading' | 'ready' | 'error';
  commands: Readonly<Record<string, CommandActivity>>;
  blockedCommands: Readonly<Record<string, CommandActivity>>;
  // Deltas do not contain enough metadata to invent a canonical Message or SessionItem.
  messageStreams: Readonly<Record<string, Extract<AppEvent, { type: 'message.delta' }>>>;
  itemStreams: Readonly<Record<string, Extract<AppEvent, { type: 'item.outputDelta' }>>>;
  limits: Extract<AppEvent, { type: 'usage.limits' }> | null;
  runtimeExits: Readonly<Record<string, Extract<AppEvent, { type: 'runtime.exited' }>>>;
  closeCauses?: Readonly<Record<string, 'idle' | 'process-limit'>>;
}
const upsert = <T extends { id: string }>(items: T[], item: T): T[] => items.some(value => value.id === item.id)
  ? items.map(value => value.id === item.id ? item : value) : [...items, item];
const without = <T>(items: Readonly<Record<string, T>>, key: string) => {
  const next = { ...items }; delete next[key]; return next;
};
const streamKey = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);

export function sessionCanInterrupt(snapshot: Snapshot, sessionId: string): boolean {
  const activity = snapshot.sessions.find(session => session.id === sessionId)?.activity;
  return activity === 'running' || activity === 'waiting-user' || activity === 'waiting-lock'
    || snapshot.turns.some(turn => turn.sessionId === sessionId && !turn.nativeTaskId && turn.state === 'running');
}

export function sessionBlocksSend(snapshot: Snapshot, sessionId: string): boolean {
  return snapshot.sessions.some(session => session.id === sessionId && session.activity === 'running')
    || snapshot.turns.some(turn => turn.sessionId === sessionId && turn.state === 'running');
}

/** Apply only observed facts. A runtime exit does not establish a delivery or turn outcome. */
export function applyEnvelope(state: RendererState, envelope: EventEnvelope): RendererState {
  if (!state.snapshot || envelope.seq <= state.snapshot.seq) return state;
  const snapshot = { ...state.snapshot, seq: envelope.seq };
  const next = { ...state, snapshot };
  const event = envelope.event;
  switch (event.type) {
    case 'session.updated':
      snapshot.sessions = upsert(snapshot.sessions, event.session);
      if (event.session.activity !== 'closed') next.closeCauses = without(state.closeCauses ?? {}, event.session.id);
      break;
    case 'session.activity':
      snapshot.sessions = snapshot.sessions.map(session => session.id === event.sessionId ? { ...session, activity: event.activity, updatedAt: event.at } : session);
      next.closeCauses = event.cause ? { ...state.closeCauses, [event.sessionId]: event.cause } : without(state.closeCauses ?? {}, event.sessionId);
      break;
    case 'turn.updated': snapshot.turns = upsert(snapshot.turns, event.turn); break;
    case 'message.completed':
      snapshot.messages = upsert(snapshot.messages, event.message);
      next.messageStreams = without(state.messageStreams, streamKey(event.message.sessionId, event.message.id)); break;
    case 'message.delta': {
      const key = streamKey(event.sessionId, event.messageId);
      if (snapshot.messages.some(message => message.sessionId === event.sessionId && message.id === event.messageId)) {
        snapshot.messages = snapshot.messages.map(message => message.sessionId === event.sessionId && message.id === event.messageId ? { ...message, text: message.text + event.delta } : message);
      } else next.messageStreams = { ...state.messageStreams, [key]: { ...event, delta: (state.messageStreams[key]?.delta ?? '') + event.delta } };
      break;
    }
    case 'item.updated':
      snapshot.items = upsert(snapshot.items, event.item);
      next.itemStreams = without(state.itemStreams, streamKey(event.item.sessionId, event.item.id)); break;
    case 'item.outputDelta': {
      const key = streamKey(event.sessionId, event.itemId);
      if (snapshot.items.some(item => item.id === event.itemId && item.sessionId === event.sessionId && item.kind === 'command')) {
        snapshot.items = snapshot.items.map(item => item.id === event.itemId && item.sessionId === event.sessionId && item.kind === 'command' ? { ...item, output: item.output + event.delta } : item);
      } else next.itemStreams = { ...state.itemStreams, [key]: { ...event, delta: (state.itemStreams[key]?.delta ?? '') + event.delta } };
      break;
    }
    case 'permission.updated': snapshot.permissionRequests = upsert(snapshot.permissionRequests, event.request); break;
    case 'nativeTask.updated': {
      const matches = (task: Snapshot['nativeTasks'][number]) => task.id === event.task.id && task.sessionId === event.task.sessionId && task.runtime === event.task.runtime;
      snapshot.nativeTasks = snapshot.nativeTasks.some(matches) ? snapshot.nativeTasks.map(task => matches(task) ? event.task : task) : [...snapshot.nativeTasks, event.task]; break;
    }
    case 'artifact.updated': snapshot.artifacts = upsert(snapshot.artifacts, event.artifact); break;
    case 'instance.updated': snapshot.instances = upsert(snapshot.instances, event.instance); break;
    case 'handoff.updated': snapshot.handoffs = upsert(snapshot.handoffs, event.handoff); break;
    case 'peerMessage.updated': snapshot.peerMessages = upsert(snapshot.peerMessages, event.message); break;
    case 'escalation.updated': snapshot.escalations = upsert(snapshot.escalations, event.escalation); break;
    case 'transfer.updated': snapshot.transfers = upsert(snapshot.transfers, event.proposal); break;
    case 'usage.tokens':
      if (!event.usage.nativeTaskId) snapshot.sessions = snapshot.sessions.map(session => session.id === event.usage.sessionId ? { ...session, tokenUsage: event.usage } : session);
      break;
    case 'usage.limits': next.limits = event; break;
    case 'modelOptions.updated': snapshot.modelOptions = [...snapshot.modelOptions.filter(option => option.runtime !== event.runtime), ...event.options]; break;
    case 'preferences.updated': snapshot.preferences = event.preferences; break;
    case 'agent.updated': snapshot.agents = upsert(snapshot.agents, event.agent); break;
    case 'agent.deleted': snapshot.agents = snapshot.agents.filter(agent => agent.id !== event.agentId); break;
    case 'workflow.updated': snapshot.workflows = upsert(snapshot.workflows, event.workflow); break;
    case 'project.updated': snapshot.projects = upsert(snapshot.projects, event.project); break;
    case 'locks.updated': snapshot.locks = event.locks; break;
    // The subscription reloads the authoritative Snapshot before applying this sequence.
    case 'snapshot.invalidated': break;
    case 'storage.updated': snapshot.storage = event.storage; break;
    case 'app.readOnly': snapshot.app = { status: 'read-only', reason: event.reason, location: event.location }; break;
    case 'model.observed': snapshot.sessions = snapshot.sessions.map(session => session.id === event.sessionId ? { ...session, observedModel: event.observed } : session); break;
    case 'runtime.exited': next.runtimeExits = { ...state.runtimeExits, [event.runtime]: event }; break;
    default: { const exhaustive: never = event; return exhaustive; }
  }
  return next;
}

export function commandTarget(command: Command): string {
  if (command.type === 'backup.restore' || command.type === 'backup.cancelRestore') return 'storage';
  if (command.type === 'task.retryCleanup') return `task:${JSON.stringify([command.instanceId, command.taskId])}`;
  if ('nativeTaskId' in command) return `nativeTask:${JSON.stringify([command.sessionId, command.nativeTaskId])}`;
  if ('sessionId' in command) return `session:${command.sessionId}`;
  if ('agent' in command) return `agent:${command.agent.id}`;
  if ('agentId' in command) return `agent:${command.agentId}`;
  if ('workflow' in command) return `workflow:${command.workflow.id}`;
  if ('instanceId' in command) return `instance:${command.instanceId}`;
  if ('transferId' in command) return `transfer:${command.transferId}`;
  if ('escalationId' in command) return `escalation:${command.escalationId}`;
  return 'preferences';
}

export function createRendererStore(bridge: RendererBridge, timeoutMs = 15000) {
  let state: RendererState = { snapshot: null, connection: 'idle', commands: {}, blockedCommands: {}, messageStreams: {}, itemStreams: {}, limits: null, runtimeExits: {} };
  const submittedIds = new Set<string>();
  const blockKey = (type: Command['type'], target: string) => JSON.stringify([type, target]);
  const listeners = new Set<() => void>();
  const interruptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let unsubscribe: (() => void) | undefined;
  let loading: Promise<void> | undefined;
  let generation = 0;
  type Delivery = EventEnvelope | EventBatch;
  let buffer: Delivery[] | null = null;
  let invalidatedSeq = 0;
  let notificationPending = false;
  let notificationFrame: number | undefined;
  const publish = (next: RendererState, defer = false) => {
    if (next === state) return;
    // These guards survive pane/route changes.
    for (const [key, activity] of Object.entries(next.blockedCommands)) {
      const { command, result } = activity;
      if (!next.snapshot || !result) continue;
      const newerRevision = command.type === 'session.send' && !result.ok && result.code === 'stale_revision' && !blocksResubmit(result)
        && next.snapshot.sessions.some(session => session.id === command.sessionId && session.revision > command.expectedRevision);
      const interrupted = command.type === 'session.interrupt' && result.ok && !sessionCanInterrupt(next.snapshot, command.sessionId);
      if (newerRevision || interrupted) next = { ...next, blockedCommands: without(next.blockedCommands, key) };
    }
    for (const [id, timer] of interruptTimers) {
      if (!Object.values(next.blockedCommands).some(activity => activity.command.requestId === id)) {
        clearTimeout(timer); interruptTimers.delete(id);
      }
    }
    state = next;
    if (defer) {
      if (!notificationPending) {
        notificationPending = true;
        const notify = () => { notificationFrame = undefined; if (notificationPending) { notificationPending = false; listeners.forEach(listener => listener()); } };
        if (typeof requestAnimationFrame === 'function') notificationFrame = requestAnimationFrame(notify);
        else queueMicrotask(notify);
      }
    } else {
      if (notificationFrame !== undefined) { cancelAnimationFrame(notificationFrame); notificationFrame = undefined; }
      notificationPending = false; listeners.forEach(listener => listener());
    }
  };
  const lastSeq = (delivery: Delivery) => 'toSeq' in delivery ? delivery.toSeq : delivery.seq;
  const firstSeq = (delivery: Delivery) => 'fromSeq' in delivery ? delivery.fromSeq : delivery.seq;
  const applyDelivery = (next: RendererState, delivery: Delivery) => {
    if (!('envelopes' in delivery)) return applyEnvelope(next, delivery);
    // Only adjacent deltas of exactly the same target can merge. Every barrier stays in order.
    const envelopes: EventEnvelope[] = [];
    for (const envelope of delivery.envelopes) {
      const previous = envelopes.at(-1);
      const a = previous?.event; const b = envelope.event;
      if (!a || !isDelta(a) || !isDelta(b)) { envelopes.push(envelope); continue; }
      if (a?.type === 'message.delta' && b.type === a.type && a.sessionId === b.sessionId && a.messageId === b.messageId && a.turnId === b.turnId && a.nativeTaskId === b.nativeTaskId) {
        envelopes[envelopes.length - 1] = { ...envelope, event: { ...b, delta: a.delta + b.delta } };
      } else if (a?.type === 'item.outputDelta' && b.type === a.type && a.sessionId === b.sessionId && a.itemId === b.itemId) {
        envelopes[envelopes.length - 1] = { ...envelope, event: { ...b, delta: a.delta + b.delta } };
      } else envelopes.push(envelope);
    }
    return envelopes.reduce(applyEnvelope, next);
  };
  const receiveBatch = (batch: EventBatch) => {
    const parsed = EventBatch.safeParse(batch);
    if (!parsed.success) { void reconnect(); return; }
    if (state.connection === 'idle' || state.connection === 'error') return;
    const delivery = parsed.data;
    const invalidation = delivery.envelopes.find(e => e.event.type === 'snapshot.invalidated' && e.seq > (state.snapshot?.seq ?? -1));
    if (invalidation) invalidatedSeq = Math.max(invalidatedSeq, invalidation.seq);
    if (buffer) { buffer.push(delivery); return; }
    if (delivery.toSeq <= (state.snapshot?.seq ?? -1)) return;
    if (invalidation || delivery.fromSeq !== (state.snapshot?.seq ?? 0) + 1) { void reconnect(); buffer = [delivery]; return; }
    publish(applyDelivery(state, delivery), delivery.envelopes.every(e => isDelta(e.event)));
  };
  const receive = (envelope: EventEnvelope) => {
    const parsed = EventEnvelope.safeParse(envelope);
    if (!parsed.success) {
      generation++; loading = undefined; buffer = null;
      publish({ ...state, connection: 'error' }); return;
    }
    if (state.connection === 'error' || state.connection === 'idle') return;
    if (parsed.data.event.type === 'snapshot.invalidated' && parsed.data.seq > (state.snapshot?.seq ?? -1)) {
      invalidatedSeq = Math.max(invalidatedSeq, parsed.data.seq);
      if (buffer) buffer.push(parsed.data);
      else void reconnect();
      return;
    }
    if (buffer) buffer.push(parsed.data);
    else if (state.snapshot && parsed.data.seq > state.snapshot.seq + 1) {
      void reconnect();
      buffer = [parsed.data];
    } else publish(applyEnvelope(state, parsed.data), isDelta(parsed.data.event));
  };
  // Subscribe before querying: events during snapshot() are buffered then filtered by its seq.
  const reconnect = (): Promise<void> => {
    if (loading) return loading;
    const current = ++generation;
    buffer = [];
    publish({ ...state, connection: 'loading' });
    loading = Promise.resolve().then(async () => {
      if (current !== generation) return;
      unsubscribe?.();
      unsubscribe = bridge.onBatch ? bridge.onBatch(batch => { if (current === generation) receiveBatch(batch); })
        : bridge.onEvent(envelope => { if (current === generation) receive(envelope); });
      // Keep the subscription and loading state across reads; never flash an error
      // while catching up with a newer invalidation or a buffered sequence gap.
      for (let attempt = 0; attempt < 5; attempt++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let snapshot: Snapshot;
        try {
          snapshot = Snapshot.parse(await Promise.race([bridge.snapshot(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('snapshot timeout')), timeoutMs);
          })]));
        } finally { clearTimeout(timer); }
        if (current !== generation) return;
        if (state.snapshot && snapshot.seq < state.snapshot.seq) throw new Error('snapshot regressed');
        if (snapshot.seq < invalidatedSeq) continue;
        let next: RendererState = { ...state, snapshot, connection: 'ready', closeCauses: {},
          messageStreams: Object.fromEntries(Object.entries(state.messageStreams).filter(([, stream]) => !snapshot.messages.some(message => message.id === stream.messageId && message.sessionId === stream.sessionId))),
          itemStreams: Object.fromEntries(Object.entries(state.itemStreams).filter(([, stream]) => !snapshot.items.some(item => item.id === stream.itemId && item.sessionId === stream.sessionId))),
        };
        let gap = false;
        for (const envelope of (buffer ?? []).sort((a, b) => lastSeq(a) - lastSeq(b))) {
          if (lastSeq(envelope) <= next.snapshot!.seq) continue;
          if (firstSeq(envelope) !== next.snapshot!.seq + 1) { gap = true; break; }
          next = applyDelivery(next, envelope);
        }
        if (gap) continue;
        // Only a successful authoritative read after an uncertain receipt enables
        // reconciliation. A session.updated event alone is not this evidence.
        for (const [key, activity] of Object.entries(next.blockedCommands)) {
          const { command, result } = activity;
          if (command.type !== 'session.create' || !result || result.ok) continue;
          const checked: CommandActivity = { ...activity, createCheck: snapshot.sessions.some(session => session.id === command.sessionId) ? 'found' : 'missing' };
          next = { ...next, blockedCommands: { ...next.blockedCommands, [key]: checked },
            commands: next.commands[command.requestId] ? { ...next.commands, [command.requestId]: checked } : next.commands };
        }
        buffer = null;
        publish(next);
        return;
      }
      throw new Error('snapshot did not converge after 5 reads');
    }).catch(() => { if (current === generation) { buffer = null; publish({ ...state, connection: 'error' }); } })
      .finally(() => { if (current === generation) loading = undefined; });
    return loading;
  };
  const readOnlyBlocks = (type: Command['type']) => state.snapshot?.app.status === 'read-only' && type !== 'backup.restore' && type !== 'backup.cancelRestore';
  const isBlocked = (type: Command['type'], target: string) => readOnlyBlocks(type) || !!state.blockedCommands[blockKey(type, target)];
  const acknowledge = (type: Command['type'], target: string) => {
    const key = blockKey(type, target);
    const activity = state.blockedCommands[key];
    if (!activity?.result) return;
    // Generic acknowledgement must not bypass a required revision or create-ID check.
    if (activity.command.type === 'session.send' && !activity.result.ok && activity.result.code === 'stale_revision' && !activity.result.mayHaveSideEffects) return;
    if (activity.command.type === 'session.interrupt' && activity.result.ok) return;
    const command = activity.command;
    if (command.type === 'session.create' && (state.connection !== 'ready' || !activity.createCheck)) return;
    const id = activity.command.requestId;
    publish({ ...state, blockedCommands: without(state.blockedCommands, key),
      commands: state.commands[id] ? { ...state.commands, [id]: { ...state.commands[id], reviewed: true } } : state.commands });
  };
  const send = async (command: Command): Promise<CommandResult> => {
    // No mount/subscription/reconnect path calls send; a request is never replayed.
    const unavailable = (message: string): CommandResult => ({ ok: false, requestId: command.requestId, code: 'runtime_unavailable', message, retryable: false, mayHaveSideEffects: false });
    const readOnlyResult = (): CommandResult => ({ ok: false, requestId: command.requestId, code: 'storage_read_only', message: '資料目前為唯讀，寫入操作已停用。', retryable: false, mayHaveSideEffects: false });
    if (readOnlyBlocks(command.type)) return readOnlyResult();
    if (submittedIds.has(command.requestId) || isBlocked(command.type, commandTarget(command))) return unavailable('本機已阻擋重複操作，這次未送出指令。');
    submittedIds.add(command.requestId);
    const key = blockKey(command.type, commandTarget(command));
    const record = (result: CommandResult | null) => {
      const activity = { command, result, reviewed: state.commands[command.requestId]?.reviewed ?? false };
      const commands = result && !state.commands[command.requestId] ? state.commands
        : Object.fromEntries(Object.entries({ ...state.commands, [command.requestId]: activity }).slice(-COMMAND_HISTORY_LIMIT));
      let blockedCommands = state.blockedCommands;
      if (!result) blockedCommands = { ...blockedCommands, [key]: activity };
      else if (blockedCommands[key]?.command.requestId === command.requestId) {
        const waitingRevision = command.type === 'session.send' && !result.ok && result.code === 'stale_revision';
        const waitingInterrupt = command.type === 'session.interrupt' && result.ok;
        blockedCommands = blocksResubmit(result) || waitingRevision || waitingInterrupt ? { ...blockedCommands, [key]: activity } : without(blockedCommands, key);
      }
      publish({ ...state, commands, blockedCommands });
      if (command.type === 'session.interrupt' && result?.ok && state.blockedCommands[key]?.command.requestId === command.requestId && !interruptTimers.has(command.requestId)) {
        interruptTimers.set(command.requestId, setTimeout(() => {
          interruptTimers.delete(command.requestId);
          if (state.blockedCommands[key]?.command.requestId !== command.requestId) return;
          const previous = state.commands[command.requestId];
          publish({ ...state, blockedCommands: without(state.blockedCommands, key),
            commands: previous ? { ...state.commands, [command.requestId]: { ...previous, interruptRetryReady: true } } : state.commands });
        }, INTERRUPT_WAIT_MS));
      }
    };
    record(null);
    if (state.snapshot?.app.status === 'damaged') {
      const result: CommandResult = { ok: false, requestId: command.requestId, code: 'storage_failed', message: '資料損壞，操作已停用。', retryable: false, mayHaveSideEffects: false };
      record(result); return result;
    }
    if (state.connection !== 'ready') {
      const result: CommandResult = { ok: false, requestId: command.requestId, code: 'runtime_unavailable', message: '尚未完成資料同步，未送出指令。', retryable: true, mayHaveSideEffects: false };
      record(result); return result;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const validate = (value: CommandResult): CommandResult => {
      const parsed = CommandResult.safeParse(value);
      if (!parsed.success || (parsed.data.requestId !== null && parsed.data.requestId !== command.requestId)) return unknownResult(command.requestId);
      return parsed.data;
    };
    const response = Promise.resolve().then(() => {
      if (readOnlyBlocks(command.type)) return readOnlyResult();
      if (state.snapshot?.app.status === 'damaged') return { ok: false as const, requestId: command.requestId, code: 'storage_failed' as const, message: '資料損壞，操作已停用。', retryable: false, mayHaveSideEffects: false };
      if (state.connection !== 'ready') return unavailable('尚未完成資料同步，未送出指令。');
      return bridge.send(command);
    }).then(validate, () => unknownResult(command.requestId));
    const result = await Promise.race([response, new Promise<CommandResult>(resolve => { timer = setTimeout(() => resolve(unknownResult(command.requestId)), timeoutMs); })]);
    clearTimeout(timer);
    // Creation can update the session again while provisioning. Read its latest revision
    // before exposing the composer, even if an earlier session.updated already arrived.
    const refresh = async (receipt: CommandResult) => {
      if (receipt.ok && ['agent.save', 'agent.delete', 'workflow.save', 'project.save', 'session.create'].includes(command.type)) {
        await loading;
        if (state.connection !== 'idle') await reconnect();
      }
    };
    const settle = async (receipt: CommandResult) => {
      // Also protect late create receipts: a timed-out screen can already be
      // watching this command, so do not expose success before its fresh read.
      const creating = command.type === 'session.create' && receipt.ok;
      if (!creating) record(receipt);
      await refresh(receipt);
      if (creating) record(receipt);
    };
    await settle(result);
    // A late receipt can resolve a timeout, but it must never trigger a second send.
    void response.then(async late => { if (late !== result) await settle(late); });
    return result;
  };
  const histories = new Map<string, Promise<void>>();
  const loadHistory = (sessionId: SessionId): Promise<void> => {
    const before = state.snapshot?.historyPages.find(info => info.sessionId === sessionId)?.olderCursor;
    if (state.connection !== 'ready') return Promise.reject(new Error('連線尚未就緒，請重新讀取資料後重試。'));
    if (!before) return Promise.resolve();
    const current = generation;
    const key = JSON.stringify([current, sessionId, before]);
    const pending = histories.get(key);
    if (pending) return pending;
    const promise = queryBridge(bridge, { type: 'session.history', requestId: queryId(), sessionId, before, limit: 50 }, timeoutMs).then(result => {
      if (current !== generation || state.connection !== 'ready' || !state.snapshot || state.snapshot.historyPages.find(info => info.sessionId === sessionId)?.olderCursor !== before) return;
      if (!result.ok || result.type !== 'session.history' || result.page.sessionId !== sessionId || result.page.olderCursor === before) throw new Error('歷史頁面不符或游標未前進，請重新讀取。');
      publish({ ...state, snapshot: mergeHistory(state.snapshot, result.page) });
    }).finally(() => { histories.delete(key); });
    histories.set(key, promise);
    return promise;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => state.connection === 'idle' ? reconnect() : loading ?? Promise.resolve(),
    reconnect, send, isBlocked, acknowledge, loadHistory,
    query: (request: Parameters<typeof queryBridge>[1]) => queryBridge(bridge, request, timeoutMs),
    dispose: () => {
      interruptTimers.forEach(clearTimeout); interruptTimers.clear();
      generation++; unsubscribe?.(); unsubscribe = undefined; loading = undefined; buffer = null;
      notificationPending = false;
      publish({ ...state, connection: 'idle' });
    },
  };
}
export type RendererStore = ReturnType<typeof createRendererStore>;
const stores = new WeakMap<AwgBridge, RendererStore>();
export function rendererStore(bridge: AwgBridge): RendererStore {
  let store = stores.get(bridge);
  if (!store) { store = createRendererStore(bridge); stores.set(bridge, store); }
  return store;
}

import { Command, CommandResult, EventEnvelope, Snapshot } from '../../../contracts';
import type { AppEvent } from '../../../contracts';
import type { AwgBridge } from '../../preload/bridge-types';
import { blocksResubmit, unknownResult } from './command-feedback';

export interface CommandActivity { command: Command; result: CommandResult | null; reviewed?: boolean }
export const COMMAND_HISTORY_LIMIT = 50;
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
}
const upsert = <T extends { id: string }>(items: T[], item: T): T[] => items.some(value => value.id === item.id)
  ? items.map(value => value.id === item.id ? item : value) : [...items, item];
const without = <T>(items: Readonly<Record<string, T>>, key: string) => {
  const next = { ...items }; delete next[key]; return next;
};
const streamKey = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);

/** Apply only observed facts. A runtime exit does not establish a delivery or turn outcome. */
export function applyEnvelope(state: RendererState, envelope: EventEnvelope): RendererState {
  if (!state.snapshot || envelope.seq <= state.snapshot.seq) return state;
  const snapshot = { ...state.snapshot, seq: envelope.seq };
  const next = { ...state, snapshot };
  const event = envelope.event;
  switch (event.type) {
    case 'session.updated': snapshot.sessions = upsert(snapshot.sessions, event.session); break;
    case 'session.activity': snapshot.sessions = snapshot.sessions.map(session => session.id === event.sessionId ? { ...session, activity: event.activity, updatedAt: event.at } : session); break;
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
    case 'model.observed': snapshot.sessions = snapshot.sessions.map(session => session.id === event.sessionId ? { ...session, observedModel: event.observed } : session); break;
    case 'runtime.exited': next.runtimeExits = { ...state.runtimeExits, [event.runtime]: event }; break;
    default: { const exhaustive: never = event; return exhaustive; }
  }
  return next;
}

export function commandTarget(command: Command): string {
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

export function createRendererStore(bridge: AwgBridge, timeoutMs = 15000) {
  let state: RendererState = { snapshot: null, connection: 'idle', commands: {}, blockedCommands: {}, messageStreams: {}, itemStreams: {}, limits: null, runtimeExits: {} };
  const submittedIds = new Set<string>();
  const blockKey = (type: Command['type'], target: string) => JSON.stringify([type, target]);
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  let loading: Promise<void> | undefined;
  let generation = 0;
  let buffer: EventEnvelope[] | null = null;
  const publish = (next: RendererState) => { if (next === state) return; state = next; listeners.forEach(listener => listener()); };
  const receive = (envelope: EventEnvelope) => {
    const parsed = EventEnvelope.safeParse(envelope);
    if (!parsed.success) {
      generation++; loading = undefined; buffer = null;
      publish({ ...state, connection: 'error' }); return;
    }
    if (state.connection === 'error' || state.connection === 'idle') return;
    if (buffer) buffer.push(parsed.data);
    else if (state.snapshot && parsed.data.seq > state.snapshot.seq + 1) {
      void reconnect();
      buffer = [parsed.data];
    } else publish(applyEnvelope(state, parsed.data));
  };
  // Subscribe before querying: events during snapshot() are buffered then filtered by its seq.
  const reconnect = (retryGap = true): Promise<void> => {
    if (loading) return loading;
    const current = ++generation;
    let gap = false;
    buffer = [];
    publish({ ...state, connection: 'loading' });
    loading = Promise.resolve().then(async () => {
      if (current !== generation) return;
      unsubscribe?.();
      unsubscribe = bridge.onEvent(envelope => { if (current === generation) receive(envelope); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let snapshot: Snapshot;
      try {
        snapshot = Snapshot.parse(await Promise.race([bridge.snapshot(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('snapshot timeout')), timeoutMs);
        })]));
      } finally { clearTimeout(timer); }
      if (current !== generation) return;
      if (state.snapshot && snapshot.seq < state.snapshot.seq) throw new Error('snapshot regressed');
      let next: RendererState = { ...state, snapshot, connection: 'ready',
        messageStreams: Object.fromEntries(Object.entries(state.messageStreams).filter(([, stream]) => !snapshot.messages.some(message => message.id === stream.messageId && message.sessionId === stream.sessionId))),
        itemStreams: Object.fromEntries(Object.entries(state.itemStreams).filter(([, stream]) => !snapshot.items.some(item => item.id === stream.itemId && item.sessionId === stream.sessionId))),
      };
      for (const envelope of (buffer ?? []).sort((a, b) => a.seq - b.seq)) {
        if (envelope.seq > next.snapshot!.seq + 1) { gap = true; throw new Error('event sequence gap'); }
        next = applyEnvelope(next, envelope);
      }
      buffer = null;
      publish(next);
    }).catch(() => { if (current === generation) { buffer = null; publish({ ...state, connection: 'error' }); } })
      .finally(() => { if (current === generation) loading = undefined; })
      .then(async () => { if (gap && retryGap && current === generation) await reconnect(false); });
    return loading;
  };
  const isBlocked = (type: Command['type'], target: string) => !!state.blockedCommands[blockKey(type, target)];
  const acknowledge = (type: Command['type'], target: string) => {
    const key = blockKey(type, target);
    const activity = state.blockedCommands[key];
    if (!activity?.result) return;
    const id = activity.command.requestId;
    publish({ ...state, blockedCommands: without(state.blockedCommands, key),
      commands: state.commands[id] ? { ...state.commands, [id]: { ...state.commands[id], reviewed: true } } : state.commands });
  };
  const send = async (command: Command): Promise<CommandResult> => {
    // No mount/subscription/reconnect path calls send; a request is never replayed.
    const unavailable = (message: string): CommandResult => ({ ok: false, requestId: command.requestId, code: 'runtime_unavailable', message, retryable: false, mayHaveSideEffects: false });
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
        blockedCommands = blocksResubmit(result) ? { ...blockedCommands, [key]: activity } : without(blockedCommands, key);
      }
      publish({ ...state, commands, blockedCommands });
    };
    record(null);
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
    const response = Promise.resolve().then(() => bridge.send(command)).then(validate, () => unknownResult(command.requestId));
    const result = await Promise.race([response, new Promise<CommandResult>(resolve => { timer = setTimeout(() => resolve(unknownResult(command.requestId)), timeoutMs); })]);
    clearTimeout(timer);
    record(result);
    // Agent/Workflow updates have no event in v0.4; read their authoritative revisions.
    const refresh = async (receipt: CommandResult) => {
      if (receipt.ok && ['agent.save', 'agent.delete', 'workflow.save'].includes(command.type)) {
        await loading;
        if (state.connection !== 'idle') await reconnect();
      }
    };
    await refresh(result);
    // A late receipt can resolve a timeout, but it must never trigger a second send.
    void response.then(async late => { if (late !== result) { record(late); await refresh(late); } });
    return result;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => state.connection === 'idle' ? reconnect() : loading ?? Promise.resolve(),
    reconnect, send, isBlocked, acknowledge,
    dispose: () => {
      generation++; unsubscribe?.(); unsubscribe = undefined; loading = undefined; buffer = null;
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

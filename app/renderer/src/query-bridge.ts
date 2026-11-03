import { AppEvent, HistoryCursor, QueryRequest, QueryResult, RequestId, Snapshot } from '../../../contracts';
import type { EventBatch, HistoryPage } from '../../../contracts';
import type { AppBridge, AwgBridge } from '../../preload/bridge-types';
import { fixtureBackupList } from '../../../contracts/fixtures/snapshot';
import { longConversation } from '../../../contracts/fixtures/long-conversation';

/** T040 integration: expose query and optionally onBatch on window.awg.
 * When onBatch exists it replaces onEvent; do not subscribe to both transports. */
export interface QueryBridge { query(request: QueryRequest): Promise<QueryResult> }
export type RendererBridge = AwgBridge & Partial<QueryBridge> & Partial<Pick<AppBridge, 'readSnapshot' | 'report'>> & {
  onBatch?: (listener: (batch: EventBatch) => void) => () => void;
};

export async function queryBridge(bridge: Partial<QueryBridge>, request: QueryRequest, timeoutMs = 15000): Promise<QueryResult> {
  if (!bridge.query) throw new Error('此版本尚未接入查詢服務，請更新應用程式後重試。');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = QueryResult.parse(await Promise.race([bridge.query(QueryRequest.parse(request)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('查詢逾時，請重試。')), timeoutMs);
    })]));
    if (!result.ok && result.requestId === null) throw new Error(result.message);
    if (result.requestId !== request.requestId || (result.ok && result.type !== request.type)) throw new Error('查詢回覆不符，請重新讀取。');
    if (!result.ok) throw new Error(result.message || '查詢失敗，請重試。');
    return result;
  } finally { clearTimeout(timer); }
}

/** Existing/live facts win over an overlapping historical page. */
export function mergeHistory(snapshot: Snapshot, page: HistoryPage): Snapshot {
  const merge = <T extends { id: string; sessionId: string }>(current: T[], older: T[]) => {
    const ids = new Set(current.map(item => JSON.stringify([item.sessionId, item.id])));
    return [...older.filter(item => {
      const key = JSON.stringify([item.sessionId, item.id]);
      if (ids.has(key)) return false;
      ids.add(key); return true;
    }), ...current];
  };
  return { ...snapshot, messages: merge(snapshot.messages, page.messages).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    turns: merge(snapshot.turns, page.turns), items: merge(snapshot.items, page.items),
    nativeTasks: merge(snapshot.nativeTasks, page.nativeTasks), permissionRequests: merge(snapshot.permissionRequests, page.permissionRequests),
    artifacts: merge(snapshot.artifacts, page.artifacts),
    historyPages: [...snapshot.historyPages.filter(info => info.sessionId !== page.sessionId), { sessionId: page.sessionId, olderCursor: page.olderCursor }] };
}

/** Isolated preview service: never sends runtime commands or touches disk. */
export function createStorageDemo(initial: Snapshot): RendererBridge {
  let snapshot = initial;
  const listeners = new Set<Parameters<AwgBridge['onEvent']>[0]>();
  const histories = new Map<string, HistoryPage>();
  return {
    getAppInfo: () => Promise.resolve({ name: 'AgentWorkflowGui（示意）', version: '0.1.0' }),
    snapshot: () => Promise.resolve(snapshot),
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query: async request => {
      await Promise.resolve();
      if (request.type === 'backup.list') return { ...fixtureBackupList, requestId: request.requestId };
      const initialCursor = initial.historyPages.find(info => info.sessionId === request.sessionId)?.olderCursor;
      let history = histories.get(request.sessionId);
      if (!history) {
        history = longConversation({ sessionId: request.sessionId, turns: 120 });
        // Place generated older turns before the first fixture message.
        const first = Math.min(...initial.messages.filter(m => m.sessionId === request.sessionId).map(m => Date.parse(m.createdAt)));
        const shift = (value: string) => new Date(Date.parse(value) - Date.parse(history!.messages[0]!.createdAt) + (Number.isFinite(first) ? first : Date.now()) - 121 * 60000).toISOString();
        history = { ...history, messages: history.messages.map(m => ({ ...m, createdAt: shift(m.createdAt) })), turns: history.turns.map(t => ({ ...t, startedAt: shift(t.startedAt), ...(t.endedAt ? { endedAt: shift(t.endedAt) } : {}) })), items: history.items.map(i => ({ ...i, startedAt: shift(i.startedAt), ...(i.endedAt ? { endedAt: shift(i.endedAt) } : {}) })) };
        histories.set(request.sessionId, history);
      }
      const prefix = `demo:${request.sessionId}:`;
      const end = request.before === initialCursor ? history.turns.length : request.before.startsWith(prefix) ? Number(request.before.slice(prefix.length)) : NaN;
      if (!Number.isInteger(end) || end < 1 || end > history.turns.length) return { ok: false, requestId: request.requestId, code: 'invalid_request', message: '示意游標不符。' };
      const start = Math.max(0, end - request.limit);
      const turns = history.turns.slice(start, end);
      const ids = new Set(turns.map(t => t.id));
      return { ok: true, type: request.type, requestId: request.requestId, page: { ...history, turns,
        messages: history.messages.filter(m => m.turnId && ids.has(m.turnId)), items: history.items.filter(i => i.turnId && ids.has(i.turnId)),
        olderCursor: start ? HistoryCursor.parse(`${prefix}${start}`) : null } };
    },
    send: async input => {
      await Promise.resolve();
      const requestId = RequestId.parse(input.requestId);
      const at = new Date().toISOString();
      const event = input.type === 'preferences.set' ? { type: 'preferences.updated' as const, preferences: input.preferences, at }
        : input.type === 'backup.restore' ? { type: 'storage.updated' as const, storage: { lastBackupAt: snapshot.storage.lastBackupAt, pendingRestore: { backupId: input.backupId, requestedAt: at } }, at }
        : input.type === 'backup.cancelRestore' ? { type: 'storage.updated' as const, storage: { lastBackupAt: snapshot.storage.lastBackupAt }, at } : null;
      if (!event) return { ok: false, requestId, code: 'unsupported', message: '示意模式未連接 runtime。', retryable: false, mayHaveSideEffects: false };
      // Parse defaults and optional fields at the boundary just as the real service does.
      const parsed = AppEvent.parse(event);
      snapshot = Snapshot.parse({ ...snapshot, seq: snapshot.seq + 1, ...(parsed.type === 'preferences.updated' ? { preferences: parsed.preferences } : parsed.type === 'storage.updated' ? { storage: parsed.storage } : {}) });
      listeners.forEach(listener => listener({ schemaVersion: snapshot.schemaVersion, seq: snapshot.seq, event: parsed }));
      return { ok: true, requestId, created: [] };
    },
  };
}

export const queryId = () => RequestId.parse(crypto.randomUUID());

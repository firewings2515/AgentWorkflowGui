// The conversation panes of the v0.4 shell (WB-07, WB-08): at most two side by side, each keeping its own draft,
// detail pane and reading position per session. Closing a pane or switching its session keeps that context.
import type { SessionId } from '../../../../contracts';

export const detailPanels = [
  { id: 'files', label: '成果／檔案' },
  { id: 'tasks', label: '任務流程' },
  { id: 'messages', label: '跨 session 訊息' },
  { id: 'info', label: 'Session 資訊' },
] as const;
export type DetailTab = (typeof detailPanels)[number]['id'];
export interface TranscriptPosition {
  anchor: { id: string; offset: number } | null;
  following: boolean;
}
export interface SessionContext {
  draft: string;
  /** The detail pane starts closed (REVISION_V0_4 §3.1, WB-08 in v0.4). */
  details: boolean;
  tab: DetailTab;
  reading?: TranscriptPosition;
}
export interface Pane { id: string; sessionId: SessionId; contexts: Record<string, SessionContext> }
export interface PaneState { panes: Pane[]; closed: Pane[]; active: string; nextId: number }

export const MAX_PANES = 2;
export const emptyContext = (): SessionContext => ({ draft: '', details: false, tab: 'files' });
export const contextOf = (pane: Pane, sessionId: SessionId = pane.sessionId): SessionContext => pane.contexts[sessionId] ?? emptyContext();
export const initialPanes = (sessionId?: SessionId): PaneState =>
  ({ panes: sessionId ? [{ id: 'pane-1', sessionId, contexts: {} }] : [], closed: [], active: 'pane-1', nextId: 2 });

export type PaneAction =
  | { type: 'open'; sessionId: SessionId; paneId?: string; draft?: string }
  | { type: 'split'; sessionId: SessionId }
  | { type: 'close'; paneId: string }
  | { type: 'focus'; paneId: string }
  | { type: 'context'; paneId: string; sessionId: SessionId; patch: Partial<SessionContext> }
  /** Clears a draft after its message was accepted, unless the user has typed something else since. */
  | { type: 'sent'; sessionId: SessionId; text: string };

const withContext = (pane: Pane, sessionId: SessionId, patch: Partial<SessionContext>): Pane =>
  ({ ...pane, contexts: { ...pane.contexts, [sessionId]: { ...contextOf(pane, sessionId), ...patch } } });

/** Where `open` puts a session: the pane already showing it, else the active pane, else a new (or restored) one. */
export function openTarget(state: PaneState, sessionId: SessionId): string {
  const shown = state.panes.find(pane => pane.sessionId === sessionId);
  if (shown) return shown.id;
  if (state.panes.some(pane => pane.id === state.active)) return state.active;
  return state.closed.at(-1)?.id ?? `pane-${state.nextId}`;
}

function add(state: PaneState, sessionId: SessionId): PaneState {
  if (state.panes.length >= MAX_PANES) return state;
  const restored = state.closed.at(-1);
  const pane = restored ? { ...restored, sessionId } : { id: `pane-${state.nextId}`, sessionId, contexts: {} };
  return { panes: [...state.panes, pane], closed: restored ? state.closed.slice(0, -1) : state.closed, active: pane.id, nextId: restored ? state.nextId : state.nextId + 1 };
}

export function paneReducer(state: PaneState, action: PaneAction): PaneState {
  switch (action.type) {
    case 'focus': return state.panes.some(pane => pane.id === action.paneId) ? { ...state, active: action.paneId } : state;
    case 'context': return { ...state, panes: state.panes.map(pane => pane.id === action.paneId ? withContext(pane, action.sessionId, action.patch) : pane) };
    case 'sent': return { ...state, panes: state.panes.map(pane => pane.contexts[action.sessionId]?.draft === action.text ? withContext(pane, action.sessionId, { draft: '' }) : pane) };
    case 'open': {
      const shown = action.paneId === undefined ? state.panes.find(pane => pane.sessionId === action.sessionId) : undefined;
      const target = shown?.id ?? action.paneId ?? state.active;
      let next = state.panes.some(pane => pane.id === target)
        ? { ...state, active: target, panes: state.panes.map(pane => pane.id === target ? { ...pane, sessionId: action.sessionId } : pane) }
        : add(state, action.sessionId);
      if (action.draft !== undefined) next = paneReducer(next, { type: 'context', paneId: next.active, sessionId: action.sessionId, patch: { draft: action.draft } });
      return next;
    }
    case 'split': {
      const active = state.panes.find(pane => pane.id === state.active);
      if (!active) return paneReducer(state, { type: 'open', sessionId: action.sessionId });
      const other = state.panes.find(pane => pane.id !== active.id);
      if (other) return { ...state, active: other.id, panes: state.panes.map(pane => pane.id === other.id ? { ...pane, sessionId: action.sessionId } : pane) };
      return add(state, action.sessionId);
    }
    case 'close': {
      const closed = state.panes.find(pane => pane.id === action.paneId);
      if (!closed) return state;
      const panes = state.panes.filter(pane => pane.id !== action.paneId);
      return { ...state, panes, closed: [...state.closed, closed], active: state.active === action.paneId ? (panes.at(-1)?.id ?? state.active) : state.active };
    }
  }
}

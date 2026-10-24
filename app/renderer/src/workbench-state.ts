import type { LogicalSession, SessionId } from '../../../contracts';

export const detailPanels = [
  { id: 'files', label: '成果／檔案' },
  { id: 'tasks', label: '任務流程' },
  { id: 'messages', label: '跨 session 訊息' },
  { id: 'info', label: 'Session 資訊' },
] as const;
export type DetailTab = (typeof detailPanels)[number]['id'];
export interface SessionViewContext {
  draft: string;
  detailTab: DetailTab;
  detailsVisible: boolean;
  scrollTop: number;
}
export interface WorkspaceView {
  id: string;
  sessionId: SessionId;
  contexts: Record<string, SessionViewContext>;
}
export interface WorkspaceState {
  views: WorkspaceView[];
  closedViews: WorkspaceView[];
  activeViewId: string;
  nextId: number;
}
export const emptyContext = (): SessionViewContext => ({ draft: '', detailTab: 'files', detailsVisible: true, scrollTop: 0 });
export const contextFor = (view: WorkspaceView): SessionViewContext => view.contexts[view.sessionId] ?? emptyContext();
export function initialWorkspace(sessions: readonly LogicalSession[]): WorkspaceState {
  const session = sessions[0];
  return { views: session ? [{ id: 'view-1', sessionId: session.id, contexts: {} }] : [], closedViews: [], activeViewId: 'view-1', nextId: 2 };
}
export type WorkspaceAction =
  | { type: 'focus'; viewId: string }
  | { type: 'open'; sessionId: SessionId; viewId?: string }
  | { type: 'add'; sessionId: SessionId }
  | { type: 'close'; viewId: string }
  | { type: 'context'; viewId: string; sessionId: SessionId; patch: Partial<SessionViewContext> };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'focus': return { ...state, activeViewId: action.viewId };
    case 'context': return { ...state, views: state.views.map(view => view.id === action.viewId
      ? { ...view, contexts: { ...view.contexts, [action.sessionId]: { ...(view.contexts[action.sessionId] ?? emptyContext()), ...action.patch } } } : view) };
    case 'open': {
      const target = action.viewId ?? state.activeViewId;
      if (!state.views.some(view => view.id === target)) return workspaceReducer(state, { type: 'add', sessionId: action.sessionId });
      return { ...state, activeViewId: target, views: state.views.map(view => view.id === target ? { ...view, sessionId: action.sessionId } : view) };
    }
    case 'add': {
      // T004 validates one/two panes; this is a layout limit, never a session schema limit.
      if (state.views.length >= 2) return state;
      const restored = state.closedViews.at(-1);
      const view = restored ? { ...restored, sessionId: action.sessionId } : { id: `view-${state.nextId}`, sessionId: action.sessionId, contexts: {} };
      return { views: [...state.views, view], closedViews: restored ? state.closedViews.slice(0, -1) : state.closedViews,
        activeViewId: view.id, nextId: restored ? state.nextId : state.nextId + 1 };
    }
    case 'close': {
      const closed = state.views.find(view => view.id === action.viewId);
      if (!closed) return state;
      const views = state.views.filter(view => view.id !== action.viewId);
      return { ...state, views, closedViews: [...state.closedViews, closed],
        activeViewId: state.activeViewId === action.viewId ? (views.at(-1)?.id ?? '') : state.activeViewId };
    }
  }
}

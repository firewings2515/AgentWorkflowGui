// Test-only: one v0.4 conversation pane with its own pane state, like the shell gives it (T051 moved the old
// SessionWorkspace tests here). A button switches the pane to another session and back.
import { useReducer, useSyncExternalStore } from 'react';
import type { SessionId, Snapshot } from '../../../../contracts';
import type { RendererStore } from '../renderer-store';
import { Conversation } from './Conversation';
import { contextOf, initialPanes, paneReducer } from './pane-state';

export function ConversationHarness({ store, snapshot: fixed, sessionId, onNotice = () => undefined }: {
  store?: RendererStore; snapshot?: Snapshot; sessionId?: SessionId; onNotice?: (text: string) => void;
}) {
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => undefined), store?.getSnapshot ?? (() => undefined));
  const snapshot = state?.snapshot ?? fixed!;
  const [panes, dispatch] = useReducer(paneReducer, undefined, () => initialPanes(sessionId ?? snapshot.sessions[0]!.id));
  const pane = panes.panes[0]!;
  const session = snapshot.sessions.find(item => item.id === pane.sessionId);
  const other = snapshot.sessions.find(item => item.id !== pane.sessionId)!;
  return <>
    <button type="button" onClick={() => dispatch({ type: 'open', sessionId: other.id, paneId: pane.id })}>切換測試 session</button>
    <Conversation snapshot={snapshot} store={store} historyStore={store} ipcState={state} pane={pane} title={session?.title ?? pane.sessionId} active split={false}
      agents={snapshot.agents} editTitle={0} firstNotSent={false}
      choice={{ folder: { kind: 'picked', path: session?.cwd ?? '' }, agentId: session?.agent?.id ?? '', modelKey: session ? `${session.requestedModel.runtime}:${session.requestedModel.model}` : '' }}
      onContext={patch => dispatch({ type: 'context', paneId: pane.id, sessionId: pane.sessionId, patch })} onChoice={() => undefined}
      onSend={() => undefined} onRename={() => undefined} onClose={() => undefined} onFocus={() => undefined} onOpen={() => undefined} onProgress={() => undefined} onNotice={onNotice} />
    <output data-testid="reading">{JSON.stringify(contextOf(pane).reading)}</output>
  </>;
}

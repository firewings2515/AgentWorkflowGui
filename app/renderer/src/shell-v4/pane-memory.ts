// The split layout kept across restarts (U3_PLAN Q-16, T054): the panes, each pane's session, the active pane, and each
// pane's detail pane (open or not, which tab). Drafts and reading positions are not kept. localStorage `awg.panes.v1`.
import { z } from 'zod';
import type { SessionId } from '../../../../contracts';
import { contextOf, detailPanels, emptyContext, initialPanes, MAX_PANES, paneReducer } from './pane-state';
import type { PaneState } from './pane-state';
import type { StoredRead } from './local-store';

export const PANES_KEY = 'awg.panes.v1';

const tabs = detailPanels.map(panel => panel.id) as [typeof detailPanels[number]['id'], ...typeof detailPanels[number]['id'][]];
const StoredLayout = z.strictObject({
  version: z.literal(1),
  panes: z.array(z.strictObject({ sessionId: z.string().min(1), details: z.boolean(), tab: z.enum(tabs) })).max(MAX_PANES),
  active: z.number().int().min(0),
});
export type StoredLayout = z.infer<typeof StoredLayout>;

/** What is kept of the pane state: the current session of each pane with its detail pane, and the active pane's index. */
export function serializeLayout(state: PaneState): StoredLayout {
  return {
    version: 1,
    panes: state.panes.map(pane => { const context = contextOf(pane); return { sessionId: pane.sessionId, details: context.details, tab: context.tab }; }),
    active: Math.max(0, state.panes.findIndex(pane => pane.id === state.active)),
  };
}

/**
 * The pane state to start from, or undefined for the default screen: nothing stored, a wrong shape or version, or no
 * stored session left in the Snapshot. Panes whose session is gone are skipped; if that was the active one, the first
 * remaining pane becomes active.
 */
export function restoreLayout(stored: StoredRead, known: (id: string) => boolean): PaneState | undefined {
  if (!stored.ok) return undefined;
  const parsed = StoredLayout.safeParse(stored.value);
  if (!parsed.success) return undefined;
  const kept = parsed.data.panes.map((pane, index) => ({ pane, index })).filter(({ pane }) => known(pane.sessionId));
  if (!kept.length) return undefined;
  const panes = kept.map(({ pane }, n) => ({
    id: `pane-${n + 1}`, sessionId: pane.sessionId as SessionId,
    contexts: { [pane.sessionId]: { ...emptyContext(), details: pane.details, tab: pane.tab } },
  }));
  const active = kept.findIndex(({ index }) => index === parsed.data.active);
  return { panes, closed: [], active: panes[Math.max(0, active)]!.id, nextId: panes.length + 1 };
}

/**
 * The panes at start-up (T054 §0-1): the restored layout, with the session the address names (if any) shown in it — in
 * the pane already showing it, or else in the active pane. Without a restored layout, the default for that address.
 */
export function startPanes(restored: PaneState | undefined, routeSession: SessionId | undefined): PaneState {
  if (!restored) return initialPanes(routeSession);
  if (!routeSession) return restored;
  const shown = restored.panes.find(pane => pane.sessionId === routeSession);
  return shown ? { ...restored, active: shown.id } : paneReducer(restored, { type: 'open', sessionId: routeSession });
}

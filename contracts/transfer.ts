// Cross-tool transfer proposals and preferences.
import { z } from 'zod';
import { ModelSelection } from './agent';
import { Revision, SessionId, Timestamp, TransferId } from './common';
import { DeliveryState } from './workflow';

/**
 * Transfer to a new session in another tool (R-02). Content follows the fixed frame verified in SP-09.
 * Nothing reaches the target before `state` becomes `approved` (COM-05, CR-5).
 */
export const TransferProposal = z.strictObject({
  id: TransferId,
  /** Changing source content after approval makes the proposal stale (re-confirm). */
  revision: Revision,
  sourceSessionId: SessionId,
  sourceRevision: Revision,
  target: ModelSelection,
  content: z.strictObject({
    goal: z.string().min(1),
    note: z.string(),
    /** Who wrote the note: the source agent, or the GUI from the transcript (no model call). */
    noteSource: z.enum(['agent', 'gui-digest']),
    diff: z.string(),
    testOutput: z.string(),
  }),
  state: z.enum(['draft', 'awaiting-confirmation', 'approved', 'cancelled', 'stale']),
  delivery: DeliveryState.optional(),
  createdSessionId: SessionId.optional(),
  createdAt: Timestamp,
  approvedAt: Timestamp.optional(),
});
export type TransferProposal = z.infer<typeof TransferProposal>;

/** Appearance (R-15): dark by default. */
export const Theme = z.enum(['dark', 'light']);
export const UiPreferences = z.strictObject({ theme: Theme.default('dark') });
export type UiPreferences = z.infer<typeof UiPreferences>;

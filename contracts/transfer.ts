// Cross-tool transfer proposals and preferences.
import { z } from 'zod';
import { ModelSelection } from './agent';
import { OperationId, PayloadHash, Revision, SessionId, Timestamp, TransferId } from './common';
import { DeliveryRecord, ProvisionRecord, deliveryTargetIssues } from './delivery';

export const TransferState = z.enum(['draft', 'awaiting-confirmation', 'stale', 'approved', 'failed', 'cancelled']);

/**
 * Transfer to a new session in another tool (R-02). Content follows the fixed frame verified in SP-09.
 * The schema enforces the confirmation gate (CR-5): before approval nothing is provisioned, created or
 * delivered; the approval binds the revision; the payload waits for the created target (CR2 §3).
 */
export const TransferProposal = z
  .strictObject({
    id: TransferId,
    operationId: OperationId,
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
    payloadHash: PayloadHash,
    state: TransferState,
    approvedRevision: Revision.optional(),
    approvedAt: Timestamp.optional(),
    provision: ProvisionRecord.optional(),
    createdSessionId: SessionId.optional(),
    delivery: DeliveryRecord.optional(),
    /** Target creation failed for good; the work stays in the source session (R-02). */
    failure: z.strictObject({ message: z.string() }).optional(),
    cancelledAt: Timestamp.optional(),
    createdAt: Timestamp,
  })
  .superRefine((p, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const approved = p.approvedAt !== undefined;
    if (approved !== (p.approvedRevision !== undefined)) fail('approvedAt and approvedRevision go together');
    if (p.approvedRevision !== undefined && p.approvedRevision !== p.revision) fail('the approval binds the current revision');
    if (!approved && (p.provision || p.createdSessionId || p.delivery)) fail('nothing is created or sent before approval');
    if (['draft', 'awaiting-confirmation', 'stale'].includes(p.state) && (approved || p.failure || p.cancelledAt)) fail(`${p.state} has no approval, failure or cancel`);
    if ((p.state === 'approved' || p.state === 'failed') && !approved) fail(`${p.state} needs an approval`);
    if ((p.state === 'failed') !== (p.failure !== undefined)) fail('failure is set exactly when failed');
    if ((p.state === 'cancelled') !== (p.cancelledAt !== undefined)) fail('cancelledAt is set exactly when cancelled');
    // Target creation failed, so the payload never crossed the dispatch boundary.
    if (p.state === 'failed' && p.delivery && (p.delivery.state !== 'pending' || p.delivery.attempts.length > 0)) fail('a failed transfer dispatched nothing');
    // Cancelling stops follow-up work; a delivery reconciled as sent afterwards is still recorded (CR2 §2).
    if ((p.createdSessionId !== undefined) !== (p.provision?.state === 'sent')) fail('createdSessionId is set exactly when the target was created');
    const target = { sessionId: p.createdSessionId, nativeSessionRef: p.provision?.nativeSessionRef, provision: p.provision };
    for (const issue of deliveryTargetIssues(p.delivery, target)) fail(issue);
  });
export type TransferProposal = z.infer<typeof TransferProposal>;

/** Appearance (R-15): dark by default. */
export const Theme = z.enum(['dark', 'light']);
export const UiPreferences = z.strictObject({ theme: Theme.default('dark') });
export type UiPreferences = z.infer<typeof UiPreferences>;

// Inferred types for schemas that are not typed next to their definition.
export type TransferState = z.infer<typeof TransferState>;
export type Theme = z.infer<typeof Theme>;

// Cross-tool transfer proposals and preferences.
import { z } from 'zod';
import { ModelSelection } from './agent';
import { OperationId, PayloadHash, Revision, SessionId, Timestamp, TransferId } from './common';
import { DeliveryRecord, ProvisionRecord, deliveryTargetIssues } from './delivery';
import { addRuleIssue, type ContractRule } from './rules';

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
    const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
    const approved = p.approvedAt !== undefined;
    if (approved !== (p.approvedRevision !== undefined)) fail('transfer.approval-pair');
    // The approval binds the revision it was saved with: while approved it is the current one; a later
    // failure or cancel is saved with a newer revision and keeps the approval as it was (T020 r2 P1).
    if (p.approvedRevision !== undefined && (p.state === 'approved' ? p.approvedRevision !== p.revision : p.approvedRevision > p.revision)) fail('transfer.approval-revision');
    if (!approved && (p.provision || p.createdSessionId || p.delivery)) fail('transfer.nothing-before-approval');
    if (['draft', 'awaiting-confirmation', 'stale'].includes(p.state) && (approved || p.failure || p.cancelledAt)) fail('transfer.unapproved-is-clean');
    if ((p.state === 'approved' || p.state === 'failed') && !approved) fail('transfer.state-needs-approval');
    if ((p.state === 'failed') !== (p.failure !== undefined)) fail('transfer.failure-when-failed');
    if ((p.state === 'cancelled') !== (p.cancelledAt !== undefined)) fail('transfer.cancelled-at');
    // Target creation failed, so the payload never crossed the dispatch boundary.
    if (p.state === 'failed' && p.delivery && (p.delivery.state !== 'pending' || p.delivery.attempts.length > 0)) fail('transfer.failed-dispatched-nothing');
    // Cancelling stops follow-up work; a delivery reconciled as sent afterwards is still recorded (CR2 §2).
    if ((p.createdSessionId !== undefined) !== (p.provision?.state === 'sent')) fail('transfer.created-session');
    const target = { sessionId: p.createdSessionId, nativeSessionRef: p.provision?.nativeSessionRef, provision: p.provision };
    for (const rule of deliveryTargetIssues(p.delivery, target)) fail(rule);
  });
export type TransferProposal = z.infer<typeof TransferProposal>;

/** Appearance (R-15): dark by default. */
export const Theme = z.enum(['dark', 'light']);
export const UiPreferences = z.strictObject({ theme: Theme.default('dark') });
export type UiPreferences = z.infer<typeof UiPreferences>;

// Inferred types for schemas that are not typed next to their definition.
export type TransferState = z.infer<typeof TransferState>;
export type Theme = z.infer<typeof Theme>;

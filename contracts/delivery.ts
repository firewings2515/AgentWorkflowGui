// Delivery records for handoffs, cross-session messages and transfers (R-04 steps 3-7, CR-2,
// CR2_DELIVERY_FIX). The schema rejects records that contradict the dispatch rules.
import { z } from 'zod';
import { AttemptId, ClientMessageId, OperationId, Timestamp } from './common';

/** Minimal delivery states (CR-2). `unknown` is never auto-resent; it is reconciled or shown to the user. */
export const DeliveryState = z.enum(['pending', 'sent', 'unknown']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** Runtime-side reference stored together with `sent` (Codex thread/turn/item, Claude session/message uuid). */
export const NativeRef = z.strictObject({
  sessionRef: z.string().min(1),
  turnRef: z.string().min(1).optional(),
  itemRef: z.string().min(1).optional(),
});
export type NativeRef = z.infer<typeof NativeRef>;

/**
 * Why an attempt counts as sent. `live-ack`: an accept response / message event tied to this attempt.
 * `reconciled`: the persisted history shows the same clientMessageId, target and matching content.
 * Session init, a local queue push or a finished socket write are not evidence (CR2_DELIVERY_FIX §1 step 5).
 */
export const DeliveryEvidence = z.strictObject({
  kind: z.enum(['live-ack', 'reconciled']),
  at: Timestamp,
  detail: z.string(),
});

/** A decision the user made about an unknown attempt (CR2_DELIVERY_FIX §2). Root AI never decides. */
export const AttemptResolution = z.strictObject({
  decision: z.enum(['wait', 'cancel', 'retry']),
  decidedBy: z.literal('user'),
  at: Timestamp,
  note: z.string().optional(),
});

/** One crossing of the dispatch boundary: committed as `unknown` before the runtime is called. */
export const DispatchAttempt = z
  .strictObject({
    attemptId: AttemptId,
    clientMessageId: ClientMessageId,
    state: z.enum(['unknown', 'sent']),
    dispatchStartedAt: Timestamp,
    nativeRef: NativeRef.optional(),
    evidence: DeliveryEvidence.optional(),
    resolution: AttemptResolution.optional(),
  })
  .refine((a) => (a.state === 'sent' ? a.nativeRef !== undefined && a.evidence !== undefined : a.nativeRef === undefined && a.evidence === undefined), {
    message: 'nativeRef and evidence are stored together with sent, never on unknown',
  })
  .refine((a) => a.state === 'unknown' || a.resolution === undefined, {
    message: 'only unknown attempts carry a user resolution',
  });
export type DispatchAttempt = z.infer<typeof DispatchAttempt>;

const unique = (xs: readonly string[]) => new Set(xs).size === xs.length;

/**
 * Delivery of one logical operation. `pending`: nobody holds an un-abandoned attempt (a user retry
 * abandons the old unknown attempt but keeps it). `unknown`: the last attempt crossed the boundary
 * without evidence. `sent`: the last attempt has a nativeRef and evidence.
 */
export const DeliveryRecord = z
  .strictObject({
    state: DeliveryState,
    attempts: z.array(DispatchAttempt),
  })
  .superRefine((d, ctx) => {
    const last = d.attempts.at(-1);
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (!unique(d.attempts.map((a) => a.attemptId))) fail('attemptId must be unique');
    if (!unique(d.attempts.map((a) => a.clientMessageId))) fail('clientMessageId must be unique per attempt');
    if (d.attempts.slice(0, -1).some((a) => a.state === 'sent' || a.resolution?.decision !== 'retry')) {
      fail('an earlier attempt must be unknown and abandoned by a user retry');
    }
    if (d.state === 'pending' && last && last.resolution?.decision !== 'retry') fail('pending cannot have a live attempt');
    if (d.state === 'unknown' && (last?.state !== 'unknown' || last.resolution?.decision === 'retry')) {
      fail('unknown needs a live unknown attempt');
    }
    if (d.state === 'sent' && last?.state !== 'sent') fail('sent needs a last attempt with nativeRef and evidence');
  });
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

/**
 * Creating a target session is its own operation, recorded before the runtime call (CR2_DELIVERY_FIX §3).
 * `nativeSessionRef` is known once created, or pre-allocated (Claude `sessionId` UUID chosen by the GUI).
 */
export const ProvisionRecord = z
  .strictObject({
    operationId: OperationId,
    /** Unique logical key of the target binding, so two provisions cannot race to create it. */
    bindingKey: z.string().min(1),
    state: DeliveryState,
    nativeSessionRef: z.string().min(1).optional(),
    preallocated: z.boolean(),
  })
  .refine((p) => p.state !== 'sent' || p.nativeSessionRef !== undefined, { message: 'a created target has a nativeSessionRef' })
  .refine((p) => !p.preallocated || p.nativeSessionRef !== undefined, { message: 'a pre-allocated target has a nativeSessionRef' });
export type ProvisionRecord = z.infer<typeof ProvisionRecord>;

/** Payload must not leave the GUI while its target is not bound (R-04 step 4). */
export const deliveryNeedsBoundTarget = (delivery: DeliveryRecord | undefined, provision: ProvisionRecord | undefined) =>
  delivery === undefined || delivery.state === 'pending' || provision === undefined || provision.state === 'sent';

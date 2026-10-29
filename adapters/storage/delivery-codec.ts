// Port-only delivery fields have no public schema. Validate them here alongside the contract DTOs.
import { z } from 'zod';
import {
  DeliveryRecord, DeliveryTarget, Handoff, HandoffId, InstanceId, MessageOrigin, ModelSelection,
  NodeId, OperationId, OperationOutcome, PayloadHash, PeerMessage, PeerMessageId, Revision,
  Runtime, SessionId, TaskId, Timestamp, deliveryTargetIssues,
} from '../../contracts';
import type { StoredDelivery } from '../../core/ports';
import { checkRecord, InvalidRecordError, readRecord, StoredDataError } from './codec';

// Acceptance and stored reads share all schemas and projection checks, but report distinct errors.
const validate = <S extends z.ZodType>(schema: S, value: unknown, writing: boolean): z.output<S> =>
  writing ? checkRecord(schema, 'delivery', value) : readRecord(schema, 'delivery', JSON.stringify(value));
const damaged = (problems: string[], writing: boolean): never => {
  throw writing ? new InvalidRecordError('delivery', problems) : new StoredDataError('delivery', problems);
};

const settings = { model: ModelSelection, readOnly: z.boolean(), instructions: z.string().optional() };
const handoff = z.strictObject({
  handoffId: HandoffId, instanceId: InstanceId, taskId: TaskId, fromNodeId: NodeId,
  toNodeId: NodeId, fromSessionId: SessionId, ruleId: z.string().min(1), rework: z.boolean(),
  round: z.number().int().nonnegative(), expectedUpstream: z.array(NodeId).optional(),
});
const peer = z.strictObject({ peerMessageId: PeerMessageId, fromSessionId: SessionId, toSessionId: SessionId, instanceId: InstanceId.optional() });
const base = {
  operationId: OperationId, sourceCallRef: z.string().min(1).optional(), sender: SessionId.optional(),
  payloadHash: PayloadHash, proposalRevision: Revision, target: DeliveryTarget, delivery: DeliveryRecord,
  acceptedAt: Timestamp, outcome: OperationOutcome.optional(),
};
export const StoredDeliverySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('provision'), spec: z.strictObject({
    ...settings, runtime: Runtime, sessionId: SessionId, cwd: z.string().min(1), preallocatedRef: z.string().min(1).optional(),
  }) }),
  z.strictObject({ ...base, kind: z.enum(['handoff', 'peer-message', 'transfer', 'user-message']),
    payload: z.string(), handoff: handoff.optional(), peer: peer.optional(),
    context: z.strictObject({ runtime: Runtime, cwd: z.string().min(1), session: z.strictObject(settings),
      origin: MessageOrigin.optional(), entry: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('new-turn'), model: ModelSelection.optional() }),
        z.strictObject({ kind: z.literal('insert'), expectedTurnRef: z.string().min(1).optional() }),
      ]),
    }),
  }),
]);

const payloadSchema = StoredDeliverySchema.options[1].pick({ payload: true, context: true, handoff: true, peer: true });
const provisionSchema = StoredDeliverySchema.options[0].pick({ spec: true });
export const readDeliveryBody = (kind: StoredDelivery['kind'], body: string): object =>
  kind === 'provision' ? readRecord(provisionSchema, 'delivery', body) : readRecord(payloadSchema, 'delivery', body);

export const projectHandoff = (record: StoredDelivery, writing = false): Handoff | undefined => {
  if (record.kind !== 'handoff' || record.handoff === undefined) return undefined;
  const { handoffId, ...meta } = record.handoff;
  return validate(Handoff, {
    ...meta, id: handoffId, operationId: record.operationId, sourceCallRef: record.sourceCallRef,
    payload: record.payload, payloadHash: record.payloadHash, proposalRevision: record.proposalRevision,
    target: record.target, delivery: record.delivery, outcome: record.outcome, acceptedAt: record.acceptedAt,
  }, writing);
};

export const projectPeer = (record: StoredDelivery, writing = false): PeerMessage | undefined => {
  if (record.kind !== 'peer-message' || record.peer === undefined) return undefined;
  const { peerMessageId, ...meta } = record.peer;
  if (record.target.sessionId !== meta.toSessionId) damaged(['peer:target-mismatch'], writing);
  return validate(PeerMessage, {
    ...meta, id: peerMessageId, operationId: record.operationId, sourceCallRef: record.sourceCallRef,
    toNativeSessionRef: record.target.nativeSessionRef, text: record.payload, payloadHash: record.payloadHash,
    entry: record.context.entry.kind, delivery: record.delivery, outcome: record.outcome, createdAt: record.acceptedAt,
  }, writing);
};

export const validateDelivery = (value: unknown, writing = false): StoredDelivery => {
  // JSON cannot contain explicit undefined properties; the port uses exact optional properties.
  const record = validate(StoredDeliverySchema, value, writing) as StoredDelivery;
  if (record.kind === 'provision') {
    const p = record.target.provision;
    const last = record.delivery.attempts.at(-1);
    if (p === undefined || p.operationId !== record.operationId || p.state !== record.delivery.state ||
      record.target.sessionId !== record.spec.sessionId ||
      (last?.state === 'sent' && (last.nativeRef.sessionRef !== p.nativeSessionRef || record.target.nativeSessionRef !== p.nativeSessionRef))) {
      damaged(['provision:binding-mismatch'], writing);
    }
  } else {
    const issues = deliveryTargetIssues(record.delivery, record.target);
    if (issues.length > 0) damaged(issues, writing);
    if ((record.handoff !== undefined && record.kind !== 'handoff') || (record.peer !== undefined && record.kind !== 'peer-message')) {
      damaged(['metadata:kind-mismatch'], writing);
    }
    // Pre-v4 records may lack metadata; new acceptances must always supply it.
    if (writing && ((record.kind === 'handoff' && record.handoff === undefined) || (record.kind === 'peer-message' && record.peer === undefined))) {
      damaged(['metadata:missing'], writing);
    }
    projectHandoff(record, writing);
    projectPeer(record, writing);
  }
  return record;
};

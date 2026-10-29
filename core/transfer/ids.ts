// Fixed IDs of a transfer (T023): every step after the user's confirmation can be redone after a restart
// and lands on the same operation, so the store recognises it instead of creating a second one (CR-2).
import { OperationId, SessionId, TransferId } from '../../contracts';

const PAYLOAD = 'transfer:';
const NOTE = 'transfer-note:';
const TARGET = 'transfer-target:';

/** The proposal's payload: the fixed frame sent to the new session. */
export const payloadOperationOf = (id: TransferId): OperationId => OperationId.parse(`${PAYLOAD}${id}`);
/** The request asking the source agent for its handoff note (`noteSource: 'agent'`). */
export const noteOperationOf = (id: TransferId): OperationId => OperationId.parse(`${NOTE}${id}`);
/** The new session in the target tool; created only once the user confirmed (CR-5). */
export const targetSessionOf = (id: TransferId): SessionId => SessionId.parse(`${TARGET}${id}`);

/** The transfer a payload or note operation belongs to. */
export const transferOfOperation = (operationId: string): { transferId: TransferId; part: 'payload' | 'note' } | undefined => {
  if (operationId.startsWith(NOTE) && operationId.length > NOTE.length) return { transferId: TransferId.parse(operationId.slice(NOTE.length)), part: 'note' };
  if (operationId.startsWith(PAYLOAD) && operationId.length > PAYLOAD.length) return { transferId: TransferId.parse(operationId.slice(PAYLOAD.length)), part: 'payload' };
  return undefined;
};

/** The transfer whose target this session ID names. */
export const transferOfSession = (sessionId: string): TransferId | undefined =>
  sessionId.startsWith(TARGET) && sessionId.length > TARGET.length ? TransferId.parse(sessionId.slice(TARGET.length)) : undefined;

/** The transfer whose target's creation this is: the session service names a provision `provision:<sessionId>`. */
export const transferOfProvision = (operationId: string): TransferId | undefined =>
  operationId.startsWith('provision:') ? transferOfSession(operationId.slice('provision:'.length)) : undefined;

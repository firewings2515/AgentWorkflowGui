import { randomUUID } from 'node:crypto';
import { HistoryCursor, type SessionId } from '../../contracts';

export interface HistoryBoundary { at: number; row: number }
/** A cursor is an issued capability, not serialized client-controlled query parameters. */
export class HistoryCursors {
  static readonly capacity = 8;
  private readonly issued = new Map<SessionId, Map<string, HistoryBoundary>>();
  issue(session: SessionId, boundary: HistoryBoundary): HistoryCursor {
    const cursor = HistoryCursor.parse(randomUUID());
    let issued = this.issued.get(session);
    if (!issued) { issued = new Map(); this.issued.set(session, issued); }
    issued.set(cursor, boundary);
    if (issued.size > HistoryCursors.capacity) issued.delete(issued.keys().next().value!);
    return cursor;
  }
  get(session: SessionId, cursor: HistoryCursor): HistoryBoundary | undefined {
    return this.issued.get(session)?.get(cursor);
  }
}

export const checkHistoryLimit = (limit: number): void => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('history:limit');
};

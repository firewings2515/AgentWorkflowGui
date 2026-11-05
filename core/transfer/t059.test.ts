// T059 (U4) r1 P2: a transfer from a session of an archived conversation is refused by the command itself (`archived`),
// nothing proposed; an active transfer keeps its conversation from being archived; a confirmation of a proposal whose
// conversation was archived meanwhile is refused.
import { describe, expect, it } from 'vitest';
import { SessionId, TransferId } from '../../contracts';
import { AGENT, confirm, CWD, prepare, rid, settle, source, world } from './testing/harness';

const archive = async (w: Awaited<ReturnType<typeof world>>, id: SessionId) =>
  w.run({ type: 'session.archive', requestId: rid(), sessionId: id, expectedRevision: (await w.repositories.sessions.get(id))!.revision });

describe('T059 transfers and archived conversations', () => {
  it('transfer.prepare from a session of an archived tree (top or below): refused archived, no proposal stored', async () => {
    const w = await world();
    const top = await source(w);
    const child = SessionId.parse('child-1');
    expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: child, kind: 'ordinary', agentId: AGENT, model: { runtime: 'claude', model: 'haiku' }, cwd: CWD, parentId: top })).toMatchObject({ ok: true });
    await settle();
    expect(await archive(w, top)).toMatchObject({ ok: true });
    for (const [id, from] of [['tr-top', top], ['tr-child', child]] as const) {
      const result = await prepare(w, from, TransferId.parse(id));
      expect(result).toMatchObject({ ok: false, code: 'invalid_transition', reason: 'archived' });
      expect(await w.repositories.transfers.get(TransferId.parse(id))).toBeUndefined();
    }
    expect(await w.repositories.transfers.list()).toEqual([]);
    // Unarchived, the same transfer is prepared.
    expect(await w.run({ type: 'session.unarchive', requestId: rid(), sessionId: top, expectedRevision: (await w.repositories.sessions.get(top))!.revision })).toMatchObject({ ok: true });
    expect(await prepare(w, top, TransferId.parse('tr-again'))).toMatchObject({ ok: true });
  });

  it('a prepared transfer keeps its conversation from being archived; a proposal whose conversation was archived meanwhile is not confirmed', async () => {
    const w = await world();
    const top = await source(w);
    const id = TransferId.parse('tr-1');
    expect(await prepare(w, top, id)).toMatchObject({ ok: true });
    await settle();
    expect(await archive(w, top)).toMatchObject({ ok: false, code: 'invalid_transition' });
    // Archived as it was prepared (the mark written straight into storage here).
    const session = (await w.repositories.sessions.get(top))!;
    await w.repositories.sessions.update({ ...session, archivedAt: '2026-11-05T00:00:00.000Z' } as typeof session, session.revision);
    expect(await confirm(w, id)).toMatchObject({ ok: false, code: 'invalid_transition', reason: 'archived' });
    expect((await w.repositories.transfers.get(id))?.state).not.toBe('approved');
  });
});

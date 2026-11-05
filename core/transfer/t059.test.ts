// T059 (U4) r1 P2: a transfer from a session of an archived conversation is refused by the command itself (`archived`),
// nothing proposed; an active transfer keeps its conversation from being archived; a confirmation of a proposal whose
// conversation was archived meanwhile is refused.
import { describe, expect, it } from 'vitest';
import { SessionId, TransferId } from '../../contracts';
import { targetSessionOf } from './ids';
import { AGENT, CLAUDE, confirm, CWD, prepare, proposal, rid, settle, source, world } from './testing/harness';

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

describe('T059 r2: a transfer and the archive commit', () => {
  const ticks = async (n = 4) => {
    for (let i = 0; i < n; i++) await settle();
  };

  it('a transfer prepared and confirmed from a child while its tree is being archived: never an archived tree with the new session working', async () => {
    const w = await world();
    const top = await source(w, CLAUDE, 'top-a');
    const child = await source(w, CLAUDE, 'child-b');
    expect(await w.run({ type: 'session.reparent', requestId: rid(), sessionId: child, expectedRevision: (await w.repositories.sessions.get(child))!.revision, parentId: top })).toMatchObject({ ok: true });
    const id = TransferId.parse('tr-race');
    const target = targetSessionOf(id);
    w.holding.add(target);
    // The archive stops after its last checks, right before it writes the mark.
    const sessions = w.repositories.sessions;
    const update = sessions.update.bind(sessions);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    sessions.update = async (session, expected) => {
      if (session.id === top && session.kind === 'ordinary' && session.archivedAt !== undefined && !paused) {
        paused = true;
        await held;
      }
      return update(session, expected);
    };
    const archiving = archive(w, top);
    for (let i = 0; i < 40 && !paused; i++) await settle();
    expect(paused).toBe(true);
    // Meanwhile the user prepares a transfer from the child and confirms it.
    const transferring = (async () => {
      const prepared = await prepare(w, child, id);
      if (!prepared.ok) return prepared;
      for (let i = 0; i < 20 && (await w.repositories.transfers.get(id))?.state !== 'awaiting-confirmation'; i++) await settle();
      return confirm(w, id, (await proposal(w, id)).revision);
    })();
    await ticks();
    release();
    const archived = await archiving;
    const transferred = await transferring;
    sessions.update = update;
    await ticks();
    const topNow = (await w.repositories.sessions.get(top))!;
    const isArchived = topNow.kind === 'ordinary' && topNow.archivedAt !== undefined;
    const made = await w.repositories.sessions.get(target);
    // Either the archive went first and the transfer was refused (archived, nothing made), or the other way round.
    if (isArchived) {
      expect(archived).toMatchObject({ ok: true });
      expect(transferred).toMatchObject({ ok: false, reason: 'archived' });
      expect(made).toBeUndefined();
      expect(await w.repositories.transfers.get(id)).toBeUndefined();
    } else {
      expect(archived).toMatchObject({ ok: false });
    }
    expect(isArchived && made !== undefined).toBe(false);
  });

  it('a confirmation that comes while the tree is being archived waits for the commit and is refused (archived)', async () => {
    const w = await world();
    const top = await source(w, CLAUDE, 'top-a');
    const id = TransferId.parse('tr-confirm');
    expect(await prepare(w, top, id)).toMatchObject({ ok: true });
    for (let i = 0; i < 20 && (await w.repositories.transfers.get(id))?.state !== 'awaiting-confirmation'; i++) await settle();
    const p = await proposal(w, id);
    const session = (await w.repositories.sessions.get(top))!;
    // Archived straight in storage while the proposal still waits (as if the two raced past each other's checks).
    await w.repositories.sessions.update({ ...session, archivedAt: '2026-11-05T00:00:00.000Z' } as typeof session, session.revision);
    const service = w.service;
    const inArchived = service.inArchivedTree.bind(service);
    // Past the confirmation's own quick check: refused where the approval is written.
    service.inArchivedTree = () => Promise.resolve(false);
    const result = await confirm(w, id, p.revision);
    service.inArchivedTree = inArchived;
    expect(result).toMatchObject({ ok: false, code: 'invalid_transition', reason: 'archived' });
    expect((await proposal(w, id)).state).toBe('awaiting-confirmation');
    expect(await w.repositories.sessions.get(targetSessionOf(id))).toBeUndefined();
  });
});

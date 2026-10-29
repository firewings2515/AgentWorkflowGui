import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HandoffId, InstanceId, NodeId, PeerMessageId, SessionId, TaskId, TransferProposal, WorkflowInstance } from '../../contracts';
import { fixtureSnapshot as fx } from '../../contracts/fixtures/snapshot';
import { DeliveryService } from '../../core/delivery/service';
import { FakeHistory, FakeRuntime } from '../../core/delivery/testing/fake-runtime';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { hashOf as serviceHash, payloadInput as serviceInput, uuid } from '../../core/delivery/testing/fixtures';
import { InvalidRecordError, StoredDataError } from './codec';
import { openDatabase } from './database';
import { SqliteDeliveryStore } from './delivery-store';
import { createRepositories } from './repositories';
import { at, claimInput, COUNT_KEY, op, payloadInput, provisionInput, THREAD } from './testing/fixtures';

let dir: string;
let path: string;
let db: DatabaseSync;
let store: SqliteDeliveryStore;
let repos: ReturnType<typeof createRepositories>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t022-'));
  path = join(dir, 'app.sqlite');
  db = openDatabase(path);
  store = new SqliteDeliveryStore(db);
  repos = createRepositories(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const reopen = () => { db.close(); db = openDatabase(path); store = new SqliteDeliveryStore(db); repos = createRepositories(db); };
const counts = [{ key: COUNT_KEY, limit: 3 }, { key: 'rework', limit: 1 }];
const ack = { kind: 'live-ack' as const, at: at(20), detail: 'accepted' };
const draft = (): TransferProposal => ({ ...fx.transfers[1]!, operationId: op('transfer-payload') });

describe('T022 atomic acceptance', () => {
  it('limit zero rejects the first admission with no writes, matching MemoryDeliveryStore', async () => {
    const input = payloadInput({ counts: [{ key: 'rw', limit: 0 }] });
    const expected = { status: 'limit-exceeded', key: 'rw', count: 0, limit: 0 };
    expect(await new MemoryDeliveryStore().accept(input)).toEqual(expected);
    expect(await store.accept(input)).toEqual(expected);
    for (const table of ['delivery', 'receive_admission', 'provision', 'dispatch_attempt']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('invalid acceptance uses the read schemas before writing and returns a fixed detail', async () => {
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    const inputs = [
      payloadInput({ sourceCallRef: undefined }),
      payloadInput({ kind: 'peer-message', peer, sourceCallRef: undefined }),
      payloadInput({ handoff: { ...payloadInput().handoff!, expectedUpstream: [NodeId.parse('SECRET')] } }),
      payloadInput({ kind: 'peer-message', peer: { ...peer, toSessionId: SessionId.parse('SECRET') } }),
      payloadInput({ at: 'SECRET' }),
      provisionInput({ target: {} }),
    ];
    for (const input of inputs) {
      expect(await store.accept(input)).toEqual({ status: 'invalid', detail: 'invalid delivery acceptance' });
    }
    expect(db.prepare('SELECT count(*) AS n FROM delivery').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM provision').get()).toEqual({ n: 0 });
  });

  it('metadata appears exactly on its own delivery kind', async () => {
    const handoff = payloadInput().handoff!;
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    for (const kind of ['handoff', 'peer-message', 'transfer', 'user-message', 'provision'] as const) {
      const base = kind === 'provision' ? provisionInput() : payloadInput({ kind, handoff: undefined, peer: undefined });
      for (const metadata of [{ handoff }, { peer }, { handoff, peer }, {}]) {
        const result = await store.accept({ ...base, ...metadata });
        const valid = (kind === 'handoff' && 'handoff' in metadata && !('peer' in metadata)) ||
          (kind === 'peer-message' && 'peer' in metadata && !('handoff' in metadata)) ||
          (!['handoff', 'peer-message'].includes(kind) && Object.keys(metadata).length === 0);
        expect(result.status).toBe(valid ? 'accepted' : 'invalid');
        db.exec('DELETE FROM receive_admission; DELETE FROM provision; DELETE FROM delivery');
      }
    }
  });

  it('unique indexes enforce projection IDs and source calls across operations', async () => {
    const input = payloadInput();
    await store.accept(input);
    expect(await store.accept(payloadInput({ operationId: op('same-handoff'), handoff: input.handoff })))
      .toMatchObject({ status: 'conflict', existing: { operationId: input.operationId } });
    expect(await store.accept(payloadInput({ operationId: op('same-call'), sourceCallRef: input.sourceCallRef, counts: [{ key: COUNT_KEY, limit: 1 }] })))
      .toMatchObject({ status: 'conflict', existing: { operationId: input.operationId } });
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    await store.accept(payloadInput({ kind: 'peer-message', operationId: op('peer'), peer, counts: undefined }));
    expect(await store.accept(payloadInput({ kind: 'peer-message', operationId: op('same-peer'), peer, counts: undefined })))
      .toMatchObject({ status: 'conflict', existing: { operationId: 'peer' } });
    // Bypass the adapter: SQLite, not just application checks, rejects duplicate identities.
    for (const field of ['source_call_ref', 'body']) {
      expect(() => db.exec(`INSERT INTO delivery
        (operation_id, kind, payload_hash, proposal_revision, accepted_target, target, body, state, accepted_at, accepted_ms, source_call_ref)
        SELECT 'direct', kind, payload_hash, proposal_revision, accepted_target, target,
          ${field === 'body' ? 'body' : "'{}'"}, state, accepted_at, accepted_ms,
          ${field === 'source_call_ref' ? 'source_call_ref' : 'NULL'} FROM delivery WHERE operation_id = 'op-1'`)).toThrow(/UNIQUE/);
    }
    expect(() => db.exec(`INSERT INTO delivery
      (operation_id, kind, payload_hash, proposal_revision, accepted_target, target, body, state, accepted_at, accepted_ms)
      SELECT 'direct-peer', kind, payload_hash, proposal_revision, accepted_target, target, body, state, accepted_at, accepted_ms
      FROM delivery WHERE operation_id = 'peer'`)).toThrow(/UNIQUE/);
    for (const id of ['null-a', 'null-b']) expect((await store.accept(payloadInput({ kind: 'user-message', operationId: op(id), sourceCallRef: undefined, counts: undefined }))).status).toBe('accepted');
    expect(db.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 1 });
  });

  it('unrelated damaged rows do not block acceptance or targeted projections; snapshot fails closed', async () => {
    await store.accept(payloadInput());
    db.exec("UPDATE delivery SET body = 'SECRET broken JSON'");
    const healthy = payloadInput({ operationId: op('healthy') });
    expect((await store.accept(healthy)).status).toBe('accepted');
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    expect((await store.accept(payloadInput({ kind: 'peer-message', operationId: op('peer'), peer, counts: undefined }))).status).toBe('accepted');
    expect(await repos.handoffs.get(healthy.handoff!.handoffId)).toMatchObject({ operationId: healthy.operationId });
    expect(await repos.handoffs.listByInstance(healthy.handoff!.instanceId)).toHaveLength(1);
    expect(await repos.peerMessages.get(peer.peerMessageId)).toMatchObject({ id: peer.peerMessageId });
    expect(await repos.peerMessages.list()).toHaveLength(1);
    await expect(repos.readSnapshotData()).rejects.toBeInstanceOf(StoredDataError);
  });

  it('delivery and projection lists sort by epoch milliseconds then rowid across offsets', async () => {
    const times = ['2026-10-26T09:00:00.002+08:00', '2026-10-26T01:00:00.001Z', '2026-10-26T09:00:00.001+08:00'];
    for (const kind of ['handoff', 'peer-message'] as const) {
      for (const [i, timestamp] of times.entries()) {
        const id = `${kind}-${i}`;
        const peer = { peerMessageId: PeerMessageId.parse(id), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
        expect((await store.accept(payloadInput({ kind, operationId: op(id), at: timestamp, counts: undefined, ...(kind === 'peer-message' && { peer }) }))).status).toBe('accepted');
      }
    }
    const expected = ['handoff-1', 'handoff-2', 'peer-message-1', 'peer-message-2', 'handoff-0', 'peer-message-0'];
    expect((await store.listByState('pending')).map((r) => r.operationId)).toEqual(expected);
    expect(store.loadAll().map((r) => r.operationId)).toEqual(expected);
    expect((await repos.handoffs.listByInstance(InstanceId.parse('instance-1'))).map((r) => r.operationId)).toEqual(['handoff-1', 'handoff-2', 'handoff-0']);
    expect((await repos.peerMessages.list()).map((r) => r.operationId)).toEqual(['peer-message-1', 'peer-message-2', 'peer-message-0']);
  });
  it('sequential accepts across two connections count once; metadata survives reopen', async () => {
    const second = openDatabase(path);
    const input = payloadInput({ counts, sender: SessionId.parse('sender') });
    try {
      const results = await Promise.all([store.accept(input), new SqliteDeliveryStore(second).accept(input)]);
      expect(results.map((r) => r.status)).toEqual(['accepted', 'duplicate']);
      expect(results[0]).toMatchObject({ counts: [{ key: COUNT_KEY, count: 1 }, { key: 'rework', count: 1 }] });
    } finally { second.close(); }
    reopen();
    expect(await store.findBySourceCallRef('call-1')).toMatchObject({ sender: 'sender', handoff: input.handoff });
    expect((await store.accept(input)).status).toBe('duplicate');
    expect(await store.accept(payloadInput({ operationId: op('blocked'), counts }))).toMatchObject({ status: 'limit-exceeded', key: 'rework' });
    expect(await store.get(op('blocked'))).toBeUndefined();
    expect(db.prepare('SELECT count_key FROM receive_admission ORDER BY ordinal').all()).toEqual([{ count_key: COUNT_KEY }, { count_key: 'rework' }]);
    expect((await repos.handoffs.listByInstance(InstanceId.parse('instance-1')))).toHaveLength(1);
  });

  it('resends compare sender, ordered keys and metadata; changed limits do not recount', async () => {
    const input = payloadInput({ counts, sender: SessionId.parse('sender') });
    await store.accept(input);
    for (const change of [
      { sender: SessionId.parse('other') }, { counts: [...counts].reverse() }, { counts: counts.slice(0, 1) },
      { handoff: { ...input.handoff!, rework: true } }, { handoff: { ...input.handoff!, ruleId: 'other' } },
      { payload: 'other' }, { target: { ...input.target, nativeSessionRef: 'other' } },
    ]) expect((await store.accept({ ...input, ...change })).status).toBe('conflict');
    expect((await store.accept({ ...input, counts: counts.map((c) => ({ ...c, limit: 99 })) })).status).toBe('duplicate');
    expect(await store.accept(payloadInput({ handoff: undefined }))).toMatchObject({ status: 'invalid' });
    expect(await store.accept(payloadInput({ kind: 'peer-message' }))).toMatchObject({ status: 'invalid' });
  });

  it('rolls back delivery and every admission if a later count insert fails', async () => {
    db.exec("CREATE TRIGGER fail_count BEFORE INSERT ON receive_admission WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(store.accept(payloadInput({ counts }))).rejects.toThrow('injected');
    expect(await store.get(op('op-1'))).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 0 });
    expect(await repos.handoffs.listByInstance(InstanceId.parse('instance-1'))).toEqual([]);
  });

  it('outcomes are set once, survive restart, and never suppress later delivery evidence', async () => {
    await store.accept(payloadInput());
    const claim = claimInput(op('op-1'));
    await store.claim(claim);
    const outcome = { kind: 'cancelled' as const, detail: 'cancelled', at: at(12) };
    expect(await store.recordOutcome(op('op-1'), outcome)).toBe('recorded');
    expect(await store.recordOutcome(op('op-1'), outcome)).toBe('recorded');
    expect(await store.recordOutcome(op('op-1'), { ...outcome, kind: 'failed' })).toBe('stale');
    expect(await store.recordOutcome(op('missing'), outcome)).toBe('stale');
    reopen();
    await store.recordSent(op('op-1'), claim.attemptId, { sessionRef: THREAD }, ack);
    expect(await repos.handoffs.get(HandoffId.parse('handoff-op-1'))).toMatchObject({ outcome, delivery: { state: 'sent' } });
    expect(await store.findBySourceCallRef('absent')).toBeUndefined();
  });
});

describe('T022 instance/task CAS and node sessions', () => {
  it('instance and transfer createdAt are immutable and both creates force revision zero', async () => {
    const instance = { ...fx.instances[0]!, revision: 7 };
    const proposal = { ...draft(), revision: 7 };
    await repos.instances.create(instance);
    await repos.transfers.create(proposal);
    const beforeInstance = db.prepare('SELECT created_ms, body FROM workflow_instance').get();
    const beforeTransfer = db.prepare('SELECT created_ms, body FROM transfer_proposal').get();
    expect((await repos.instances.get(instance.id))?.revision).toBe(0);
    expect((await repos.transfers.get(proposal.id))?.revision).toBe(0);
    expect(await repos.instances.update({ ...instance, createdAt: at(59) }, 0)).toMatchObject({ status: 'stale', current: { createdAt: instance.createdAt } });
    expect(await repos.transfers.update({ ...proposal, revision: 1, createdAt: at(59) }, 0)).toMatchObject({ status: 'stale', current: { createdAt: proposal.createdAt } });
    expect(db.prepare('SELECT created_ms, body FROM workflow_instance').get()).toEqual(beforeInstance);
    expect(db.prepare('SELECT created_ms, body FROM transfer_proposal').get()).toEqual(beforeTransfer);
    expect(await repos.instances.update(instance, 0)).toMatchObject({ status: 'saved' });
    expect(await repos.transfers.update({ ...proposal, revision: 1 }, 0)).toMatchObject({ status: 'saved' });
    expect(db.prepare('SELECT created_ms FROM workflow_instance').get()?.created_ms).toBe(beforeInstance?.created_ms);
    expect(db.prepare('SELECT created_ms FROM transfer_proposal').get()?.created_ms).toBe(beforeTransfer?.created_ms);
  });

  it('bindNodeSession rejects an empty taskId without aliasing the root', async () => {
    const root = { instanceId: InstanceId.parse('i'), nodeId: NodeId.parse('n') };
    await expect(repos.instances.bindNodeSession({ ...root, taskId: '' as TaskId }, SessionId.parse('bad'))).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repos.instances.findNodeSession(root)).toBeUndefined();
    await repos.instances.bindNodeSession(root, SessionId.parse('root'));
    await expect(repos.instances.bindNodeSession({ ...root, taskId: '' as TaskId }, SessionId.parse('bad'))).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repos.instances.findNodeSession(root)).toBe('root');
  });
  it('stores a pinned template and tasks together, creates at zero and rejects a stale update', async () => {
    const instance = fx.instances[0]!;
    expect(await repos.instances.create(instance)).toBe('created');
    expect(await repos.instances.create({ ...instance, title: 'ignored' })).toBe('exists');
    const second = openDatabase(path);
    try {
      const updated = { ...instance, tasks: instance.tasks.map((t) => ({ ...t, reworkCount: 2 })) };
      const results = await Promise.all([repos.instances.update(updated, 0), createRepositories(second).instances.update({ ...instance, state: 'completed' }, 0)]);
      expect(results[0]).toMatchObject({ status: 'saved', record: { revision: 1 } });
      expect(results[1]).toMatchObject({ status: 'stale', current: { revision: 1 } });
    } finally { second.close(); }
    reopen();
    expect(await repos.instances.get(instance.id)).toMatchObject({ revision: 1, template: instance.template, tasks: instance.tasks.map((t) => ({ ...t, reworkCount: 2 })) });
    expect(await repos.instances.list()).toHaveLength(1);
    expect(await repos.instances.get(InstanceId.parse('absent'))).toBeUndefined();
  });

  it('binds one session per tuple, including root, without delimiter collisions', async () => {
    const key = { instanceId: InstanceId.parse('i/a'), nodeId: NodeId.parse('b'), taskId: TaskId.parse('c') };
    const second = openDatabase(path);
    try {
      expect(await Promise.all([repos.instances.bindNodeSession(key, SessionId.parse('one')), createRepositories(second).instances.bindNodeSession(key, SessionId.parse('two'))]))
        .toEqual([{ status: 'bound' }, { status: 'exists', sessionId: 'one' }]);
    } finally { second.close(); }
    const root = { instanceId: key.instanceId, nodeId: key.nodeId };
    expect(await repos.instances.bindNodeSession(root, SessionId.parse('root'))).toEqual({ status: 'bound' });
    expect(await repos.instances.bindNodeSession({ ...key, instanceId: InstanceId.parse('i'), nodeId: NodeId.parse('a/b') }, SessionId.parse('three'))).toEqual({ status: 'bound' });
    reopen();
    expect(await repos.instances.findNodeSession(key)).toBe('one');
    expect(await repos.instances.findNodeSession(root)).toBe('root');
  });
});

describe('T022 live projections', () => {
  it('snapshot and transfer projections share one read transaction during a concurrent writer commit', async () => {
    const proposal = draft();
    const provision = provisionInput();
    await store.accept(provision);
    await repos.transfers.create(proposal);
    await repos.transfers.update({ ...proposal, revision: 1, state: 'approved', approvedRevision: 1, approvedAt: at(), provision: provision.target.provision }, 0);
    const second = openDatabase(path);
    const writer = new SqliteDeliveryStore(second);
    const prepare = db.prepare.bind(db);
    let write: ReturnType<SqliteDeliveryStore['claim']> | undefined;
    db.prepare = (sql) => {
      if (sql.includes('FROM transfer_proposal ORDER') && write === undefined) {
        write = writer.claim(claimInput(provision.operationId, { expectedNativeSessionRef: undefined }));
      }
      return prepare(sql);
    };
    try {
      const snapshot = await repos.readSnapshotData();
      expect(await write).toMatchObject({ status: 'claimed' });
      expect(snapshot.transfers[0]?.provision?.state).toBe('pending');
      expect((await repos.transfers.get(proposal.id))?.provision?.state).toBe('unknown');
    } finally { db.prepare = prepare; second.close(); }
  });

  it('handoff rework, target and delivery follow provision, claim, retry and sent immediately', async () => {
    const provision = provisionInput();
    const input = payloadInput({ target: provision.target, counts, handoff: { ...payloadInput().handoff!, rework: true } });
    await store.accept(input);
    await store.accept(provision);
    const pclaim = claimInput(provision.operationId, { expectedNativeSessionRef: undefined });
    await store.claim(pclaim);
    await store.recordSent(provision.operationId, pclaim.attemptId, { sessionRef: provision.spec.preallocatedRef! }, ack);
    const target = (await store.get(provision.operationId))!.target;
    await store.updateTarget(input.operationId, input.target, target);
    const claim = claimInput(input.operationId, { expectedNativeSessionRef: target.nativeSessionRef });
    await store.claim(claim);
    expect(await repos.handoffs.get(input.handoff!.handoffId)).toMatchObject({ rework: true, target, delivery: { state: 'unknown' } });
    await store.recordResolution(input.operationId, claim.attemptId, { decision: 'retry', at: at(11) });
    expect((await repos.readSnapshotData()).handoffs[0]?.delivery.state).toBe('pending');
    const next = claimInput(input.operationId, { expectedNativeSessionRef: target.nativeSessionRef });
    await store.claim(next);
    await store.recordSent(input.operationId, next.attemptId, { sessionRef: target.nativeSessionRef! }, ack);
    expect((await repos.readSnapshotData()).handoffs[0]).toMatchObject({ rework: true, delivery: { state: 'sent', attempts: [{ resolution: { decision: 'retry' } }, { state: 'sent' }] } });
    expect(db.prepare('SELECT count(*) AS n FROM receive_admission').get()).toEqual({ n: 2 });
  });

  it('PeerMessage projects current native target, entry, delivery and outcome', async () => {
    const peer = { peerMessageId: PeerMessageId.parse('p'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target'), instanceId: InstanceId.parse('i') };
    const input = payloadInput({ kind: 'peer-message', peer, counts: undefined, context: { ...payloadInput().context, entry: { kind: 'insert', expectedTurnRef: 'turn' } } });
    await store.accept(input);
    expect(await repos.peerMessages.get(peer.peerMessageId)).toMatchObject({ text: input.payload, instanceId: peer.instanceId, entry: 'insert', toNativeSessionRef: THREAD });
    const claim = claimInput(input.operationId);
    await store.claim(claim);
    expect((await repos.peerMessages.list())[0]?.delivery.state).toBe('unknown');
    await store.recordSent(input.operationId, claim.attemptId, { sessionRef: THREAD }, ack);
    await store.recordOutcome(input.operationId, { kind: 'cancelled', at: at(), detail: '' });
    expect((await repos.readSnapshotData()).peerMessages[0]).toMatchObject({ delivery: { state: 'sent' }, outcome: { kind: 'cancelled' } });
    expect(await repos.peerMessages.get(PeerMessageId.parse('absent'))).toBeUndefined();
  });

  it('transfer preserves pending provision before acceptance and projects live state after acceptance', async () => {
    const proposal = draft();
    const provision = provisionInput();
    await repos.transfers.create(proposal);
    const approved = { ...proposal, revision: 1, state: 'approved' as const, approvedAt: at(), approvedRevision: 1, provision: provision.target.provision };
    expect(await repos.transfers.update(approved, 0)).toMatchObject({ status: 'saved', record: { revision: 1, provision: provision.target.provision } });
    reopen();
    expect(await repos.transfers.get(proposal.id)).toMatchObject({ provision: provision.target.provision });
    expect(await store.get(provision.operationId)).toBeUndefined();
    await store.accept(provision);
    const payload = payloadInput({ kind: 'transfer', operationId: proposal.operationId, payloadHash: proposal.payloadHash, target: provision.target, counts: undefined });
    await store.accept(payload);
    // Bogus delivery snapshots passed by callers are ignored; live delivery records take precedence.
    const cancelled = { ...approved, revision: 2, state: 'cancelled' as const, cancelledAt: at(5), createdSessionId: SessionId.parse('bogus'), delivery: { state: 'sent' as const, attempts: [] } };
    expect(await repos.transfers.update(cancelled, 1)).toMatchObject({ status: 'saved', record: { delivery: { state: 'pending' }, provision: { state: 'pending' } } });
    const stored = JSON.parse((db.prepare('SELECT body FROM transfer_proposal').get() as { body: string }).body) as Record<string, unknown>;
    expect(stored).not.toHaveProperty('delivery');
    expect(stored).not.toHaveProperty('createdSessionId');
    expect(stored.provision).toEqual(provision.target.provision);
    const claim = claimInput(provision.operationId, { expectedNativeSessionRef: undefined });
    await store.claim(claim);
    expect((await repos.transfers.get(proposal.id))?.provision?.state).toBe('unknown');
    await store.recordSent(provision.operationId, claim.attemptId, { sessionRef: provision.spec.preallocatedRef! }, ack);
    expect((await repos.transfers.get(proposal.id))).toMatchObject({ state: 'cancelled', approvedRevision: 1, revision: 2, createdSessionId: provision.spec.sessionId, provision: { state: 'sent' }, delivery: { state: 'pending' } });
    const target = (await store.get(provision.operationId))!.target;
    await store.updateTarget(payload.operationId, payload.target, target);
    const deliveryClaim = claimInput(payload.operationId, { expectedNativeSessionRef: target.nativeSessionRef });
    await store.claim(deliveryClaim);
    expect((await repos.transfers.list())[0]?.delivery?.state).toBe('unknown');
    await store.recordSent(payload.operationId, deliveryClaim.attemptId, { sessionRef: target.nativeSessionRef! }, ack);
    reopen();
    expect((await repos.readSnapshotData()).transfers[0]?.delivery?.state).toBe('sent');
  });

  it('transfer CAS refuses stale confirmation and wrong next revision, supports failure after approval', async () => {
    const proposal = draft();
    await repos.transfers.create(proposal);
    expect(await repos.transfers.create(proposal)).toBe('exists');
    const edited = { ...proposal, revision: 1, sourceRevision: proposal.sourceRevision + 1, content: { ...proposal.content, note: 'new source' } };
    await repos.transfers.update(edited, 0);
    const approval = { ...proposal, revision: 1, state: 'approved' as const, approvedRevision: 1, approvedAt: at() };
    expect(await repos.transfers.update(approval, 0)).toMatchObject({ status: 'stale', current: edited });
    await expect(repos.transfers.update({ ...edited, revision: 1 }, 1)).rejects.toBeInstanceOf(TypeError);
    await expect(repos.transfers.update({ ...approval, revision: 2 }, 1)).rejects.toBeInstanceOf(InvalidRecordError);
    await repos.transfers.update({ ...edited, revision: 2, state: 'approved', approvedRevision: 2, approvedAt: at() }, 1);
    expect(await repos.transfers.update({ ...edited, revision: 3, state: 'failed', approvedRevision: 2, approvedAt: at(), failure: { message: 'failed to create' } }, 2)).toMatchObject({ status: 'saved', record: { state: 'failed', revision: 3, approvedRevision: 2 } });
  });
});

describe('T022 fail closed', () => {
  it.each(['payloadHash', 'proposalRevision'] as const)('transfer fails closed when delivery %s differs from approval', async (field) => {
    const proposal = draft();
    const provision = provisionInput();
    await repos.transfers.create(proposal);
    await repos.transfers.update({ ...proposal, revision: 1, state: 'approved', approvedRevision: 1, approvedAt: at(), provision: provision.target.provision }, 0);
    const payload = payloadInput({ kind: 'transfer', operationId: proposal.operationId, payloadHash: proposal.payloadHash, target: provision.target, counts: undefined });
    const changed = { ...payload, ...(field === 'payloadHash' ? { payloadHash: serviceHash('SECRET') } : { proposalRevision: 2 }) };
    // T022 r2 P2-1: a delivery that does not match the approval is refused before it is written...
    expect(await store.accept(changed)).toMatchObject({ status: 'invalid' });
    expect(await store.get(proposal.operationId)).toBeUndefined();
    // ...and one that is stored anyway (damage) still fails every read closed.
    expect((await store.accept(payload)).status).toBe('accepted');
    if (field === 'payloadHash') db.prepare('UPDATE delivery SET payload_hash = ? WHERE operation_id = ?').run(serviceHash('SECRET'), proposal.operationId);
    else db.prepare('UPDATE delivery SET proposal_revision = 2 WHERE operation_id = ?').run(proposal.operationId);
    const error = { name: 'StoredDataError', table: 'transfer_proposal', problems: ['delivery:approval-mismatch'] };
    await expect(repos.transfers.get(proposal.id)).rejects.toMatchObject(error);
    await expect(repos.transfers.list()).rejects.toMatchObject(error);
    await expect(repos.readSnapshotData()).rejects.toMatchObject(error);
  });
  it.each(['workflow_instance', 'transfer_proposal', 'delivery'] as const)('rejects the whole snapshot for damaged %s JSON without quoting content', async (table) => {
    await repos.instances.create(fx.instances[0]!);
    await repos.transfers.create(draft());
    await store.accept(payloadInput());
    db.prepare(`UPDATE ${table} SET body = ?`).run('SECRET damaged JSON');
    await expect(repos.readSnapshotData()).rejects.toMatchObject({ name: 'StoredDataError', table });
    try { await repos.readSnapshotData(); } catch (error) { expect(String(error)).not.toContain('SECRET'); }
  });
  it.each([
    "UPDATE workflow_instance SET revision = 9",
    "UPDATE node_session SET session_id = ''",
    "UPDATE delivery SET body = json_remove(body, '$.handoff')",
    "UPDATE delivery SET outcome = '{\"kind\":\"bad\"}'",
    "UPDATE delivery SET target = '{\"nativeSessionRef\":42}'",
    "UPDATE delivery SET body = json_set(body, '$.handoff.rework', 'SECRET')",
    "UPDATE delivery SET body = json_remove(body, '$.handoff.rework')",
    "UPDATE receive_admission SET count_key = ''",
  ])('rejects structurally corrupt stored data: %s', async (sql) => {
    await repos.instances.create(fx.instances[0]!);
    await repos.instances.bindNodeSession({ instanceId: InstanceId.parse('i'), nodeId: NodeId.parse('n') }, SessionId.parse('s'));
    await store.accept(payloadInput());
    db.exec(sql);
    await expect(repos.readSnapshotData()).rejects.toBeInstanceOf(StoredDataError);
  });
  it('refuses invalid instance writes without partial changes', async () => {
    await expect(repos.instances.create({ ...fx.instances[0]!, tasks: [{ ...fx.instances[0]!.tasks[0]!, instanceId: InstanceId.parse('other') }] })).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repos.instances.list()).toEqual([]);
    expect(WorkflowInstance.safeParse(fx.instances[0]).success).toBe(true);
  });

  it('rejects corrupt attempts and mismatched transfer provision links', async () => {
    const proposal = draft();
    const provision = provisionInput();
    await store.accept(provision);
    await repos.transfers.create(proposal);
    await repos.transfers.update({ ...proposal, revision: 1, state: 'approved', approvedRevision: 1, approvedAt: at(), provision: provision.target.provision }, 0);
    db.exec("UPDATE transfer_proposal SET body = json_set(body, '$.provision.bindingKey', 'wrong')");
    await expect(repos.readSnapshotData()).rejects.toMatchObject({ name: 'StoredDataError', table: 'transfer_proposal' });
    db.exec('DELETE FROM transfer_proposal');
    const claim = claimInput(provision.operationId, { expectedNativeSessionRef: undefined });
    await store.claim(claim);
    db.exec("UPDATE dispatch_attempt SET resolution = 'SECRET invalid JSON'");
    await expect(repos.readSnapshotData()).rejects.toBeInstanceOf(StoredDataError);
  });
});

describe('C-01/C-08 service with SQLite', () => {
  const gui = () => {
    const history = new FakeHistory();
    const codex = new FakeRuntime('codex', history);
    const claude = new FakeRuntime('claude', history);
    const service = new DeliveryService({ store, runtimes: { codex, claude }, now: () => at(40), uuid, hashPayload: serviceHash });
    return { service, codex, claude };
  };

  it('copies metadata/counts from descriptors: getters are not read and a lying Proxy cannot evade the limit', async () => {
    const g = gui();
    const input = serviceInput();
    let reads = 0;
    const handoff = { ...input.handoff! };
    Object.defineProperty(handoff, 'ruleId', { enumerable: true, get: () => { reads++; return 'other'; } });
    expect(await g.service.accept({ ...input, handoff })).toMatchObject({ status: 'invalid' });
    expect(reads).toBe(0);
    // Unlike the core test's ['node-a'], this valid set includes the sender required by the Handoff schema.
    const expectedUpstream = new Proxy([input.handoff!.fromNodeId], {});
    expect(await g.service.accept({ ...input, handoff: { ...input.handoff!, expectedUpstream }, counts: [{ key: COUNT_KEY, limit: 1 }] })).toMatchObject({ status: 'accepted' });
    const lying = new Proxy([{ key: COUNT_KEY, limit: 1 }], { get: (target, key, receiver) => key === 'length' ? 0 : Reflect.get(target, key, receiver) as unknown });
    expect(await g.service.accept(serviceInput({ operationId: op('second'), sourceCallRef: 'call-second', counts: lying }))).toMatchObject({ status: 'limit-exceeded' });
    expect(await store.get(op('second'))).toBeUndefined();
  });

  it.each(['handoff', 'peer-message', 'transfer'] as const)('checks and snapshots the %s origin before dispatch', async (kind) => {
    const g = gui();
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    const input = kind === 'peer-message'
      ? serviceInput({ kind, peer, counts: undefined, context: { ...serviceInput().context, origin: { kind: 'peer', fromSessionId: peer.fromSessionId, peerMessageId: peer.peerMessageId } } })
      : serviceInput({ kind, counts: undefined });
    expect(await g.service.accept(input)).toMatchObject({ status: 'accepted' });
    expect(await g.service.dispatch(input.operationId, { origin: { kind: 'user' } })).toMatchObject({ status: 'not-dispatched', reason: 'origin-mismatch' });
    let reads = 0;
    expect(await g.service.dispatch(input.operationId, { get origin() { return { kind: ++reads === 1 ? 'system' as const : 'user' as const }; } })).toMatchObject({ status: 'sent' });
    expect(reads).toBe(1);
    expect(g.codex.dispatched[0]?.origin).toEqual({ kind: 'system' });
  });

  it('rejects absent/malformed peer and handoff origins; recovered legacy transfer uses system', async () => {
    const g = gui();
    const context = { ...serviceInput().context };
    delete context.origin;
    expect(await g.service.accept(serviceInput({ context }))).toMatchObject({ status: 'invalid' });
    expect(await g.service.accept(serviceInput({ context: { ...context, origin: { kind: 'user' } } }))).toMatchObject({ status: 'invalid' });
    const input = serviceInput({ kind: 'transfer', counts: undefined, context });
    expect(await g.service.accept(input)).toMatchObject({ status: 'accepted' });
    reopen();
    const next = gui();
    await next.service.recover();
    expect(next.codex.dispatched[0]?.origin).toEqual({ kind: 'system' });
  });

  it('user messages retain their user origin', async () => {
    const g = gui();
    const context = { ...serviceInput().context };
    delete context.origin;
    const input = serviceInput({ kind: 'user-message', counts: undefined, context });
    await g.service.accept(input);
    expect(await g.service.dispatch(input.operationId, { origin: { kind: 'system' } })).toMatchObject({ status: 'not-dispatched', reason: 'origin-mismatch' });
    expect(await g.service.dispatch(input.operationId)).toMatchObject({ status: 'sent' });
    expect(g.codex.dispatched[0]).not.toHaveProperty('origin');
  });

  it('recovery preserves peer origin/sender and source call; refuses origin override', async () => {
    const history = new FakeHistory();
    const codex = new FakeRuntime('codex', history);
    const claude = new FakeRuntime('claude', history);
    const service = () => new DeliveryService({ store, runtimes: { codex, claude }, now: () => at(40), uuid, hashPayload: serviceHash });
    const peer = { peerMessageId: PeerMessageId.parse('peer'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target') };
    const origin = { kind: 'peer' as const, fromSessionId: peer.fromSessionId, peerMessageId: peer.peerMessageId };
    const input = serviceInput({ kind: 'peer-message', peer, sender: peer.fromSessionId, counts: undefined, context: { ...serviceInput().context, origin } });
    expect((await service().accept(input)).status).toBe('accepted');
    reopen();
    expect(await service().dispatch(input.operationId, { origin: { kind: 'user' } })).toMatchObject({ status: 'not-dispatched', reason: 'origin-mismatch' });
    await service().recover();
    expect(codex.dispatched[0]?.origin).toEqual(origin);
    expect(await store.findBySourceCallRef(input.sourceCallRef!)).toMatchObject({ sender: peer.fromSessionId, delivery: { state: 'sent' } });
  });
});

describe('T022 r2 P2-3: projections of one instance', () => {
  it('filters peer messages by the instance in their own facts, not the handoff path', async () => {
    const instanceId = InstanceId.parse('instance-1');
    const peer = { peerMessageId: PeerMessageId.parse('peer-in'), fromSessionId: SessionId.parse('from'), toSessionId: SessionId.parse('session-target'), instanceId };
    await store.accept(payloadInput({ kind: 'peer-message', operationId: op('peer-in'), peer, counts: undefined }));
    const outside = { ...peer, peerMessageId: PeerMessageId.parse('peer-out'), instanceId: InstanceId.parse('instance-2') };
    await store.accept(payloadInput({ kind: 'peer-message', operationId: op('peer-out'), peer: outside, counts: undefined }));
    expect(store.loadProjections('peer-message', instanceId).map((r) => r.operationId)).toEqual(['peer-in']);
    expect(store.loadProjections('handoff', instanceId)).toEqual([]);
  });
});

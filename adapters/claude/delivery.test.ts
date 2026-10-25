// CR-2 delivery: dispatchOnce sends once and proves delivery only by the echoed uuid; reconcile reads
// the stored transcript and never resumes or starts a turn (CR2_DELIVERY_FIX §1, §2, §4).
import { describe, expect, it } from 'vitest';
import type { DispatchRequest } from '../../core/ports';
import { payloadRecords } from './history';
import { attempt, CWD, echo, expectValidEvents, init, loadStored, promptLine, REF, replyLine, result, SESSION, settle, started, transcript, u, until } from './testing/harness';

const request = (extra: Partial<DispatchRequest> = {}): DispatchRequest => ({
  nativeSessionRef: REF,
  attempt: attempt(),
  text: 'Handoff: implement subtract().',
  entry: { kind: 'new-turn' },
  timeoutMs: 1000,
  ...extra,
});

describe('dispatchOnce', () => {
  it('writes one SDKUserMessage with the clientMessageId as uuid and is sent only when a reply echoes it', async () => {
    const h = await started({ dispatchOrigin: () => ({ kind: 'peer', from: 'session-b', fromMode: 'bypass' }) });
    const q = h.sdk.last;
    const req = request();
    const uuid = req.attempt.clientMessageId;
    const pending = h.adapter.dispatchOnce(req);
    await until(() => q.inputs.length === 1, 'input written');
    expect(q.inputs[0]).toEqual({
      type: 'user',
      uuid,
      session_id: REF,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Handoff: implement subtract().' },
      origin: { kind: 'peer', from: 'session-b', fromMode: 'bypass' },
    });
    // init alone is not evidence (CR2 §1 step 5).
    q.emit(init());
    await settle();
    let settled = false;
    void pending.then(() => (settled = true));
    await settle();
    expect(settled).toBe(false);

    q.emit(echo(uuid));
    const sent = await pending;
    expect(sent).toMatchObject({ state: 'sent', nativeRef: { sessionRef: REF, turnRef: uuid, itemRef: uuid }, evidence: { kind: 'live-ack', at: '2026-10-25T12:00:00.000Z' } });
    expect(sent.state === 'sent' && sent.evidence.detail).toContain(uuid);
    // The turn the payload started is named after it, as the stored history names it.
    expect(h.of('turn.updated')[0]!.turn.id).toBe(uuid);
    expect(h.of('message.completed')[0]!.message).toMatchObject({ id: uuid, role: 'user', origin: { kind: 'user' }, text: 'Handoff: implement subtract().', turnId: uuid });
    q.emit(result());
    await until(() => h.of('turn.updated').length === 2, 'turn end');
    expectValidEvents(h.events);
  });

  it('accepts the echo on the result or among batched uuids', async () => {
    const h = await started();
    const q = h.sdk.last;
    const a = request();
    const b = request({ entry: { kind: 'insert' } });
    const first = h.adapter.dispatchOnce(a);
    await until(() => q.inputs.length === 1, 'first input');
    q.emit(init());
    await settle();
    const second = h.adapter.dispatchOnce(b);
    await until(() => q.inputs.length === 2, 'second input');
    // Both prompts consumed by one turn: the result lists both (user_message_uuids).
    q.emit(result({ user_message_uuid: b.attempt.clientMessageId, user_message_uuids: [a.attempt.clientMessageId, b.attempt.clientMessageId] }));
    expect(await first).toMatchObject({ state: 'sent', nativeRef: { turnRef: a.attempt.clientMessageId } });
    expect(await second).toMatchObject({ state: 'sent', nativeRef: { turnRef: a.attempt.clientMessageId, itemRef: b.attempt.clientMessageId } });
  });

  it('acknowledges a payload inserted into a busy turn on the status frame that lists it (live, T009)', async () => {
    const h = await started();
    const q = h.sdk.last;
    const first = request();
    const sending = h.adapter.dispatchOnce(first);
    await until(() => q.inputs.length === 1, 'first input');
    q.emit({ ...init(), user_message_uuids: [first.attempt.clientMessageId] });
    await sending;
    const insert = request({ entry: { kind: 'insert', expectedTurnRef: first.attempt.clientMessageId } });
    const inserted = h.adapter.dispatchOnce(insert);
    await until(() => q.inputs.length === 2, 'insert written');
    // The fold shows on a system/status frame; the assistant frames keep the typed prompt's uuid.
    q.emit({ type: 'system', subtype: 'status', status: 'requesting', session_id: REF, uuid: 's2', user_message_uuids: [first.attempt.clientMessageId, insert.attempt.clientMessageId] });
    const sent = await inserted;
    expect(sent).toMatchObject({ state: 'sent', nativeRef: { turnRef: first.attempt.clientMessageId, itemRef: insert.attempt.clientMessageId } });
    expect(sent.state === 'sent' && sent.evidence.detail).toMatch(/^system\/status frame/);
  });

  it('reports timeout as unknown and never writes again (CR-2)', async () => {
    const h = await started();
    const req = request({ timeoutMs: 20 });
    expect(await h.adapter.dispatchOnce(req)).toMatchObject({ state: 'unknown', reason: 'timeout', written: true });
    expect(await h.adapter.dispatchOnce(req)).toMatchObject({ state: 'unknown', reason: 'already-dispatched', written: false });
    expect(await h.adapter.dispatchOnce({ ...request(), attempt: { ...attempt(), clientMessageId: req.attempt.clientMessageId } })).toMatchObject({ reason: 'already-dispatched' });
    expect(h.sdk.last.inputs).toHaveLength(1);
  });

  it('reports a process that ends before the echo as disconnected', async () => {
    const h = await started();
    const q = h.sdk.last;
    const pending = h.adapter.dispatchOnce(request());
    await until(() => q.inputs.length === 1, 'input');
    q.end(new Error('claude.exe exited'));
    expect(await pending).toMatchObject({ state: 'unknown', reason: 'disconnected', written: true });
  });

  it('refuses without writing when the session is not open or the entry does not fit', async () => {
    const h = await started();
    const q = h.sdk.last;
    expect(await h.adapter.dispatchOnce(request({ nativeSessionRef: '11111111-1111-4111-8111-111111111111' }))).toMatchObject({ reason: 'not-running', written: false });
    expect(await h.adapter.dispatchOnce(request({ entry: { kind: 'insert' } }))).toMatchObject({ reason: 'rejected', written: false, detail: 'no running turn to insert into' });
    q.emit(init());
    await until(() => h.of('turn.updated').length === 1, 'turn');
    expect(await h.adapter.dispatchOnce(request())).toMatchObject({ reason: 'rejected', written: false });
    expect(await h.adapter.dispatchOnce(request({ entry: { kind: 'insert', expectedTurnRef: 'another-turn' } }))).toMatchObject({ reason: 'rejected', written: false });
    expect(await h.adapter.dispatchOnce(request({ entry: { kind: 'new-turn', model: { runtime: 'codex', model: 'gpt-6-luna' } } }))).toMatchObject({ reason: 'rejected' });
    expect(q.inputs).toEqual([]);
    await h.adapter.close();
    expect(await h.adapter.dispatchOnce(request())).toMatchObject({ reason: 'not-running', written: false });
  });

  it('throws for an attempt that is not the live unknown attempt', async () => {
    const h = await started();
    const a = attempt();
    await expect(h.adapter.dispatchOnce(request({ attempt: { ...a, resolution: { decision: 'retry', decidedBy: 'user', at: a.dispatchStartedAt } } }))).rejects.toThrow(/live attempt/);
  });

  it('switches the model before a new turn, and does not write when that fails', async () => {
    const h = await started();
    const q = h.sdk.last;
    const ok = h.adapter.dispatchOnce(request({ entry: { kind: 'new-turn', model: { runtime: 'claude', model: 'sonnet', effort: 'high' } } }));
    await until(() => q.inputs.length === 1, 'input');
    expect(q.calls.indexOf('setModel:sonnet')).toBeGreaterThanOrEqual(0);
    expect(q.flagSettings).toEqual([{ effortLevel: 'high' }]);
    q.emit(echo(q.inputs[0]!.uuid), result());
    expect(await ok).toMatchObject({ state: 'sent' });
    await until(() => h.of('turn.updated').length === 2, 'turn end');
    expect(h.of('turn.updated')[0]!.turn.requestedModel).toEqual({ runtime: 'claude', model: 'sonnet', effort: 'high' });

    const h2 = await started();
    h2.sdk.behaviour.setModelError = new Error('Model nope not found');
    expect(await h2.adapter.dispatchOnce(request({ entry: { kind: 'new-turn', model: { runtime: 'claude', model: 'nope' } } }))).toMatchObject({ reason: 'rejected', written: false });
    expect(h2.sdk.last.inputs).toEqual([]);
  });
});

describe('reconcile (CR2_DELIVERY_FIX §4)', () => {
  const uuid = '6c8a00ac-6181-4e5f-8c01-0d915ed9844f';
  const text = `Receipt fixture ${uuid}. Reply only ACK. Do not call tools.`;
  const req = { nativeSessionRef: REF, cwd: CWD, clientMessageId: uuid as never, text };
  const ack = (n: number) => replyLine(u(n), { type: 'text', text: 'ACK' });
  const lines = (...l: Parameters<typeof transcript>[2]) => transcript(REF, CWD, l);

  it('finds the stored prompt by session, uuid and text, read-only', async () => {
    const h = await started();
    h.sdk.store(CWD, REF, lines(promptLine(u(1), 'earlier'), ack(2), promptLine(uuid, text), ack(3)));
    const queries = h.sdk.queries.length;
    const out = await h.adapter.reconcile(req);
    expect(out).toMatchObject({ state: 'sent', nativeRef: { sessionRef: REF, turnRef: uuid, itemRef: uuid }, evidence: { kind: 'reconciled', at: '2026-10-25T12:00:00.000Z' } });
    expect(out.state === 'sent' && out.evidence.detail).toContain(uuid);
    // No query was started and nothing was written to the open session.
    expect(h.sdk.queries.length).toBe(queries);
    expect(h.sdk.last.inputs).toEqual([]);
  });

  it('also works with no adapter session open, and with the text as one text block', async () => {
    const h = await started();
    await h.adapter.close();
    h.sdk.store(CWD, REF, lines(promptLine(uuid, [{ type: 'text', text }]), ack(1)));
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'sent' });
  });

  it('finds a payload folded into a running turn, stored as a queued-command attachment (live, T009)', async () => {
    const h = await started();
    const queued = { type: 'attachment', uuid: u(9), attachment: { type: 'queued_command', prompt: text, source_uuid: uuid, commandMode: 'prompt' } };
    h.sdk.store(CWD, REF, lines(promptLine(u(1), 'Run the tests.'), replyLine(u(2), { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }, { stop: 'tool_use' }), queued, ack(3)));
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'sent', nativeRef: { turnRef: u(1), itemRef: uuid } });
  });

  it('names the turn readHistory shows for a queued payload, also after the previous turn ended (review r2 P1-2)', async () => {
    const h = await started();
    const queued = { type: 'attachment', uuid: u(9), attachment: { type: 'queued_command', prompt: text, source_uuid: uuid, commandMode: 'prompt' } };
    const raw = lines(
      promptLine(u(1), 'Say hi.'),
      replyLine(u(2), { type: 'text', text: 'hi' }),
      queued,
      replyLine(u(3), { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }, { stop: 'tool_use' }),
    );
    h.sdk.store(CWD, REF, raw);
    const history = await h.adapter.readHistory({ sessionId: SESSION, nativeSessionRef: REF, cwd: CWD });
    const turns = history.entries.flatMap((e) => (e.kind === 'turn' ? [[e.turn.id, e.turn.state]] : []));
    // A ended before Q came in, so Q starts its own turn, still running.
    expect(turns).toEqual([
      [u(1), 'completed'],
      [uuid, 'running'],
    ]);
    const shown = history.entries.find((e) => e.kind === 'message' && e.message.id === uuid);
    expect(shown?.kind === 'message' && shown.message.turnId).toBe(uuid);
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'sent', nativeRef: { turnRef: uuid } });
    // The raw-line rules (used when the chain view lacks the payload) agree.
    expect(payloadRecords(raw, uuid).map((r) => r.turnRef)).toEqual([uuid]);
  });

  it('stays unknown when the raw read missed lines, even with one matching record (review r2 P1-1)', async () => {
    const h = await started();
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text), ack(1)));
    h.sdk.incompleteRead = 'read 600 of 700 transcript bytes; some lines did not parse';
    const out = await h.adapter.reconcile(req);
    expect(out).toMatchObject({ state: 'unknown', reason: 'read-failed', matches: [{ contentMatches: true }] });
    expect(out.state === 'unknown' && out.detail).toContain('600 of 700');
  });

  it('sees a duplicate the SDK chain view hides (review r1 P1-1)', async () => {
    const h = await started();
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text), ack(1), promptLine(uuid, text, { parentUuid: u(1) }), ack(2)));
    // getSessionMessages keeps one entry per uuid, so it alone cannot show the duplicate.
    const chain = await h.sdk.getSessionMessages(REF, { dir: CWD });
    expect(chain.filter((m) => m.uuid === uuid)).toHaveLength(1);
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'unknown', reason: 'duplicate', matches: [{ contentMatches: true }, { contentMatches: true }] });
    // A prompt line and a queued-command record of the same uuid are two records too.
    const queued = { type: 'attachment', uuid: u(9), attachment: { type: 'queued_command', prompt: text, source_uuid: uuid } };
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text), queued, ack(1)));
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'duplicate' });
  });

  it('stays unknown when not found, different or unreadable', async () => {
    const h = await started();
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'unknown', reason: 'not-found', matches: [] });
    h.sdk.store(CWD, REF, lines(promptLine(uuid, `${text} (edited)`)));
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch', matches: [{ contentMatches: false }] });
    h.sdk.store(CWD, REF, lines(promptLine(uuid, [{ type: 'text', text }, { type: 'text', text: 'extra' }])));
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch' });
    // A record of another session (copied transcript) does not count for this one.
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text, { sessionId: '22222222-2222-4222-8222-222222222222' })));
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch' });
    // Any line with this uuid is a record of it; one that is not the prompt does not match.
    h.sdk.store(CWD, REF, lines(promptLine(u(1), 'x'), { ...promptLine(uuid, [{ type: 'tool_result', tool_use_id: 't', content: text }]) }));
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch' });
    h.sdk.readError = new Error('EACCES');
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'unknown', reason: 'read-failed', detail: 'EACCES' });
  });

  it('reads past a compaction, whose summary hides earlier prompts from the chain view (review r1 P1-2)', async () => {
    const h = await started();
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: u(5), parentUuid: null, logicalParentUuid: u(4), content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 150000 } };
    const summary = promptLine(u(6), 'This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text), ack(4), boundary, summary, promptLine(u(7), 'next'), ack(8)));
    expect((await h.sdk.getSessionMessages(REF, { dir: CWD })).some((m) => m.uuid === uuid)).toBe(false);
    // The raw lines still hold the one record: positive evidence, and a duplicate would still show.
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'sent' });
    // Not found after a compaction says so; it stays unknown.
    const other = await h.adapter.reconcile({ ...req, clientMessageId: u(99) as never });
    expect(other).toMatchObject({ state: 'unknown', reason: 'not-found' });
    expect(other.state === 'unknown' && other.detail).toContain('compacted');
  });

  it('finds the session from another worktree of the same repository, as the SDK does (SP-07)', async () => {
    const h = await started();
    h.sdk.store(CWD, REF, lines(promptLine(uuid, text), ack(1)), { alsoFoundFrom: ['E:\\work\\task-1-copy'] });
    expect(await h.adapter.reconcile({ ...req, cwd: 'E:\\work\\task-1-copy' })).toMatchObject({ state: 'sent' });
    expect(await h.adapter.reconcile({ ...req, cwd: 'E:\\elsewhere' })).toMatchObject({ reason: 'not-found' });
  });

  it('reconciles a prompt recorded by a real session (SP-03 transcript)', async () => {
    const h = await started();
    const fx = loadStored('sp03-transcript.json');
    h.sdk.store(fx.cwd, fx.sessionId, fx.entries);
    const prompt = fx.entries.find((e) => e.type === 'user')!;
    const content = (prompt.message as { content: string }).content;
    const out = await h.adapter.reconcile({ nativeSessionRef: fx.sessionId, cwd: fx.cwd, clientMessageId: prompt.uuid as never, text: content });
    expect(out).toMatchObject({ state: 'sent', nativeRef: { sessionRef: fx.sessionId, itemRef: prompt.uuid } });
  });
});

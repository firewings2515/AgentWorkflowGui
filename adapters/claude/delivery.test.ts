// CR-2 delivery: dispatchOnce sends once and proves delivery only by the echoed uuid; reconcile reads
// the stored transcript and never resumes or starts a turn (CR2_DELIVERY_FIX §1, §2, §4).
import { describe, expect, it } from 'vitest';
import type { DispatchRequest } from '../../core/ports';
import { attempt, CWD, echo, expectValidEvents, init, loadStored, REF, result, settle, started, until } from './testing/harness';
import type { WireSessionMessage } from './wire';

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
  const stored = (uuid: string, content: unknown, sessionId = REF): WireSessionMessage => ({
    type: 'user',
    uuid,
    session_id: sessionId,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    timestamp: '2026-10-25T11:59:00.000Z',
  });
  const reply = (uuid: string): WireSessionMessage => ({ type: 'assistant', uuid, session_id: REF, message: { id: 'msg_1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ACK' }] }, parent_tool_use_id: null });
  const uuid = '6c8a00ac-6181-4e5f-8c01-0d915ed9844f';
  const text = `Receipt fixture ${uuid}. Reply only ACK. Do not call tools.`;
  const req = { nativeSessionRef: REF, cwd: CWD, clientMessageId: uuid as never, text };

  it('finds the stored prompt by session, uuid and text, read-only', async () => {
    const h = await started();
    h.sdk.store(CWD, REF, [stored('11111111-0000-4000-8000-000000000000', 'earlier'), reply('r1'), stored(uuid, text), reply('r2')]);
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
    h.sdk.store(CWD, REF, [stored(uuid, [{ type: 'text', text }])]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'sent' });
  });

  it('stays unknown when not found, in another cwd, duplicated, different or unreadable', async () => {
    const h = await started();
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'unknown', reason: 'not-found', matches: [] });
    // Stored under the cwd it ran in: another cwd finds nothing (R-06).
    h.sdk.store('E:\\work\\other', REF, [stored(uuid, text)]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'not-found' });
    h.sdk.store(CWD, REF, [stored(uuid, text), reply('r'), stored(uuid, text)]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'duplicate', matches: [{ contentMatches: true }, { contentMatches: true }] });
    h.sdk.store(CWD, REF, [stored(uuid, `${text} (edited)`)]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch', matches: [{ contentMatches: false }] });
    h.sdk.store(CWD, REF, [stored(uuid, [{ type: 'text', text }, { type: 'text', text: 'extra' }])]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'content-mismatch' });
    h.sdk.store(CWD, REF, [{ ...stored(uuid, [{ type: 'tool_result', tool_use_id: 't', content: text }]) }]);
    expect(await h.adapter.reconcile(req)).toMatchObject({ reason: 'not-found' });
    h.sdk.readError = new Error('EACCES');
    expect(await h.adapter.reconcile(req)).toMatchObject({ state: 'unknown', reason: 'read-failed', detail: 'EACCES' });
  });

  it('reconciles a prompt recorded by a real session (SP-03 transcript)', async () => {
    const h = await started();
    const fx = loadStored('sp03-history.json');
    h.sdk.store(fx.cwd, fx.sessionId, fx.messages);
    const prompt = fx.messages.find((m) => m.type === 'user')!;
    const content = (prompt.message as { content: string }).content;
    const out = await h.adapter.reconcile({ nativeSessionRef: fx.sessionId, cwd: fx.cwd, clientMessageId: prompt.uuid as never, text: content });
    expect(out).toMatchObject({ state: 'sent', nativeRef: { sessionRef: fx.sessionId, itemRef: prompt.uuid } });
  });
});

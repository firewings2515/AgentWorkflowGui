// Contracts 0.5 (T020, C-04): the GUI's own tools are recognised by the request's `tool` and `server`
// fields, never by its summary, so a summary written to look like a GUI tool gets the policy.
import { describe, expect, it } from 'vitest';
import { Escalation, MessageId, OperationId, PermissionRequest } from '../../contracts';
import { isGuiToolRequest } from './permissions';
import { created, rid, settle, world } from './testing/harness';

const base = { id: 'perm-1', sessionId: 'session-1', state: 'pending', createdAt: '2026-10-29T00:00:00Z' } as const;
const claude = (fields: Record<string, unknown>) => PermissionRequest.parse({ ...base, kind: 'permissions', ...fields });
const codex = (serverName: string) =>
  PermissionRequest.parse({ ...base, kind: 'mcpElicitation', summary: 'asks', server: serverName, elicitation: { mode: 'form', serverName, message: 'm', requestedSchema: {} } });

describe('C-04: GUI tools by field, not by summary', () => {
  it('lets ToolSearch and the GUI tools of server gui through', () => {
    expect(isGuiToolRequest(claude({ tool: 'ToolSearch', summary: 'ToolSearch select:mcp__gui__send_message' }))).toBe(true);
    expect(isGuiToolRequest(claude({ tool: 'mcp__gui__report_to_root', server: 'gui', summary: 'mcp__gui__report_to_root' }))).toBe(true);
    expect(isGuiToolRequest(codex('gui'))).toBe(true);
  });

  it.each([
    ['a summary alone', { summary: 'mcp__gui__send_message' }],
    ['ToolSearch in the summary only', { summary: 'ToolSearch' }],
    ['a GUI tool name from another server', { tool: 'mcp__gui__send_message', server: 'other', summary: 'mcp__gui__send_message' }],
    ['an unknown tool of server gui', { tool: 'mcp__gui__shell', server: 'gui', summary: 'mcp__gui__shell' }],
    ['a look-alike tool name', { tool: 'mcp__gui__send_message; rm -rf .', server: 'gui', summary: 'x' }],
  ])('sends %s to the policy', (_, fields) => {
    expect(isGuiToolRequest(claude(fields))).toBe(false);
  });

  it('sends another server’s elicitation to the policy', () => {
    expect(isGuiToolRequest(codex('gui-helper'))).toBe(false);
  });
});

describe('T020 r2 P2: a waiting confirmation after a restart belongs to nobody known', () => {
  it('answers not-owner to every caller after a restart', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: c } = await created(w, 'claude', 'session-claude');
    const { sessionId: b } = await created(w, 'codex', 'session-b');
    const call = (svc: typeof w.service, caller: typeof a, content: string, ref: string) =>
      svc.sendMessage({ to: c, content }, { caller, operationId: OperationId.parse('op-wait'), sourceCallRef: ref });
    expect(await call(w.service, a, 'original', 'call-1')).toMatchObject({ status: 'awaiting-confirmation' });
    const after = w.restart();
    await after.service.start();
    expect(await call(after.service, a, 'original', 'call-2')).toMatchObject({ status: 'rejected', rejection: { reason: 'not-owner' } });
    expect(await call(after.service, b, 'original', 'call-3')).toMatchObject({ status: 'rejected', rejection: { reason: 'not-owner' } });
  });
});

describe('T020 r3 P2: the user’s retry of an unknown user message', () => {
  it('dispatches the message again as the user’s', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const codex = w.codex.get(sessionId)!;
    codex.dispatchModes.push('lost');
    const revision = w.repositories.sessionRecords.get(sessionId)!.revision;
    const sent = await w.run({ type: 'session.send', requestId: rid(), sessionId, messageId: MessageId.parse('m-r'), expectedRevision: revision, text: 'maybe', attachments: [] });
    expect(sent).toMatchObject({ ok: false, code: 'unknown_outcome' });
    await settle();
    const operationId = OperationId.parse('user-message:m-r');
    expect((await w.store.get(operationId))?.delivery.state).toBe('unknown');
    // The escalation C-02 makes possible (the service does not open it yet: T017's contracts gap 2).
    const attemptId = (await w.store.get(operationId))!.delivery.attempts.at(-1)!.attemptId;
    const escalation = Escalation.parse({
      id: `delivery:${operationId}/${attemptId}`, rootSessionId: sessionId, fromSessionId: sessionId, kind: 'delivery-unknown', title: 'Message outcome unknown', detail: 'fixed',
      ref: { kind: 'message', operationId, messageId: 'm-r' }, state: 'open', createdAt: '2026-10-29T01:00:00.000Z',
    });
    await w.repositories.escalations.upsert(escalation);
    const resolved = await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true });
    if (!resolved.ok) throw new Error(`${resolved.code}: ${resolved.message}`);
    expect(codex.dispatched).toHaveLength(2);
    expect(codex.dispatched[1]?.origin ?? { kind: 'user' }).toEqual({ kind: 'user' });
    expect((await w.store.get(operationId))?.delivery.state).toBe('sent');
  });
});

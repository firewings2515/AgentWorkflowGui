// T017 (T012 review r2 P2-1): the MCP token never reaches the delivery store, and the payload's origin
// reaches the adapter. The mount is added only at start / resume by the session service (C-07).
import { describe, expect, it } from 'vitest';
import type { MessageOrigin, PeerMessageId, SessionId } from '../../contracts';
import type { McpMount, ProvisionSpec, SessionSettings, StartSessionOptions } from '../ports';
import { OP, gui, payloadInput, provisionInput } from './testing/fixtures';

const TOKEN = 'secret-token-0123456789abcdef';
const mount: McpMount = { url: 'http://127.0.0.1:4000/mcp', token: TOKEN };

describe('the MCP token is never stored', () => {
  it('refuses a provision whose spec carries the mount after passing through SessionSettings', async () => {
    const g = gui();
    const base = provisionInput();
    const start: StartSessionOptions = { ...base.spec, mcp: mount };
    // Typed as SessionSettings, `mcp` is invisible to the compiler but still on the object.
    const settings: SessionSettings = start;
    const spec: ProvisionSpec = {
      ...settings,
      runtime: base.spec.runtime,
      sessionId: base.spec.sessionId,
      cwd: base.spec.cwd,
    };
    const outcome = await g.service.accept({ ...base, spec });
    expect(outcome.status).toBe('invalid');
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(await g.store.get(base.operationId)).toBeUndefined();
  });

  it('refuses a payload whose context.session carries the mount', async () => {
    const g = gui();
    const base = payloadInput();
    const start: StartSessionOptions = {
      sessionId: 'session-target' as SessionId,
      cwd: 'E:/work',
      ...base.context.session,
      mcp: mount,
    };
    const session: SessionSettings = start;
    const outcome = await g.service.accept({
      ...base,
      context: { ...base.context, session },
    });
    expect(outcome.status).toBe('invalid');
    expect(await g.store.get(OP)).toBeUndefined();
  });

  it('writes only the fields the port allows, whatever else rides along', async () => {
    const g = gui();
    const base = provisionInput();
    const spec = {
      ...base.spec,
      token: TOKEN,
      headers: { Authorization: `Bearer ${TOKEN}` },
    } as ProvisionSpec;
    expect((await g.service.accept({ ...base, spec })).status).toBe('accepted');
    const stored = await g.store.get(base.operationId);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(stored?.kind === 'provision' && Object.keys(stored.spec).sort()).toEqual(['cwd', 'model', 'preallocatedRef', 'readOnly', 'runtime', 'sessionId']);

    const payload = payloadInput();
    const session = {
      ...payload.context.session,
      instructions: 'be brief',
      url: mount.url,
      token: TOKEN,
    } as SessionSettings;
    expect(
      (
        await g.service.accept({
          ...payload,
          context: { ...payload.context, session },
        })
      ).status,
    ).toBe('accepted');
    const storedPayload = await g.store.get(OP);
    expect(JSON.stringify(storedPayload)).not.toContain(TOKEN);
    expect(storedPayload?.kind !== 'provision' && storedPayload?.context.session).toEqual({ ...payload.context.session, instructions: 'be brief' });
  });

  it('a resend of the same accepted input is still a duplicate after the fields are picked', async () => {
    const g = gui();
    const input = payloadInput();
    expect((await g.service.accept(input)).status).toBe('accepted');
    expect((await g.service.accept(input)).status).toBe('duplicate');
  });
});

describe('origin', () => {
  it('hands the caller’s origin to the adapter, and none when the caller gives none', async () => {
    const g = gui();
    const peer: MessageOrigin = {
      kind: 'peer',
      fromSessionId: 'session-from' as SessionId,
      peerMessageId: 'peer-1' as PeerMessageId,
    };
    expect((await g.service.accept(payloadInput())).status).toBe('accepted');
    expect((await g.service.dispatch(OP, { origin: peer })).status).toBe('sent');
    expect(g.codex.dispatched[0]?.origin).toEqual(peer);

    const other = payloadInput({
      operationId: OP.replace('1', '2') as typeof OP,
      payload: 'second',
      count: undefined,
    });
    expect((await g.service.accept(other)).status).toBe('accepted');
    expect((await g.service.dispatch(other.operationId)).status).toBe('sent');
    expect(g.codex.dispatched[1]).not.toHaveProperty('origin');
  });
});

// T017 (T012 review r2 P2-1): the MCP token never reaches the delivery store, and the payload's origin
// reaches the adapter. The mount is added only at start / resume by the session service (C-07).
import { describe, expect, it } from 'vitest';
import type { MessageOrigin, PeerMessageId, SessionId } from '../../contracts';
import type { McpMount, ProvisionSpec, SessionSettings, StartSessionOptions } from '../ports';
import { OP, contextWithoutOrigin, gui, payloadInput, provisionInput } from './testing/fixtures';

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
  it('hands the caller’s origin to the adapter; a user message without one reaches it as the user’s', async () => {
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
      kind: 'user-message',
      operationId: OP.replace('1', '2') as typeof OP,
      payload: 'second',
      counts: undefined,
      context: contextWithoutOrigin(),
    });
    expect((await g.service.accept(other)).status).toBe('accepted');
    expect((await g.service.dispatch(other.operationId)).status).toBe('sent');
    expect(g.codex.dispatched[1]).not.toHaveProperty('origin');
  });
});

describe('r1-P1-1 every level is rebuilt from plain data', () => {
  const stored = async (g: ReturnType<typeof gui>, id = provisionInput().operationId) => JSON.stringify(await g.store.get(id));

  it('r1-P1-1 an MCP mount nested in spec.model is not stored', async () => {
    const g = gui();
    const base = provisionInput();
    const spec = { ...base.spec, model: { ...base.spec.model, mcp: { token: TOKEN } } } as unknown as ProvisionSpec;
    expect((await g.service.accept({ ...base, spec })).status).toBe('accepted');
    expect(await stored(g)).not.toContain(TOKEN);
    expect(await stored(g)).not.toContain('"mcp"');
  });

  it('r1-P1-1 a getter (on the model, or returning a model that carries the mount) is refused, not read', async () => {
    const g = gui();
    const base = provisionInput();
    const spec = { ...base.spec } as Record<string, unknown>;
    Object.defineProperty(spec, 'model', { enumerable: true, get: () => ({ ...base.spec.model, mcp: mount }) });
    expect(await g.service.accept({ ...base, spec: spec as unknown as ProvisionSpec })).toMatchObject({ status: 'invalid' });
    const model = { ...base.spec.model } as Record<string, unknown>;
    Object.defineProperty(model, 'effort', { enumerable: true, get: () => TOKEN });
    expect(await g.service.accept({ ...base, spec: { ...base.spec, model: model as unknown as ProvisionSpec['model'] } })).toMatchObject({ status: 'invalid' });
    expect(await g.store.get(base.operationId)).toBeUndefined();
  });

  it('r1-P1-1 a model that is an array or a class instance is refused', async () => {
    const g = gui();
    const base = provisionInput();
    const asArray = Object.assign([TOKEN], { runtime: 'claude', model: 'x' });
    expect(await g.service.accept({ ...base, spec: { ...base.spec, model: asArray as unknown as ProvisionSpec['model'] } })).toMatchObject({ status: 'invalid' });
    class Model {
      runtime = 'claude';
      model = 'x';
      token = TOKEN;
    }
    expect(await g.service.accept({ ...base, spec: { ...base.spec, model: new Model() as unknown as ProvisionSpec['model'] } })).toMatchObject({ status: 'invalid' });
    const payload = payloadInput();
    const session = { ...payload.context.session, model: [payload.context.session.model] } as unknown as SessionSettings;
    expect(await g.service.accept({ ...payload, context: { ...payload.context, session } })).toMatchObject({ status: 'invalid' });
    expect(await g.store.get(base.operationId)).toBeUndefined();
    expect(await g.store.get(OP)).toBeUndefined();
  });

  it('r1-P1-1 an entry model is rebuilt too, and a payload keeps working', async () => {
    const g = gui();
    const payload = payloadInput();
    const entry = { kind: 'new-turn', model: { runtime: 'codex', model: 'gpt-6-luna', mcp: mount } } as unknown as typeof payload.context.entry;
    expect((await g.service.accept({ ...payload, context: { ...payload.context, entry } })).status).toBe('accepted');
    expect(await stored(g, OP)).not.toContain(TOKEN);
  });
});

describe('r2-P1-1 every field is read once, through its descriptor', () => {
  it('r2-P1-1 a Proxy that answers another value to a second read cannot slip the token in', async () => {
    const g = gui();
    const base = provisionInput();
    const extra = { ...base.spec.model, mcp: { token: TOKEN } };
    const model = new Proxy({ ...base.spec.model }, { get: (target, key) => (key === 'model' ? extra.mcp.token : (Reflect.get(target, key) as unknown)) });
    const outcome = await g.service.accept({ ...base, spec: { ...base.spec, model } });
    expect(outcome.status).toBe('accepted');
    const stored = JSON.stringify(await g.store.get(base.operationId));
    expect(stored).not.toContain(TOKEN);
  });

  it('r2-P1-1 a getter on the target (nativeSessionRef) is refused and never runs', async () => {
    const g = gui();
    const base = payloadInput();
    let reads = 0;
    const target = { sessionId: base.target.sessionId } as Record<string, unknown>;
    Object.defineProperty(target, 'nativeSessionRef', {
      enumerable: true,
      get: () => {
        reads++;
        return TOKEN;
      },
    });
    expect(await g.service.accept({ ...base, target: target })).toMatchObject({ status: 'invalid' });
    expect(reads).toBe(0);
    expect(await g.store.get(OP)).toBeUndefined();
  });

  it('r2-P1-1 a target with keys the contract does not have is refused', async () => {
    const g = gui();
    const base = payloadInput();
    expect(await g.service.accept({ ...base, target: { ...base.target, token: TOKEN } as typeof base.target })).toMatchObject({ status: 'invalid' });
  });
});

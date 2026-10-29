// T017 on the Claude adapter: the GUI MCP server is mounted from the port's `mcp` option, merged with the
// configured servers, and a payload's origin decides `SDKUserMessage.origin` and the user message it
// becomes (R-03: a peer message is never the user's approval).
import { describe, expect, it } from 'vitest';
import { type MessageOrigin, PeerMessageId, SessionId } from '../../contracts';
import type { DispatchRequest } from '../../core/ports';
import { attempt, CWD, echo, promptLine, REF, result, SESSION, started, transcript, u, until } from './testing/harness';

const TOKEN = 'tok-0123456789abcdef0123456789abcdef';
const MOUNT = { url: 'http://127.0.0.1:50123/mcp', token: TOKEN };
const PEER: MessageOrigin = {
  kind: 'peer',
  fromSessionId: SessionId.parse('session-b'),
  peerMessageId: PeerMessageId.parse('peer-1'),
};

describe('the GUI MCP server from the port’s mcp option', () => {
  it('mounts `gui` with this start’s token and keeps the other configured servers', async () => {
    const h = await started(
      {
        mcpServers: () => ({
          gui: { type: 'http', url: 'http://old/mcp' },
          docs: { command: 'docs-server' },
        }),
      },
      { mcp: MOUNT },
    );
    expect(h.sdk.last.options.mcpServers).toEqual({
      gui: {
        type: 'http',
        url: MOUNT.url,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
      docs: { command: 'docs-server' },
    });
    expect(JSON.stringify([h.events, h.logs])).not.toContain(TOKEN);
  });

  it('mounts it on resume too, with the new token', async () => {
    const h = await started({}, { mcp: MOUNT });
    await h.adapter.closeSession(REF);
    h.sdk.store(CWD, REF, transcript(REF, CWD, [promptLine(u(1), 'hi')]));
    await h.adapter.resumeSession({
      sessionId: SESSION,
      nativeSessionRef: REF,
      cwd: CWD,
      model: { runtime: 'claude', model: 'haiku' },
      readOnly: false,
      mcp: { ...MOUNT, token: 'second' },
    });
    expect(h.sdk.last.options.mcpServers).toEqual({
      gui: {
        type: 'http',
        url: MOUNT.url,
        headers: { Authorization: 'Bearer second' },
      },
    });
  });

  it('mounts nothing without the option or a configured server', async () => {
    const h = await started();
    expect(h.sdk.last.options.mcpServers).toBeUndefined();
  });
});

describe('origin (R-03)', () => {
  const request = (origin: MessageOrigin | undefined): DispatchRequest => ({
    nativeSessionRef: REF,
    attempt: attempt(),
    text: 'hello',
    entry: { kind: 'new-turn' },
    timeoutMs: 1000,
    ...(origin && { origin }),
  });

  const send = async (origin: MessageOrigin | undefined) => {
    const h = await started();
    const q = h.sdk.last;
    const req = request(origin);
    const pending = h.adapter.dispatchOnce(req);
    await until(() => q.inputs.length === 1, 'input written');
    q.emit(echo(req.attempt.clientMessageId));
    expect(await pending).toMatchObject({ state: 'sent' });
    q.emit(result());
    return {
      h,
      input: q.inputs[0],
      message: h.of('message.completed').find((e) => e.message.role === 'user')?.message,
    };
  };

  it('marks a peer payload as peer, never human, and keeps the peer origin on its user message', async () => {
    const { input, message } = await send(PEER);
    expect(input?.origin).toEqual({ kind: 'peer', from: 'session-b' });
    expect(message).toMatchObject({ origin: PEER, text: 'hello' });
  });

  it('marks the user’s own input as human', async () => {
    const { input, message } = await send({ kind: 'user' });
    expect(input?.origin).toEqual({ kind: 'human' });
    expect(message?.origin).toEqual({ kind: 'user' });
  });

  it('leaves a system payload, or one without an origin, unattributed (not human)', async () => {
    expect((await send({ kind: 'system' })).input).not.toHaveProperty('origin');
    expect((await send(undefined)).input).not.toHaveProperty('origin');
  });
});

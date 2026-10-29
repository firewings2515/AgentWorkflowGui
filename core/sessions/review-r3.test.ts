// T017 review round 3: every reproduction from T017-r3-result.md as a regression test (memory ports, fake
// adapters). The real-ClaudeAdapter case of r3-P1-2 is in app/main/backend.test.ts.
import { describe, expect, it } from 'vitest';
import { type AppEvent, ItemId, MessageId, NativeTaskId, OperationId, type SessionId, TurnId } from '../../contracts';
import { Redactor } from './redact';
import { permissionRequest } from './testing/fake-adapter';
import { CWD, created, settle, world, type World } from './testing/harness';

const at = '2026-10-29T01:00:00.000Z';
const later = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};
const deltaText = (w: World, pick: (e: AppEvent) => string | undefined) => w.events.map(pick).filter((d): d is string => d !== undefined).join('');
const messageDeltas = (messageId: string) => (e: AppEvent) => (e.type === 'message.delta' && e.messageId === messageId ? e.delta : undefined);
/** Pauses the first call of `get` on the world's session repository until `gate` resolves. */
const pauseFirstSessionRead = (w: World, gate: Promise<void>) => {
  const get = w.repositories.sessions.get;
  let paused = false;
  w.repositories.sessions.get = async (id) => {
    if (!paused) {
      paused = true;
      await gate;
    }
    return get(id);
  };
};

describe('r3-P1-1 held delta text comes out only at its own end', () => {
  it('r3-P1-1 a sub-agent turn ending in the middle of a main-turn message does not let the split token out', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    const mainTurn = TurnId.parse('turn-main');
    const messageId = MessageId.parse('a-1');
    codex.emit({ type: 'message.delta', sessionId, turnId: mainTurn, messageId, delta: `x ${token.slice(0, 8)}` });
    codex.emit({
      type: 'turn.updated',
      turn: { id: TurnId.parse('turn-sub'), sessionId, nativeTaskId: NativeTaskId.parse('task-1'), state: 'completed', startedAt: at, endedAt: at },
    });
    codex.emit({ type: 'message.delta', sessionId, turnId: mainTurn, messageId, delta: `${token.slice(8)} y` });
    await settle();
    expect(deltaText(w, messageDeltas('a-1'))).not.toContain(token.slice(0, 8));
    codex.emit({ type: 'message.completed', message: { id: messageId, sessionId, turnId: mainTurn, role: 'assistant', origin: { kind: 'agent' }, text: `x ${token} y`, attachments: [], createdAt: at } });
    await settle();
    expect(deltaText(w, messageDeltas('a-1'))).toBe('x [redacted] y');
    expect(JSON.stringify(w.events)).not.toContain(token);
  });

  it('r3-P1-1 a message is still let out when its own turn ends without a completion', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    const mainTurn = TurnId.parse('turn-main');
    codex.emit({ type: 'message.delta', sessionId, turnId: mainTurn, messageId: MessageId.parse('a-1'), delta: `cut ${token.slice(0, 8)}` });
    codex.emit({ type: 'turn.updated', turn: { id: mainTurn, sessionId, state: 'interrupted', startedAt: at, endedAt: at } });
    await settle();
    expect(deltaText(w, messageDeltas('a-1'))).toBe(`cut ${token.slice(0, 8)}`);
  });

  it('r3-P1-1 a background command’s output crossing a turn end is held until the command itself ends', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const token = w.mounts[0]!.mount.token;
    const codex = w.codex.get(sessionId)!;
    const itemId = ItemId.parse('bg-1');
    const output = (e: AppEvent) => (e.type === 'item.outputDelta' && e.itemId === itemId ? e.delta : undefined);
    codex.emit({ type: 'item.outputDelta', sessionId, itemId, delta: token.slice(0, 8) });
    codex.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-main'), sessionId, state: 'completed', startedAt: at, endedAt: at } });
    codex.emit({ type: 'item.outputDelta', sessionId, itemId, delta: `${token.slice(8)}\n` });
    await settle();
    expect(deltaText(w, output)).not.toContain(token.slice(0, 8));
    codex.emit({
      type: 'item.updated',
      item: { id: itemId, sessionId, kind: 'command', command: 'serve', cwd: CWD, state: 'completed', background: true, output: '', outputTruncated: false, startedAt: at, endedAt: at },
    });
    await settle();
    expect(deltaText(w, output)).toBe('[redacted]\n');
  });
});

describe('r3-P1-2 a request already being checked is declined once closing began', () => {
  it('r3-P1-2 a request whose session read is held until shutdown finished is declined, never approved', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    const hold = later();
    pauseFirstSessionRead(w, hold.gate);
    const handle = w.codex.get(sessionId)!.ask(permissionRequest(sessionId));
    await settle();
    await w.service.shutdown();
    hold.release();
    await settle();
    expect(handle.decision).toMatchObject({ outcome: 'decline', decidedBy: 'policy' });
    expect(w.contexts).toEqual([]);
  });

  it('r3-P1-2 a request held for the user cannot be approved once closing began', async () => {
    const w = await world();
    const { sessionId } = await created(w);
    w.decide = () => ({ action: 'escalate', rule: 'destructive', reason: 'fixed' });
    const handle = w.codex.get(sessionId)!.ask(permissionRequest(sessionId));
    await settle();
    const [escalation] = [...w.repositories.escalationRecords.values()];
    const shutdown = w.service.shutdown();
    expect(await w.service.gate.respond(escalation!, { decision: 'approve' })).toBe('gone');
    await shutdown;
    expect(handle.decision).toMatchObject({ outcome: 'decline', decidedBy: 'policy' });
  });
});

describe('r3-P2-1 stream keys cannot collide', () => {
  it('r3-P2-1 (s:x, m) and (s, x:m) keep their own held text', () => {
    const r = new Redactor();
    r.add('tok-0123456789');
    const delta = (sessionId: string, messageId: string, text: string) =>
      ({ type: 'message.delta', sessionId: sessionId as SessionId, messageId: MessageId.parse(messageId), delta: text }) as const;
    const out = [...r.events(delta('s:x', 'm', 'AAA')), ...r.events(delta('s', 'x:m', 'BBB'))];
    expect(out).toEqual([]);
    const done = r.events({
      type: 'message.completed',
      message: { id: MessageId.parse('m'), sessionId: 's:x' as SessionId, role: 'assistant', origin: { kind: 'agent' }, text: 'AAA', attachments: [], createdAt: at },
    });
    expect(done[0]).toMatchObject({ type: 'message.delta', sessionId: 's:x', messageId: 'm', delta: 'AAA' });
  });
});

describe('r3-P2-2 a call that runs into the exit answers shutting-down', () => {
  it('r3-P2-2 a cross-tool send_message whose session read is held until shutdown finished answers shutting-down, not an error', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    const { sessionId: c } = await created(w, 'claude', 'session-c');
    const hold = later();
    pauseFirstSessionRead(w, hold.gate);
    const result = w.service.sendMessage({ to: c, content: 'cross' }, { caller: a, operationId: OperationId.parse('op-x'), sourceCallRef: 'call-x' });
    await settle();
    await w.service.shutdown();
    hold.release();
    expect(await result).toMatchObject({ status: 'rejected', rejection: { reason: 'shutting-down' } });
    expect([...w.repositories.escalationRecords.values()].filter((e) => e.kind === 'confirmation')).toEqual([]);
  });
});

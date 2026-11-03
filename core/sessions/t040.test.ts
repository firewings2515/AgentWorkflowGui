// T040: what the session service answers that the views and agents act on — a closed target whose folder is gone is
// refused with `folder-missing` (C-30, T036 G-2), before anything is accepted or dispatched.
import { describe, expect, it } from 'vitest';
import { OperationId, type SessionId } from '../../contracts';
import { created, settle, world, type World } from './testing/harness';

const call = (w: World, caller: SessionId, to: string, operationId = 'op-1') =>
  w.service.sendMessage({ to: to as SessionId, content: 'ping' }, { caller, operationId: OperationId.parse(operationId), sourceCallRef: `call-${operationId}` });

describe('folder-missing (C-30)', () => {
  it('a message to a closed session whose folder is gone is refused with folder-missing; nothing is accepted or sent', async () => {
    const first = await world();
    const { sessionId: a } = await created(first);
    const { sessionId: b } = await created(first, 'codex', 'session-b');
    // After a restart every runtime is closed; then b's folder goes.
    const w = first.restart();
    await w.service.start();
    await settle();
    w.realPath = (path) => (path.startsWith('E:\\work') ? null : path);
    const result = await call(w, a, b);
    expect(result).toEqual({ status: 'rejected', rejection: { reason: 'folder-missing', detail: 'the target session is closed and its folder no longer exists' } });
    expect(await w.store.get(OperationId.parse('op-1'))).toBeUndefined();
    expect(w.codex.get(b)).toBeUndefined();
  });

  it('an unknown target stays unknown-target', async () => {
    const w = await world();
    const { sessionId: a } = await created(w);
    expect(await call(w, a, 'nobody')).toMatchObject({ status: 'rejected', rejection: { reason: 'unknown-target' } });
  });
});

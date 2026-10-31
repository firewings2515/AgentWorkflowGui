// The idle supervisor's cases (T036), run on memory storage (core/supervisor/supervisor.test.ts) and on the real
// SQLite repositories and delivery store (app/main/supervisor-sqlite.test.ts): what idle means, closing (R-14) and
// resuming in the original folder (R-06) with the model set now (R-12), the global limit, CR-7, and the crashes and
// await windows between deciding and closing.
import { describe, expect, it } from 'vitest';
import { type ItemId, type NativeTaskId, OperationId, type Runtime, type SessionId, TurnId } from '../../../contracts';
import { hashOf } from '../../delivery/testing/fixtures';
import { permissionRequest } from '../../sessions/testing/fake-adapter';
import { CWD } from '../../sessions/testing/harness';
import {
  activityOf,
  onlyCloseDeadline,
  adapterOf,
  adaptersOf,
  AT,
  closesOf,
  resumedOf,
  textsOf,
  created,
  endLastTurn,
  exchange,
  gate,
  IDLE_MS,
  idleFor,
  isOpen,
  rid,
  send,
  settle,
  type SupWorld,
  type SupWorldOptions,
} from './harness';

export type MakeSupWorld = (o?: SupWorldOptions) => Promise<SupWorld>;

let ops = 0;
/** A user message accepted for the session and left pending (dispatched later by the test, outside any queue). */
const pending = async (w: SupWorld, sessionId: SessionId, runtime: Runtime, text = `queued ${String(++ops)}`) => {
  const operationId = OperationId.parse(`user-message:sup-pending-${String(++ops)}`);
  const ref = await w.service.nativeSessionOf(sessionId);
  const accepted = await w.service.delivery.accept({
    kind: 'user-message',
    operationId,
    payloadHash: hashOf(text),
    payload: text,
    proposalRevision: 0,
    target: { sessionId, nativeSessionRef: ref! },
    at: AT,
    context: { runtime, cwd: CWD, entry: { kind: 'new-turn' }, session: { model: { runtime, model: 'm' }, readOnly: false } },
  });
  if (accepted.status !== 'accepted') throw new Error(`accept ended ${accepted.status}`);
  return operationId;
};

const stateOf = async (w: SupWorld, operationId: OperationId) => (await w.store.get(operationId))?.delivery.state;

export const supervisorCases = (name: string, make: MakeSupWorld) => {
  describe(`idle supervisor: closing and resuming (${name})`, () => {
    for (const runtime of ['codex', 'claude'] as const) {
      it(`closes an idle ${runtime} session after the idle time, keeps it as it was, and resumes it in its folder on the next message`, async () => {
        const w = await make();
        const a = await created(w, runtime);
        await exchange(w, runtime, a, 'first');
        const before = (await w.repositories.sessions.get(a))!;

        await idleFor(w, IDLE_MS - 1);
        expect(isOpen(w, a)).toBe(true);
        expect(closesOf(w, runtime, a)).toEqual([]);

        await idleFor(w, 1);
        // R-14: the adapter's own close (Claude interrupts then closes, Codex closes stdin), then the Job.
        expect(closesOf(w, runtime, a)).toHaveLength(1);
        expect(w.closed).toEqual([a]);
        expect(isOpen(w, a)).toBe(false);
        const after = (await w.repositories.sessions.get(a))!;
        expect(after.activity).toBe('closed');
        expect({ ...after, activity: before.activity, revision: before.revision, updatedAt: before.updatedAt }).toEqual(before);
        expect((await w.repositories.conversations.get(a)).messages.map((m) => m.text)).toContain('first');

        const result = await send(w, a, 'second');
        expect(result.ok).toBe(true);
        // A Codex session gets a new adapter (app-server) for its new opening (T036 r2 P1-1).
        expect(resumedOf(w, runtime, a)).toHaveLength(1);
        expect(resumedOf(w, runtime, a)[0]).toMatchObject({ sessionId: a, cwd: CWD, nativeSessionRef: await w.service.nativeSessionOf(a) });
        expect(textsOf(w, runtime, a)).toEqual(['first', 'second']);
        expect(await activityOf(w, a)).toBe('idle');
      });
    }

    it('resumes with the model set while it was closed (R-12)', async () => {
      const w = await make();
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      await idleFor(w, IDLE_MS);
      const s = (await w.repositories.sessions.get(a))!;
      const changed = await w.run({ type: 'session.setModel', requestId: rid(), sessionId: a, expectedRevision: s.revision, model: { runtime: 'claude', model: 'opus' } });
      expect(changed.ok).toBe(true);
      // Nothing runs, so nothing was told; the resume carries it.
      expect(w.claude.models).toEqual([]);
      await send(w, a, 'again');
      expect(w.claude.resumed.at(-1)?.model).toEqual({ runtime: 'claude', model: 'opus' });
    });

    it('closing one Codex session leaves the others and their app-servers alone (CR-7)', async () => {
      const w = await make();
      const a = await created(w, 'codex', 'session-a');
      const b = await created(w, 'codex', 'session-b');
      await exchange(w, 'codex', a);
      w.clock.advance(IDLE_MS / 2);
      await exchange(w, 'codex', b);
      await idleFor(w, IDLE_MS / 2);
      expect(w.closed).toEqual([a]);
      expect(w.codex.get(b)!.closedSessions).toEqual([]);
      expect(w.codex.get(b)!.calls).not.toContain('close');
      await exchange(w, 'codex', b, 'still here');
      expect(w.codex.get(b)!.resumed).toEqual([]);
      expect(w.codex.get(b)!.dispatched.map((d) => d.text)).toEqual(['hello', 'still here']);
    });

    it('Claude sessions share one adapter: only the idle one is closed', async () => {
      const w = await make();
      const a = await created(w, 'claude', 'session-a');
      const b = await created(w, 'claude', 'session-b');
      await exchange(w, 'claude', a);
      w.clock.advance(IDLE_MS / 2);
      await exchange(w, 'claude', b);
      await idleFor(w, IDLE_MS / 2);
      expect(w.claude.closedSessions).toEqual([await w.service.nativeSessionOf(a)]);
      expect(isOpen(w, b)).toBe(true);
    });
  });

  describe(`idle supervisor: what keeps a session open (${name})`, () => {
    const open = async (o?: SupWorldOptions) => {
      const w = await make(o);
      const a = await created(w, 'codex');
      await exchange(w, 'codex', a);
      return { w, a, codex: w.codex.get(a)! };
    };
    const stillOpenAfterIdle = async (w: SupWorld, a: SessionId) => {
      await idleFor(w, IDLE_MS * 2);
      expect(isOpen(w, a)).toBe(true);
      expect(w.closed).toEqual([]);
    };

    it('a running turn', async () => {
      const { w, a, codex } = await open();
      codex.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-own'), sessionId: a, state: 'running', startedAt: AT } });
      await settle();
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('turn-running'))).toBe(true);
    });

    it('a turn the ack named that was not seen to end', async () => {
      const { w, a } = await open();
      expect((await send(w, a, 'no turn events yet')).ok).toBe(true);
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('turn-acked'))).toBe(true);
      await endLastTurn(w, 'codex', a);
      await idleFor(w, IDLE_MS);
      expect(isOpen(w, a)).toBe(false);
    });

    it('a background command still running after its turn (Claude run_in_background)', async () => {
      const w = await make();
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      const item = { id: 'bg-1' as ItemId, sessionId: a, turnId: TurnId.parse('turn-1'), kind: 'command' as const, command: 'sleep 40', cwd: CWD, state: 'running' as const, background: true, output: '', outputTruncated: false, startedAt: AT };
      w.claude.emit({ type: 'item.updated', item });
      await settle();
      await stillOpenAfterIdle(w, a);
      w.claude.emit({ type: 'item.updated', item: { ...item, state: 'completed', endedAt: w.clock.now() } });
      await settle();
      await idleFor(w, IDLE_MS);
      expect(isOpen(w, a)).toBe(false);
    });

    it('a running native sub-agent (R-13)', async () => {
      const { w, a, codex } = await open();
      codex.emit({
        type: 'nativeTask.updated',
        task: { id: 'nt-1' as NativeTaskId, sessionId: a, runtime: 'codex', parentRef: 'thread-session-a', nativeRef: 'child-1', label: 'explorer', state: 'running', background: true, startedAt: AT },
      });
      await settle();
      await stillOpenAfterIdle(w, a);
    });

    it('a process still alive in its Job (a Codex Start-Process child)', async () => {
      const { w, a } = await open();
      w.owned.set(a, 1);
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('owned-process'))).toBe(true);
      w.owned.delete(a);
      await idleFor(w, 0);
      expect(isOpen(w, a)).toBe(false);
    });

    it('a pending delivery, and one whose outcome is unknown (CR-2)', async () => {
      const { w, a, codex } = await open();
      const op = await pending(w, a, 'codex');
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('delivery-pending'))).toBe(true);
      // Dispatched with no ack: unknown, still not idle.
      codex.dispatchModes = ['lost'];
      await w.service.delivery.dispatch(op);
      expect(await stateOf(w, op)).toBe('unknown');
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('delivery-unknown'))).toBe(true);
    });

    it('a request held for the user (R-05)', async () => {
      const { w, a, codex } = await open();
      w.decide = () => ({ action: 'escalate', rule: 'destructive', reason: 'wide delete' });
      codex.ask(permissionRequest(a, { id: 'perm-held' as never, summary: 'rm -rf build', command: 'rm -rf build' }));
      await settle();
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('held-request'))).toBe(true);
    });

    it('a file lock it holds (R-07)', async () => {
      const w = await make({ locks: true });
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      w.files.set('e:\\real\\project\\shared.txt', `sha256:${'1'.repeat(64)}`);
      const handle = w.claude.ask(
        permissionRequest(a, { id: 'perm-w' as never, kind: 'fileChange', tool: 'Edit', itemId: 'tool-w' as ItemId, turnId: 'turn-lock' as never, summary: 'Edit', paths: ['E:\\work\\project\\shared.txt'] }),
      );
      await settle();
      expect(handle.decision).toMatchObject({ outcome: 'approve' });
      expect(w.service.locks!.list()).toEqual([expect.objectContaining({ holderSessionId: a })]);
      await stillOpenAfterIdle(w, a);
      expect(w.logs.some((l) => l.includes('lock-held'))).toBe(true);
      // The turn ends: the lock goes, and so does the runtime once idle long enough.
      w.claude.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-lock'), sessionId: a, state: 'completed', startedAt: AT, endedAt: AT } });
      await settle();
      expect(w.service.locks!.list()).toEqual([]);
      await idleFor(w, IDLE_MS);
      expect(isOpen(w, a)).toBe(false);
    });
  });

  describe(`idle supervisor: the global limit (${name})`, () => {
    it('above the limit closes the least recently used idle session first, whatever its idle time', async () => {
      const w = await make({ maxOpen: 2 });
      const a = await created(w, 'codex', 'session-a');
      await exchange(w, 'codex', a);
      w.clock.advance(1000);
      const b = await created(w, 'codex', 'session-b');
      await exchange(w, 'codex', b);
      w.clock.advance(1000);
      // b is used again after a: a is the least recently used.
      await exchange(w, 'codex', b, 'b again');
      w.clock.advance(1000);
      const c = await created(w, 'codex', 'session-c');
      await settle();
      expect(w.closed).toEqual([a]);
      expect(isOpen(w, b) && isOpen(w, c)).toBe(true);
    });

    it('skips a busy session for the next idle one, and goes above the limit when none is idle', async () => {
      const w = await make({ maxOpen: 1 });
      const a = await created(w, 'codex', 'session-a');
      await exchange(w, 'codex', a);
      w.codex.get(a)!.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-busy'), sessionId: a, state: 'running', startedAt: AT } });
      await settle();
      w.clock.advance(1000);
      const b = await created(w, 'codex', 'session-b');
      await settle();
      // a is busy, b holds nothing yet but was opened just now: b is the only idle one, so b goes.
      expect(w.closed).toEqual([b]);
      expect(isOpen(w, a)).toBe(true);
      // b is wanted again: it resumes, and with a still busy the limit is passed rather than cutting a off.
      const out = await send(w, b, 'to b');
      expect(out.ok).toBe(true);
      await settle();
      expect(isOpen(w, a) && isOpen(w, b)).toBe(true);
      expect(w.logs.some((l) => l.includes('above the limit'))).toBe(true);
    });
  });

  describe(`idle supervisor: resume only in the original folder (${name})`, () => {
    it('a closed session whose folder is gone is refused plainly, before anything is saved or sent', async () => {
      const w = await make();
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      await idleFor(w, IDLE_MS);
      w.gone.add(CWD);
      const messages = (await w.repositories.conversations.get(a)).messages.length;
      const result = await send(w, a, 'are you there');
      expect(result).toMatchObject({ ok: false, code: 'invalid_transition', message: expect.stringContaining('no longer exists') as unknown });
      expect(w.claude.resumed).toEqual([]);
      expect((await w.repositories.conversations.get(a)).messages).toHaveLength(messages);
      expect((await w.store.listByState('pending')).filter((r) => r.kind === 'user-message')).toEqual([]);
    });

    it('a folder removed while the message is on its way is said plainly, not as the runtime’s error, and nothing is claimed', async () => {
      const w = await make();
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      await idleFor(w, IDLE_MS);
      // The worktree is removed right as the resume starts; Claude then reports a binary that cannot start (SP-07 G5).
      w.claude.onResume = () => {
        w.gone.add(CWD);
        throw new Error('Claude Code native binary could not be started');
      };
      const result = await send(w, a, 'late');
      expect(result).toMatchObject({ ok: false, code: 'invalid_transition', message: expect.stringContaining('no longer exists') as unknown });
      expect(result.ok === false && result.message).not.toContain('binary');
      expect(w.claude.dispatched.map((d) => d.text)).toEqual(['hello']);
      const left = (await w.store.listByState('pending')).filter((r) => r.kind === 'user-message');
      expect(left).toHaveLength(1);
      expect(left[0]!.delivery.attempts).toEqual([]);
    });

    it('send_message to a closed session whose folder is gone is rejected, never accepted', async () => {
      const w = await make();
      const a = await created(w, 'codex', 'session-a');
      const b = await created(w, 'codex', 'session-b');
      await exchange(w, 'codex', b);
      await idleFor(w, IDLE_MS);
      expect(isOpen(w, b)).toBe(false);
      w.gone.add(CWD);
      const result = await w.service.sendMessage({ to: b, content: 'hi' }, { caller: a, operationId: OperationId.parse('peer-op-1'), sourceCallRef: 'call-1' });
      expect(result).toMatchObject({ status: 'rejected', rejection: { reason: 'unknown-target' } });
      expect(await w.store.get(OperationId.parse('peer-op-1'))).toBeUndefined();
    });
  });

  describe(`idle supervisor: await windows between deciding and closing (${name})`, () => {
    const idleOne = async (runtime: Runtime = 'codex') => {
      const w = await make();
      const a = await created(w, runtime);
      await exchange(w, runtime, a);
      w.clock.advance(IDLE_MS);
      return { w, a, adapter: adapterOf(w, runtime, a) };
    };

    it('a message ahead of the close in the session queue cancels it; nothing is resumed', async () => {
      const { w, a } = await idleOne();
      // The command enters the session's queue first, then the close (both in the same step).
      const revision = (await w.repositories.sessions.get(a))!.revision;
      const sending = w.run({ type: 'session.send', requestId: rid(), sessionId: a, messageId: 'sup-m-ahead' as never, expectedRevision: revision, text: 'just in time', attachments: [] });
      const ticking = w.supervisor.tick();
      expect((await sending).ok).toBe(true);
      await ticking;
      await settle();
      expect(closesOf(w, 'codex', a)).toEqual([]);
      expect(resumedOf(w, 'codex', a)).toEqual([]);
      expect(textsOf(w, 'codex', a)).toEqual(['hello', 'just in time']);
      // Cancelled by the message itself, before any fact was read (not by the turn it then started).
      expect(w.logs.filter((l) => l.includes('is not idle'))).toEqual([]);
    });

    it('a message behind a close that is checking waits for it, then resumes the session once', async () => {
      const { w, a } = await idleOne();
      const b = await created(w, 'codex', 'session-b');
      const held = gate();
      w.storeGate = held.promise;
      const ticking = w.supervisor.tick();
      await settle();
      // A peer's send_message: it goes through the target's queue, behind the close.
      const sending = w.service.sendMessage({ to: a, content: 'queued behind' }, { caller: b, operationId: OperationId.parse('peer-behind'), sourceCallRef: 'call-behind' });
      await settle();
      expect(textsOf(w, 'codex', a)).toHaveLength(1);
      w.storeGate = undefined;
      held.open();
      await ticking;
      expect(await sending).toMatchObject({ status: 'accepted', delivery: 'sent' });
      expect(closesOf(w, 'codex', a)).toHaveLength(1);
      expect(resumedOf(w, 'codex', a)).toHaveLength(1);
      expect(textsOf(w, 'codex', a)).toEqual(['hello', 'queued behind']);
      expect(await activityOf(w, a)).toBe('idle');
    });

    it('a runtime event while the close is checking cancels it', async () => {
      const { w, a, adapter } = await idleOne();
      const held = gate();
      w.storeGate = held.promise;
      const ticking = w.supervisor.tick();
      await settle();
      // A background sub-agent finished and woke the session (R-13).
      adapter.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-woke'), sessionId: a, state: 'running', startedAt: AT } });
      w.storeGate = undefined;
      held.open();
      await ticking;
      await settle();
      expect(closesOf(w, 'codex', a)).toEqual([]);
      expect(isOpen(w, a)).toBe(true);
    });

    it('a delivery from outside the queue while the runtime is being released waits, resumes it, and is sent once', async () => {
      const { w, a, adapter } = await idleOne();
      const held = gate();
      adapter.closeGate = held.promise;
      const ticking = w.supervisor.tick();
      await settle();
      expect(closesOf(w, 'codex', a)).toHaveLength(1);
      // Accepted now and dispatched straight away, as a user's retry is: not through the session's queue.
      const op = await pending(w, a, 'codex', 'retried');
      const dispatching = w.service.delivery.dispatch(op);
      await settle();
      expect(textsOf(w, 'codex', a)).toHaveLength(1);
      expect(resumedOf(w, 'codex', a)).toEqual([]);
      held.open();
      await ticking;
      const outcome = await dispatching;
      await settle();
      expect(outcome.status).toBe('sent');
      expect(await stateOf(w, op)).toBe('sent');
      expect(resumedOf(w, 'codex', a)).toHaveLength(1);
      expect(textsOf(w, 'codex', a)).toEqual(['hello', 'retried']);
      expect(isOpen(w, a)).toBe(true);
      expect(await activityOf(w, a)).toBe('idle');
    });

    it('two deliveries to a closed session resume it once and are each sent once', async () => {
      const { w, a } = await idleOne();
      await w.supervisor.tick();
      await settle();
      expect(isOpen(w, a)).toBe(false);
      const held = gate();
      // The resume of the next opening (a new adapter) is held.
      w.onNewAdapter = (next) => {
        next.resumeGate = held.promise;
      };
      const one = await pending(w, a, 'codex', 'one');
      const two = await pending(w, a, 'codex', 'two');
      const both = Promise.all([w.service.delivery.dispatch(one), w.service.delivery.dispatch(two)]);
      await settle();
      held.open();
      const outcomes = await both;
      expect(outcomes.map((o) => o.status)).toEqual(['sent', 'sent']);
      expect(resumedOf(w, 'codex', a)).toHaveLength(1);
      expect(textsOf(w, 'codex', a).sort()).toEqual(['hello', 'one', 'two']);
    });

    it('the task pipeline closing the same runtime at the same time closes it once', async () => {
      const { w, a, adapter } = await idleOne();
      const held = gate();
      adapter.closeGate = held.promise;
      const ticking = w.supervisor.tick();
      await settle();
      const ref = (await w.service.nativeSessionOf(a))!;
      const other = w.service.runtimes.closeSession(ref, 5000);
      held.open();
      await Promise.all([ticking, other]);
      await settle();
      expect(closesOf(w, 'codex', a)).toHaveLength(1);
      expect(w.closed).toEqual([a]);
    });

    it('a close under way when the app exits finishes, and no new close starts', async () => {
      const { w, a, adapter } = await idleOne();
      const b = await created(w, 'codex', 'session-b');
      await exchange(w, 'codex', b);
      w.clock.advance(IDLE_MS);
      const held = gate();
      adapter.closeGate = held.promise;
      const ticking = w.supervisor.tick();
      await settle();
      const shutdown = w.service.shutdown(5000);
      held.open();
      await Promise.all([ticking, shutdown]);
      // b was closed by the exit (R-14), not by the supervisor, which stopped at the exit.
      expect(w.logs.filter((l) => l.includes('closed the idle runtime'))).toEqual([`[supervisor] closed the idle runtime of ${a}`]);
      expect(w.codex.get(b)!.closedSessions).toHaveLength(1);
      await w.supervisor.tick();
    });
  });

  describe(`idle supervisor: review r1 sequences (${name})`, () => {
    it('P1-1: a sent delivery whose ack is not yet followed is not closed by the limit', async () => {
      const w = await make({ maxOpen: 1 });
      const a = await created(w, 'codex', 'session-a');
      await exchange(w, 'codex', a);
      // A retry from outside the queue: the runtime acks, `sent` commits, and the call has not returned yet.
      const op = await pending(w, a, 'codex', 'retried');
      const held = gate();
      w.holdNextRecordSent = held.promise;
      const dispatching = w.service.delivery.dispatch(op);
      await settle();
      expect(await stateOf(w, op)).toBe('sent');
      w.clock.advance(1);
      // A second session goes above the limit of one: the limit looks for the oldest idle session.
      const b = await created(w, 'codex', 'session-b');
      await settle();
      expect(isOpen(w, a)).toBe(true);
      expect(w.closed).not.toContain(a);
      expect(w.logs.some((l) => l.includes(`${a} is not idle`) && l.includes('turn-acked'))).toBe(true);
      held.open();
      expect((await dispatching).status).toBe('sent');
      // The newest one was the idle one, so it went instead.
      expect(w.closed).toEqual([b]);
    });

    it('P1-2: a graceful close that returns after the deadline leaves the session resumed since alone', async () => {
      const { w, a, adapter } = await (async () => {
        const world = await make();
        const id = await created(world, 'codex');
        await exchange(world, 'codex', id);
        world.clock.advance(IDLE_MS);
        return { w: world, a: id, adapter: world.codex.get(id)! };
      })();
      const held = gate();
      adapter.closeGate = held.promise;
      // The close deadline passes at once: the session is released by force (its Job ended).
      w.sleeper = () => Promise.resolve();
      await w.supervisor.tick();
      await settle();
      expect(w.closed).toEqual([a]);
      expect(isOpen(w, a)).toBe(false);
      expect((await send(w, a, 'after the deadline')).ok).toBe(true);
      expect(resumedOf(w, 'codex', a)).toHaveLength(1);
      expect(isOpen(w, a)).toBe(true);
      const mounts = w.mounts.filter((m) => m === a).length;
      // The old close returns now: the new opening keeps its runtime, token and Job.
      held.open();
      await settle();
      expect(isOpen(w, a)).toBe(true);
      expect(w.closed).toEqual([a]);
      expect(w.mounts.filter((m) => m === a)).toHaveLength(mounts);
      expect(await activityOf(w, a)).toBe('idle');
    });

    it('P1-3: two deliveries to a closed session, the first held before its resume, resume it once with one mount', async () => {
      const w = await make();
      const a = await created(w, 'claude');
      await exchange(w, 'claude', a);
      await idleFor(w, IDLE_MS);
      expect(isOpen(w, a)).toBe(false);
      const mountsBefore = w.mounts.filter((m) => m === a).length;
      const one = await pending(w, a, 'claude', 'one');
      const two = await pending(w, a, 'claude', 'two');
      const held = gate();
      // The first one's resume stops on its read of the session.
      w.holdNextSessionGet = held.promise;
      const first = w.service.delivery.dispatch(one);
      await settle();
      const second = w.service.delivery.dispatch(two);
      await settle();
      held.open();
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.map((o) => o.status)).toEqual(['sent', 'sent']);
      expect(w.claude.resumed).toHaveLength(1);
      expect(w.mounts.filter((m) => m === a)).toHaveLength(mountsBefore + 1);
      expect(w.claude.dispatched.map((d) => d.text).sort()).toEqual(['hello', 'one', 'two']);
    });
  });

  describe(`idle supervisor: review r2 sequences (${name})`, () => {
    for (const runtime of ['codex', 'claude'] as const) {
      it(`P1-1: a late exit of the earlier ${runtime} opening leaves the session resumed since alone`, async () => {
        // Claude as the main process gives it: a new adapter per opening.
        const w = await make({ claudePerSession: true });
        const a = await created(w, runtime);
        await exchange(w, runtime, a);
        w.clock.advance(IDLE_MS);
        const old = adapterOf(w, runtime, a);
        const held = gate();
        old.closeGate = held.promise;
        // The graceful close does not return in time: the session is released by force. The old adapter is retired but
        // not collected yet (its close has not returned), so its late events still arrive.
        w.sleeper = onlyCloseDeadline;
        await w.supervisor.tick();
        await settle();
        expect(w.closed).toEqual([a]);
        expect((await send(w, a, 'after the deadline')).ok).toBe(true);
        const fresh = adapterOf(w, runtime, a);
        expect(fresh).not.toBe(old);
        expect(await w.service.mainTurnRunning(a)).toBe(true);
        // The earlier opening's stream ends only now: its exit and its activity come late.
        old.emit({ type: 'runtime.exited', runtime, sessionIds: [a], expected: true, code: null, signal: null, at: AT });
        old.emit({ type: 'session.activity', sessionId: a, activity: 'closed', at: AT });
        held.open();
        await settle();
        expect(isOpen(w, a)).toBe(true);
        expect(w.closed).toEqual([a]);
        expect(await w.service.mainTurnRunning(a)).toBe(true);
        expect(await activityOf(w, a)).toBe('idle');
        expect(w.logs.some((l) => l.includes('late exit of an earlier opening'))).toBe(true);
        // The new opening's own exit still counts.
        fresh.emit({ type: 'runtime.exited', runtime, sessionIds: [a], expected: false, code: 1, signal: null, at: AT });
        await settle();
        expect(isOpen(w, a)).toBe(false);
        expect(w.closed).toEqual([a, a]);
      });
    }

    it('P1-2: after a restart, a reconcile that names a turn never stored leaves no turn running', async () => {
      const w = await make();
      const a = await created(w, 'codex');
      await exchange(w, 'codex', a, 'before');
      // No ack, and nothing this process can find: the outcome stays unknown (CR-2).
      adapterOf(w, 'codex', a).dispatchModes = ['lost'];
      expect(await send(w, a, 'lost one')).toMatchObject({ ok: false, code: 'unknown_outcome' });
      const [record] = (await w.store.listByState('unknown')).filter((r) => r.kind === 'user-message');
      const attempt = record!.delivery.attempts.at(-1)!;
      const ref = (await w.service.nativeSessionOf(a))!;
      // The GUI dies before the turn's events were stored; the runtime did take the message.
      const w2 = w.restart();
      w2.onNewAdapter = (next) => {
        next.history.set(attempt.clientMessageId, { ref, text: 'lost one' });
        next.reconcileTurn = 'turn-never-stored';
      };
      await w2.service.start();
      await settle();
      expect(await stateOf(w2, record!.operationId)).toBe('sent');
      expect(await w2.service.mainTurnRunning(a)).toBe(false);
      await exchange(w2, 'codex', a, 'after the restart');
      expect(await w2.service.mainTurnRunning(a)).toBe(false);
      await idleFor(w2, IDLE_MS);
      expect(isOpen(w2, a)).toBe(false);
      expect(w2.logs.some((l) => l.includes('turn-acked'))).toBe(false);
    });
  });

  describe(`idle supervisor: review r3 sequences (${name})`, () => {
    it('P2: closing and resuming again and again leaves no retired adapter or listener behind', async () => {
      const w = await make();
      const a = await created(w, 'codex');
      for (let round = 0; round < 4; round++) {
        await exchange(w, 'codex', a, `round ${String(round)}`);
        await idleFor(w, IDLE_MS);
        expect(isOpen(w, a)).toBe(false);
      }
      await settle();
      expect(w.service.runtimes.retiredCount).toBe(0);
      const adapters = adaptersOf(w, 'codex', a);
      expect(adapters).toHaveLength(4);
      // Each was closed when it was let go (R-14), and none is listened to any more.
      expect(adapters.every((x) => x.calls.includes('close'))).toBe(true);
      adapters[0]!.emit({ type: 'runtime.exited', runtime: 'codex', sessionIds: [a], expected: false, code: 1, signal: null, at: AT });
      adapters[0]!.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-after-collect'), sessionId: a, state: 'completed', startedAt: AT, endedAt: AT } });
      await settle();
      expect(w.logs.some((l) => l.includes('late exit'))).toBe(false);
      expect((await w.repositories.conversations.get(a)).turns.some((t) => t.id === 'turn-after-collect')).toBe(false);
    });

    it('an earlier opening’s late running turn and request change nothing now (history only)', async () => {
      const w = await make({ locks: true });
      const a = await created(w, 'codex');
      await exchange(w, 'codex', a);
      w.clock.advance(IDLE_MS);
      const old = adapterOf(w, 'codex', a);
      const held = gate();
      old.closeGate = held.promise;
      w.sleeper = onlyCloseDeadline;
      await w.supervisor.tick();
      await settle();
      expect((await send(w, a, 'after')).ok).toBe(true);
      expect(await w.service.mainTurnRunning(a)).toBe(true);
      const before = (await activityOf(w, a))!;
      // The earlier opening reports a turn running, then ending, and asks to run a command.
      old.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-old-late'), sessionId: a, state: 'running', startedAt: AT } });
      const asked = old.ask(permissionRequest(a, { id: 'perm-old' as never, summary: 'npm test', command: 'npm test' }));
      old.emit({ type: 'turn.updated', turn: { id: TurnId.parse('turn-old-late'), sessionId: a, state: 'interrupted', startedAt: AT, endedAt: AT } });
      await settle();
      // Its end is history; its running never was stored, the acked turn still runs, and the request is declined.
      const turns = (await w.repositories.conversations.get(a)).turns;
      expect(turns.find((t) => t.id === 'turn-old-late')?.state).toBe('interrupted');
      expect(await w.service.mainTurnRunning(a)).toBe(true);
      expect(await activityOf(w, a)).toBe(before);
      expect(asked.decision).toMatchObject({ outcome: 'decline', decidedBy: 'policy' });
      held.open();
      await settle();
    });
  });

  describe(`idle supervisor: crashes (${name})`, () => {
    it('a crash while closing: after the restart the session is closed and resumes once in its folder', async () => {
      const w = await make();
      const a = await created(w, 'codex');
      await exchange(w, 'codex', a, 'before');
      w.clock.advance(IDLE_MS);
      const adapter = w.codex.get(a)!;
      adapter.closeGate = new Promise<void>(() => undefined);
      void w.supervisor.tick();
      await settle();
      expect(adapter.closedSessions).toHaveLength(1);
      // The GUI dies here: its Jobs end with it; nothing else is stored about the close.
      const w2 = w.restart();
      await w2.service.start();
      expect(await activityOf(w2, a)).toBe('closed');
      expect((await send(w2, a, 'after')).ok).toBe(true);
      const again = w2.codex.get(a)!;
      expect(again.resumed).toEqual([expect.objectContaining({ cwd: CWD })]);
      expect(again.dispatched.map((d) => d.text)).toEqual(['after']);
      expect(adapter.dispatched.map((d) => d.text)).toEqual(['before']);
    });

    it('a crash while resuming: the message was not claimed, so the restart sends it once', async () => {
      const w = await make();
      const a = await created(w, 'codex');
      await exchange(w, 'codex', a, 'before');
      await idleFor(w, IDLE_MS);
      const adapter = w.codex.get(a)!;
      // The next opening's adapter never answers its resume.
      w.onNewAdapter = (next) => {
        next.resumeGate = new Promise<void>(() => undefined);
      };
      void send(w, a, 'during resume');
      await settle();
      expect(resumedOf(w, 'codex', a)).toHaveLength(1);
      const w2 = w.restart();
      const report = await w2.service.start();
      await settle();
      expect(report.failed).toEqual([]);
      const again = w2.codex.get(a)!;
      expect(again.resumed).toEqual([expect.objectContaining({ cwd: CWD })]);
      expect(again.dispatched.map((d) => d.text)).toEqual(['during resume']);
      expect(adapter.dispatched.map((d) => d.text)).toEqual(['before']);
      const messages = (await w2.repositories.conversations.get(a)).messages.filter((m) => m.text === 'during resume');
      expect(messages).toHaveLength(1);
    });
  });
};

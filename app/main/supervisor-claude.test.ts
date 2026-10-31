// T036 review r3 sequences on the real ClaudeAdapter over a fake SDK whose query does not end on close() (a CLI that
// does not exit): an earlier opening's late turn must not release a later opening's file lock (P1-1), and its
// request still in the permission check must not be approved or take a lock after the session was opened again
// (P1-2). The same session service, supervisor and harness as core/supervisor, on memory and on real SQLite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionId } from '../../contracts';
import { ClaudeAdapter } from '../../adapters/claude';
import { FakeSdk } from '../../adapters/claude/testing/fake-sdk';
import { promptLine, transcript } from '../../adapters/claude/testing/harness';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import type { AppRepositories, DeliveryStore } from '../../core/ports';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { CWD } from '../../core/sessions/testing/harness';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { created, gate, IDLE_MS, isOpen, onlyCloseDeadline, send, settle, supWorldOn, type SupWorld } from '../../core/supervisor/testing/harness';

const FILE = 'E:\\work\\project\\shared.txt';
const FILE_KEY = 'e:\\real\\project\\shared.txt';
const MODEL = 'claude-haiku-5-5';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What the CLI streams, for the session `ref`. */
const frames = (ref: string) => ({
  init: () => ({ type: 'system', subtype: 'init', session_id: ref, model: MODEL, cwd: CWD, uuid: `init-${String(Math.random())}` }),
  /** The turn's first reply, echoing the dispatched message: the live ack. */
  echo: (uuid: string, text = 'ok') => ({
    type: 'assistant',
    message: { model: MODEL, id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: `a-${uuid}`,
    session_id: ref,
    user_message_uuid: uuid,
    user_message_uuids: [uuid],
  }),
  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    message: { model: MODEL, id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    uuid: `a-${id}`,
    session_id: ref,
  }),
  toolResult: (id: string) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'written', is_error: false }] },
    parent_tool_use_id: null,
    uuid: `u-${id}`,
    session_id: ref,
  }),
  /** A reply the CLI had buffered, with no message of ours to echo. */
  late: () => ({
    type: 'assistant',
    message: { model: MODEL, id: 'msg_late', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'late' }] },
    parent_tool_use_id: null,
    uuid: 'a-late',
    session_id: ref,
  }),
  result: () => ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: ref,
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } },
  }),
});

interface ClaudeWorld {
  w: SupWorld;
  sdk: FakeSdk;
  /** `finish`: every dispatched message is acked and its turn ends; `stay`: acked, and the turn keeps running. */
  mode: { value: 'finish' | 'stay' };
}

const claudeWorld = async (repositories: AppRepositories, store: DeliveryStore): Promise<ClaudeWorld> => {
  const sdk = new FakeSdk();
  const mode: ClaudeWorld['mode'] = { value: 'finish' };
  // A CLI that does not exit when its query is closed (T036 r3, `closeEnds: false`).
  sdk.behaviour = {
    closeEnds: false,
    onInput: (message, query) => {
      const ref = message.session_id;
      const f = frames(ref);
      query.emit(f.init(), f.echo(message.uuid ?? ''));
      if (mode.value === 'finish') query.emit(f.result());
    },
  };
  const w = await supWorldOn(repositories, store, {
    locks: true,
    // The real adapter, a new one per opening as the main process makes it, with the router's hooks.
    createAdapter: (runtime, _sessionId, hooks, world) =>
      runtime === 'claude'
        ? new ClaudeAdapter({
            sdk,
            onPermissionRequest: (handle) => hooks.onPermissionRequest(handle),
            now: () => new Date(Date.parse(world.clock.now())),
            cwdExists: () => true,
            log: (level, message) => world.logs.push(`[claude ${level}] ${message}`),
          })
        : undefined,
  });
  w.files.set(FILE_KEY, `sha256:${'1'.repeat(64)}`);
  return { w, sdk, mode };
};

/** The session's transcript as the CLI stored it under its folder: what a resume reads first. */
const stored = async (c: ClaudeWorld, sessionId: SessionId) => {
  const ref = (await c.w.service.nativeSessionOf(sessionId))!;
  c.sdk.store(CWD, ref, transcript(ref, CWD, [promptLine('11111111-0000-4000-8000-000000000001', 'first')]));
};

/** An idle Claude session whose close does not return in time: released by force, then resumed by a new message. */
const forcedAndResumed = async (c: ClaudeWorld, sessionId: SessionId) => {
  const { w, sdk } = c;
  const old = sdk.last;
  w.clock.advance(IDLE_MS);
  // The close deadline passes at once; the router's wait for an earlier close too; collecting the old adapter does not.
  w.sleeper = onlyCloseDeadline;
  await w.supervisor.tick();
  await settle();
  expect(isOpen(w, sessionId)).toBe(false);
  expect(old.calls).toEqual(expect.arrayContaining(['interrupt', 'close']));
  await stored(c, sessionId);
  c.mode.value = 'stay';
  expect((await send(w, sessionId, 'after the close')).ok).toBe(true);
  await settle();
  const fresh = sdk.last;
  expect(fresh).not.toBe(old);
  expect(isOpen(w, sessionId)).toBe(true);
  return { old, fresh };
};

const locksOf = (w: SupWorld, sessionId: SessionId) => (w.service.locks?.list() ?? []).filter((l) => l.holderSessionId === sessionId);

const claudeCases = (name: string, make: () => Promise<ClaudeWorld>) => {
  describe(`T036 r3 on the real Claude adapter (${name})`, () => {
    it('P1-1: an earlier opening’s late reply and stream end do not release the lock the resumed turn holds', async () => {
      const c = await make();
      const { w } = c;
      const a = await created(w, 'claude');
      expect((await send(w, a, 'first')).ok).toBe(true);
      await settle();
      const ref = (await w.service.nativeSessionOf(a))!;
      const f = frames(ref);
      const { old, fresh } = await forcedAndResumed(c, a);

      // The resumed turn writes a file: a lock, held while its turn runs.
      fresh.emit(f.toolUse('toolu_w', 'Write', { file_path: FILE, content: 'x' }));
      await settle();
      const hook = fresh.callHook({ tool_name: 'Write', tool_input: { file_path: FILE, content: 'x' }, tool_use_id: 'toolu_w' });
      expect(await hook.output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      fresh.emit(f.toolResult('toolu_w'));
      await settle();
      expect(locksOf(w, a)).toHaveLength(1);

      // The earlier opening's CLI streams a reply it had buffered, then ends.
      old.emit(f.late());
      await settle();
      old.end();
      await settle();
      expect(locksOf(w, a)).toHaveLength(1);
      expect(isOpen(w, a)).toBe(true);
      expect(await w.service.mainTurnRunning(a)).toBe(true);
      // Its own turn and its end are kept as history only.
      const turns = (await w.repositories.conversations.get(a)).turns;
      expect(turns.filter((t) => t.state === 'running')).toHaveLength(1);
      // Its close returned: the old adapter is collected.
      await settle();
      expect(w.service.runtimes.retiredCount).toBe(0);
    });

    it('P1-2: a request of the earlier opening still in the check is declined, takes no lock, and approves nothing', async () => {
      const c = await make();
      const { w } = c;
      const a = await created(w, 'claude');
      expect((await send(w, a, 'first')).ok).toBe(true);
      await settle();
      const old = c.sdk.last;
      // After its turn ended, the CLI asks to write; the check stops on reading the session.
      const held = gate();
      w.holdNextSessionGet = held.promise;
      const asked = old.callHook({ tool_name: 'Write', tool_input: { file_path: FILE, content: 'old' }, tool_use_id: 'toolu_old' });
      await settle();
      // A request on its way to an answer keeps the session from being idle.
      w.clock.advance(IDLE_MS);
      await w.supervisor.tick();
      await settle();
      expect(isOpen(w, a)).toBe(true);
      expect(w.logs.some((l) => l.includes(`${a} is not idle`) && l.includes('held-request'))).toBe(true);

      // Released anyway (as the task pipeline releases a session before removing its folder), then resumed.
      w.sleeper = onlyCloseDeadline;
      expect(await w.service.closeIdle(a, () => Promise.resolve(true), 4000)).toBe('closed');
      await settle();
      expect(isOpen(w, a)).toBe(false);
      // The release declined it to the CLI at once.
      expect(await asked.output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
      await stored(c, a);
      c.mode.value = 'stay';
      expect((await send(w, a, 'after the close')).ok).toBe(true);
      await settle();
      expect(isOpen(w, a)).toBe(true);

      // The old check goes on now: nothing is approved and no lock is taken for the session.
      held.open();
      await settle();
      expect(locksOf(w, a)).toEqual([]);
      const requests = (await w.repositories.conversations.get(a)).permissionRequests.filter((r) => r.paths.includes(FILE));
      expect(requests.every((r) => r.decision?.outcome !== 'approve')).toBe(true);
    });
  });
};

claudeCases('memory', () => claudeWorld(new MemoryRepositories(), new MemoryDeliveryStore()));
claudeCases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t036-claude-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return claudeWorld(createRepositories(db), new SqliteDeliveryStore(db));
});

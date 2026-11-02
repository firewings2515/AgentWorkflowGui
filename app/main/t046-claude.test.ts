// T046 F-1 on the real ClaudeAdapter over a fake SDK: the CLI writes a session's transcript only with its first
// message, so a session that never had one cannot be resumed (`resume` finds nothing). It is opened again under its
// own session ID (the query's `sessionId`, never `resume`) only when nothing was handed to it; a session that had a
// message sent, or whose transcript cannot be read, is never opened again. The same session service, supervisor
// and harness as core/supervisor, on memory and on real SQLite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../adapters/claude';
import { FakeSdk } from '../../adapters/claude/testing/fake-sdk';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import type { AppRepositories, DeliveryStore } from '../../core/ports';
import { MemoryDeliveryStore } from '../../core/delivery/testing/memory-store';
import { CWD } from '../../core/sessions/testing/harness';
import { MemoryRepositories } from '../../core/sessions/testing/memory-repositories';
import { activityOf, created, IDLE_MS, isOpen, onlyCloseDeadline, send, settle, supWorldOn, type SupWorld } from '../../core/supervisor/testing/harness';

const MODEL = 'claude-haiku-5-5';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The real adapter, a new one per opening as the main process makes it; every message is acked and its turn ends. */
const claudeWorld = async (repositories: AppRepositories, store: DeliveryStore): Promise<{ w: SupWorld; sdk: FakeSdk }> => {
  const sdk = new FakeSdk();
  sdk.behaviour = {
    onInput: (message, query) => {
      const ref = message.session_id;
      const uuid = message.uuid ?? '';
      query.emit(
        { type: 'system', subtype: 'init', session_id: ref, model: MODEL, cwd: CWD, uuid: `init-${uuid}` },
        {
          type: 'assistant',
          message: { model: MODEL, id: `msg_${uuid.slice(0, 8)}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          parent_tool_use_id: null,
          uuid: `a-${uuid}`,
          session_id: ref,
          user_message_uuid: uuid,
          user_message_uuids: [uuid],
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: ref,
          usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
          modelUsage: { [MODEL]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200000 } },
        },
      );
    },
  };
  const w = await supWorldOn(repositories, store, {
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
  return { w, sdk };
};

/** The idle supervisor releases the session (its graceful close returns at once). */
const idleClose = async (w: SupWorld) => {
  w.clock.advance(IDLE_MS);
  w.sleeper = onlyCloseDeadline;
  await w.supervisor.tick();
  await settle();
};

const cases = (name: string, make: () => Promise<{ w: SupWorld; sdk: FakeSdk }>) => {
  describe(`T046 F-1 on the real Claude adapter (${name})`, () => {
    it('created and released by the idle supervisor before any message: the next message opens it again with `sessionId`, never `resume`, and is sent once', async () => {
      const { w, sdk } = await make();
      const a = await created(w, 'claude');
      const ref = (await w.service.nativeSessionOf(a))!;
      expect(sdk.queries.map((q) => q.options.sessionId)).toEqual([ref]);
      await idleClose(w);
      expect(isOpen(w, a)).toBe(false);

      expect(await send(w, a, 'first')).toMatchObject({ ok: true });
      await settle();
      // The resume read the transcript, found none and started nothing; the opening again uses the same ID.
      expect(sdk.reads).toContain(`transcript:${ref}`);
      expect(sdk.queries.map((q) => ({ sessionId: q.options.sessionId, resume: q.options.resume }))).toEqual([
        { sessionId: ref, resume: undefined },
        { sessionId: ref, resume: undefined },
      ]);
      expect(sdk.last.inputs.map((m) => m.session_id)).toEqual([ref]);
      expect(isOpen(w, a)).toBe(true);
      expect(await activityOf(w, a)).toBe('idle');
    });

    it('a session that had a message sent is never opened again, even when the CLI has no transcript for it', async () => {
      const { w, sdk } = await make();
      const a = await created(w, 'claude');
      expect(await send(w, a, 'first')).toMatchObject({ ok: true });
      await settle();
      await idleClose(w);
      const queries = sdk.queries.length;
      expect(await send(w, a, 'second')).toMatchObject({ ok: false, code: 'runtime_unavailable' });
      await settle();
      expect(sdk.queries).toHaveLength(queries);
      expect(isOpen(w, a)).toBe(false);
    });

    it('r1 P1-1: nothing handed over, but the transcript was not read whole and nothing came of it: not opened again; the session shows error', async () => {
      const { w, sdk } = await make();
      const a = await created(w, 'claude');
      await idleClose(w);
      const queries = sdk.queries.length;
      sdk.readTranscript = (sessionId) => {
        sdk.reads.push(`transcript:${sessionId}`);
        return Promise.resolve({ lines: [], complete: false, detail: 'the transcript changed while it was read' });
      };
      const result = await send(w, a, 'first');
      await settle();
      expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
      expect(sdk.queries).toHaveLength(queries);
      expect(await activityOf(w, a)).toBe('error');
    });

    it('nothing handed over, but the transcript cannot be read: not opened again; the session shows error', async () => {
      const { w, sdk } = await make();
      const a = await created(w, 'claude');
      await idleClose(w);
      const queries = sdk.queries.length;
      sdk.readError = new Error('EBUSY: the transcript is locked');
      const result = await send(w, a, 'first');
      await settle();
      expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
      expect(sdk.queries).toHaveLength(queries);
      expect(await activityOf(w, a)).toBe('error');
    });
  });
};

cases('memory', () => claudeWorld(new MemoryRepositories(), new MemoryDeliveryStore()));
cases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t046-claude-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return claudeWorld(createRepositories(db), new SqliteDeliveryStore(db));
});

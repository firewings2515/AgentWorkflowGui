// T065 on the real SQLite repositories and delivery store, with the same session service, engine, memory git and fake
// runtimes as the memory run in core/workflow/t065.test.ts. Only mkdtemp folders are touched.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageId } from '../../contracts';
import { createRepositories, openDatabase, SqliteDeliveryStore } from '../../adapters/storage';
import { attempt, echo, REF as CLAUDE_REF, started as startedClaude, until } from '../../adapters/claude/testing/harness';
import { ROOT, settle, started, template, worldOn } from '../../core/workflow/testing/harness';
import { t065ClaimCases } from '../../core/delivery/testing/t065-cases';
import { t065Cases } from '../../core/workflow/testing/t065-cases';

const opened: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

t065Cases('SQLite', (workflow) => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t065-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return worldOn(createRepositories(db), new SqliteDeliveryStore(db), workflow);
});

t065ClaimCases('SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awg-t065-'));
  const db = openDatabase(join(dir, 'awg.sqlite'));
  opened.push({ db, dir });
  return new SqliteDeliveryStore(db);
});

describe('T065 on SQLite: the notice the Claude adapter acks is stored in root\'s conversation', () => {
  it('as a system message it is recorded; the user-role shape it had before is refused by the storage', async () => {
    // What the real Claude adapter emits for an acked notice from the GUI.
    const claude = await startedClaude();
    const q = claude.sdk.last;
    const req = {
      nativeSessionRef: CLAUDE_REF,
      attempt: attempt(),
      text: 'Notice from the GUI (not a message from the user): the tasks were created.',
      entry: { kind: 'new-turn' as const },
      timeoutMs: 1000,
      origin: { kind: 'system' as const },
    };
    const sending = claude.adapter.dispatchOnce(req);
    await until(() => q.inputs.length === 1, 'input written');
    q.emit(echo(req.attempt.clientMessageId));
    await sending;
    const emitted = claude.of('message.completed')[0]!.message;
    expect(emitted.role).toBe('system');

    const dir = mkdtempSync(join(tmpdir(), 'awg-t065-'));
    const db = openDatabase(join(dir, 'awg.sqlite'));
    opened.push({ db, dir });
    const w = await worldOn(createRepositories(db), new SqliteDeliveryStore(db), template());
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    // Root's own turn is not the adapter's: the message is placed without one.
    const placed = { ...emitted };
    delete placed.turnId;
    w.claude.emit({ type: 'message.completed', message: { ...placed, sessionId: ROOT } });
    // Before T065 the adapter said `user` for it, which the contracts (and so the storage) refuse.
    w.claude.emit({ type: 'message.completed', message: { ...placed, id: MessageId.parse('7b1c2d3e-0000-4000-8000-000000000065'), sessionId: ROOT, role: 'user' } });
    await settle();
    const messages = (await w.repositories.conversations.get(ROOT)).messages;
    expect(messages.filter((m) => m.text === req.text).map((m) => [m.id, m.role, m.origin.kind])).toEqual([[req.attempt.clientMessageId, 'system', 'system']]);
    expect(w.logs.some((l) => l.includes(`recording message.completed of ${ROOT} failed (InvalidRecordError)`))).toBe(true);
  });
});

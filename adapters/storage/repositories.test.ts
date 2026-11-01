// The repositories against a real SQLite file (core/ports/repository.ts): compare-and-set on revision,
// records surviving a reopen, large text kept apart, damaged data reported without its content, and an
// upgrade from the T007 schema.
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDefinition, LogicalSession, Message, OwnedProcess, SessionId, SessionItem, type UiPreferences } from '../../contracts';
import { fixtureSnapshot as fx } from '../../contracts/fixtures/snapshot';
import type { AppRepositories } from '../../core/ports';
import { InvalidRecordError, StoredDataError } from './codec';
import { openDatabase } from './database';
import { canonicalJson, SqliteDeliveryStore } from './delivery-store';
import { MIGRATIONS, latestVersion, migrate } from './migrations';
import { createRepositories } from './repositories';
import { op, payloadInput } from './testing/fixtures';

let dir = '';
let path = '';
let db: DatabaseSync;
let repos: AppRepositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t015-'));
  path = join(dir, 'app.sqlite');
  db = openDatabase(path);
  repos = createRepositories(db, { blobThresholdBytes: 100 });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ts = (value: string) => value;
const byId = <T extends { id: string }>(records: readonly T[]): T[] => [...records].sort((a, b) => (a.id < b.id ? -1 : 1));

/** Stores every session of the fixture and what hangs off them. */
const seedConversations = async () => {
  for (const s of fx.sessions) expect(await repos.sessions.create(s)).toBe('created');
  for (const x of fx.turns) await repos.conversations.upsertTurn(x);
  for (const x of fx.messages) await repos.conversations.appendMessage(x);
  for (const x of fx.items) await repos.conversations.upsertItem(x);
  for (const x of fx.nativeTasks) await repos.conversations.upsertNativeTask(x);
  for (const x of fx.permissionRequests) await repos.conversations.upsertPermissionRequest(x);
  for (const x of fx.artifacts) await repos.conversations.upsertArtifact(x);
};

describe('agents and workflows (compare-and-set)', () => {
  const agent = fx.agents[0] as AgentDefinition;

  it('creates at revision 0, then raises it by one per save', async () => {
    const created = await repos.agents.save(agent, null);
    expect(created).toEqual({ status: 'saved', record: { ...agent, revision: 0 } });
    const edited = await repos.agents.save({ ...agent, name: '新名稱' }, 0);
    expect(edited).toEqual({ status: 'saved', record: { ...agent, name: '新名稱', revision: 1 } });
    expect(await repos.agents.get(agent.id)).toEqual({ ...agent, name: '新名稱', revision: 1 });
  });

  it('answers stale with what is stored and writes nothing when the revision is old', async () => {
    await repos.agents.save(agent, null);
    await repos.agents.save({ ...agent, name: 'B' }, 0);
    const stale = await repos.agents.save({ ...agent, name: 'C' }, 0);
    expect(stale).toEqual({ status: 'stale', current: { ...agent, name: 'B', revision: 1 } });
    expect((await repos.agents.get(agent.id))?.name).toBe('B');
  });

  it('refuses to create what exists, and to edit what is missing', async () => {
    await repos.agents.save(agent, null);
    expect(await repos.agents.save({ ...agent, name: 'again' }, null)).toEqual({ status: 'stale', current: { ...agent, revision: 0 } });
    expect(await repos.agents.save(fx.agents[1] as AgentDefinition, 3)).toEqual({ status: 'stale', current: undefined });
    expect(await repos.agents.list()).toHaveLength(1);
  });

  it('deletes only at the current revision', async () => {
    await repos.agents.save(agent, null);
    expect(await repos.agents.delete(agent.id, 5)).toBe('stale');
    expect(await repos.agents.delete(agent.id, 0)).toBe('deleted');
    expect(await repos.agents.delete(agent.id, 0)).toBe('not-found');
    expect(await repos.agents.get(agent.id)).toBeUndefined();
  });

  it('lists in creation order, and an edit keeps its place', async () => {
    for (const a of fx.agents) await repos.agents.save(a, null);
    await repos.agents.save({ ...(fx.agents[0] as AgentDefinition) }, 0);
    expect((await repos.agents.list()).map((a) => a.id)).toEqual(fx.agents.map((a) => a.id));
  });

  it('keeps workflow templates whole', async () => {
    const workflow = fx.workflows[0];
    if (workflow === undefined) throw new Error('fixture has no workflow');
    const saved = await repos.workflows.save(workflow, null);
    expect(saved).toEqual({ status: 'saved', record: { ...workflow, revision: 0 } });
    expect(await repos.workflows.list()).toEqual([{ ...workflow, revision: 0 }]);
    expect(await repos.workflows.delete(workflow.id, 0)).toBe('deleted');
  });

  it('rejects a record the contract does not accept, naming rules but no values', async () => {
    const bad = { ...agent, model: 'secret-model-value' } as unknown as AgentDefinition;
    const error = await repos.agents.save(bad, null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidRecordError);
    expect((error as Error).message).not.toContain('secret-model-value');
    expect(await repos.agents.list()).toEqual([]);
  });

  it('waits for another process that holds the write lock, then answers stale instead of overwriting', async () => {
    await repos.agents.save(agent, null);
    // A second process opens its write transaction first, reads revision 0, and commits revision 1 only
    // after 400 ms. The save below starts while that transaction is open, so it must wait for the lock
    // and then see the new revision. (The wait blocks this process; the other one keeps running.)
    const script = join(dir, 'competitor.mjs');
    writeFileSync(
      script,
      `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('BEGIN IMMEDIATE');
const row = db.prepare('SELECT revision FROM agent').get();
if (row.revision !== 0) throw new Error('unexpected revision');
process.send({ locked: true });
setTimeout(() => {
  db.prepare("UPDATE agent SET revision = 1, body = json_set(body, '$.revision', 1, '$.name', 'from-other-process')").run();
  db.exec('COMMIT');
  db.close();
  process.send({ committed: true }, () => process.exit(0));
}, 400);`,
    );
    const child = fork(script, [path], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`competitor failed: ${stderr}`))));
    });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('exit', () => reject(new Error(`competitor did not take the lock: ${stderr}`)));
    });

    const started = Date.now();
    const result = await repos.agents.save({ ...agent, name: 'from-this-process' }, 0);
    const waited = Date.now() - started;
    await exited;

    expect(result).toEqual({ status: 'stale', current: { ...agent, name: 'from-other-process', revision: 1 } });
    expect(waited).toBeGreaterThanOrEqual(250); // it really waited behind the other transaction
    expect(await repos.agents.get(agent.id)).toEqual({ ...agent, name: 'from-other-process', revision: 1 });
  }, 30_000);
});

describe('sessions', () => {
  const session = fx.sessions[0] as LogicalSession;

  it('creates once; the same ID again is `exists` and changes nothing', async () => {
    expect(await repos.sessions.create(session)).toBe('created');
    expect(await repos.sessions.create({ ...session, title: 'changed' })).toBe('exists');
    expect(await repos.sessions.get(session.id)).toEqual(session);
  });

  it('updates by compare-and-set and returns the stored session', async () => {
    await repos.sessions.create(session);
    const saved = await repos.sessions.update({ ...session, title: '改名', activity: 'running' }, session.revision);
    expect(saved).toEqual({ status: 'saved', record: { ...session, title: '改名', activity: 'running', revision: session.revision + 1 } });
    const stale = await repos.sessions.update({ ...session, title: '舊的' }, session.revision);
    expect(stale).toEqual({ status: 'stale', current: { ...session, title: '改名', activity: 'running', revision: session.revision + 1 } });
    expect(await repos.sessions.update(session, 0)).toEqual({ status: 'stale', current: expect.anything() as unknown });
  });

  it('reports stale with nothing current for a session that does not exist', async () => {
    expect(await repos.sessions.update(session, 0)).toEqual({ status: 'stale', current: undefined });
  });

  it('keeps workflow sessions with their binding, and lists oldest first', async () => {
    for (const s of [...fx.sessions].reverse()) await repos.sessions.create(s);
    const listed = await repos.sessions.list();
    expect(byId(listed)).toEqual(byId(fx.sessions));
    const times = listed.map((s) => Date.parse(s.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(listed.find((s) => s.kind === 'workflow')).toMatchObject({ workflow: { instanceId: 'inst-login' } });
  });

  it('orders by the instant, not by the text, when offsets differ', async () => {
    const early = { ...session, id: SessionId.parse('s-early'), createdAt: ts('2026-10-24T10:00:00+08:00') };
    const late = { ...session, id: SessionId.parse('s-late'), createdAt: ts('2026-10-24T03:00:00+00:00') };
    await repos.sessions.create(late);
    await repos.sessions.create(early);
    // 10:00+08:00 is 02:00Z, earlier than 03:00Z although its text sorts later.
    expect((await repos.sessions.list()).map((s) => s.id)).toEqual(['s-early', 's-late']);
  });
});

describe('conversations', () => {
  it('stores and reads back every kind, per session, oldest first', async () => {
    await seedConversations();
    for (const s of fx.sessions) {
      const conversation = await repos.conversations.get(s.id);
      const mine = <T extends { sessionId: string }>(records: readonly T[]) => records.filter((r) => r.sessionId === s.id);
      expect(byId(conversation.turns)).toEqual(byId(mine(fx.turns)));
      expect(byId(conversation.messages)).toEqual(byId(mine(fx.messages)));
      expect(byId(conversation.items)).toEqual(byId(mine(fx.items)));
      expect(byId(conversation.nativeTasks)).toEqual(byId(mine(fx.nativeTasks)));
      expect(byId(conversation.permissionRequests)).toEqual(byId(mine(fx.permissionRequests)));
      expect(byId(conversation.artifacts)).toEqual(byId(mine(fx.artifacts)));
    }
    expect(await repos.conversations.get(SessionId.parse('s-nobody'))).toEqual({
      turns: [],
      messages: [],
      items: [],
      nativeTasks: [],
      permissionRequests: [],
      artifacts: [],
    });
  });

  it('orders messages by when they were created, then by arrival', async () => {
    const session = fx.sessions[0] as LogicalSession;
    await repos.sessions.create(session);
    const base = fx.messages[0] as Message;
    const m = (id: string, createdAt: string): Message => ({ ...base, id: id as Message['id'], createdAt: ts(createdAt) });
    for (const x of [m('b', '2026-10-24T10:05:00+08:00'), m('a', '2026-10-24T02:00:00+00:00'), m('c', '2026-10-24T10:05:00+08:00')]) await repos.conversations.appendMessage(x);
    // a = 02:00Z = 10:00+08:00 is first; b and c share an instant and keep arrival order.
    expect((await repos.conversations.get(session.id)).messages.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('writes a message once: a repeat of its ID is ignored', async () => {
    await repos.sessions.create(fx.sessions[0] as LogicalSession);
    const message = fx.messages[0] as Message;
    await repos.conversations.appendMessage(message);
    await repos.conversations.appendMessage({ ...message, text: 'a different text' });
    expect((await repos.conversations.get(message.sessionId)).messages).toEqual([message]);
  });

  it('replaces an item, a turn and a permission request with the same ID, keeping their place', async () => {
    await seedConversations();
    const item = fx.items.find((i) => i.kind === 'command') as Extract<SessionItem, { kind: 'command' }>;
    await repos.conversations.upsertItem({ ...item, output: 'Tests  13 passed (13)' });
    const items = (await repos.conversations.get(item.sessionId)).items;
    expect(items.filter((i) => i.id === item.id)).toEqual([{ ...item, output: 'Tests  13 passed (13)' }]);
    // Oldest first by start time; the replaced item stays where its start puts it.
    const expected = fx.items.filter((i) => i.sessionId === item.sessionId).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    expect(items.map((i) => i.id)).toEqual(expected.map((i) => i.id));

    const turn = fx.turns[0];
    if (turn === undefined) throw new Error('fixture has no turn');
    const ended = { ...turn, state: 'completed' as const, endedAt: ts('2026-10-24T11:00:00+08:00') };
    await repos.conversations.upsertTurn(ended);
    expect((await repos.conversations.get(turn.sessionId)).turns).toContainEqual(ended);
  });

  it('keeps artifacts in the order they first appeared when one is updated', async () => {
    await seedConversations();
    const [first] = fx.artifacts;
    if (first === undefined) throw new Error('fixture has no artifact');
    await repos.conversations.upsertArtifact({ ...first, revision: first.revision + 1, updatedAt: ts('2026-10-25T00:00:00+08:00') });
    const ids = (await repos.conversations.get(first.sessionId)).artifacts.map((a) => a.id);
    expect(ids).toEqual(fx.artifacts.filter((a) => a.sessionId === first.sessionId).map((a) => a.id));
  });

  it('refuses records of a session that does not exist, and an ID that belongs to another session', async () => {
    const message = fx.messages[0] as Message;
    await expect(repos.conversations.appendMessage(message)).rejects.toThrow(/FOREIGN KEY/);
    await seedConversations();
    const item = fx.items[0] as SessionItem;
    const other = fx.sessions.find((s) => s.id !== item.sessionId) as LogicalSession;
    await expect(repos.conversations.upsertItem({ ...item, sessionId: other.id })).rejects.toBeInstanceOf(InvalidRecordError);
    expect((await repos.conversations.get(item.sessionId)).items.map((i) => i.id)).toContain(item.id);
  });

  it('rejects an invalid record before it reaches the database', async () => {
    await repos.sessions.create(fx.sessions[0] as LogicalSession);
    const message = { ...(fx.messages[0] as Message), role: 'assistant' } as Message; // a user origin cannot be an assistant
    await expect(repos.conversations.appendMessage(message)).rejects.toBeInstanceOf(InvalidRecordError);
    expect((await repos.conversations.get(message.sessionId)).messages).toEqual([]);
  });
});

describe('large text', () => {
  const big = '大'.repeat(200); // 600 bytes in UTF-8, over the 100-byte threshold
  const blobs = () => db.prepare('SELECT kind, owner_id, field, size_bytes FROM blob ORDER BY kind, owner_id, field').all();

  it('keeps a long message text, command output and diff apart and returns them whole', async () => {
    await seedConversations();
    const message = { ...(fx.messages[0] as Message), id: 'm-big' as Message['id'], text: big };
    await repos.conversations.appendMessage(message);
    const command = { ...(fx.items.find((i) => i.kind === 'command') as SessionItem), id: 'it-big' as SessionItem['id'], output: `${big}\n` } as SessionItem;
    const change = { ...(fx.items.find((i) => i.kind === 'fileChange') as SessionItem), id: 'it-diff' as SessionItem['id'], diff: big } as SessionItem;
    await repos.conversations.upsertItem(command);
    await repos.conversations.upsertItem(change);

    expect(blobs()).toEqual([
      { kind: 'message', owner_id: 'm-big', field: 'text', size_bytes: 600 },
      { kind: 'session_item', owner_id: 'it-big', field: 'output', size_bytes: 601 },
      { kind: 'session_item', owner_id: 'it-diff', field: 'diff', size_bytes: 600 },
    ]);
    // The rows themselves stay small.
    expect(db.prepare("SELECT length(body) AS n FROM message WHERE id = 'm-big'").get()).toEqual({ n: expect.any(Number) as number });
    expect(String((db.prepare("SELECT body FROM message WHERE id = 'm-big'").get() as { body: string }).body)).not.toContain('大大大');

    expect((await repos.conversations.get(message.sessionId)).messages).toContainEqual(message);
    expect((await repos.conversations.get(command.sessionId)).items).toContainEqual(command);
    expect((await repos.conversations.get(change.sessionId)).items).toContainEqual(change);
  });

  it('does not store text at the threshold, and drops a blob when the text shrinks', async () => {
    await seedConversations();
    const command = fx.items.find((i) => i.kind === 'command') as Extract<SessionItem, { kind: 'command' }>;
    await repos.conversations.upsertItem({ ...command, output: 'x'.repeat(100) });
    expect(blobs()).toEqual([]);
    await repos.conversations.upsertItem({ ...command, output: 'x'.repeat(101) });
    expect(blobs()).toHaveLength(1);
    await repos.conversations.upsertItem({ ...command, output: 'short' });
    expect(blobs()).toEqual([]);
    expect((await repos.conversations.get(command.sessionId)).items.find((i) => i.id === command.id)).toMatchObject({ output: 'short' });
  });

  it('keeps the first message and its blob when its ID is written again', async () => {
    await repos.sessions.create(fx.sessions[0] as LogicalSession);
    const message = { ...(fx.messages[0] as Message), text: big };
    await repos.conversations.appendMessage(message);
    await repos.conversations.appendMessage({ ...message, text: `${big}!` });
    expect((await repos.conversations.get(message.sessionId)).messages).toEqual([message]);
    expect(blobs()).toEqual([{ kind: 'message', owner_id: message.id, field: 'text', size_bytes: 600 }]);
  });

  it('round-trips text with NUL and lone surrogates, through a Snapshot read and a reopen', async () => {
    await seedConversations();
    const texts = ['prefix\0' + 'x'.repeat(65_536), '\0'.repeat(300), `ok${String.fromCharCode(0xd800)}${'y'.repeat(200)}`];
    const message = { ...(fx.messages[0] as Message), id: 'm-nul' as Message['id'], text: texts[0] as string };
    const command = { ...(fx.items.find((i) => i.kind === 'command') as Extract<SessionItem, { kind: 'command' }>), id: 'it-nul' as SessionItem['id'], output: texts[1] as string };
    const diff = { ...(fx.items.find((i) => i.kind === 'fileChange') as Extract<SessionItem, { kind: 'fileChange' }>), id: 'it-lone' as SessionItem['id'], diff: texts[2] as string };
    await repos.conversations.appendMessage(message);
    await repos.conversations.upsertItem(command);
    await repos.conversations.upsertItem(diff);

    const check = async () => {
      const { conversations } = await repos.readSnapshotData();
      expect(conversations.messages).toContainEqual(message);
      expect(conversations.items).toContainEqual(command);
      expect(conversations.items).toContainEqual(diff);
    };
    await check();
    db.close();
    db = openDatabase(path);
    repos = createRepositories(db, { blobThresholdBytes: 100 });
    await check();
  });

  it('reports a blob that was changed or lost without quoting it', async () => {
    await repos.sessions.create(fx.sessions[0] as LogicalSession);
    const message = { ...(fx.messages[0] as Message), text: big };
    await repos.conversations.appendMessage(message);
    db.prepare('UPDATE blob SET content = ? WHERE owner_id = ?').run('秘密的內容'.repeat(40), message.id);
    const changed = await repos.conversations.get(message.sessionId).catch((e: unknown) => e);
    expect(changed).toBeInstanceOf(StoredDataError);
    expect((changed as Error).message).not.toContain('秘密');
    db.prepare('DELETE FROM blob WHERE owner_id = ?').run(message.id);
    await expect(repos.conversations.get(message.sessionId)).rejects.toBeInstanceOf(StoredDataError);
  });
});

describe('escalations', () => {
  it('upserts, reads, and filters by state, oldest first', async () => {
    for (const e of fx.escalations) await repos.escalations.upsert(e);
    expect(byId(await repos.escalations.list())).toEqual(byId(fx.escalations));
    const open = await repos.escalations.list({ state: 'open' });
    expect(byId(open)).toEqual(byId(fx.escalations.filter((e) => e.state === 'open')));
    const [first] = open;
    if (first === undefined) throw new Error('fixture has no open escalation');
    const resolved = { ...first, state: 'approved' as const, resolvedBy: 'user' as const, resolvedAt: ts('2026-10-24T12:00:00+08:00') };
    await repos.escalations.upsert(resolved);
    expect(await repos.escalations.get(first.id)).toEqual(resolved);
    expect((await repos.escalations.list({ state: 'open' })).map((e) => e.id)).not.toContain(first.id);
    expect(await repos.escalations.get('esc-none' as typeof first.id)).toBeUndefined();
  });
});

describe('preferences', () => {
  it('defaults to the dark theme until something is saved', async () => {
    expect(await repos.preferences.get()).toEqual({ theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    expect(await repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } })).toEqual({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    expect(await repos.preferences.get()).toEqual({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    await repos.preferences.set({ theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
    expect(db.prepare('SELECT count(*) AS n FROM preference').get()).toEqual({ n: 1 });
  });

  it('refuses a theme the contract does not know', async () => {
    await expect(repos.preferences.set({ theme: 'sepia' } as unknown as UiPreferences)).rejects.toBeInstanceOf(InvalidRecordError);
  });
});

describe('owned processes', () => {
  const process = (pid: number, startedAt: string, extra: Partial<OwnedProcess> = {}): OwnedProcess => ({
    pid,
    startedAt: ts(startedAt),
    sessionId: SessionId.parse('s-plan-notes'),
    runtime: 'codex',
    kind: 'runtime-host',
    jobRef: `job-${pid}`,
    recordedAt: ts('2026-10-24T10:00:00+08:00'),
    ...extra,
  });

  it('lists what is recorded and not ended, and ends exactly the process whose PID and start both match', async () => {
    await repos.processes.record(process(100, '2026-10-24T09:00:00+08:00'));
    await repos.processes.record(process(100, '2026-10-24T09:30:00+08:00'));
    await repos.processes.record(process(200, '2026-10-24T09:10:00+08:00', { kind: 'command' }));
    expect((await repos.processes.listLive()).map((p) => p.pid)).toEqual([100, 100, 200]);

    // A reused PID: the end of the first process says nothing about the second.
    await repos.processes.markEnded(100, ts('2026-10-24T09:00:00+08:00'), ts('2026-10-24T10:30:00+08:00'));
    expect((await repos.processes.listLive()).map((p) => [p.pid, p.startedAt])).toEqual([
      [100, '2026-10-24T09:30:00+08:00'],
      [200, '2026-10-24T09:10:00+08:00'],
    ]);
    await repos.processes.markEnded(999, ts('2026-10-24T09:00:00+08:00'), ts('2026-10-24T10:30:00+08:00'));
    expect(await repos.processes.listLive()).toHaveLength(2);
  });

  it('matches a start time written with another offset, and never revives an ended process', async () => {
    const original = process(300, '2026-10-24T09:00:00+08:00');
    await repos.processes.record(original);
    await repos.processes.markEnded(300, ts('2026-10-24T01:00:00+00:00'), ts('2026-10-24T02:00:00+00:00'));
    expect(await repos.processes.listLive()).toEqual([]);
    await repos.processes.record(original);
    expect(await repos.processes.listLive()).toEqual([]);
  });

  it('tells apart processes created less than a millisecond apart, and ends only the one named', async () => {
    await repos.processes.record(process(500, '2026-10-24T00:00:00.123100Z'));
    await repos.processes.record(process(500, '2026-10-24T00:00:00.123900Z'));
    expect((await repos.processes.listLive()).map((p) => p.startedAt)).toEqual(['2026-10-24T00:00:00.123100Z', '2026-10-24T00:00:00.123900Z']);
    await repos.processes.markEnded(500, ts('2026-10-24T00:00:00.123100Z'), ts('2026-10-24T01:00:00Z'));
    expect((await repos.processes.listLive()).map((p) => p.startedAt)).toEqual(['2026-10-24T00:00:00.123900Z']);
  });

  it('treats the same instant as one process however it is written', async () => {
    await repos.processes.record(process(600, '2026-10-24T08:00:00.1231+08:00'));
    await repos.processes.record(process(600, '2026-10-24T00:00:00.123100Z'));
    expect(await repos.processes.listLive()).toHaveLength(1);
    await repos.processes.markEnded(600, ts('2026-10-24T00:00:00.12310Z'), ts('2026-10-24T01:00:00Z'));
    expect(await repos.processes.listLive()).toEqual([]);
    // Whole seconds with and without a zero fraction, and an offset without a colon, are the same instant too.
    await repos.processes.record(process(601, '2026-10-24T09:00:00.000+09:00'));
    await repos.processes.markEnded(601, ts('2026-10-24T00:00:00Z'), ts('2026-10-24T01:00:00Z'));
    expect(await repos.processes.listLive()).toEqual([]);
  });

  it('records a process that already ended as not live, and returns the record unchanged', async () => {
    const live = process(400, '2026-10-24T09:00:00+08:00', { endedAt: undefined });
    await repos.processes.record(live);
    expect(await repos.processes.listLive()).toEqual([live]);
    expect(OwnedProcess.parse((await repos.processes.listLive())[0])).toEqual(live);
    await repos.processes.record(process(401, '2026-10-24T09:00:00+08:00', { endedAt: ts('2026-10-24T09:05:00+08:00') }));
    expect((await repos.processes.listLive()).map((p) => p.pid)).toEqual([400]);
  });
});

describe('snapshot data and reopening', () => {
  const seedEverything = async () => {
    for (const a of fx.agents) await repos.agents.save(a, null);
    for (const w of fx.workflows) await repos.workflows.save(w, null);
    await seedConversations();
    for (const e of fx.escalations) await repos.escalations.upsert(e);
    await repos.preferences.set({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
  };

  it('reads everything the Snapshot takes from these repositories in one go', async () => {
    await seedEverything();
    const data = await repos.readSnapshotData();
    expect(data.agents).toEqual(fx.agents.map((a) => ({ ...a, revision: 0 })));
    expect(data.workflows).toEqual(fx.workflows.map((w) => ({ ...w, revision: 0 })));
    expect(byId(data.sessions)).toEqual(byId(fx.sessions));
    expect(byId(data.conversations.messages)).toEqual(byId(fx.messages));
    expect(byId(data.conversations.turns)).toEqual(byId(fx.turns));
    expect(byId(data.conversations.items)).toEqual(byId(fx.items));
    expect(byId(data.conversations.nativeTasks)).toEqual(byId(fx.nativeTasks));
    expect(byId(data.conversations.permissionRequests)).toEqual(byId(fx.permissionRequests));
    expect(byId(data.conversations.artifacts)).toEqual(byId(fx.artifacts));
    expect(byId(data.escalations)).toEqual(byId(fx.escalations));
    expect(data.preferences).toEqual({ theme: 'light', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } });
  });

  it('returns defaults and empty lists from an empty database', async () => {
    expect(await repos.readSnapshotData()).toEqual({
      agents: [],
      workflows: [],
      sessions: [],
      conversations: { turns: [], messages: [], items: [], nativeTasks: [], permissionRequests: [], artifacts: [] },
      escalations: [],
      preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } },
      instances: [],
      handoffs: [],
      peerMessages: [],
      transfers: [],
      projects: [],
      historyPages: [],
    });
  });

  it('has everything again after the database is closed and opened', async () => {
    await seedEverything();
    const big = { ...(fx.messages[0] as Message), id: 'm-big' as Message['id'], text: 'x'.repeat(5000) };
    await repos.conversations.appendMessage(big);
    await repos.processes.record({ pid: 7, startedAt: ts('2026-10-24T09:00:00+08:00'), sessionId: SessionId.parse('s-plan-notes'), runtime: 'claude', kind: 'helper', jobRef: 'j', recordedAt: ts('2026-10-24T09:00:01+08:00') });
    const before = await repos.readSnapshotData();
    const live = await repos.processes.listLive();
    db.close();

    db = openDatabase(path);
    repos = createRepositories(db, { blobThresholdBytes: 100 });
    expect(await repos.readSnapshotData()).toEqual(before);
    expect(await repos.processes.listLive()).toEqual(live);
    // And it still edits: the revision a reader saw before the restart is still the current one.
    const [first] = before.agents;
    if (first === undefined) throw new Error('no agent');
    expect(await repos.agents.save({ ...first, name: '重開後' }, first.revision)).toMatchObject({ status: 'saved' });
  });
});

describe('damaged data', () => {
  it('names the table and the failed rules but never the stored content', async () => {
    await repos.agents.save(fx.agents[0] as AgentDefinition, null);
    // Text that is not JSON.
    db.prepare('UPDATE agent SET body = ?').run('{"instructions": "密碼是 hunter2"');
    const notJson = await repos.agents.list().catch((e: unknown) => e);
    expect(notJson).toBeInstanceOf(StoredDataError);
    expect((notJson as Error).message).toMatch(/agent/);
    expect((notJson as Error).message).not.toContain('hunter2');

    // JSON of the wrong shape, with a secret as a value, a key and an enum value.
    db.prepare('UPDATE agent SET body = ?').run(JSON.stringify({ id: 'a', revision: 0, 'hunter2-key': 1, name: 42, instructions: 'hunter2' }));
    const wrongShape = await repos.agents.get((fx.agents[0] as AgentDefinition).id).catch((e: unknown) => e);
    expect(wrongShape).toBeInstanceOf(StoredDataError);
    expect((wrongShape as StoredDataError).problems.length).toBeGreaterThan(0);
    expect(JSON.stringify([(wrongShape as Error).message, (wrongShape as StoredDataError).problems])).not.toContain('hunter2');
    expect((wrongShape as Error).cause).toBeUndefined();
  });

  it('notices a body whose revision disagrees with its row', async () => {
    await repos.agents.save(fx.agents[0] as AgentDefinition, null);
    db.prepare('UPDATE agent SET revision = 9').run();
    await expect(repos.agents.list()).rejects.toBeInstanceOf(StoredDataError);
  });

  it('names a broken cross-field rule by its code', async () => {
    const turn = fx.turns[0];
    if (turn === undefined) throw new Error('fixture has no turn');
    await repos.sessions.create(fx.sessions.find((s) => s.id === turn.sessionId) as LogicalSession);
    await repos.conversations.upsertTurn(turn);
    db.prepare('UPDATE turn SET body = ?').run(JSON.stringify({ ...turn, state: 'completed' })); // completed without endedAt
    const error = await repos.conversations.get(turn.sessionId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoredDataError);
    expect((error as StoredDataError).problems).toContain('$:turn.ended-at');
  });
});

describe('upgrading from the T007 schema', () => {
  it('adds the tables to a version-1 database and keeps its delivery records', async () => {
    const v1 = join(dir, 'v1.sqlite');
    const old = new DatabaseSync(v1);
    old.exec('PRAGMA journal_mode = WAL');
    old.exec('PRAGMA foreign_keys = ON');
    const first = MIGRATIONS[0];
    if (first === undefined) throw new Error('no migrations');
    expect(migrate(old, [first])).toBe(1);
    // Seed the historical schema as its writer did; the current writer requires v4.
    const input = payloadInput();
    const body = { payload: input.payload, context: input.context };
    old.prepare(`INSERT INTO delivery (operation_id, kind, source_call_ref, payload_hash, proposal_revision,
      accepted_target, target, body, state, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(input.operationId, input.kind, input.sourceCallRef!, input.payloadHash, input.proposalRevision,
        canonicalJson(input.target), canonicalJson(input.target), canonicalJson(body), input.at);
    old.prepare('INSERT INTO receive_admission (operation_id, count_key) VALUES (?, ?)').run(input.operationId, input.counts![0]!.key);
    const before = { operationId: input.operationId, kind: input.kind, sourceCallRef: input.sourceCallRef,
      payloadHash: input.payloadHash, proposalRevision: input.proposalRevision, target: input.target, ...body,
      delivery: { state: 'pending', attempts: [] }, acceptedAt: input.at };
    old.close();

    const upgraded = openDatabase(v1);
    try {
      expect(upgraded.prepare('SELECT max(version) AS v FROM schema_migration').get()).toEqual({ v: latestVersion() });
      expect(upgraded.prepare('SELECT version FROM schema_migration ORDER BY version').all().map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(await new SqliteDeliveryStore(upgraded).get(op('op-1'))).toEqual(before);
      const upgradedRepos = createRepositories(upgraded);
      await upgradedRepos.agents.save(fx.agents[0] as AgentDefinition, null);
      expect((await upgradedRepos.readSnapshotData()).agents).toHaveLength(1);
    } finally {
      upgraded.close();
    }
  });
});

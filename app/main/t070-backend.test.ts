// T070 on the assembled backend with a real SQLite file in a temporary directory: the template library through the IPC
// parse and the read-only gate (C-29). A first start still adds only the starter set and never the library's templates;
// a library template is added alone, once, again after a delete, never over an edited Agent, and announced on the bus.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Command,
  type CommandResult,
  type OwnedProcess,
  RequestId,
  type Runtime,
  type SessionId,
  Snapshot,
  BUILTIN_AGENT_IDS,
  BUILTIN_WORKFLOW_IDS,
  STARTER_AGENT_IDS,
  STARTER_WORKFLOW_ID,
} from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { InjectedStorageFaults } from '../../adapters/storage/testing/storage-faults';
import { MIGRATIONS, migrate } from '../../adapters/storage/migrations';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { runCommand } from './app-ipc';
import { type Backend, type BackendProcessHost, startBackend, STORAGE_READ_ONLY } from './backend';
import { EventBus } from './event-bus';

let dir: string;
let running: Backend[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t070-'));
});
afterEach(async () => {
  for (const backend of running) await backend.shutdown().catch(() => undefined);
  running = [];
  // Only the temporary directory this test made.
  rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BackendProcessHost {
  openJob(sessionId: SessionId) {
    return Promise.resolve({ sessionId, jobRef: `job-${sessionId}` });
  }
  closeJob() {
    return Promise.resolve({ ended: [] as OwnedProcess[] });
  }
  listOwned() {
    return Promise.resolve([] as OwnedProcess[]);
  }
  cleanupOrphans(records: readonly OwnedProcess[]) {
    return Promise.resolve({ ended: [] as OwnedProcess[], gone: [...records] });
  }
  spawn(): never {
    throw new Error('no process is started in these tests');
  }
}

let requests = 0;
const rid = () => RequestId.parse(`r-${++requests}`);
const dbPath = () => join(dir, 'awg.sqlite');

const start = async (faults?: InjectedStorageFaults) => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((envelope) => {
    const e = envelope.event;
    if (e.type === 'agent.updated') events.push(`agent:${e.agent.id}`);
    if (e.type === 'workflow.updated') events.push(`workflow:${e.workflow.id}`);
  });
  const logs: string[] = [];
  const result = await startBackend({
    dbPath: dbPath(),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, _sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)),
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: ['high'], isDefault: true, hidden: false }]),
    ...(faults !== undefined && { storageHooks: faults }),
    autoArchive: false,
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  running.push(result);
  const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
  const snapshot = async () => Snapshot.parse(await result.facade.snapshot());
  const close = async () => {
    await result.shutdown();
    running = running.filter((b) => b !== result);
  };
  return { backend: result, events, logs, run, snapshot, close, raw: (command: unknown) => runCommand(result.facade, command) };
};

const starterIds = [STARTER_AGENT_IDS.plan, STARTER_AGENT_IDS.implement, STARTER_AGENT_IDS.review];
const tddAgents = Object.values(BUILTIN_AGENT_IDS.tdd);
const add = (template?: string) => ({ type: 'workflow.addStarter', requestId: rid(), ...(template !== undefined && { template }) });
/** The models are listed in the background after the start. */
const listed = async (s: Awaited<ReturnType<typeof start>>) => {
  for (let i = 0; i < 100 && (await s.snapshot()).modelOptions.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('T070 the template library on the backend', () => {
  it('a first start still adds only the starter set: none of the library\'s templates', async () => {
    const s = await start();
    const snapshot = await s.snapshot();
    expect(snapshot.workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    expect(snapshot.agents.map((a) => a.id)).toEqual(starterIds);
    await s.close();
    // Nor at the next start.
    const again = await start();
    expect((await again.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
  });

  it('an install in use gets nothing at start; a library template is added on request, with the models listed by then', async () => {
    const raw = new DatabaseSync(dbPath());
    migrate(raw, MIGRATIONS.slice(0, 14));
    const agent = fixtureSnapshotInput.agents[0]!;
    raw.prepare('INSERT INTO agent (id, revision, body) VALUES (?, ?, ?)').run(agent.id, agent.revision, JSON.stringify({ ...agent, schemaVersion: '0.11.0' }));
    raw.prepare('INSERT INTO app_marker (name, at) VALUES (?, ?)').run('starter-offered', '2026-11-06T00:00:00.000Z');
    raw.close();
    const s = await start();
    expect((await s.snapshot()).workflows).toEqual([]);
    await listed(s);
    expect(await s.raw(add('tdd'))).toMatchObject({ ok: true, revision: 0 });
    const after = await s.snapshot();
    expect(after.workflows.map((w) => w.id)).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
    expect(after.agents.map((a) => a.id).sort()).toEqual([agent.id, ...tddAgents].sort());
    expect(after.workflows[0]!.nodes.map((n) => (n.kind === 'agent' ? n.model : undefined))).toEqual([
      { runtime: 'claude', model: 'claude-m' },
      { runtime: 'claude', model: 'claude-m' },
      { runtime: 'codex', model: 'codex-m', effort: 'high' },
      { runtime: 'claude', model: 'claude-m' },
    ]);
  });

  it('adds only that template and its Agents, announced on the bus; a repeat adds and announces nothing', async () => {
    const s = await start();
    const from = s.events.length;
    expect(await s.raw(add('spec-parallel'))).toMatchObject({ ok: true, revision: 0 });
    const ids = Object.values(BUILTIN_AGENT_IDS['spec-parallel']);
    expect(s.events.slice(from).sort()).toEqual([...ids.map((id) => `agent:${id}`), `workflow:${BUILTIN_WORKFLOW_IDS['spec-parallel']}`].sort());
    const snapshot = await s.snapshot();
    expect(snapshot.workflows.map((w) => w.id).sort()).toEqual([STARTER_WORKFLOW_ID, BUILTIN_WORKFLOW_IDS['spec-parallel']].sort());
    expect(snapshot.agents).toHaveLength(3 + ids.length);
    const again = s.events.length;
    expect(await s.raw(add('spec-parallel'))).toMatchObject({ ok: true, revision: 0 });
    expect(s.events.slice(again)).toEqual([]);
    expect((await s.snapshot()).workflows).toHaveLength(2);
  });

  it('deleted by the user, it is added again; an edited Agent is kept; a restart changes nothing', async () => {
    const s = await start();
    await s.raw(add('tdd'));
    const verifier = (await s.snapshot()).agents.find((a) => a.id === BUILTIN_AGENT_IDS.tdd.verifier)!;
    expect(await s.run({ type: 'agent.save', requestId: rid(), agent: { ...verifier, instructions: '我的驗證方式' }, expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    expect(await s.run({ type: 'workflow.delete', requestId: rid(), workflowId: BUILTIN_WORKFLOW_IDS.tdd, expectedRevision: 0 })).toMatchObject({ ok: true });
    await s.close();
    const next = await start();
    // Not added back by a start.
    expect((await next.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    const from = next.events.length;
    expect(await next.raw(add('tdd'))).toMatchObject({ ok: true, revision: 0 });
    expect(next.events.slice(from)).toEqual([`workflow:${BUILTIN_WORKFLOW_IDS.tdd}`]);
    const snapshot = await next.snapshot();
    expect(snapshot.workflows.filter((w) => w.id === BUILTIN_WORKFLOW_IDS.tdd)).toHaveLength(1);
    expect(snapshot.agents.find((a) => a.id === BUILTIN_AGENT_IDS.tdd.verifier)).toMatchObject({ instructions: '我的驗證方式', revision: 1 });
  });

  it('the IPC parse: an unknown key or another field is refused; the 0.11 call is the starter set', async () => {
    const s = await start();
    expect(await s.raw(add('nope'))).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await s.raw({ ...add('tdd'), workflowId: BUILTIN_WORKFLOW_IDS.tdd })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await s.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    expect(await s.run({ type: 'workflow.delete', requestId: rid(), workflowId: STARTER_WORKFLOW_ID, expectedRevision: 0 })).toMatchObject({ ok: true });
    expect(await s.raw(add())).toMatchObject({ ok: true, revision: 0 });
    expect((await s.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
  });

  it('C-29: read-only data refuses it, adding nothing', async () => {
    const raw = new DatabaseSync(dbPath());
    migrate(raw);
    raw.exec("INSERT INTO schema_migration (version, name, applied_at) VALUES (9999, 'from-a-newer-app', 0)");
    raw.close();
    const s = await start();
    expect((await s.snapshot()).app).toMatchObject({ status: 'read-only' });
    expect(await s.run({ type: 'workflow.addStarter', requestId: rid(), template: 'tdd' })).toMatchObject({ ok: false, code: 'storage_read_only', message: STORAGE_READ_ONLY });
    expect((await s.snapshot()).workflows).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it('C-29: the data turning read-only refuses it before it reaches the core', async () => {
    const faults = new InjectedStorageFaults();
    const s = await start(faults);
    faults.failNextWrite('disk-full');
    expect(await s.run({ type: 'preferences.set', requestId: rid(), preferences: { theme: 'dark', supervisor: { idleCloseMinutes: 15, maxOpenRuntimes: 6 } } })).toMatchObject({ code: 'storage_read_only' });
    expect(await s.run({ type: 'workflow.addStarter', requestId: rid(), template: 'routing' })).toMatchObject({ ok: false, code: 'storage_read_only' });
    expect((await s.snapshot()).workflows.map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
  });
});

// The workflow engine assembled in the backend (T024): a real SQLite file, the real GUI MCP server reached
// over HTTP with each session's own token, and fake adapters. Runs the template flow plan → implement →
// review (sent back once) → implement → review → root, then a restart with a handoff still queued.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, type EventEnvelope, InstanceId, RequestId, type Runtime, SessionId, Snapshot, TurnId } from '../../contracts';
import type { McpMount, PermissionHandle } from '../../core/ports';
import { FakeAdapter } from '../../core/sessions/testing/fake-adapter';
import { agents, IMPL, PLAN, REVIEW, template, WORKFLOW } from '../../core/workflow/testing/harness';
import type { OwnedProcess } from '../../contracts';
import { type Backend, type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';
import { lastOf, stalledWindow } from './testing/stalled-window';

let dir: string;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t024-'));
});
afterEach(async () => {
  holding.clear();
  open.clear();
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
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
const INSTANCE = InstanceId.parse('run-main');
const ROOT = SessionId.parse('root-main');

interface Started {
  backend: Backend;
  bus: EventBus;
  envelopes: EventEnvelope[];
  adapters: FakeAdapter[];
  logs: string[];
  run(command: Command): Promise<CommandResult>;
}

/** Sessions whose turns stay running after a dispatch until the test ends them (r1-P2-3). */
const holding = new Set<string>();
const open = new Map<string, { adapter: FakeAdapter; turnId: string }>();
let turnIds = 0;

const emitTurn = (adapter: FakeAdapter, sessionId: SessionId, id: string, state: 'running' | 'completed') => {
  adapter.emit({ type: 'turn.updated', turn: { id: TurnId.parse(id), sessionId, state, startedAt: '2026-10-29T01:00:00.000Z', ...(state !== 'running' && { endedAt: '2026-10-29T01:00:01.000Z' }) } });
  adapter.emit({ type: 'session.activity', sessionId, activity: state === 'running' ? 'running' : 'idle', at: '2026-10-29T01:00:00.000Z' });
};

/** A dispatch that starts a turn, as the runtimes do: it runs, then completes unless its session is held. */
const withTurns = (adapter: FakeAdapter, codexSession?: SessionId): FakeAdapter => {
  const dispatch = adapter.dispatchOnce.bind(adapter);
  adapter.dispatchOnce = async (request) => {
    let result = await dispatch(request);
    const sessionId =
      codexSession ??
      [...adapter.started.map((o) => [o.preallocatedRef, o.sessionId] as const), ...adapter.resumed.map((o) => [o.nativeSessionRef, o.sessionId] as const)].find(([ref]) => ref === request.nativeSessionRef)?.[1];
    if (result.state === 'sent' && request.entry.kind === 'new-turn' && sessionId !== undefined) {
      const id = `turn-${String(++turnIds)}`;
      // The ack names the turn it started, as the real adapters' acks do (r2-P1-2).
      result = { ...result, nativeRef: { ...result.nativeRef, turnRef: id } };
      void Promise.resolve().then(() => {
        emitTurn(adapter, sessionId, id, 'running');
        if (holding.has(sessionId)) open.set(sessionId, { adapter, turnId: id });
        else emitTurn(adapter, sessionId, id, 'completed');
      });
    }
    return result;
  };
  return adapter;
};

const finishTurn = (sessionId: SessionId) => {
  const turn = open.get(sessionId);
  if (turn === undefined) throw new Error(`no open turn of ${sessionId}`);
  open.delete(sessionId);
  emitTurn(turn.adapter, sessionId, turn.turnId, 'completed');
};

const start = async (): Promise<Started> => {
  const logs: string[] = [];
  const adapters: FakeAdapter[] = [];
  const bus = new EventBus();
  const envelopes: EventEnvelope[] = [];
  bus.subscribe((e) => envelopes.push(e));
  let claude: FakeAdapter | undefined;
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      if (runtime === 'claude' && claude !== undefined) return claude;
      const adapter = withTurns(new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h)), runtime === 'codex' ? sessionId : undefined);
      if (runtime === 'claude') claude = adapter;
      adapters.push(adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => p,
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  return { backend: result, bus, envelopes, adapters, logs, run: (command) => result.facade.execute(command) as Promise<CommandResult> };
};

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** The MCP mount a session got at its latest start or resume, as its runtime would use it. */
const mountOf = (s: Started, sessionId: SessionId): McpMount => {
  const opened = s.adapters.flatMap((a) => [...a.started, ...a.resumed]).filter((o) => o.sessionId === sessionId);
  const mount = opened.at(-1)?.mcp;
  if (mount === undefined) throw new Error(`no mount for ${sessionId}`);
  return mount;
};

/** Calls a GUI tool as the session's runtime would: over HTTP, with its own bearer token. */
const call = async (s: Started, sessionId: SessionId, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const mount = mountOf(s, sessionId);
  const client = new Client({ name: 'node', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mount.url), { requestInit: { headers: { Authorization: `Bearer ${mount.token}` } } }));
  clients.push(client);
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? 'null') as Record<string, unknown>;
};

const snapshot = async (s: Started) => Snapshot.parse(await s.backend.facade.snapshot());

const prepare = async (s: Started) => {
  for (const a of agents()) expect(await s.run({ type: 'agent.save', requestId: rid(), agent: a, expectedRevision: null })).toMatchObject({ ok: true });
  expect(await s.run({ type: 'workflow.save', requestId: rid(), workflow: template({}), expectedRevision: null })).toMatchObject({ ok: true });
};

const startRun = (s: Started) =>
  s.run({ type: 'workflow.start', requestId: rid(), instanceId: INSTANCE, rootSessionId: ROOT, workflowId: WORKFLOW, workflowRevision: 0, title: 'Login page', workFolder: dir, projectFolder: dir, firstMessage: 'Plan a login page.', crossToolConsent: true });

const nodeSession = async (s: Started, nodeId: string) => {
  const snap = await snapshot(s);
  const found = snap.sessions.find((x) => x.kind === 'workflow' && x.workflow.nodeId === nodeId);
  if (found === undefined) throw new Error(`no session of ${nodeId}`);
  return found.id;
};

const databaseBytes = () =>
  readdirSync(dir)
    .filter((f) => f.startsWith('awg.sqlite'))
    .map((f) => readFileSync(join(dir, f)).toString('latin1'))
    .join('\n');

describe('the workflow engine in the backend (T024)', () => {
  it('runs the template flow through the GUI MCP server, counting rework on a real SQLite file', async () => {
    const s = await start();
    await prepare(s);
    expect(await startRun(s)).toMatchObject({ ok: true });
    await settle();

    expect(await call(s, ROOT, 'handoff', { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'Build the form.' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
    const impl = await nodeSession(s, IMPL);
    expect(await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, content: 'Form built.' })).toMatchObject({ status: 'accepted' });
    const review = await nodeSession(s, REVIEW);
    expect(await call(s, review, 'handoff', { ruleId: 'rework', target: { kind: 'node', nodeId: IMPL }, content: 'Validate the email.' })).toMatchObject({ status: 'accepted' });
    expect(await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, content: 'Validation added.' })).toMatchObject({ status: 'accepted' });
    expect(await call(s, review, 'handoff', { ruleId: 'done', target: { kind: 'root' }, content: 'Approved.' })).toMatchObject({ status: 'accepted' });
    // Not connected: implement has no edge to plan. create_tasks needs a tasks rule of root, which this template has not (T032).
    expect(await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: PLAN }, content: 'x' })).toMatchObject({ status: 'rejected', rejection: { reason: 'not-connected' } });
    expect(await call(s, ROOT, 'create_tasks', { ruleId: 'split', tasks: [{ key: 'a', title: 'A' }] })).toMatchObject({ status: 'rejected', rejection: { reason: 'no-matching-rule' } });

    const snap = await snapshot(s);
    const [instance] = snap.instances;
    expect(instance).toMatchObject({ id: INSTANCE, workflowRevision: 0, rootSessionId: ROOT, template: { reworkLimit: 2 } });
    expect(instance?.crossToolConsentAt).toBeDefined();
    // One loop is one rework (T064): the second review adds nothing.
    expect(instance?.tasks[0]).toMatchObject({ reworkCount: 1, currentNodeId: PLAN });
    expect(snap.handoffs.map((h) => [h.fromNodeId, h.toNodeId, h.rework, h.delivery.state])).toEqual([
      [PLAN, IMPL, false, 'sent'],
      [IMPL, REVIEW, false, 'sent'],
      [REVIEW, IMPL, true, 'sent'],
      [IMPL, REVIEW, false, 'sent'],
      [REVIEW, PLAN, false, 'sent'],
    ]);
    // One session per (node, task): three sessions, implement and review reused for the rework.
    expect(snap.sessions.filter((x) => x.kind === 'workflow').map((x) => x.id).sort()).toEqual([ROOT, impl, review].sort());
    const codex = s.adapters.filter((a) => a.runtime === 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]?.started).toHaveLength(1);
    expect(codex[0]?.dispatched.map((d) => d.origin?.kind)).toEqual(['handoff', 'handoff']);
    expect(s.envelopes.some((e) => e.event.type === 'handoff.updated')).toBe(true);
    // No token in the database or the log (C-07).
    const tokens = s.adapters.flatMap((a) => [...a.started, ...a.resumed]).flatMap((o) => (o.mcp === undefined ? [] : [o.mcp.token]));
    expect(tokens.length).toBeGreaterThan(0);
    const bytes = databaseBytes();
    for (const token of tokens) {
      expect(bytes).not.toContain(token);
      expect(s.logs.join('\n')).not.toContain(token);
      expect(JSON.stringify(s.envelopes)).not.toContain(token);
    }
    await s.backend.shutdown();
  });

  it('T040: a window let go during the run (event-overflow) finds every handoff and escalation it was not sent in the Snapshot it reads next', async () => {
    const s = await start();
    await prepare(s);
    const window = stalledWindow(s.bus, 6);
    expect(await startRun(s)).toMatchObject({ ok: true });
    await settle();
    expect(await call(s, ROOT, 'handoff', { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'Build the form.' })).toMatchObject({ status: 'accepted' });
    const impl = await nodeSession(s, IMPL);
    expect(await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, content: 'Form built.' })).toMatchObject({ status: 'accepted' });
    const review = await nodeSession(s, REVIEW);
    expect(await call(s, review, 'handoff', { ruleId: 'rework', target: { kind: 'node', nodeId: IMPL }, content: 'Validate the email.' })).toMatchObject({ status: 'accepted' });
    expect(await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, content: 'Validation added.' })).toMatchObject({ status: 'accepted' });
    expect(await call(s, review, 'handoff', { ruleId: 'done', target: { kind: 'root' }, content: 'Approved.' })).toMatchObject({ status: 'accepted' });
    await settle();
    expect(window.batcher.stats.overflows).toBeGreaterThanOrEqual(1);
    const missed = window.missed(s.envelopes);
    const handoffs = lastOf(missed, 'handoff.updated', (e) => e.handoff);
    const turnsEnded = lastOf(missed, 'turn.updated', (e) => e.turn).filter((t) => t.state !== 'running');
    expect(handoffs.length).toBeGreaterThan(0);
    expect(turnsEnded.length).toBeGreaterThan(0);
    // It reads the Snapshot (cut first, as the IPC handler does): each one it missed, as last published.
    window.batcher.cut();
    const snap = await snapshot(s);
    for (const h of handoffs) expect(snap.handoffs.find((x) => x.id === h.id)).toEqual(h);
    for (const t of turnsEnded) expect(snap.turns.find((x) => x.id === t.id && x.sessionId === t.sessionId)).toEqual(t);
    for (const e of lastOf(missed, 'escalation.updated', (x) => x.escalation)) expect(snap.escalations.find((x) => x.id === e.id)).toEqual(e);
    window.stop();
    await s.backend.shutdown();
  });

  it('after a restart, two handoffs queued for a busy target go one per turn and the run is rebuilt from storage', async () => {
    const s = await start();
    await prepare(s);
    await startRun(s);
    await settle();
    await call(s, ROOT, 'handoff', { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'Build the form.' });
    const impl = await nodeSession(s, IMPL);
    await call(s, impl, 'handoff', { ruleId: 'to-review', target: { kind: 'node', nodeId: REVIEW }, content: 'Form built.' });
    const review = await nodeSession(s, REVIEW);
    // Implement is busy in its own turn: the formal handoff waits for it (SP-05).
    const codex = s.adapters.find((a) => a.runtime === 'codex')!;
    codex.emit({ type: 'turn.updated', turn: { id: TurnId.parse('t-busy'), sessionId: impl, state: 'running', startedAt: '2026-10-29T01:00:00.000Z' } });
    codex.emit({ type: 'session.activity', sessionId: impl, activity: 'running', at: '2026-10-29T01:00:00.000Z' });
    await settle();
    expect(await call(s, review, 'handoff', { ruleId: 'rework', target: { kind: 'node', nodeId: IMPL }, content: 'Validate the email.' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
    expect(await call(s, ROOT, 'handoff', { ruleId: 'to-impl', target: { kind: 'node', nodeId: IMPL }, content: 'Also add a logo.' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
    expect(codex.dispatched).toHaveLength(1);
    await s.backend.shutdown();
    holding.add(impl);

    const again = await start();
    await settle();
    const resumed = again.adapters.find((a) => a.runtime === 'codex');
    expect(resumed?.resumed.map((r) => r.sessionId)).toEqual([impl]);
    // The oldest only; its turn runs (held), so the other waits for it (SP-05, r1-P1-2).
    expect(resumed?.dispatched).toHaveLength(1);
    expect(resumed?.dispatched[0]).toMatchObject({ origin: { kind: 'handoff', fromSessionId: review }, entry: { kind: 'new-turn' } });
    let snap = await snapshot(again);
    expect(snap.handoffs.slice(-2).map((h) => [h.fromNodeId, h.rework, h.delivery.state])).toEqual([
      [REVIEW, true, 'sent'],
      [PLAN, true, 'pending'],
    ]);
    finishTurn(impl);
    await settle();
    expect(resumed?.dispatched.map((d) => (d.origin?.kind === 'handoff' ? d.origin.fromSessionId : ''))).toEqual([review, ROOT]);
    snap = await snapshot(again);
    expect(snap.handoffs.at(-1)?.delivery.state).toBe('sent');
    expect(snap.instances[0]?.tasks[0]).toMatchObject({ reworkCount: 2, currentNodeId: IMPL });
    await again.backend.shutdown();
  });
});

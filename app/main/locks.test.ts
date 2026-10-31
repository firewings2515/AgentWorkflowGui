// T033 (R-07) in the assembled backend: two same-folder sessions on a real file, the Snapshot's `locks` and
// the `locks.updated` event, `wait_for_file` over the GUI MCP server, the folder watcher's unlocked-write
// check, and the synchronous file hash. Fake adapters; no runtime is started.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Command, type CommandResult, type EventEnvelope, type OwnedProcess, RequestId, type Runtime, SessionId, Snapshot } from '../../contracts';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter, permissionRequest } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { type Backend, type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';
import { hashFile } from './file-hash';

let dir: string;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t033-'));
});
afterEach(async () => {
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

let n = 0;
const rid = () => RequestId.parse(`t033-${++n}`);

const start = async () => {
  const adapters = new Map<string, FakeAdapter>();
  const envelopes: EventEnvelope[] = [];
  const watchers: ((event: string, filename: string | null) => void)[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => envelopes.push(e));
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus,
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.set(sessionId, adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => p,
    watch: (_root, listener) => {
      watchers.push(listener);
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as never;
    },
    log: () => undefined,
  });
  if (result.status !== 'ready') throw new Error('backend not ready');
  const backend: Backend = result;
  const run = (command: Command) => backend.facade.execute(command) as Promise<CommandResult>;
  await run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
  return { backend, adapters, envelopes, watchers, run };
};

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

type Started = Awaited<ReturnType<typeof start>>;

const create = async (s: Started, id: string) => {
  const sessionId = SessionId.parse(id);
  await s.run({ type: 'session.create', requestId: rid(), sessionId, kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: dir });
  await settle();
  return sessionId;
};

/** Codex's item/started for patch-1, which comes before its approval request (SP-06 W2). */
const announce = (s: Started, sessionId: SessionId, file: string) =>
  s.adapters.get(sessionId)!.emit({
    type: 'item.updated',
    item: { id: 'patch-1' as never, sessionId, turnId: 'turn-a' as never, kind: 'fileChange', changes: [{ path: file, change: 'update' }], state: 'proposed', startedAt: '2026-10-31T00:00:00.000Z' },
  });

const callWait = async (s: Started, sessionId: SessionId, path: string) => {
  const mount = s.adapters.get(sessionId)!.started.at(-1)!.mcp!;
  const client = new Client({ name: 'node', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mount.url), { requestInit: { headers: { Authorization: `Bearer ${mount.token}` } } }));
  clients.push(client);
  const result = await client.callTool({ name: 'wait_for_file', arguments: { path } });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? 'null') as Record<string, unknown>;
};

describe('same-folder locks in the backend (R-07)', () => {
  it('shows the lock in the Snapshot and in locks.updated, and wait_for_file returns once it frees', async () => {
    const s = await start();
    const file = join(dir, 'shared.txt');
    writeFileSync(file, 'line 1\n');
    const a = await create(s, 'session-a');
    const b = await create(s, 'session-b');
    announce(s, a, file);
    const held = s.adapters.get(a)!.ask(permissionRequest(a, { kind: 'fileChange', itemId: 'patch-1' as never, turnId: 'turn-a' as never, summary: 'patch', paths: [file] }));
    await settle();
    expect(held.decision).toMatchObject({ outcome: 'approve' });
    const key = file.toLowerCase();
    expect(Snapshot.parse(await s.backend.facade.snapshot()).locks).toEqual([expect.objectContaining({ path: key, holderSessionId: a, writing: 1 })]);
    expect(s.envelopes.filter((e) => e.event.type === 'locks.updated').at(-1)?.event).toMatchObject({ locks: [{ path: key, holderSessionId: a }] });

    const waiting = callWait(s, b, 'shared.txt');
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Snapshot.parse(await s.backend.facade.snapshot()).locks[0]!.waiters).toEqual([expect.objectContaining({ sessionId: b, via: 'wait_for_file' })]);
    s.adapters.get(a)!.emit({ type: 'turn.updated', turn: { id: 'turn-a' as never, sessionId: a, state: 'completed', startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:00:01.000Z' } });
    expect(await waiting).toEqual({ status: 'free' });
    expect(Snapshot.parse(await s.backend.facade.snapshot()).locks).toEqual([]);
    await s.backend.shutdown();
  });

  it("escalates a change of a locked file the holder did not write, seen by the folder watcher", async () => {
    const s = await start();
    const file = join(dir, 'shared.txt');
    writeFileSync(file, 'line 1\n');
    const a = await create(s, 'session-a');
    announce(s, a, file);
    s.adapters.get(a)!.ask(permissionRequest(a, { kind: 'fileChange', itemId: 'patch-1' as never, turnId: 'turn-a' as never, summary: 'patch', paths: [file] }));
    await settle();
    // The patch fails: nothing of A's was applied, and a shell then writes the file.
    s.adapters.get(a)!.emit({
      type: 'item.updated',
      item: { id: 'patch-1' as never, sessionId: a, turnId: 'turn-a' as never, kind: 'fileChange', changes: [{ path: file, change: 'update' }], state: 'failed', startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:00:01.000Z' },
    });
    writeFileSync(file, 'written by a shell\n');
    for (const w of s.watchers) w('change', 'shared.txt');
    await settle();
    const escalation = Snapshot.parse(await s.backend.facade.snapshot()).escalations.find((e) => e.kind === 'unlocked-write');
    expect(escalation).toMatchObject({ state: 'open', ref: { kind: 'lock', path: file.toLowerCase(), holderSessionId: a } });
    await s.backend.shutdown();
  });
});

describe('hashFile', () => {
  it('hashes a file, and tells a missing path from one it cannot read', () => {
    const file = join(dir, 'x.txt');
    writeFileSync(file, 'abc');
    expect(hashFile(file)).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashFile(join(dir, 'missing.txt'))).toBe('missing');
    expect(hashFile(dir)).toBe('directory');
  });
});

describe('hashFile size limit', () => {
  it('does not read a file above the limit: it counts as unreadable', () => {
    const fs = { size: () => ({ size: 11, isFile: true }), read: () => Buffer.from('never read') };
    expect(hashFile('E:\\big.bin', fs, 10)).toBe('unreadable');
    expect(hashFile('E:\\ok.bin', { ...fs, size: () => ({ size: 10, isFile: true }) }, 10)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

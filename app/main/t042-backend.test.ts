// T042 (V-04, V-18): the assembled backend on a real SQLite file and a real mkdtemp folder, with fake runtimes.
// An out-of-scope request is HELD by the backend (the runtime gets no answer until the user decides), whatever
// the UI shows; attachments are refused before anything is read; a command changes only the target it names;
// and what goes back to the renderer never carries a path or a token from the input.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Command,
  type CommandResult,
  EscalationId,
  MessageId,
  NativeTaskId,
  type OwnedProcess,
  type PermissionRequest,
  RequestId,
  type Runtime,
  SessionId,
  Snapshot,
} from '../../contracts';
import type { PermissionHandle } from '../../core/ports';
import { FakeAdapter, permissionRequest } from '../../core/sessions/testing/fake-adapter';
import { agent } from '../../core/sessions/testing/harness';
import { runCommand } from './app-ipc';
import { type BackendProcessHost, startBackend } from './backend';
import { EventBus } from './event-bus';
import { handleFolderRequest } from './folders';
import { realFolder } from './exe-search';
import { resolveRealPath } from './real-path';

const hashed = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('./file-hash', async (original) => {
  const actual = await original<typeof import('./file-hash')>();
  return {
    ...actual,
    hashFile: (path: string) => {
      hashed.paths.push(path);
      return actual.hashFile(path);
    },
  };
});

let dir = '';
let ws = '';
let far = '';
const SECRET_PATH_TEXT = 'C:\\Users\\someone\\secret-folder';
const TOKEN_TEXT = 'Bearer sk-live-0123456789abcdef';

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'awg-t042-backend-')));
  ws = join(dir, 'ws');
  far = join(dir, 'far');
  mkdirSync(ws);
  mkdirSync(join(far, 'deep'), { recursive: true });
  writeFileSync(join(far, 'x.txt'), 'OUTSIDE');
  writeFileSync(join(ws, 'a.txt'), 'INSIDE');
  writeFileSync(join(dir, 'not-a-folder.cmd'), '@echo off');
  symlinkSync(join(far, 'deep'), join(ws, 'link'), 'junction');
  hashed.paths.length = 0;
});
afterEach(() => {
  if (/awg-t042-backend-[A-Za-z0-9]+$/.test(dir)) rmSync(dir, { recursive: true, force: true });
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
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

const start = async () => {
  const adapters = new Map<string, FakeAdapter>();
  const logs: string[] = [];
  const result = await startBackend({
    dbPath: join(dir, 'awg.sqlite'),
    bus: new EventBus(),
    createHost: () => new FakeHost(),
    createAdapter: (runtime: Runtime, sessionId, hooks: { onPermissionRequest(h: PermissionHandle): unknown }) => {
      const adapter = new FakeAdapter(runtime, (h) => hooks.onPermissionRequest(h));
      adapters.set(sessionId, adapter);
      return adapter;
    },
    listModels: (runtime: Runtime) => Promise.resolve([{ runtime, model: `${runtime}-m`, displayName: 'M', efforts: [], isDefault: true, hidden: false }]),
    resolveRealPath: (p) => resolveRealPath(p),
    watch: () => {
      const watcher = { close: () => undefined, on: () => watcher };
      return watcher as unknown as ReturnType<NonNullable<Parameters<typeof startBackend>[0]['watch']>>;
    },
    log: (message) => logs.push(message),
  });
  if (result.status !== 'ready') throw new Error(`backend not ready: ${result.reason}`);
  const run = (command: Command) => result.facade.execute(command) as Promise<CommandResult>;
  const snapshot = async () => Snapshot.parse(await result.facade.snapshot());
  const create = async (id: string, runtime: Runtime, cwd = ws) => {
    const r = await run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse(id), kind: 'ordinary', agentId: agent().id, model: { runtime, model: `${runtime}-m` }, cwd });
    await settle();
    return r;
  };
  await run({ type: 'agent.save', requestId: rid(), agent: agent(), expectedRevision: null });
  return { backend: result, adapters, logs, run, snapshot, create };
};
type Started = Awaited<ReturnType<typeof start>>;

/** Asks through the session's runtime; the handle records whether and how the backend answered. */
const ask = async (s: Started, sessionId: string, extra: Partial<PermissionRequest>) => {
  const handle = s.adapters.get(sessionId)!.ask(permissionRequest(SessionId.parse(sessionId), { id: `perm-${++requests}` as PermissionRequest['id'], cwd: ws, ...extra }));
  await settle();
  return handle;
};
const codexCmd = (script: string) => `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command '${script}'`;

describe('T042: the backend itself holds an out-of-scope request until the user decides', () => {
  it('Codex: a read and a write outside the folder are held, the runtime gets no answer, and decline reaches it', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    const read = await ask(s, 'codex-a', { kind: 'command', command: codexCmd(`Get-Content ${join(far, 'x.txt')}`), summary: 'Run command' });
    const write = await ask(s, 'codex-a', { kind: 'fileChange', command: undefined, paths: [join(ws, 'link', 'n.txt')], summary: 'apply_patch' });
    const inside = await ask(s, 'codex-a', { kind: 'command', command: codexCmd('Get-Content a.txt'), summary: 'Run command' });
    expect(read.decision).toBeUndefined();
    expect(read.matchedRule).toBe('secret-read');
    expect(write.decision).toBeUndefined();
    expect(write.matchedRule).toBe('write-outside-scope');
    expect(inside.decision).toMatchObject({ outcome: 'approve', decidedBy: 'policy' });

    const open = (await s.snapshot()).escalations.filter((e) => e.state === 'open');
    expect(open.map((e) => e.rule).sort()).toEqual(['secret-read', 'write-outside-scope']);
    // The escalation shown to the user is fixed text: no path from the request.
    expect(JSON.stringify(open)).not.toContain(far.replaceAll('\\', '\\\\'));
    for (const e of open) expect((await s.run({ type: 'escalation.respond', requestId: rid(), escalationId: e.id, decision: 'decline' })).ok).toBe(true);
    expect(read.decision).toMatchObject({ outcome: 'decline', decidedBy: 'user' });
    expect(write.decision).toMatchObject({ outcome: 'decline', decidedBy: 'user' });
    await s.backend.shutdown();
  });

  it('Claude: Read through a junction, Write outside and `cat link/../x.txt` are held; nothing is approved by the policy', async () => {
    const s = await start();
    await s.create('claude-a', 'claude');
    const viaJunction = await ask(s, 'claude-a', { kind: 'permissions', tool: 'Read', command: undefined, paths: [join(ws, 'link', 'x.txt')], summary: 'Read', itemId: 'toolu_1' as never });
    const outside = await ask(s, 'claude-a', { kind: 'fileChange', tool: 'Write', command: undefined, paths: [join(far, 'w.txt')], summary: 'Write', itemId: 'toolu_2' as never });
    const dotdot = await ask(s, 'claude-a', { kind: 'command', tool: 'Bash', command: 'cat link/../x.txt', summary: 'Bash', itemId: 'toolu_3' as never });
    for (const h of [viaJunction, outside, dotdot]) {
      expect(h.decision).toBeUndefined();
      expect(h.holdState).toMatchObject({ reason: 'awaiting-user' });
    }
    expect([viaJunction.matchedRule, outside.matchedRule, dotdot.matchedRule]).toEqual(['secret-read', 'write-outside-scope', 'secret-read']);
    // A13: the lock's read hash is taken only after an approval; nothing outside was read for a held request.
    expect(hashed.paths.filter((p) => p.toLowerCase().includes(far.toLowerCase()))).toEqual([]);
    await s.backend.shutdown();
  });

  it('the root AI cannot answer: only escalation.respond does, and only once', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    const read = await ask(s, 'codex-a', { kind: 'command', command: codexCmd(`Get-Content ${join(far, 'x.txt')}`), summary: 'Run command' });
    const [e] = (await s.snapshot()).escalations.filter((x) => x.state === 'open');
    expect((await s.run({ type: 'escalation.respond', requestId: rid(), escalationId: e!.id, decision: 'decline' })).ok).toBe(true);
    const again = await s.run({ type: 'escalation.respond', requestId: rid(), escalationId: e!.id, decision: 'approve' });
    expect(again).toMatchObject({ ok: false, code: 'invalid_transition' });
    expect(read.decision?.outcome).toBe('decline');
    await s.backend.shutdown();
  });
});

describe('T042 A12: attachments outside the folder', () => {
  it('are refused before anything is stored, read, hashed or sent', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    const revision = (await s.snapshot()).sessions[0]!.revision;
    for (const path of [join(far, 'x.txt'), join(ws, 'link', 'x.txt'), `\\\\?\\${join(far, 'x.txt')}`, join(ws, 'a.txt')]) {
      for (const kind of ['file', 'image', 'folder'] as const) {
        const r = await s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('codex-a'), messageId: MessageId.parse(`m-${++requests}`), expectedRevision: revision, text: 'see attached', attachments: [{ kind, path, name: 'x.txt' }] });
        expect(r).toMatchObject({ ok: false, code: 'unsupported' });
        expect(JSON.stringify(r)).not.toContain('x.txt');
      }
    }
    expect(s.adapters.get('codex-a')!.dispatched).toEqual([]);
    expect((await s.snapshot()).messages).toEqual([]);
    expect(hashed.paths).toEqual([]);
    await s.backend.shutdown();
  });
});

describe('T042 D2: a command changes only the target it names (ownership)', () => {
  it('nativeTask.stop with another session’s sub-agent is not_found and stops nothing', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    await s.create('codex-b', 'codex');
    const b = SessionId.parse('codex-b');
    const task = { id: NativeTaskId.parse('task-b'), sessionId: b, runtime: 'codex' as const, parentRef: 'thread-1', nativeRef: 'child-b', label: 'worker', state: 'running' as const, background: false, startedAt: '2026-11-01T01:00:00.000Z' };
    s.adapters.get('codex-b')!.emit({ type: 'nativeTask.updated', task });
    await settle();
    const crossed = await s.run({ type: 'nativeTask.stop', requestId: rid(), sessionId: SessionId.parse('codex-a'), nativeTaskId: task.id });
    expect(crossed).toMatchObject({ ok: false, code: 'not_found' });
    expect(s.adapters.get('codex-a')!.stoppedTasks).toEqual([]);
    expect(s.adapters.get('codex-b')!.stoppedTasks).toEqual([]);
    await s.backend.shutdown();
  });

  it('delivery.resolve on a permission escalation is not_found, and the permission stays open for its own answer', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    const read = await ask(s, 'codex-a', { kind: 'command', command: codexCmd(`Get-Content ${join(far, 'x.txt')}`), summary: 'Run command' });
    const [e] = (await s.snapshot()).escalations.filter((x) => x.state === 'open');
    expect(await s.run({ type: 'delivery.resolve', requestId: rid(), escalationId: e!.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: false, code: 'not_found' });
    expect(read.decision).toBeUndefined();
    expect((await s.snapshot()).escalations.find((x) => x.id === e!.id)?.state).toBe('open');
    expect(await s.run({ type: 'escalation.respond', requestId: rid(), escalationId: EscalationId.parse('permission-nobody'), decision: 'approve' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(read.decision).toBeUndefined();
    await s.backend.shutdown();
  });

  it('a message ID already used in one session is refused in another (nothing written there)', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    await s.create('codex-b', 'codex');
    const snap = await s.snapshot();
    const rev = (id: string) => snap.sessions.find((x) => x.id === id)!.revision;
    expect((await s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('codex-a'), messageId: MessageId.parse('m-shared'), expectedRevision: rev('codex-a'), text: 'one', attachments: [] })).ok).toBe(true);
    await settle();
    const taken = await s.run({ type: 'session.send', requestId: rid(), sessionId: SessionId.parse('codex-b'), messageId: MessageId.parse('m-shared'), expectedRevision: rev('codex-b'), text: 'two', attachments: [] });
    expect(taken).toMatchObject({ ok: false, code: 'invalid_request' });
    expect((await s.snapshot()).messages.filter((m) => m.sessionId === 'codex-b')).toEqual([]);
    expect(s.adapters.get('codex-b')!.dispatched).toEqual([]);
    await s.backend.shutdown();
  });
});

describe('T042 F2: opening a "folder" never runs a file', () => {
  it('a session whose folder is a file: the explorer is not called', async () => {
    const s = await start();
    const file = join(dir, 'not-a-folder.cmd');
    await s.create('codex-file', 'codex', file);
    await s.create('codex-a', 'codex');
    const opened: string[] = [];
    const deps = {
      snapshot: () => s.snapshot(),
      dataFolder: dir,
      pickFolder: () => Promise.resolve(null),
      openPath: (p: string) => {
        opened.push(p);
        return Promise.resolve('');
      },
      realFolder: (p: string) => realFolder(p),
    };
    const onFile = await handleFolderRequest({ type: 'folder.open', requestId: 'r1', target: { kind: 'session-cwd', sessionId: 'codex-file' } }, deps);
    expect(onFile).toMatchObject({ ok: false, code: 'not_found' });
    expect(JSON.stringify(onFile)).not.toContain('not-a-folder');
    expect(await handleFolderRequest({ type: 'folder.open', requestId: 'r2', target: { kind: 'session-cwd', sessionId: 'codex-a' } }, deps)).toEqual({ ok: true, requestId: 'r2' });
    expect(opened).toEqual([ws]);
    await s.backend.shutdown();
  });
});

describe('T042 D3: what goes back to the renderer carries no path or token from the input', () => {
  it('failed commands answer fixed text', async () => {
    const s = await start();
    await s.create('codex-a', 'codex');
    const bad = `\\\\?\\${SECRET_PATH_TEXT} ${TOKEN_TEXT}`;
    const results = [
      await runCommand(s.backend.facade, { type: 'session.create', requestId: 'q1', sessionId: 'x-1', kind: 'ordinary', agentId: agent().id, model: { runtime: 'codex', model: 'codex-m' }, cwd: bad }),
      await runCommand(s.backend.facade, { type: 'session.create', requestId: 'q2', sessionId: 'x-2', kind: 'ordinary', agentId: SECRET_PATH_TEXT, model: { runtime: 'codex', model: 'codex-m' }, cwd: ws }),
      await runCommand(s.backend.facade, { type: 'session.send', requestId: 'q3', sessionId: 'nobody', messageId: 'm-q3', expectedRevision: 0, text: TOKEN_TEXT, attachments: [] }),
      await runCommand(s.backend.facade, { type: 'session.send', requestId: 'q4', sessionId: 'codex-a', messageId: 'm-q4', expectedRevision: 0, text: 'x', attachments: [{ kind: 'file', path: bad, name: TOKEN_TEXT }] }),
      await runCommand(s.backend.facade, { type: 'session.send', requestId: 'q5', sessionId: 'codex-a', messageId: 7, text: bad }),
      await runCommand(s.backend.facade, { type: 'no.such', requestId: 'q6', path: bad }),
      await runCommand({ snapshot: () => s.snapshot(), execute: () => Promise.reject(new Error(`ENOENT ${bad}`)) }, { type: 'preferences.set', requestId: 'q7', preferences: { theme: 'dark' } }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      const text = JSON.stringify(r);
      expect(text).not.toContain('someone');
      expect(text).not.toContain('sk-live');
      expect(text).not.toContain('Bearer');
    }
    expect(s.logs.join('\n')).not.toContain('sk-live');
    await s.backend.shutdown();
  });
});

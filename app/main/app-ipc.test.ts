import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandResult, EventBatch, QueryResult, Snapshot, type Command, type QueryRequest } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { BATCH_ACK_CHANNEL, BATCH_CHANNEL, COMMAND_CHANNEL, QUERY_CHANNEL, SNAPSHOT_CHANNEL, SNAPSHOT_READ_CHANNEL, WINDOW_REPORT_CHANNEL } from '../preload/channels';
import { QUERY_FAILED, readSnapshot, registerAppIpc, runCommand, runQuery, SNAPSHOT_UNAVAILABLE, UNKNOWN_REQUEST_ID, windowReport, type EventTarget } from './app-ipc';
import { EventBus } from './event-bus';
import type { AppFacade } from './facade';
import { createFakeFacade } from './testing/fake-facade';
import type { IpcSenderEvent, TrustedSender } from './ipc-guard';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, listener),
    removeListener: (channel: string) => electron.listeners.delete(channel),
  },
}));

const mainFrame = { url: 'http://localhost:5173/' };
const trusted: TrustedSender = { webContentsId: 7, isTrustedUrl: (url) => url.startsWith('http://localhost:5173/') };
const trustedEvent: IpcSenderEvent = { sender: { id: 7, mainFrame }, senderFrame: mainFrame };
const otherWindowEvent: IpcSenderEvent = { sender: { id: 8, mainFrame }, senderFrame: mainFrame };
const evilFrame = { url: 'https://example.com/' };
const evilPageEvent: IpcSenderEvent = { sender: { id: 7, mainFrame: evilFrame }, senderFrame: evilFrame };

const setPreferences = (requestId = 'req-1'): unknown => ({ type: 'preferences.set', requestId, preferences: { theme: 'light' } });

function setup(overrides: { facade?: AppFacade; target?: EventTarget | null } = {}) {
  const bus = new EventBus({ seq: fixtureSnapshot.seq });
  const facade = overrides.facade ?? createFakeFacade({ bus });
  const sent: { channel: string; batch: EventBatch }[] = [];
  const target: EventTarget | null =
    overrides.target === undefined
      ? { isDestroyed: () => false, getURL: () => 'http://localhost:5173/', send: (channel, batch) => sent.push({ channel, batch: EventBatch.parse(batch) }) }
      : overrides.target;
  const stop = registerAppIpc({
    facade,
    bus,
    getTrustedSender: () => trusted,
    getEventTarget: () => target,
    isTrustedUrl: (url) => trusted.isTrustedUrl(url),
    forwarding: { batchMs: 0, maxInFlight: 1 },
  });
  const call = (channel: string, event: unknown, ...args: unknown[]) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(event, ...args);
  };
  return { bus, facade, sent, stop, call };
}

beforeEach(() => {
  electron.handlers.clear();
  electron.listeners.clear();
});

/** Lets the batch timer (0 ms here) run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe('sender checks', () => {
  it.each([
    ['another window', otherWindowEvent],
    ['an untrusted page', evilPageEvent],
  ])('rejects snapshot and command calls from %s', (_name, event) => {
    const { call } = setup();
    expect(() => call(SNAPSHOT_CHANNEL, event)).toThrow(/untrusted sender/);
    expect(() => call(COMMAND_CHANNEL, event, setPreferences())).toThrow(/untrusted sender/);
    expect(() => call(QUERY_CHANNEL, event, { type: 'backup.list', requestId: 'q' })).toThrow(/untrusted sender/);
  });

  it('does not run the command when the sender is rejected', () => {
    const execute = vi.fn();
    const { call } = setup({ facade: { snapshot: () => fixtureSnapshot, execute } });
    expect(() => call(COMMAND_CHANNEL, otherWindowEvent, setPreferences())).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects everything while there is no trusted window', () => {
    const bus = new EventBus();
    registerAppIpc({ facade: createFakeFacade({ bus }), bus, getTrustedSender: () => null, getEventTarget: () => null, isTrustedUrl: () => true });
    const handler = electron.handlers.get(SNAPSHOT_CHANNEL);
    expect(() => handler?.(trustedEvent)).toThrow(/untrusted sender/);
  });
});

describe('snapshot', () => {
  it('returns a Snapshot that matches the contract and carries the bus seq', async () => {
    const { call, bus } = setup();
    const first = Snapshot.parse(await call(SNAPSHOT_CHANNEL, trustedEvent));
    expect(first.seq).toBe(fixtureSnapshot.seq);

    await call(COMMAND_CHANNEL, trustedEvent, {
      type: 'session.reparent',
      requestId: 'req-move',
      sessionId: 's-research',
      parentId: null,
      expectedRevision: 2,
    });
    const second = Snapshot.parse(await call(SNAPSHOT_CHANNEL, trustedEvent));
    expect(second.seq).toBe(bus.seq);
    expect(second.seq).toBe(first.seq + 1);
  });

  describe('when no valid Snapshot can be produced', () => {
    const MARKER = 'SENSITIVE_INPUT_MARKER';
    const capture = async (facade: AppFacade) => {
      const log = vi.fn();
      let thrown: unknown;
      try {
        await readSnapshot(facade, log);
      } catch (error) {
        thrown = error;
      }
      return { log, thrown };
    };

    it('throws fixed text and keeps a private-path exception out of the renderer and the log', async () => {
      const { log, thrown } = await capture({
        snapshot: () => {
          throw new Error('cannot read C:/Users/someone/' + MARKER + '/state.db');
        },
        execute: vi.fn(),
      });
      expect(thrown).toEqual(new Error(SNAPSHOT_UNAVAILABLE));
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain(MARKER);
      expect(String(log.mock.calls[0]?.[0])).not.toContain('someone');
    });

    it('throws fixed text and keeps IDs from an invalid Snapshot out of the renderer and the log', async () => {
      const broken = { ...fixtureSnapshot, schemaVersion: '0.0.1', workflows: [{ ...fixtureSnapshot.workflows[0], id: MARKER, nodes: MARKER }] } as unknown as Snapshot;
      const { log, thrown } = await capture({ snapshot: () => broken, execute: vi.fn() });
      expect(thrown).toEqual(new Error(SNAPSHOT_UNAVAILABLE));
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain(MARKER);
      expect(String(log.mock.calls[0]?.[0])).toContain('schemaVersion');
    });

    it('rejects the snapshot call with the fixed text through the IPC handler', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { call } = setup({
        facade: {
          snapshot: () => {
            throw new Error(`leaks ${MARKER}`);
          },
          execute: vi.fn(),
        },
      });
      await expect(call(SNAPSHOT_CHANNEL, trustedEvent)).rejects.toThrow(SNAPSHOT_UNAVAILABLE);
    });
  });

  // r1 P1-1/P1-2: the records of a batch that could not be sent reach the Snapshot read; a read that fails keeps them.
  it('hands the Snapshot read what the window was not sent, and keeps it for the next read when that one fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const asked: unknown[] = [];
    let fail = true;
    const sent: EventBatch[] = [];
    const target: EventTarget = {
      isDestroyed: () => false,
      getURL: () => 'http://localhost:5173/',
      send: (_channel, batch) => {
        if (fail) throw new Error('render frame disposed');
        sent.push(batch);
      },
    };
    const { call, bus } = setup({
      target,
      facade: {
        snapshot: (missed) => {
          asked.push(missed);
          if (fail) throw new Error('read failed');
          return { ...fixtureSnapshot, seq: bus.seq };
        },
        execute: vi.fn(),
      },
    });
    bus.publish({ type: 'permission.updated', request: fixtureSnapshot.permissionRequests[0]! });
    await tick();
    await expect(call(SNAPSHOT_CHANNEL, trustedEvent)).rejects.toThrow(SNAPSHOT_UNAVAILABLE);
    fail = false;
    // Answered without a number (the plain channel): nothing of it counts as taken, so the next read brings it back.
    expect(Snapshot.parse(await call(SNAPSHOT_CHANNEL, trustedEvent)).seq).toBe(bus.seq);
    const first = (await call(SNAPSHOT_READ_CHANNEL, trustedEvent)) as { read: number; snapshot: unknown };
    const owed = (m: unknown) => (m as Map<string, { turns: Set<string> }>).get('s-wf-build-b')?.turns.has('turn-b1');
    expect(asked.map(owed)).toEqual([true, true, true]);
    // Acknowledged batches say nothing (r3); another window's report, a malformed one, an older read: nothing either.
    bus.publish({ type: 'usage.limits', at: '2026-11-03T10:00:00.000Z' });
    await tick();
    electron.listeners.get(BATCH_ACK_CHANNEL)!(trustedEvent, sent.at(-1)!.toSeq);
    const report = electron.listeners.get(WINDOW_REPORT_CHANNEL)!;
    report(otherWindowEvent, { kind: 'adopted', read: first.read, seq: bus.seq });
    report(trustedEvent, { kind: 'adopted', read: String(first.read), seq: bus.seq });
    const second = (await call(SNAPSHOT_READ_CHANNEL, trustedEvent)) as { read: number };
    expect(second.read).toBeGreaterThan(first.read);
    report(trustedEvent, { kind: 'adopted', read: first.read, seq: bus.seq });
    await call(SNAPSHOT_READ_CHANNEL, trustedEvent);
    expect(asked.map(owed)).toEqual([true, true, true, true, true]);
    // The window names the last read as taken: nothing is owed any more.
    const third = (await call(SNAPSHOT_READ_CHANNEL, trustedEvent)) as { read: number };
    report(trustedEvent, { kind: 'adopted', read: third.read, seq: bus.seq });
    await call(SNAPSHOT_READ_CHANNEL, trustedEvent);
    expect((asked.at(-1) as Map<string, unknown>).size).toBe(0);
  });

  it('reads window reports strictly (T040 r3)', () => {
    expect(windowReport({ kind: 'applied', toSeq: 4 })).toEqual({ kind: 'applied', toSeq: 4 });
    expect(windowReport({ kind: 'adopted', read: 2, seq: 9 })).toEqual({ kind: 'adopted', read: 2, seq: 9 });
    for (const bad of [null, 4, 'applied', { kind: 'applied' }, { kind: 'applied', toSeq: -1 }, { kind: 'applied', toSeq: 1.5 }, { kind: 'applied', toSeq: 1, extra: 1 }, { kind: 'adopted', read: 1 }, { kind: 'adopted', read: 1, seq: Number.MAX_VALUE }, { kind: 'other', toSeq: 1 }]) {
      expect(windowReport(bad)).toBeUndefined();
    }
  });
});

describe('commands', () => {
  it('runs a valid command through the facade', async () => {
    const { call, facade } = setup();
    const result = CommandResult.parse(await call(COMMAND_CHANNEL, trustedEvent, setPreferences('req-ok')));
    expect(result).toEqual({ ok: true, requestId: 'req-ok', created: [] });
    expect((await facade.snapshot()).preferences.theme).toBe('light');
  });

  it('answers unsupported for a valid command the fake does not implement', async () => {
    const { call } = setup();
    const result = await call(COMMAND_CHANNEL, trustedEvent, { type: 'transfer.cancel', requestId: 'req-t', transferId: 'tr-1' });
    expect(result).toMatchObject({ ok: false, requestId: 'req-t', code: 'unsupported' });
  });

  it.each([
    ['a string', 'hello'],
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['an unknown type', { type: 'rm.rf', requestId: 'req-x' }],
    ['a missing field', { type: 'session.interrupt', requestId: 'req-x' }],
    ['an extra field', { ...(setPreferences('req-x') as object), admin: true }],
    ['a wrong field type', { type: 'preferences.set', requestId: 'req-x', preferences: { theme: 'neon' } }],
    ['a rule the command carries', { type: 'delivery.resolve', requestId: 'req-x', escalationId: 'e-1', decision: 'retry', acceptDuplicateRisk: false }],
  ])('answers invalid_request for %s without throwing', async (_name, raw) => {
    const execute = vi.fn();
    const { call } = setup({ facade: { snapshot: () => fixtureSnapshot, execute } });

    const result = CommandResult.parse(await call(COMMAND_CHANNEL, trustedEvent, raw));

    expect(result).toMatchObject({ ok: false, code: 'invalid_request', retryable: false, mayHaveSideEffects: false });
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps the caller requestId on an invalid command, and a placeholder when there is none', async () => {
    const { facade } = setup();
    expect(await runCommand(facade, { type: 'nope', requestId: 'req-keep' })).toMatchObject({ requestId: 'req-keep' });
    expect(await runCommand(facade, { type: 'nope' })).toMatchObject({ requestId: UNKNOWN_REQUEST_ID });
    expect(await runCommand(facade, { type: 'nope', requestId: 12 })).toMatchObject({ requestId: UNKNOWN_REQUEST_ID });
  });

  describe('error messages never quote input', () => {
    const MARKER = 'SENSITIVE_INPUT_MARKER';
    const workflowWithBadEdge = () => {
      const workflow = structuredClone(fixtureSnapshot.workflows[0]);
      if (!workflow) throw new Error('fixture has no workflow');
      return { ...workflow, edges: [...workflow.edges, { source: MARKER, target: 'n-plan' }] };
    };

    it('for a field value that fails validation', async () => {
      const { facade } = setup();
      const result = await runCommand(facade, { type: 'preferences.set', requestId: 'req-s', preferences: { theme: MARKER } });
      expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    });

    it('for a workflow refinement that names an ID', async () => {
      const { facade } = setup();
      const result = await runCommand(facade, { type: 'workflow.save', requestId: 'req-w', workflow: workflowWithBadEdge(), expectedRevision: null });
      expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(JSON.stringify(result)).not.toContain(MARKER);
      // Contracts 0.4 point the issue at the offending edge (C-04).
      expect((result as { message: string }).message).toMatch(/workflow\.edges\.\d+: custom/);
    });

    it('for an unknown key', async () => {
      const { facade } = setup();
      const result = await runCommand(facade, { ...(setPreferences('req-k') as object), [MARKER]: true });
      expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
      expect(JSON.stringify(result)).not.toContain(MARKER);
    });

    it.each([
      ['an unknown session', { sessionId: MARKER, parentId: null, expectedRevision: 1 }],
      ['an unknown parent', { sessionId: 's-research', parentId: MARKER, expectedRevision: 2 }],
      ['a stale revision', { sessionId: 's-research', parentId: null, expectedRevision: 987654 }],
    ])('from the fake facade for %s', async (_name, fields) => {
      const { facade } = setup();
      const result = await runCommand(facade, { type: 'session.reparent', requestId: 'req-r', ...fields });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(MARKER);
      expect(JSON.stringify(result)).not.toContain('987654');
    });
  });

  it('turns a throwing facade into a failed result that warns about side effects', async () => {
    const facade: AppFacade = {
      snapshot: () => fixtureSnapshot,
      execute: () => {
        throw new Error('disk on fire: C:\\secret\\path');
      },
    };
    const result = await runCommand(facade, setPreferences('req-throw'));
    expect(result).toMatchObject({ ok: false, requestId: 'req-throw', code: 'runtime_unavailable', mayHaveSideEffects: true });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('turns a rejecting facade into a failed result', async () => {
    const facade: AppFacade = { snapshot: () => fixtureSnapshot, execute: () => Promise.reject(new Error('nope')) };
    expect(await runCommand(facade, setPreferences('req-rej'))).toMatchObject({ ok: false, code: 'runtime_unavailable' });
  });

  it.each([
    ['a result outside the contract', { ok: 'yes' }],
    ['a result for another request', { ok: true, requestId: 'someone-else', created: [] }],
  ])('turns %s from the facade into a failed result', async (_name, answer) => {
    const facade: AppFacade = { snapshot: () => fixtureSnapshot, execute: () => answer as unknown as ReturnType<AppFacade['execute']> };
    const result = await runCommand(facade, setPreferences('req-bad'));
    expect(result).toMatchObject({ ok: false, requestId: 'req-bad', code: 'runtime_unavailable', mayHaveSideEffects: true });
  });

  it('hands the facade the parsed command, with contract defaults filled in', async () => {
    const execute = vi.fn((command: Command) => ({ ok: true as const, requestId: command.requestId, created: [] }));
    const facade: AppFacade = { snapshot: () => fixtureSnapshot, execute };
    await runCommand(facade, { type: 'session.send', requestId: 'req-d', sessionId: 's-1', messageId: 'm-1', expectedRevision: 1, text: 'hi' });
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: 'session.send', attachments: [] });
  });
});

describe('event forwarding', () => {
  it('pushes batches with increasing seq to the window, without gaps', async () => {
    const { call, sent } = setup();

    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r1', sessionId: 's-research', parentId: null, expectedRevision: 2 });
    await tick();
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r2', sessionId: 's-research', parentId: 's-plan-notes', expectedRevision: 3 });
    await tick();

    expect(sent.map((s) => s.channel)).toEqual([BATCH_CHANNEL]);
    // The second waits: the first is not acknowledged (in-flight limit 1 here).
    const ack = electron.listeners.get(BATCH_ACK_CHANNEL)!;
    ack(trustedEvent, sent[0]!.batch.toSeq);
    await tick();
    expect(sent.map((s) => [s.batch.fromSeq, s.batch.toSeq])).toEqual([
      [fixtureSnapshot.seq + 1, fixtureSnapshot.seq + 1],
      [fixtureSnapshot.seq + 2, fixtureSnapshot.seq + 2],
    ]);
    expect(sent[0]?.batch.envelopes[0]?.event.type).toBe('session.updated');
  });

  it('ignores an acknowledgement from another window or page', async () => {
    const { call, sent } = setup();
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r1', sessionId: 's-research', parentId: null, expectedRevision: 2 });
    await tick();
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r2', sessionId: 's-research', parentId: 's-plan-notes', expectedRevision: 3 });
    await tick();
    const ack = electron.listeners.get(BATCH_ACK_CHANNEL)!;
    ack(otherWindowEvent, sent[0]!.batch.toSeq);
    ack(evilPageEvent, sent[0]!.batch.toSeq);
    ack(trustedEvent, 'not a seq');
    await tick();
    expect(sent.length).toBe(1);
  });

  it('lets a renderer resume: what waited is sent before the Snapshot seq is read, and batches continue right after it', async () => {
    const { call, sent, bus } = setup();
    bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' });
    await tick();
    // Not acknowledged: this one waits behind the in-flight limit.
    bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:01+08:00' });
    await tick();
    expect(sent.length).toBe(1);
    const before = Snapshot.parse(await call(SNAPSHOT_CHANNEL, trustedEvent));
    expect(sent.at(-1)?.batch.toSeq).toBe(before.seq);
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r1', sessionId: 's-research', parentId: null, expectedRevision: 2 });
    await tick();
    expect(sent.at(-1)?.batch.fromSeq).toBe(before.seq + 1);
  });

  it.each([
    ['there is no window', null],
    ['the window is destroyed', { isDestroyed: () => true, getURL: () => 'http://localhost:5173/', send: vi.fn() }],
    ['the window shows a page that is not ours', { isDestroyed: () => false, getURL: () => 'https://example.com/', send: vi.fn() }],
  ])('sends nothing when %s', async (_name, target) => {
    const { bus } = setup({ target });
    expect(() => bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' })).not.toThrow();
    await tick();
    if (target) expect(target.send).not.toHaveBeenCalled();
  });

  it('stops forwarding after the returned function is called', async () => {
    const { bus, sent, stop } = setup();
    stop();
    bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' });
    await tick();
    expect(sent).toEqual([]);
    expect(electron.listeners.has(BATCH_ACK_CHANNEL)).toBe(false);
  });
});

describe('queries (C-26, C-28)', () => {
  const page = { sessionId: 's-research', turns: [], messages: [], items: [], nativeTasks: [], permissionRequests: [], artifacts: [], olderCursor: null };
  const history = (sessionId = 's-research'): QueryRequest => ({ type: 'session.history', requestId: 'q-1', sessionId, before: 'c-1', limit: 50 }) as QueryRequest;
  const facadeAnswering = (answer: unknown): AppFacade => ({ snapshot: () => fixtureSnapshot, execute: vi.fn(), query: vi.fn(() => answer as QueryResult) });

  it('answers through the facade, checked against the contract', async () => {
    const { call } = setup({ facade: facadeAnswering({ ok: true, type: 'session.history', requestId: 'q-1', page }) });
    expect(QueryResult.parse(await call(QUERY_CHANNEL, trustedEvent, history()))).toMatchObject({ ok: true, page: { sessionId: 's-research' } });
  });

  it.each([
    ['not an object', 'hello'],
    ['an unknown type', { type: 'session.everything', requestId: 'q-1' }],
    ['a limit above 500', { ...history(), limit: 501 }],
    ['a path instead of an ID', { type: 'backup.list', requestId: 'q-1', path: 'C:/x' }],
  ])('answers invalid_request for %s without calling the facade', async (_name, raw) => {
    const query = vi.fn();
    const facade: AppFacade = { snapshot: () => fixtureSnapshot, execute: vi.fn(), query };
    const result = await runQuery(facade, raw);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['a page of another session', { ok: true, type: 'session.history', requestId: 'q-1', page: { ...page, sessionId: 's-plan-notes' } }],
    ['the answer to another request', { ok: true, type: 'session.history', requestId: 'q-2', page }],
    ['an answer of another type', { ok: true, type: 'backup.list', requestId: 'q-1', backups: [] }],
    ['something outside the contract', { ok: 'maybe' }],
  ])('never passes on %s', async (_name, answer) => {
    const log = vi.fn();
    expect(await runQuery(facadeAnswering(answer), history(), log)).toEqual({ ok: false, requestId: 'q-1', code: 'internal_error', message: QUERY_FAILED });
  });

  it('turns a throwing facade into fixed text, keeping its message out of the result and the log', async () => {
    const log = vi.fn();
    const facade: AppFacade = { snapshot: () => fixtureSnapshot, execute: vi.fn(), query: () => Promise.reject(new Error('C:/Users/someone/secret')) };
    const result = await runQuery(facade, history(), log);
    expect(result).toMatchObject({ ok: false, code: 'internal_error' });
    expect(JSON.stringify([result, log.mock.calls])).not.toContain('someone');
  });

  it('answers internal_error when the facade has no queries', async () => {
    expect(await runQuery({ snapshot: () => fixtureSnapshot, execute: vi.fn() }, history())).toMatchObject({ ok: false, code: 'internal_error' });
  });
});

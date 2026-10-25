import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandResult, Snapshot, type Command, type EventEnvelope } from '../../contracts';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { COMMAND_CHANNEL, EVENT_CHANNEL, SNAPSHOT_CHANNEL } from '../preload/channels';
import { readSnapshot, registerAppIpc, runCommand, SNAPSHOT_UNAVAILABLE, UNKNOWN_REQUEST_ID, type EventTarget } from './app-ipc';
import { EventBus } from './event-bus';
import { createFakeFacade, type AppFacade } from './facade';
import type { IpcSenderEvent, TrustedSender } from './ipc-guard';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
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
  const sent: { channel: string; envelope: EventEnvelope }[] = [];
  const target: EventTarget | null =
    overrides.target === undefined
      ? { isDestroyed: () => false, getURL: () => 'http://localhost:5173/', send: (channel, envelope) => sent.push({ channel, envelope }) }
      : overrides.target;
  const stop = registerAppIpc({ facade, bus, getTrustedSender: () => trusted, getEventTarget: () => target, isTrustedUrl: (url) => trusted.isTrustedUrl(url) });
  const call = (channel: string, event: unknown, ...args: unknown[]) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(event, ...args);
  };
  return { bus, facade, sent, stop, call };
}

beforeEach(() => {
  electron.handlers.clear();
});

describe('sender checks', () => {
  it.each([
    ['another window', otherWindowEvent],
    ['an untrusted page', evilPageEvent],
  ])('rejects snapshot and command calls from %s', (_name, event) => {
    const { call } = setup();
    expect(() => call(SNAPSHOT_CHANNEL, event)).toThrow(/untrusted sender/);
    expect(() => call(COMMAND_CHANNEL, event, setPreferences())).toThrow(/untrusted sender/);
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
    const first = Snapshot.parse(call(SNAPSHOT_CHANNEL, trustedEvent));
    expect(first.seq).toBe(fixtureSnapshot.seq);

    await call(COMMAND_CHANNEL, trustedEvent, {
      type: 'session.reparent',
      requestId: 'req-move',
      sessionId: 's-research',
      parentId: null,
      expectedRevision: 2,
    });
    const second = Snapshot.parse(call(SNAPSHOT_CHANNEL, trustedEvent));
    expect(second.seq).toBe(bus.seq);
    expect(second.seq).toBe(first.seq + 1);
  });

  describe('when no valid Snapshot can be produced', () => {
    const MARKER = 'SENSITIVE_INPUT_MARKER';
    const capture = (facade: AppFacade) => {
      const log = vi.fn();
      let thrown: unknown;
      try {
        readSnapshot(facade, log);
      } catch (error) {
        thrown = error;
      }
      return { log, thrown };
    };

    it('throws fixed text and keeps a private-path exception out of the renderer and the log', () => {
      const { log, thrown } = capture({
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

    it('throws fixed text and keeps IDs from an invalid Snapshot out of the renderer and the log', () => {
      const broken = { ...fixtureSnapshot, schemaVersion: '0.0.1', workflows: [{ ...fixtureSnapshot.workflows[0], id: MARKER, nodes: MARKER }] } as unknown as Snapshot;
      const { log, thrown } = capture({ snapshot: () => broken, execute: vi.fn() });
      expect(thrown).toEqual(new Error(SNAPSHOT_UNAVAILABLE));
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain(MARKER);
      expect(String(log.mock.calls[0]?.[0])).toContain('schemaVersion');
    });

    it('rejects the snapshot call with the fixed text through the IPC handler', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { call } = setup({
        facade: {
          snapshot: () => {
            throw new Error(`leaks ${MARKER}`);
          },
          execute: vi.fn(),
        },
      });
      expect(() => call(SNAPSHOT_CHANNEL, trustedEvent)).toThrow(SNAPSHOT_UNAVAILABLE);
    });
  });
});

describe('commands', () => {
  it('runs a valid command through the facade', async () => {
    const { call, facade } = setup();
    const result = CommandResult.parse(await call(COMMAND_CHANNEL, trustedEvent, setPreferences('req-ok')));
    expect(result).toEqual({ ok: true, requestId: 'req-ok', created: [] });
    expect(facade.snapshot().preferences.theme).toBe('light');
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
      expect((result as { message: string }).message).toContain('workflow: custom');
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
  it('pushes envelopes with increasing seq to the window', async () => {
    const { call, sent } = setup();

    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r1', sessionId: 's-research', parentId: null, expectedRevision: 2 });
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r2', sessionId: 's-research', parentId: 's-plan-notes', expectedRevision: 3 });

    expect(sent.map((s) => s.channel)).toEqual([EVENT_CHANNEL, EVENT_CHANNEL]);
    expect(sent.map((s) => s.envelope.seq)).toEqual([fixtureSnapshot.seq + 1, fixtureSnapshot.seq + 2]);
    expect(sent[0]?.envelope.event.type).toBe('session.updated');
  });

  it('lets a renderer resume: events after the Snapshot seq continue from it', async () => {
    const { call, sent } = setup();
    const before = Snapshot.parse(call(SNAPSHOT_CHANNEL, trustedEvent));
    await call(COMMAND_CHANNEL, trustedEvent, { type: 'session.reparent', requestId: 'r1', sessionId: 's-research', parentId: null, expectedRevision: 2 });
    expect(sent[0]?.envelope.seq).toBe(before.seq + 1);
  });

  it.each([
    ['there is no window', null],
    ['the window is destroyed', { isDestroyed: () => true, getURL: () => 'http://localhost:5173/', send: vi.fn() }],
    ['the window shows a page that is not ours', { isDestroyed: () => false, getURL: () => 'https://example.com/', send: vi.fn() }],
  ])('sends nothing when %s', (_name, target) => {
    const { bus } = setup({ target });
    expect(() => bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' })).not.toThrow();
    if (target) expect(target.send).not.toHaveBeenCalled();
  });

  it('stops forwarding after the returned function is called', () => {
    const { bus, sent, stop } = setup();
    stop();
    bus.publish({ type: 'usage.limits', at: '2026-10-26T10:00:00+08:00' });
    expect(sent).toEqual([]);
  });
});

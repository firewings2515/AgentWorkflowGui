// T059 (U4, contracts 0.10): archiving conversations and runs, by the user and by the auto-archive. One set of cases on
// the memory ports (core/sessions/t059.test.ts) and on the SQLite repositories (app/main/t059-sqlite.test.ts).
import { describe, expect, it } from 'vitest';
import {
  type AppEvent,
  type CommandResult,
  EscalationId,
  InstanceId,
  type LogicalSession,
  MessageId,
  NodeId,
  OperationId,
  PayloadHash,
  pinnedOf,
  SessionId,
  type Timestamp,
  TransferId,
  TurnId,
  type UiPreferences,
  WorkflowInstance,
  WorkflowTemplate,
} from '../../../contracts';
import { fixtureSnapshotInput } from '../../../contracts/fixtures/snapshot';
import type { AppRepositories, DeliveryStore } from '../../ports';
import { payloadInput } from '../../delivery/testing/fixtures';
import { AutoArchiver, type AutoArchiveCommands } from '../archive';
import { AGENT, created, rid, settle, type World, worldOn } from './harness';

export type T059Storage = () => { repositories: AppRepositories; store: DeliveryStore };

const DAY = 86_400_000;
const sid = (id: string) => SessionId.parse(id);
let messages = 0;

const get = async (w: World, id: string): Promise<LogicalSession> => {
  const s = await w.repositories.sessions.get(sid(id));
  if (s === undefined) throw new Error(`no session ${id}`);
  return s;
};
const revision = async (w: World, id: string) => (await get(w, id)).revision;
const archivedAt = async (w: World, id: string) => {
  const s = await get(w, id);
  return s.kind === 'ordinary' ? s.archivedAt : undefined;
};
const chat = async (w: World, id: string, parentId?: string) => {
  const { result } = await created(w, 'codex', id, parentId === undefined ? {} : { parentId: sid(parentId) });
  expect(result).toMatchObject({ ok: true });
};
const archive = async (w: World, id: string, rev?: number) => w.run({ type: 'session.archive', requestId: rid(), sessionId: sid(id), expectedRevision: rev ?? (await revision(w, id)) });
const unarchive = async (w: World, id: string, rev?: number) => w.run({ type: 'session.unarchive', requestId: rid(), sessionId: sid(id), expectedRevision: rev ?? (await revision(w, id)) });
const send = async (w: World, id: string, text = 'hello') => {
  const result = await w.run({ type: 'session.send', requestId: rid(), sessionId: sid(id), messageId: MessageId.parse(`m-${String(++messages)}`), expectedRevision: await revision(w, id), text, attachments: [] });
  await settle();
  return result;
};
/** The session's last dispatched turn ends: it is idle again. */
const finish = async (w: World, id: string) => {
  const adapter = w.codex.get(id)!;
  const sessionId = sid(id);
  const at = w.clock.now();
  adapter.emit({ type: 'turn.updated', turn: { id: TurnId.parse(`turn-${String(adapter.dispatched.length)}`), sessionId, state: 'completed', startedAt: at, endedAt: at } });
  adapter.emit({ type: 'session.activity', sessionId, activity: 'idle', at });
  await settle();
};
/** A message stored as the runtime would, at `at`. */
const message = (w: World, id: string, at: Timestamp, extra: { role?: 'user' | 'assistant' | 'system'; nativeTaskId?: string } = {}) => {
  const role = extra.role ?? 'assistant';
  return w.repositories.conversations.appendMessage({
    id: MessageId.parse(`stored-${String(++messages)}`),
    sessionId: sid(id),
    role,
    origin: { kind: role === 'assistant' ? 'agent' : role === 'system' ? 'system' : 'user' },
    text: 'stored',
    attachments: [],
    createdAt: at,
    ...(extra.nativeTaskId !== undefined && { nativeTaskId: extra.nativeTaskId as never }),
  });
};
const openEscalation = (w: World, from: string, extra: { instanceId?: string } = {}) =>
  w.repositories.escalations.upsert({
    id: EscalationId.parse(`esc-${String(++messages)}`),
    rootSessionId: sid(from),
    fromSessionId: sid(from),
    kind: 'confirmation',
    title: 'Check',
    detail: '',
    state: 'open',
    createdAt: w.clock.now(),
    ...(extra.instanceId !== undefined && { instanceId: InstanceId.parse(extra.instanceId) }),
  });
const closeEscalations = async (w: World) => {
  for (const e of await w.repositories.escalations.list({ state: 'open' })) await w.repositories.escalations.upsert({ ...e, state: 'resolved', resolvedBy: 'system', resolvedAt: w.clock.now() });
};
const setPrefs = async (w: World, change: Partial<UiPreferences>) =>
  expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...(await w.repositories.preferences.get()), ...change } })).toMatchObject({ ok: true });
const pin = (w: World, chat: string[], workflow: string[] = []) => setPrefs(w, { pinned: { chat: chat.map(sid), workflow: workflow.map((id) => InstanceId.parse(id)) } });

const template = WorkflowTemplate.parse(fixtureSnapshotInput.workflows[0]);
/** A run with its root and the node sessions named, made directly in storage (as the engine would have left it). */
const workflowRun = async (w: World, id: string, nodes: string[], state: WorkflowInstance['state'] = 'completed') => {
  await chat(w, `${id}-base`);
  const base = await get(w, `${id}-base`);
  for (const [i, node] of nodes.entries()) {
    const session = { ...base, id: sid(node), revision: 0, kind: 'workflow' as const, title: node, agent: { id: AGENT, revision: 1 }, workflow: { instanceId: InstanceId.parse(id), nodeId: NodeId.parse(`node-${String(i)}`) } };
    delete (session as { autoTitle?: true }).autoTitle;
    expect(await w.repositories.sessions.create(session)).toBe('created');
  }
  const ended = state === 'completed' || state === 'cancelled';
  const run = WorkflowInstance.parse({
    id, revision: 0, workflowId: template.id, workflowRevision: template.revision, title: 'Run', rootSessionId: nodes[0], state, template, tasks: [], createdAt: w.clock.now(),
    ...(ended && { endedAt: w.clock.now() }),
  });
  expect(await w.repositories.instances.create(run)).toBe('created');
};
const runOf = async (w: World, id: string) => (await w.repositories.instances.get(InstanceId.parse(id)))!;
const archiveRun = async (w: World, id: string, rev?: number) => w.run({ type: 'workflow.archive', requestId: rid(), instanceId: InstanceId.parse(id), expectedRevision: rev ?? (await runOf(w, id)).revision });
const unarchiveRun = async (w: World, id: string, rev?: number) => w.run({ type: 'workflow.unarchive', requestId: rid(), instanceId: InstanceId.parse(id), expectedRevision: rev ?? (await runOf(w, id)).revision });

const refused = (result: CommandResult) => (result.ok ? undefined : { code: result.code, reason: result.reason });
const sessionEvents = (w: World, id: string) => w.events.filter((e): e is Extract<AppEvent, { type: 'session.updated' }> => e.type === 'session.updated' && e.session.id === id);
const runEvents = (w: World, id: string) => w.events.filter((e): e is Extract<AppEvent, { type: 'instance.updated' }> => e.type === 'instance.updated' && e.instance.id === id);

/** An auto-archive over the world's service, its clock the world's; `before` runs right before each archive command. */
const archiverOf = (w: World, before?: (kind: 'tree' | 'run', id: string) => Promise<void>) => {
  const service = w.service;
  const commands: AutoArchiveCommands = {
    archiveTree: async (requestId, sessionId, expectedRevision, auto) => {
      await before?.('tree', sessionId);
      return service.archiveTree(rid(), sessionId, expectedRevision, auto);
    },
    archiveRun: async (requestId, instanceId, expectedRevision, auto) => {
      await before?.('run', instanceId);
      return service.archiveRun(rid(), instanceId, expectedRevision, auto);
    },
    turnRunning: (session) => service.turnRunning(session),
    unpinArchived: () => service.unpinArchived(),
    isClosing: () => service.isClosing(),
  };
  return new AutoArchiver({ repositories: w.repositories, commands, now: () => Date.parse(w.clock.now()), requestId: () => 'auto', mayWrite: () => true, log: (m) => w.logs.push(m) });
};

export const t059Cases = (backend: string, storage: T059Storage) =>
  describe(`T059 archive (${backend})`, () => {
    const begin = async () => {
      const { repositories, store } = storage();
      return worldOn(repositories, store);
    };

    describe('manual archive and unarchive', () => {
      it('archives the top session only: one write, announced once; the sessions below stay as they were; the Snapshot record says so', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        const before = await get(w, 'top');
        const child = await get(w, 'child');
        const events = sessionEvents(w, 'top').length;
        const result = await archive(w, 'top');
        expect(result).toMatchObject({ ok: true, revision: before.revision + 1 });
        const after = await get(w, 'top');
        expect(after).toMatchObject({ archivedAt: w.clock.now(), revision: before.revision + 1, title: before.title, cwd: before.cwd });
        expect(sessionEvents(w, 'top').slice(events)).toHaveLength(1);
        expect(sessionEvents(w, 'top').at(-1)!.session).toMatchObject({ archivedAt: w.clock.now() });
        expect(await get(w, 'child')).toEqual(child);
        const data = await w.repositories.readSnapshotData();
        expect(data.sessions.find((s) => s.id === 'top')).toMatchObject({ archivedAt: w.clock.now() });
      });

      it('only a mark: nothing is deleted, no runtime is stopped, interrupted or closed', async () => {
        const w = await begin();
        await chat(w, 'top');
        expect(await send(w, 'top')).toMatchObject({ ok: true });
        await finish(w, 'top');
        const conversation = await w.repositories.conversations.get(sid('top'));
        const adapter = w.codex.get('top')!;
        const calls = adapter.calls.length;
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        expect(await w.repositories.conversations.get(sid('top'))).toEqual(conversation);
        expect(adapter.calls.slice(calls)).toEqual([]);
        expect(w.closed).toEqual([]);
      });

      it('unarchives: the mark goes in one write; a repeat either way changes nothing and succeeds (CR-2), at once too', async () => {
        const w = await begin();
        await chat(w, 'top');
        const rev = await revision(w, 'top');
        const [a, b] = await Promise.all([archive(w, 'top', rev), archive(w, 'top', rev)]);
        expect(a).toMatchObject({ ok: true, revision: rev + 1 });
        expect(b).toMatchObject({ ok: true, revision: rev + 1 });
        const events = sessionEvents(w, 'top').length;
        expect(await archive(w, 'top', 0)).toMatchObject({ ok: true, revision: rev + 1 });
        expect(sessionEvents(w, 'top')).toHaveLength(events);
        const [c, d] = await Promise.all([unarchive(w, 'top', rev + 1), unarchive(w, 'top', rev + 1)]);
        expect(c).toMatchObject({ ok: true, revision: rev + 2 });
        expect(d).toMatchObject({ ok: true, revision: rev + 2 });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        expect(sessionEvents(w, 'top')).toHaveLength(events + 1);
        expect(await unarchive(w, 'top', 0)).toMatchObject({ ok: true, revision: rev + 2 });
        expect(await revision(w, 'top')).toBe(rev + 2);
      });

      it('refuses with a reason: a session below another, a workflow session, a running turn anywhere in the tree, an open escalation, another revision, an unknown session; nothing written', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        await chat(w, 'grandchild', 'child');
        await workflowRun(w, 'run-1', ['wf-root']);
        expect(refused(await archive(w, 'child'))).toEqual({ code: 'invalid_request', reason: 'not-top-level' });
        expect(refused(await unarchive(w, 'child'))).toEqual({ code: 'invalid_request', reason: 'not-top-level' });
        expect(refused(await archive(w, 'wf-root'))).toEqual({ code: 'invalid_request', reason: 'workflow-session' });
        expect(refused(await unarchive(w, 'wf-root'))).toEqual({ code: 'invalid_request', reason: 'workflow-session' });
        expect(refused(await archive(w, 'top', (await revision(w, 'top')) + 5))).toEqual({ code: 'stale_revision', reason: undefined });
        expect(await w.run({ type: 'session.archive', requestId: rid(), sessionId: sid('nobody'), expectedRevision: 0 })).toMatchObject({ ok: false, code: 'not_found' });
        // A turn of the grandchild runs.
        expect(await send(w, 'grandchild')).toMatchObject({ ok: true });
        const turning = await archive(w, 'top');
        expect(turning).toMatchObject({ ok: false, code: 'invalid_transition', reason: 'turn-running', retryable: true });
        await finish(w, 'grandchild');
        // The runtime says the child runs (a background sub-agent woke it, R-05).
        w.codex.get('child')!.emit({ type: 'session.activity', sessionId: sid('child'), activity: 'running', at: w.clock.now() });
        await settle();
        expect(refused(await archive(w, 'top'))).toEqual({ code: 'invalid_transition', reason: 'turn-running' });
        w.codex.get('child')!.emit({ type: 'session.activity', sessionId: sid('child'), activity: 'idle', at: w.clock.now() });
        await settle();
        await openEscalation(w, 'child');
        expect(refused(await archive(w, 'top'))).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        await closeEscalations(w);
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
      });

      it('an ordinary session below a workflow session, or below one that is gone, is a top session (as the sidebar shows it)', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root']);
        await chat(w, 'under-workflow', 'wf-root');
        expect(await archive(w, 'under-workflow')).toMatchObject({ ok: true });
      });

      it('archiving takes the tree out of the chat pinned list; unarchiving pins nothing again; other pins stay', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        await chat(w, 'other');
        await pin(w, ['other', 'child', 'top'], ['run-x']);
        const prefs = w.events.filter((e) => e.type === 'preferences.updated').length;
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        expect(pinnedOf(await w.repositories.preferences.get())).toEqual({ chat: ['other'], workflow: ['run-x'] });
        expect(w.events.filter((e) => e.type === 'preferences.updated')).toHaveLength(prefs + 1);
        expect(await unarchive(w, 'top')).toMatchObject({ ok: true });
        expect(pinnedOf(await w.repositories.preferences.get())).toEqual({ chat: ['other'], workflow: ['run-x'] });
      });

      it('H: a pin left by a failed preferences write is logged, the archive stands, and the next archive (a repeat) takes it out without an error', async () => {
        const w = await begin();
        await chat(w, 'top');
        await pin(w, ['top']);
        const set = w.repositories.preferences.set.bind(w.repositories.preferences);
        w.repositories.preferences.set = () => Promise.reject(new Error('disk'));
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        expect(await archivedAt(w, 'top')).toBe(w.clock.now());
        expect(pinnedOf(await w.repositories.preferences.get()).chat).toEqual(['top']);
        expect(w.logs.some((l) => l.includes('pinned list failed'))).toBe(true);
        w.repositories.preferences.set = set;
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        expect(pinnedOf(await w.repositories.preferences.get()).chat).toEqual([]);
      });

      it('H: the auto-archive pass takes leftover pins of archived items out first, also when it is turned off', async () => {
        const w = await begin();
        await chat(w, 'top');
        await workflowRun(w, 'run-1', ['wf-root']);
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        expect(await archiveRun(w, 'run-1')).toMatchObject({ ok: true });
        await setPrefs(w, { autoArchiveDays: null });
        await pin(w, ['top'], ['run-1', 'wf-root']);
        expect(await archiverOf(w).run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
        expect(pinnedOf(await w.repositories.preferences.get())).toEqual({ chat: [], workflow: [] });
      });

      it('a restart reads the mark as stored', async () => {
        const w = await begin();
        await chat(w, 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        const again = w.restart();
        expect(await again.repositories.sessions.get(sid('top'))).toMatchObject({ archivedAt: w.clock.now() });
      });
    });

    describe('runs', () => {
      it('archives an ended run: one compare-and-set, instance.updated once; the run and its node sessions leave the workflow pinned list; unarchive clears it', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root', 'wf-node']);
        await pin(w, [], ['wf-node', 'run-1', 'run-2']);
        const rev = (await runOf(w, 'run-1')).revision;
        const [a, b] = await Promise.all([archiveRun(w, 'run-1', rev), archiveRun(w, 'run-1', rev)]);
        expect(a).toMatchObject({ ok: true, revision: rev + 1 });
        expect(b).toMatchObject({ ok: true, revision: rev + 1 });
        expect(await runOf(w, 'run-1')).toMatchObject({ archivedAt: w.clock.now(), state: 'completed', revision: rev + 1 });
        expect(runEvents(w, 'run-1')).toHaveLength(1);
        expect(pinnedOf(await w.repositories.preferences.get()).workflow).toEqual(['run-2']);
        expect(await unarchiveRun(w, 'run-1')).toMatchObject({ ok: true, revision: rev + 2 });
        expect((await runOf(w, 'run-1')).archivedAt).toBeUndefined();
        expect(await unarchiveRun(w, 'run-1', 0)).toMatchObject({ ok: true, revision: rev + 2 });
        expect(runEvents(w, 'run-1')).toHaveLength(2);
        expect(pinnedOf(await w.repositories.preferences.get()).workflow).toEqual(['run-2']);
      });

      it('refuses a run not ended, a running turn of a node session, an open escalation of the run, another revision, an unknown run', async () => {
        const w = await begin();
        await workflowRun(w, 'running', ['r-root'], 'running');
        await workflowRun(w, 'blocked', ['b-root'], 'blocked');
        await workflowRun(w, 'done', ['d-root', 'd-node'], 'cancelled');
        expect(refused(await archiveRun(w, 'running'))).toEqual({ code: 'invalid_transition', reason: 'run-not-ended' });
        expect(refused(await archiveRun(w, 'blocked'))).toEqual({ code: 'invalid_transition', reason: 'run-not-ended' });
        expect(refused(await archiveRun(w, 'done', 7))).toEqual({ code: 'stale_revision', reason: undefined });
        expect(await w.run({ type: 'workflow.archive', requestId: rid(), instanceId: InstanceId.parse('none'), expectedRevision: 0 })).toMatchObject({ ok: false, code: 'not_found' });
        const node = await get(w, 'd-node');
        await w.repositories.sessions.update({ ...node, activity: 'waiting-user' }, node.revision);
        expect(refused(await archiveRun(w, 'done'))).toEqual({ code: 'invalid_transition', reason: 'turn-running' });
        const busy = await get(w, 'd-node');
        await w.repositories.sessions.update({ ...busy, activity: 'idle' }, busy.revision);
        await openEscalation(w, 'other-root', { instanceId: 'done' });
        expect(refused(await archiveRun(w, 'done'))).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
        await closeEscalations(w);
        await openEscalation(w, 'd-node');
        expect(refused(await archiveRun(w, 'done'))).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
        await closeEscalations(w);
        expect(runEvents(w, 'done')).toHaveLength(0);
        expect(await archiveRun(w, 'done')).toMatchObject({ ok: true });
      });

      it('a write of the run by someone else in between makes the archive stale; the engine writing it afterwards keeps the mark', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root']);
        const run = await runOf(w, 'run-1');
        expect(await w.repositories.instances.update({ ...run, revision: run.revision + 1, title: 'Renamed' }, run.revision)).toMatchObject({ status: 'saved' });
        expect(refused(await archiveRun(w, 'run-1', run.revision))).toEqual({ code: 'stale_revision', reason: undefined });
        expect(await archiveRun(w, 'run-1')).toMatchObject({ ok: true });
        const archived = await runOf(w, 'run-1');
        expect(await w.repositories.instances.update({ ...archived, revision: archived.revision + 1, title: 'Again' }, archived.revision)).toMatchObject({ status: 'saved' });
        expect(await runOf(w, 'run-1')).toMatchObject({ title: 'Again', archivedAt: archived.archivedAt });
      });
    });

    describe('session.send unarchives in the same command', () => {
      it('to the archived top session: the mark goes with one write before the message is stored; the message is sent', async () => {
        const w = await begin();
        await chat(w, 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        const archived = await get(w, 'top');
        const result = await send(w, 'top', 'back again');
        expect(result).toMatchObject({ ok: true });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        const unmarked = sessionEvents(w, 'top').find((e) => e.session.revision === archived.revision + 1);
        expect(unmarked?.session).not.toHaveProperty('archivedAt');
        expect(w.codex.get('top')!.dispatched.at(-1)?.text).toBe('back again');
        // The answer's revision is the session's after it (the unarchive and the first message naming it).
        expect(result.ok && result.revision).toBe(await revision(w, 'top'));
      });

      it('to a session below an archived top: the top is unarchived, the child sends; its revision did not move the top before', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        const top = await revision(w, 'top');
        expect(await send(w, 'child')).toMatchObject({ ok: true });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        expect(await revision(w, 'top')).toBe(top + 1);
      });

      it('to a session of an archived run: the run is unarchived (instance.updated) and the message sent', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root']);
        expect(await archiveRun(w, 'run-1')).toMatchObject({ ok: true });
        const events = runEvents(w, 'run-1').length;
        await send(w, 'wf-root');
        expect((await runOf(w, 'run-1')).archivedAt).toBeUndefined();
        expect(runEvents(w, 'run-1')).toHaveLength(events + 1);
      });

      it('a send refused before anything is stored leaves the archive as it was', async () => {
        const w = await begin();
        await chat(w, 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        const rev = await revision(w, 'top');
        expect(await w.run({ type: 'session.send', requestId: rid(), sessionId: sid('top'), messageId: MessageId.parse('x-1'), expectedRevision: rev - 1, text: 'x', attachments: [] })).toMatchObject({ ok: false, code: 'stale_revision' });
        expect(await w.run({ type: 'session.send', requestId: rid(), sessionId: sid('top'), messageId: MessageId.parse('x-2'), expectedRevision: rev, text: 'x', attachments: [{ kind: 'file', path: 'E:\\a.txt', name: 'a.txt' }] })).toMatchObject({ ok: false, code: 'unsupported' });

        expect(await archivedAt(w, 'top')).toBe(w.clock.now());
        expect(await revision(w, 'top')).toBe(rev);
      });

      it('the top moved on by a background write while the send ran (its activity): read again and unarchived', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        // Every first read of the top for the unarchive is followed by a background write of it.
        const sessions = w.repositories.sessions;
        const original = sessions.get.bind(sessions);
        let bumps = 2;
        sessions.get = async (id) => {
          const found = await original(id);
          if (id === 'top' && found !== undefined && bumps-- > 0) await sessions.update({ ...found, title: `t${String(bumps)}` }, found.revision);
          return found;
        };
        expect(await send(w, 'child')).toMatchObject({ ok: true });
        sessions.get = original;
        expect(await archivedAt(w, 'top')).toBeUndefined();
      });
    });

    describe('the archived tree keeps its shape', () => {
      it('reparent into or out of an archived tree, or of its top, is refused with archived; create below it and transfer from it too', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        await chat(w, 'free');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        const move = async (id: string, parentId: string | null) =>
          w.run({ type: 'session.reparent', requestId: rid(), sessionId: sid(id), expectedRevision: await revision(w, id), parentId: parentId === null ? null : sid(parentId) });
        expect(refused(await move('free', 'top'))).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(refused(await move('free', 'child'))).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(refused(await move('child', null))).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(refused(await move('child', 'free'))).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(refused(await move('top', 'free'))).toEqual({ code: 'invalid_transition', reason: 'archived' });
        const { result } = await created(w, 'codex', 'new-child', { parentId: sid('child') });
        expect(refused(result)).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(await w.repositories.sessions.get(sid('new-child'))).toBeUndefined();
        expect(await w.service.inArchivedTree(sid('child'))).toBe(true);
        expect(await w.service.inArchivedTree(sid('free'))).toBe(false);
        expect((await get(w, 'free')).parentId).toBeUndefined();
        // Unarchived, the same moves go through.
        expect(await unarchive(w, 'top')).toMatchObject({ ok: true });
        expect(await move('free', 'child')).toMatchObject({ ok: true });
      });
    });

    describe('auto-archive', () => {
      /** Two weeks and a day later than everything made so far. */
      const later = (w: World, days = 15) => w.clock.advance(days * DAY);

      it('archives a conversation whose newest message is older than 14 days (the default); one a day younger stays', async () => {
        const w = await begin();
        await chat(w, 'old');
        await chat(w, 'young');
        await message(w, 'old', w.clock.now());
        later(w, 15);
        await message(w, 'young', new Date(Date.parse(w.clock.now()) - 13 * DAY).toISOString());
        expect(await archiverOf(w).run()).toMatchObject({ archived: 1 });
        expect(await archivedAt(w, 'old')).toBe(w.clock.now());
        expect(await archivedAt(w, 'young')).toBeUndefined();
      });

      it('only user and assistant messages of the main conversation count; with none, the createdAt; a child with a new message keeps the whole tree', async () => {
        const w = await begin();
        await chat(w, 'notes');
        await chat(w, 'subagent');
        await chat(w, 'empty');
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        later(w, 15);
        await message(w, 'notes', w.clock.now(), { role: 'system' });
        await message(w, 'subagent', w.clock.now(), { nativeTaskId: 'nt-1' });
        await message(w, 'child', w.clock.now(), { role: 'user' });
        await archiverOf(w).run();
        expect(await archivedAt(w, 'notes')).toBe(w.clock.now());
        expect(await archivedAt(w, 'subagent')).toBe(w.clock.now());
        expect(await archivedAt(w, 'empty')).toBe(w.clock.now());
        expect(await archivedAt(w, 'top')).toBeUndefined();
        // A child made later keeps it too, by its createdAt.
        const w2 = await begin();
        await chat(w2, 'top');
        later(w2, 15);
        await chat(w2, 'new-child', 'top');
        await archiverOf(w2).run();
        expect(await archivedAt(w2, 'top')).toBeUndefined();
      });

      it('not while a turn runs; the next pass after it ended', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        expect(await send(w, 'child')).toMatchObject({ ok: true });
        later(w);
        expect(await archiverOf(w).run()).toMatchObject({ archived: 0 });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        await finish(w, 'child');
        // Its message is as old as the rest (sent before the two weeks passed).
        expect(await archiverOf(w).run()).toMatchObject({ archived: 1 });
        expect(await archivedAt(w, 'top')).toBe(w.clock.now());
      });

      it('not while an escalation is open; once it is answered', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        await openEscalation(w, 'child');
        later(w);
        await archiverOf(w).run();
        expect(await archivedAt(w, 'top')).toBeUndefined();
        await closeEscalations(w);
        await archiverOf(w).run();
        expect(await archivedAt(w, 'top')).toBe(w.clock.now());
      });

      it('not while pinned (the top or a child); once unpinned', async () => {
        const w = await begin();
        await chat(w, 'a');
        await chat(w, 'b');
        await chat(w, 'b-child', 'b');
        await pin(w, ['a', 'b-child']);
        later(w);
        await archiverOf(w).run();
        expect(await archivedAt(w, 'a')).toBeUndefined();
        expect(await archivedAt(w, 'b')).toBeUndefined();
        await pin(w, []);
        await archiverOf(w).run();
        expect(await archivedAt(w, 'a')).toBe(w.clock.now());
        expect(await archivedAt(w, 'b')).toBe(w.clock.now());
      });

      it('runs: only ended ones, by their newest node message; not pinned (run or node), no turn, no escalation', async () => {
        const w = await begin();
        await workflowRun(w, 'running', ['r-root'], 'running');
        await workflowRun(w, 'recent', ['n-root', 'n-node']);
        await workflowRun(w, 'pinned-run', ['p-root']);
        await workflowRun(w, 'pinned-node', ['q-root', 'q-node']);
        await workflowRun(w, 'asking', ['e-root']);
        await workflowRun(w, 'old', ['o-root', 'o-node']);
        await message(w, 'o-node', w.clock.now());
        later(w);
        // Root's message is old, a node's is new: the run is not.
        await message(w, 'n-node', w.clock.now());
        await pin(w, [], ['pinned-run', 'q-node']);
        await openEscalation(w, 'e-root', { instanceId: 'asking' });
        await archiverOf(w).run();
        expect((await runOf(w, 'old')).archivedAt).toBe(w.clock.now());
        for (const id of ['running', 'recent', 'pinned-run', 'pinned-node', 'asking']) expect((await runOf(w, id)).archivedAt).toBeUndefined();
        // The run's own sessions are not conversations: none of them is archived as one.
        for (const id of ['o-root', 'o-node']) expect(await archivedAt(w, id)).toBeUndefined();
        await closeEscalations(w);
        await archiverOf(w).run();
        expect((await runOf(w, 'asking')).archivedAt).toBe(w.clock.now());
        const node = await get(w, 'q-node');
        await pin(w, [], []);
        await w.repositories.sessions.update({ ...node, activity: 'running' }, node.revision);
        await archiverOf(w).run();
        expect((await runOf(w, 'pinned-node')).archivedAt).toBeUndefined();
      });

      it('an archived one is not written again; autoArchiveDays null archives nothing; absent is 14; 30 waits 30 days', async () => {
        const w = await begin();
        await chat(w, 'top');
        later(w);
        await setPrefs(w, { autoArchiveDays: null });
        expect(await archiverOf(w).run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        await setPrefs(w, { autoArchiveDays: 30 });
        await archiverOf(w).run();
        expect(await archivedAt(w, 'top')).toBeUndefined();
        later(w, 16);
        await archiverOf(w).run();
        expect(await archivedAt(w, 'top')).toBe(w.clock.now());
        const rev = await revision(w, 'top');
        const prefs = await w.repositories.preferences.get();
        delete prefs.autoArchiveDays;
        expect(await w.run({ type: 'preferences.set', requestId: rid(), preferences: prefs })).toMatchObject({ ok: true });
        expect(await archiverOf(w).run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
        expect(await revision(w, 'top')).toBe(rev);
      });

      it('one pass at a time; a stopped archiver writes nothing more', async () => {
        const w = await begin();
        await chat(w, 'a');
        await chat(w, 'b');
        later(w);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const archiver = archiverOf(w, () => gate);
        const first = archiver.run();
        expect(archiver.run()).toBe(first);
        await settle();
        archiver.stop();
        release();
        expect(await first).toMatchObject({ archived: 1 });
        expect([await archivedAt(w, 'a'), await archivedAt(w, 'b')].filter((v) => v !== undefined)).toHaveLength(1);
        expect(await archiver.run()).toEqual({ archived: 0, skipped: 0, failed: 0 });
      });

      describe('the user just before the auto-archive (the scan read the old state, the command comes after)', () => {
        it('a message to a child: its revision is the child\'s, the top\'s does not move; the re-check inside the locks finds it and skips', async () => {
          const w = await begin();
          await chat(w, 'top');
          await chat(w, 'child', 'top');
          later(w);
          const top = await revision(w, 'top');
          const archiver = archiverOf(w, async () => {
            expect(await send(w, 'child')).toMatchObject({ ok: true });
            await finish(w, 'child');
            // The top's revision is what the scan read: only the re-check can tell.
            expect(await revision(w, 'top')).toBe(top);
          });
          expect(await archiver.run()).toEqual({ archived: 0, skipped: 1, failed: 0 });
          expect(await archivedAt(w, 'top')).toBeUndefined();
          expect(await revision(w, 'top')).toBe(top);
        });

        it('a message to a child whose turn still runs: skipped as turn-running', async () => {
          const w = await begin();
          await chat(w, 'top');
          await chat(w, 'child', 'top');
          later(w);
          const results: CommandResult[] = [];
          const archiver = archiverOf(w, async () => {
            await send(w, 'child');
          });
          const service = w.service;
          const real = service.archiveTree.bind(service);
          service.archiveTree = async (...args) => {
            const result = await real(...args);
            results.push(result);
            return result;
          };
          expect(await archiver.run()).toMatchObject({ archived: 0, skipped: 1 });
          expect(results.map(refused)).toEqual([{ code: 'invalid_transition', reason: 'turn-running' }]);
        });

        it('a message to the top itself: its revision moved on, skipped as stale; not tried again in the same pass', async () => {
          const w = await begin();
          await chat(w, 'top');
          later(w);
          let tries = 0;
          const archiver = archiverOf(w, async () => {
            tries++;
            await send(w, 'top');
            await finish(w, 'top');
          });
          expect(await archiver.run()).toEqual({ archived: 0, skipped: 1, failed: 0 });
          expect(tries).toBe(1);
          expect(await archivedAt(w, 'top')).toBeUndefined();
        });

        it('the user archived and unarchived it: another revision, skipped, never written over', async () => {
          const w = await begin();
          await chat(w, 'top');
          later(w);
          const archiver = archiverOf(w, async () => {
            await archive(w, 'top');
            await unarchive(w, 'top');
          });
          expect(await archiver.run()).toMatchObject({ archived: 0, skipped: 1 });
          expect(await archivedAt(w, 'top')).toBeUndefined();
        });

        it('pinned just before: skipped', async () => {
          const w = await begin();
          await chat(w, 'top');
          later(w);
          const archiver = archiverOf(w, () => pin(w, ['top']));
          expect(await archiver.run()).toMatchObject({ archived: 0, skipped: 1 });
          expect(await archivedAt(w, 'top')).toBeUndefined();
        });

        it('the auto-archive first, the user\'s message right after: unarchived again in that send, the message sent', async () => {
          const w = await begin();
          await chat(w, 'top');
          await chat(w, 'child', 'top');
          later(w);
          // The send arrives while the archive holds the tree's queues (it reads the open escalations there): it waits
          // behind the archive, then finds the tree archived.
          let sent: Promise<CommandResult> | undefined;
          let archiving = false;
          const escalations = w.repositories.escalations;
          const list = escalations.list.bind(escalations);
          escalations.list = (filter) => {
            if (archiving) sent ??= send(w, 'child');
            return list(filter);
          };
          const archiver = archiverOf(w, () => {
            archiving = true;
            return Promise.resolve();
          });
          expect(await archiver.run()).toMatchObject({ archived: 1 });
          escalations.list = list;
          expect(sent).toBeDefined();
          expect(await sent).toMatchObject({ ok: true });
          expect(await archivedAt(w, 'top')).toBeUndefined();
          expect((await w.repositories.conversations.get(sid('child'))).messages.some((m) => m.role === 'user')).toBe(true);
        });

        it('a run: a message to a node just before is found by the re-check and skipped', async () => {
          const w = await begin();
          await workflowRun(w, 'run-1', ['wf-root', 'wf-node']);
          later(w);
          const rev = (await runOf(w, 'run-1')).revision;
          const archiver = archiverOf(w, async () => {
            await send(w, 'wf-node');
            await finish(w, 'wf-node');
          });
          // The run is skipped (its base conversation, made for the test, is archived).
          expect(await archiver.run()).toMatchObject({ skipped: 1 });
          expect((await runOf(w, 'run-1')).archivedAt).toBeUndefined();
          expect((await runOf(w, 'run-1')).revision).toBe(rev);
        });
      });
    });

    describe('r1: the archive commit and what it must see', () => {
      /** A write held until the test lets it go (it holds the archive commit meanwhile, when it takes it). */
      const gate = () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        return { held, release };
      };
      const ticks = async (n = 3) => {
        for (let i = 0; i < n; i++) await settle();
      };
      const later = (w: World, days = 15) => w.clock.advance(days * DAY);

      it('P1-1: a send refused because its message ID is taken leaves the archive as it was', async () => {
        const w = await begin();
        await chat(w, 'a');
        await chat(w, 'b');
        await message(w, 'a', w.clock.now());
        const taken = (await w.repositories.conversations.get(sid('a'))).messages[0]!.id;
        expect(await archive(w, 'b')).toMatchObject({ ok: true });
        const rev = await revision(w, 'b');
        const result = await w.run({ type: 'session.send', requestId: rid(), sessionId: sid('b'), messageId: taken, expectedRevision: rev, text: 'x', attachments: [] });
        expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
        expect(await archivedAt(w, 'b')).toBe(w.clock.now());
        expect(await revision(w, 'b')).toBe(rev);
        expect((await w.repositories.conversations.get(sid('b'))).messages).toEqual([]);
      });

      it('P1-1: a send whose message write fails leaves the archive as it was', async () => {
        const w = await begin();
        await chat(w, 'b');
        expect(await archive(w, 'b')).toMatchObject({ ok: true });
        const rev = await revision(w, 'b');
        const conversations = w.repositories.conversations;
        const append = conversations.appendMessage.bind(conversations);
        conversations.appendMessage = () => Promise.reject(new Error('disk'));
        await expect(w.run({ type: 'session.send', requestId: rid(), sessionId: sid('b'), messageId: MessageId.parse('w-1'), expectedRevision: rev, text: 'x', attachments: [] })).rejects.toThrow();
        conversations.appendMessage = append;
        expect(await archivedAt(w, 'b')).toBe(w.clock.now());
        expect(await revision(w, 'b')).toBe(rev);
      });

      it('P1-2: a pin being saved when the auto-archive command comes is seen by its commit: skipped, and the pin stays', async () => {
        const w = await begin();
        await chat(w, 'top');
        later(w);
        // The user's pin is being written (slowly) when the archive command comes.
        const preferences = w.repositories.preferences;
        const set = preferences.set.bind(preferences);
        const slow = gate();
        preferences.set = async (p) => {
          await slow.held;
          return set(p);
        };
        let pinning: Promise<unknown> | undefined;
        const archiver = archiverOf(w, async () => {
          pinning = w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...(await w.repositories.preferences.get()), pinned: { chat: [sid('top')], workflow: [] } } });
          await settle();
        });
        const pass = archiver.run();
        for (let i = 0; i < 20 && pinning === undefined; i++) await settle();
        await ticks();
        slow.release();
        expect(await pass).toMatchObject({ archived: 0, skipped: 1 });
        expect(await pinning).toMatchObject({ ok: true });
        preferences.set = set;
        expect(await archivedAt(w, 'top')).toBeUndefined();
        expect(pinnedOf(await w.repositories.preferences.get()).chat).toEqual(['top']);
      });

      it('P1-2: the same for a run (a node session pinned on the way)', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root', 'wf-node']);
        await pin(w, ['run-1-base']);
        later(w);
        const preferences = w.repositories.preferences;
        const set = preferences.set.bind(preferences);
        const slow = gate();
        preferences.set = async (p) => {
          await slow.held;
          return set(p);
        };
        let pinning: Promise<unknown> | undefined;
        const archiver = archiverOf(w, async (kind) => {
          if (kind !== 'run') return;
          pinning = w.run({ type: 'preferences.set', requestId: rid(), preferences: { ...(await w.repositories.preferences.get()), pinned: { chat: [sid('run-1-base')], workflow: [InstanceId.parse('wf-node')] } } });
          await settle();
        });
        const pass = archiver.run();
        for (let i = 0; i < 40 && pinning === undefined; i++) await settle();
        await ticks();
        slow.release();
        await pass;
        expect(await pinning).toMatchObject({ ok: true });
        preferences.set = set;
        expect((await runOf(w, 'run-1')).archivedAt).toBeUndefined();
        expect(pinnedOf(await w.repositories.preferences.get()).workflow).toEqual(['wf-node']);
      });

      it('P1-3: a session made below the tree while it is archived, and sent to: never an archived tree with its new message', async () => {
        const w = await begin();
        await chat(w, 'top');
        later(w);
        // While the archive reads the tree inside its locks, a child is made below the top and written to.
        const sessions = w.repositories.sessions;
        const list = sessions.list.bind(sessions);
        let reads = 0;
        let made: Promise<unknown> | undefined;
        sessions.list = async () => {
          const found = await list();
          if (++reads === 2) {
            made = (async () => {
              const { result } = await created(w, 'codex', 'late-child', { parentId: sid('top') });
              if (result.ok) await send(w, 'late-child');
              return result;
            })();
            await ticks();
          }
          return found;
        };
        const result = await w.service.archiveTree(rid(), sid('top'), await revision(w, 'top'));
        await made;
        sessions.list = list;
        const child = await w.repositories.sessions.get(sid('late-child'));
        const childMessages = child === undefined ? [] : (await w.repositories.conversations.get(child.id)).messages;
        const archived = (await archivedAt(w, 'top')) !== undefined;
        // Either the archive saw the child (and did not archive), or the child was refused below the archived tree.
        expect(archived && childMessages.length > 0).toBe(false);
        if (archived) expect(child).toBeUndefined();
        else expect(result).toMatchObject({ ok: false });
      });

      it('P1-3: a session made below a tree just archived is refused (archived)', async () => {
        const w = await begin();
        await chat(w, 'top');
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
        // Past the quick check before the folder is made: refused where it is stored.
        const service = w.service;
        const inArchived = service.inArchivedTree.bind(service);
        service.inArchivedTree = () => Promise.resolve(false);
        const { result } = await created(w, 'codex', 'child', { parentId: sid('top') });
        service.inArchivedTree = inArchived;
        expect(refused(result)).toEqual({ code: 'invalid_transition', reason: 'archived' });
        expect(await w.repositories.sessions.get(sid('child'))).toBeUndefined();
      });

      it('P1-4: an escalation being opened when the archive comes is seen by its commit: refused escalation-open', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        const escalations = w.repositories.escalations;
        const upsert = escalations.upsert.bind(escalations);
        const slow = gate();
        escalations.upsert = async (e) => {
          await slow.held;
          return upsert(e);
        };
        // Through the service's storage, as the gate, the lock coordinator, the engine and the pipeline write escalations.
        const opening = w.service.storage.repositories.escalations.upsert({
          id: EscalationId.parse('esc-late'), rootSessionId: sid('child'), fromSessionId: sid('child'), kind: 'lock-timeout', title: 'Lock', detail: '',
          ref: { kind: 'lock', path: 'E:\\work\\project\\a.txt', sessionId: sid('child') }, state: 'open', createdAt: w.clock.now(),
        });
        await settle();
        const archiving = archive(w, 'top');
        await ticks();
        slow.release();
        const result = await archiving;
        await opening;
        escalations.upsert = upsert;
        expect(refused(result)).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
        expect(await archivedAt(w, 'top')).toBeUndefined();
      });

      it('P1-4: the same for a run', async () => {
        const w = await begin();
        await workflowRun(w, 'run-1', ['wf-root']);
        const escalations = w.repositories.escalations;
        const upsert = escalations.upsert.bind(escalations);
        const slow = gate();
        escalations.upsert = async (e) => {
          await slow.held;
          return upsert(e);
        };
        const opening = w.service.storage.repositories.escalations.upsert({
          id: EscalationId.parse('esc-run'), instanceId: InstanceId.parse('run-1'), rootSessionId: sid('wf-root'), fromSessionId: sid('wf-root'), kind: 'confirmation', title: 'Report', detail: '', state: 'open', createdAt: w.clock.now(),
        });
        await settle();
        const archiving = archiveRun(w, 'run-1');
        await ticks();
        slow.release();
        const result = await archiving;
        await opening;
        escalations.upsert = upsert;
        expect(refused(result)).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
      });

      it('an escalation opened right after the commit waits for it and is stored then (nothing is lost)', async () => {
        const w = await begin();
        await chat(w, 'top');
        const [result] = await Promise.all([
          archive(w, 'top'),
          (async () => {
            await settle();
            await w.service.storage.repositories.escalations.upsert({
              id: EscalationId.parse('esc-after'), rootSessionId: sid('top'), fromSessionId: sid('top'), kind: 'confirmation', title: 'Later', detail: '', state: 'open', createdAt: w.clock.now(),
            });
          })(),
        ]);
        expect(result.ok || refused(result)?.reason === 'escalation-open').toBe(true);
        expect(await w.repositories.escalations.get(EscalationId.parse('esc-after'))).toMatchObject({ state: 'open' });
      });

      it('an active transfer of a session of the tree keeps it from being archived', async () => {
        const w = await begin();
        await chat(w, 'top');
        const base = await get(w, 'top');
        await w.repositories.transfers.create({
          id: TransferId.parse('tr-1'), operationId: OperationId.parse('op-tr-1'), revision: 0, sourceSessionId: base.id, sourceRevision: base.revision,
          target: { runtime: 'claude', model: 'haiku' }, content: { goal: 'g', note: '', noteSource: 'gui-digest', diff: '', testOutput: '' },
          payloadHash: PayloadHash.parse(`sha256:${'0'.repeat(64)}`), state: 'awaiting-confirmation', createdAt: w.clock.now(),
        });
        // Waiting for the user's confirmation: answered first, as an escalation is.
        expect(refused(await archive(w, 'top'))).toEqual({ code: 'invalid_transition', reason: 'escalation-open' });
        const awaiting = (await w.repositories.transfers.get(TransferId.parse('tr-1')))!;
        await w.repositories.transfers.update({ ...awaiting, revision: 1, state: 'draft' }, 0);
        expect(refused(await archive(w, 'top'))).toEqual({ code: 'invalid_transition', reason: 'turn-running' });
        await w.repositories.transfers.update({ ...awaiting, revision: 2, state: 'cancelled', cancelledAt: w.clock.now(), cancelReason: 'user' }, 1);
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
      });
    });

    describe('r2: deliveries waiting for a session of the tree', () => {
      /** A user's message for the session, accepted and not sent (its runtime could not take it yet). */
      const waiting = async (w: World, id: string, name: string) => {
        const session = await get(w, id);
        return payloadInput({
          kind: 'user-message', operationId: OperationId.parse(`user-message:${name}`), sourceCallRef: `call-${name}`, counts: [],
          target: { sessionId: session.id, ...(session.nativeSessionRef !== undefined && { nativeSessionRef: session.nativeSessionRef }) },
          context: { runtime: 'codex', cwd: session.cwd, entry: { kind: 'new-turn' }, session: { model: session.requestedModel, readOnly: false } },
        });
      };

      it('a payload accepted and not sent yet keeps the tree from being archived; once it has an outcome, it may be', async () => {
        const w = await begin();
        await chat(w, 'top');
        await chat(w, 'child', 'top');
        expect(await w.store.accept(await waiting(w, 'child', 'r2-1'))).toMatchObject({ status: 'accepted' });
        expect(refused(await archive(w, 'top'))).toEqual({ code: 'invalid_transition', reason: 'turn-running' });
        expect(await archivedAt(w, 'top')).toBeUndefined();
        await w.store.recordOutcome(OperationId.parse('user-message:r2-1'), { kind: 'cancelled', detail: 'test', at: w.clock.now() });
        expect(await archive(w, 'top')).toMatchObject({ ok: true });
      });

      it('a payload accepted while the archive holds its commit waits for it: never accepted between the last check and the mark', async () => {
        const w = await begin();
        await chat(w, 'top');
        const order: string[] = [];
        const sessions = w.repositories.sessions;
        const update = sessions.update.bind(sessions);
        sessions.update = async (session, expected) => {
          if (session.kind === 'ordinary' && session.archivedAt !== undefined) order.push('mark');
          return update(session, expected);
        };
        const store = w.store;
        const accept = store.accept.bind(store);
        store.accept = (input) => {
          order.push('accept');
          return accept(input);
        };
        // Inside the archive's checks (it reads the open escalations there), a payload for the top is accepted through
        // the service's store, as a peer message or a handoff is.
        const input = await waiting(w, 'top', 'r2-2');
        let accepting: Promise<unknown> | undefined;
        const escalations = w.repositories.escalations;
        const list = escalations.list.bind(escalations);
        escalations.list = (filter) => {
          accepting ??= w.service.storage.store.accept(input);
          return list(filter);
        };
        const result = await archive(w, 'top');
        expect(await accepting).toMatchObject({ status: 'accepted' });
        sessions.update = update;
        store.accept = accept;
        escalations.list = list;
        expect(result).toMatchObject({ ok: true });
        expect(order).toEqual(['mark', 'accept']);
      });
    });
  });

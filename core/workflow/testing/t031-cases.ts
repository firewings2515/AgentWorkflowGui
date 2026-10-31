// T031: rounds of nodes that wait for all upstream (CR-4) and node concurrency (R-06), run on the memory ports
// here and on the SQLite repositories and delivery store in app/main. Restarts, repeated and out-of-order
// events, a crash between two steps and the windows between awaits are part of the cases from the start.
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_VERSION,
  type Escalation,
  HandoffId,
  type InputRule,
  NodeId,
  SessionId,
  TaskId,
  TurnId,
  type WorkflowTemplate,
} from '../../../contracts';
import {
  advanceClock,
  handoff,
  IMPL,
  INSTANCE,
  instanceOf,
  node,
  PLAN,
  PLANNER,
  REVIEW,
  REVIEWER,
  ROOT,
  rid,
  sessionOf,
  settle,
  started,
  template,
  WORKFLOW,
  type World,
} from './harness';
import type { HandoffMeta } from '../../ports';
import { crashOnce } from './r2-cases';

export const RA = NodeId.parse('review-a');
export const RB = NodeId.parse('review-b');
export const JOIN = NodeId.parse('verdict');

const to = (nodeId: NodeId) => ({ kind: 'node' as const, nodeId });
const rule = (id: string, nodeId: NodeId) => ({ id, condition: id, payload: '', target: to(nodeId), requiresUserConfirmation: false });

/**
 * Plan (root) fans out to two read-only reviews, Claude and Codex, which both hand to Verdict; Verdict waits
 * for all upstream and reports to root.
 */
export const fanTemplate = (join: Partial<InputRule> = {}): WorkflowTemplate => ({
  schemaVersion: CONTRACTS_VERSION,
  id: WORKFLOW,
  revision: 0,
  name: 'Fan',
  description: '',
  reworkLimit: 5,
  isolation: 'same-folder',
  nodes: [
    node(PLAN, { label: 'Plan', agentId: PLANNER, isRoot: true, outputRules: [rule('to-a', RA), rule('to-b', RB)] }),
    node(RA, { label: 'Review A', agentId: REVIEWER, writePolicy: 'read-only', inputRules: [{ id: 'change', condition: 'a change', waitForAllUpstream: false }], outputRules: [rule('verdict', JOIN)] }),
    node(RB, {
      label: 'Review B',
      agentId: REVIEWER,
      model: { runtime: 'codex', model: 'gpt-6-luna' },
      writePolicy: 'read-only',
      inputRules: [{ id: 'change', condition: 'a change', waitForAllUpstream: false }],
      outputRules: [rule('verdict', JOIN)],
    }),
    node(JOIN, {
      label: 'Verdict',
      agentId: PLANNER,
      inputRules: [{ id: 'reviews', condition: 'the reviews', waitForAllUpstream: true, ...join }],
      outputRules: [{ id: 'done', condition: 'decided', payload: '', target: { kind: 'root' }, requiresUserConfirmation: false }],
    }),
  ],
  edges: [
    { source: PLAN, target: RA },
    { source: PLAN, target: RB },
    { source: RA, target: JOIN },
    { source: RB, target: JOIN },
  ],
  updatedAt: '2026-10-31T00:00:00.000Z',
});

const toA = { ruleId: 'to-a', target: to(RA) };
const toB = { ruleId: 'to-b', target: to(RB) };
const verdict = { ruleId: 'verdict', target: to(JOIN) };

/** Handoff contents a session's runtime received, in order (the content after the frame). */
const received = (w: World, sessionId: SessionId) => {
  const adapter = w.codex.get(sessionId) ?? w.claude;
  const refs = new Set([...adapter.started.filter((o) => o.sessionId === sessionId).map((o) => o.preallocatedRef), ...adapter.resumed.filter((o) => o.sessionId === sessionId).map((o) => o.nativeSessionRef)]);
  return adapter.dispatched.filter((d) => w.codex.has(sessionId) || refs.has(d.nativeSessionRef)).map((d) => d.text.split('\n\n').at(-1));
};

/** Root's own first turn is held open, as a turn in which the agent makes its handoffs. */
const fanOut = async (w: World, both = true) => {
  w.holding.add(ROOT);
  await started(w);
  await handoff(w, ROOT, { ...toA, content: 'review A please' });
  if (both) await handoff(w, ROOT, { ...toB, content: 'review B please' });
  await settle();
  return { ra: await sessionOf(w, RA), rb: both ? await sessionOf(w, RB) : SessionId.parse('none') };
};

/** A later turn of root (the user wrote again) in which root fans out once more. */
const fanOutAgain = async (w: World, turnId: string) => {
  w.emitTurn(ROOT, turnId, 'running');
  await settle();
  await handoff(w, ROOT, { ...toA, content: 'review A again' });
  await handoff(w, ROOT, { ...toB, content: 'review B again' });
  w.emitTurn(ROOT, turnId, 'completed');
  await settle();
};

const roundsOf = async (w: World) => (await instanceOf(w)).rounds;
const joinOf = (w: World) => sessionOf(w, JOIN);
const openOf = async (w: World, kind: Escalation['kind']) => (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === kind);
const arrivalsAt = async (w: World) => (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.toNodeId === JOIN);

/** Emits the end of the turn a handoff to `sessionId` started, with another state (a failed or stopped upstream). */
const endTurnOf = async (w: World, sessionId: SessionId, state: 'failed' | 'interrupted') => {
  const branch = (await w.repositories.handoffs.listByInstance(INSTANCE)).filter((h) => h.target.sessionId === sessionId).at(-1);
  const last = branch?.delivery.attempts.at(-1);
  const turnRef = last?.state === 'sent' ? last.nativeRef.turnRef : undefined;
  if (turnRef === undefined) throw new Error('no turn of the branch');
  const adapter = w.codex.get(sessionId) ?? w.claude;
  adapter.emit({
    type: 'turn.updated',
    turn: {
      id: TurnId.parse(turnRef),
      sessionId,
      state,
      startedAt: '2026-10-29T01:00:00.000Z',
      endedAt: '2026-10-29T01:00:02.000Z',
      ...(state === 'failed' && { failure: { message: 'the runtime stopped' } }),
    },
  });
  await settle();
};

export const t031Cases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`T031 rounds and concurrency (${backend})`, () => {
    it('a waiting node starts only once every branch of the fan-out arrived; the expected set is fixed when the source turn ends', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      // Both read-only branches run at once (R-06).
      expect(received(w, ra)).toEqual(['review A please']);
      expect(received(w, rb)).toEqual(['review B please']);
      expect(await handoff(w, ra, { ...verdict, content: 'A: fine' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      // Root's turn (the fan-out) is still open: no round yet, nothing delivered.
      expect(await roundsOf(w)).toEqual([]);
      const join = await joinOf(w);
      expect(received(w, join)).toEqual([]);
      await w.finishTurn(ROOT);
      expect(await roundsOf(w)).toEqual([expect.objectContaining({ nodeId: JOIN, round: 1, expectedUpstream: [RA, RB], arrived: [expect.objectContaining({ fromNodeId: RA })], state: 'waiting' })]);
      expect(received(w, join)).toEqual([]);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await settle();
      const [round] = await roundsOf(w);
      expect(round).toMatchObject({ state: 'ready', arrived: [{ fromNodeId: RA }, { fromNodeId: RB }] });
      expect(round?.settledAt).toBeDefined();
      // One message each, in arrival order, each framed with its round.
      expect(received(w, join)).toEqual(['A: fine', 'B: fine']);
      const joinTexts = w.claude.dispatched.filter((d) => d.text.endsWith(': fine')).map((d) => d.text);
      expect(joinTexts.every((t) => t.includes('Round 1 of node "Verdict"'))).toBe(true);
      // The round counts once: the second arrival is no rework; only the first carried counts.
      const arrivals = await arrivalsAt(w);
      expect(arrivals.map((h) => [h.round, h.rework, h.expectedUpstream])).toEqual([
        [1, false, undefined],
        [1, false, [RA, RB]],
      ]);
      expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'running', reworkCount: 0 });
      // Verdict's briefing explains the wait; root's explains the fan-out.
      expect(w.claude.started.find((o) => o.sessionId === join)?.instructions).toContain('You wait for all upstream');
      expect(w.claude.started.find((o) => o.sessionId === ROOT)?.instructions).toContain('make all those handoffs in the same turn');
    });

    it('an untaken branch is not waited for', async () => {
      const w = await make(fanTemplate());
      const { ra } = await fanOut(w, false);
      await w.finishTurn(ROOT);
      await handoff(w, ra, { ...verdict, content: 'A only' });
      await settle();
      expect(await roundsOf(w)).toEqual([expect.objectContaining({ expectedUpstream: [RA], state: 'ready' })]);
      expect(received(w, await joinOf(w))).toEqual(['A only']);
    });

    it("a late result of the previous round counts there, never in the new round", async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await handoff(w, ra, { ...verdict, content: 'A1' });
      await w.finishTurn(ROOT);
      // Review B still works on round 1 when root fans out again: its new handoff waits for that turn.
      w.emitTurn(rb, 'b-busy', 'running');
      await settle();
      await fanOutAgain(w, 'root-2');
      expect(received(w, rb)).toEqual(['review B please']);
      await handoff(w, ra, { ...verdict, content: 'A2' });
      await settle();
      // B's round-1 result: round 1 completes, round 2 still waits for B.
      await handoff(w, rb, { ...verdict, content: 'B1' });
      await settle();
      const rounds = await roundsOf(w);
      expect(rounds.map((r) => [r.round, r.state, r.arrived.map((a) => a.fromNodeId)])).toEqual([
        [1, 'ready', [RA, RB]],
        [2, 'waiting', [RA]],
      ]);
      const join = await joinOf(w);
      expect(received(w, join)).toEqual(['A1', 'B1']);
      // B's turn ends, it gets round 2, and its result completes round 2.
      w.emitTurn(rb, 'b-busy', 'completed');
      await settle();
      expect(received(w, rb)).toEqual(['review B please', 'review B again']);
      await handoff(w, rb, { ...verdict, content: 'B2' });
      await settle();
      expect((await roundsOf(w)).map((r) => r.state)).toEqual(['ready', 'ready']);
      expect(received(w, join)).toEqual(['A1', 'B1', 'A2', 'B2']);
      // The second round is rework of Verdict, counted once (with the two reviews' second handoffs, three).
      expect((await arrivalsAt(w)).map((h) => [h.round, h.rework])).toEqual([
        [1, false],
        [2, true],
        [1, false],
        [2, false],
      ]);
      expect((await instanceOf(w)).tasks[0]?.reworkCount).toBe(3);
    });

    it('ordinary handoffs queued for a busy target still go one per turn in acceptance order (the gate change, T031)', async () => {
      const w = await make(template({ reworkLimit: 5 }));
      await started(w);
      await handoff(w, ROOT, { ruleId: 'to-impl', target: to(IMPL), content: 'plan' });
      const impl = await sessionOf(w, IMPL);
      await handoff(w, impl, { ruleId: 'to-review', target: to(REVIEW), content: 'first' });
      const review = await sessionOf(w, REVIEW);
      w.emitTurn(review, 'review-busy', 'running');
      await settle();
      for (const content of ['second', 'third', 'fourth']) await handoff(w, impl, { ruleId: 'to-review', target: to(REVIEW), content });
      await settle();
      expect(received(w, review)).toEqual(['first']);
      w.holding.add(review);
      w.emitTurn(review, 'review-busy', 'completed');
      await settle();
      // One at a time: the next waits for the turn the previous one started.
      expect(received(w, review)).toEqual(['first', 'second']);
      await w.finishTurn(review);
      expect(received(w, review)).toEqual(['first', 'second', 'third']);
      await w.finishTurn(review);
      expect(received(w, review)).toEqual(['first', 'second', 'third', 'fourth']);
    });

    it('a cancelled branch blocks the round and escalates it; the user declining cancels what arrived', async () => {
      const w = await make(fanTemplate());
      w.holding.add(ROOT);
      await started(w);
      // The branch to Review A ends unknown (CR-2): not taken as failed, the round waits.
      w.claude.dispatchModes.push('lost');
      expect(await handoff(w, ROOT, { ...toA, content: 'review A please' })).toMatchObject({ status: 'accepted', delivery: 'unknown' });
      await handoff(w, ROOT, toB);
      await w.finishTurn(ROOT);
      const rb = await sessionOf(w, RB);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await settle();
      expect(await roundsOf(w)).toEqual([expect.objectContaining({ state: 'waiting' })]);
      // The user cancels the unknown branch: the round is blocked, never completed and never shrunk.
      const [unknown] = await openOf(w, 'delivery-unknown');
      expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'cancel', acceptDuplicateRisk: false })).toMatchObject({ ok: true });
      await settle();
      const [round] = await roundsOf(w);
      expect(round).toMatchObject({ state: 'blocked', blockedReason: 'upstream-cancelled', blockedUpstream: RA, expectedUpstream: [RA, RB] });
      const [question] = await openOf(w, 'round-blocked');
      expect(question).toMatchObject({ id: round?.escalationId, rootSessionId: ROOT, ref: { kind: 'round', nodeId: JOIN, round: 1 } });
      expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'round-blocked' });
      const join = await joinOf(w);
      expect(received(w, join)).toEqual([]);
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: question!.id, decision: 'decline' })).toMatchObject({ ok: true });
      await settle();
      expect((await arrivalsAt(w))[0]?.outcome).toMatchObject({ kind: 'cancelled' });
      expect((await instanceOf(w)).tasks[0]).toMatchObject({ status: 'running' });
      expect((await instanceOf(w)).tasks[0]?.blockedReason).toBeUndefined();
      expect(await w.repositories.escalations.get(question!.id)).toMatchObject({ state: 'declined', resolvedBy: 'user' });
      expect(received(w, join)).toEqual([]);
      const after = await w.restart();
      await settle();
      expect(received(after, join)).toEqual([]);
    });

    it('a branch whose target session the user gave up creating blocks the round as cancelled', async () => {
      const w = await make(fanTemplate());
      w.holding.add(ROOT);
      await started(w);
      // Creating Review A's session ends unknown (CR2 §3): its branch stays pending, the round waits.
      w.claude.startModes.push('lost');
      expect(await handoff(w, ROOT, toA)).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await handoff(w, ROOT, toB);
      await w.finishTurn(ROOT);
      await handoff(w, await sessionOf(w, RB), { ...verdict, content: 'B: fine' });
      await settle();
      expect((await roundsOf(w))[0]?.state).toBe('waiting');
      const [unknown] = (await openOf(w, 'delivery-unknown')).filter((e) => e.ref?.kind === 'provision');
      expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: unknown!.id, decision: 'cancel', acceptDuplicateRisk: false })).toMatchObject({ ok: true });
      await settle();
      expect((await roundsOf(w))[0]).toMatchObject({ state: 'blocked', blockedReason: 'upstream-cancelled', blockedUpstream: RA });
      expect(await openOf(w, 'round-blocked')).toHaveLength(1);
    });

    it('a branch that went elsewhere and stopped blocks the round as cancelled; one still working is waited for', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      // Review A works on: a report to root during its turn is not the end of the branch.
      w.emitTurn(ra, 'a-busy', 'running');
      await settle();
      expect(await w.engine.reportToRoot({ content: 'A: a question', needsUserConfirmation: false }, { caller: ra, sourceCallRef: 'call-report-a' })).toMatchObject({ status: 'reported' });
      await settle();
      expect((await roundsOf(w))[0]?.state).toBe('waiting');
      // Its turn ends without a handoff to Verdict: it will not come.
      w.emitTurn(ra, 'a-busy', 'completed');
      await settle();
      expect((await roundsOf(w))[0]).toMatchObject({ state: 'blocked', blockedReason: 'upstream-cancelled', blockedUpstream: RA });
      expect(await openOf(w, 'round-blocked')).toHaveLength(1);
    });

    it('a branch whose turn ended without sending anything is still waited for', async () => {
      const w = await make(fanTemplate());
      const { rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await settle();
      expect((await roundsOf(w))[0]?.state).toBe('waiting');
    });

    it('a failed upstream blocks the round; the user approving delivers what arrived and what arrives later', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await settle();
      await endTurnOf(w, ra, 'failed');
      const [round] = await roundsOf(w);
      expect(round).toMatchObject({ state: 'blocked', blockedReason: 'upstream-failed', blockedUpstream: RA });
      const join = await joinOf(w);
      expect(received(w, join)).toEqual([]);
      // A handoff while the task is held is accepted and kept (a late upstream is not lost), not sent.
      expect(await handoff(w, ra, { ...verdict, content: 'A: late' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      expect(received(w, join)).toEqual([]);
      const [question] = await openOf(w, 'round-blocked');
      await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: question!.id, decision: 'approve' });
      await settle();
      // Still blocked (incomplete rounds are never ready); the user's approval releases it.
      expect((await roundsOf(w))[0]).toMatchObject({ state: 'blocked', arrived: [{ fromNodeId: RB }, { fromNodeId: RA }] });
      expect((await instanceOf(w)).tasks[0]?.status).toBe('running');
      expect(received(w, join)).toEqual(['B: fine', 'A: late']);
    });

    it('a stopped upstream turn, the GUI restart included, blocks the round', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await endTurnOf(w, ra, 'interrupted');
      expect((await roundsOf(w))[0]).toMatchObject({ state: 'blocked', blockedReason: 'upstream-failed', blockedUpstream: RA });
    });

    it('the wait limit blocks the round, by a timer or at a restart after it passed; an early timer does nothing', async () => {
      const w = await make(fanTemplate({ waitTimeoutMs: 60_000 }));
      const { ra } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, ra, { ...verdict, content: 'A: fine' });
      await settle();
      const [round] = await roundsOf(w);
      expect(round?.deadline).toBe(new Date(Date.parse(round!.openedAt) + 60_000).toISOString());
      expect(w.timers.size).toBe(1);
      // A timer that comes early (or twice) is checked against the clock.
      [...w.timers][0]!.fn();
      await settle();
      expect((await roundsOf(w))[0]?.state).toBe('waiting');
      // Down while the limit passed: the restart blocks it.
      advanceClock(61_000);
      const after = await w.restart();
      await settle();
      expect((await roundsOf(after))[0]).toMatchObject({ state: 'blocked', blockedReason: 'timeout' });
      expect(await openOf(after, 'round-blocked')).toHaveLength(1);
      expect(received(after, await joinOf(after))).toEqual([]);
    });

    it('a timer blocks the round when the limit passes while running', async () => {
      const w = await make(fanTemplate({ waitTimeoutMs: 30_000 }));
      const { ra } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, ra, { ...verdict, content: 'A: fine' });
      await settle();
      advanceClock(31_000);
      w.fireTimers();
      await settle();
      expect((await roundsOf(w))[0]).toMatchObject({ state: 'blocked', blockedReason: 'timeout' });
      expect(await openOf(w, 'round-blocked')).toHaveLength(1);
      expect(w.timers.size).toBe(0);
    });

    it('a restart in the middle of a fan-out closes it with the branches sent so far', async () => {
      const w = await make(fanTemplate());
      const { ra } = await fanOut(w, false);
      const after = await w.restart();
      await settle();
      await handoff(after, ra, { ...verdict, content: 'A only' });
      await settle();
      expect(await roundsOf(after)).toEqual([expect.objectContaining({ expectedUpstream: [RA], state: 'ready' })]);
      expect(received(after, await joinOf(after))).toEqual(['A only']);
    });

    it('a replayed old turn end does not close an open fan-out early', async () => {
      const w = await make(fanTemplate());
      const { ra } = await fanOut(w, false);
      w.emitTurn(ROOT, 'old-turn', 'completed');
      await settle();
      await handoff(w, ra, { ...verdict, content: 'A: fine' });
      await settle();
      expect(await roundsOf(w)).toEqual([]);
      await handoff(w, ROOT, { ...toB, content: 'review B please' });
      await w.finishTurn(ROOT);
      expect((await roundsOf(w))[0]).toMatchObject({ expectedUpstream: [RA, RB], state: 'waiting' });
      await handoff(w, await sessionOf(w, RB), { ...verdict, content: 'B: fine' });
      await settle();
      expect(received(w, await joinOf(w))).toEqual(['A: fine', 'B: fine']);
    });

    it('a crash between accepting the last arrival and writing its round: the restart makes it ready and sends each once', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, ra, { ...verdict, content: 'A: fine' });
      await settle();
      crashOnce(w.repositories.instances, 'update', (instance) => (instance as { rounds: { state: string }[] }).rounds.some((r) => r.state === 'ready'));
      expect(await handoff(w, rb, { ...verdict, content: 'B: fine' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      expect((await roundsOf(w))[0]?.state).toBe('waiting');
      const join = await joinOf(w);
      expect(received(w, join)).toEqual([]);
      const after = await w.restart();
      await settle();
      expect((await roundsOf(after))[0]?.state).toBe('ready');
      expect(received(after, join)).toEqual(['A: fine', 'B: fine']);
    });

    it('a crash between blocking a round and opening its question: the restart opens it once', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      crashOnce(w.repositories.escalations, 'upsert', (e) => (e as Escalation).kind === 'round-blocked');
      await endTurnOf(w, ra, 'failed');
      expect((await roundsOf(w))[0]?.state).toBe('blocked');
      expect(await openOf(w, 'round-blocked')).toHaveLength(0);
      expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
      const after = await w.restart();
      await settle();
      const open = await openOf(after, 'round-blocked');
      expect(open.map((e) => e.id)).toEqual([(await roundsOf(after))[0]?.escalationId]);
      expect(received(after, await joinOf(after))).toEqual([]);
    });

    it('a crash after the user approved and before it was carried out: the restart finishes it, sending once', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, rb, { ...verdict, content: 'B: fine' });
      await endTurnOf(w, ra, 'failed');
      const [question] = await openOf(w, 'round-blocked');
      crashOnce(w.repositories.instances, 'update');
      expect(await w.run({ type: 'escalation.respond', requestId: rid(), escalationId: question!.id, decision: 'approve' })).toMatchObject({ ok: true });
      await settle();
      const join = await joinOf(w);
      expect((await instanceOf(w)).tasks[0]?.status).toBe('blocked');
      expect(received(w, join)).toEqual([]);
      const after = await w.restart();
      await settle();
      expect((await instanceOf(after)).tasks[0]?.status).toBe('running');
      expect(received(after, join)).toEqual(['B: fine']);
    });

    it('a resent arrival is the same one, before and after a restart: counted and delivered once', async () => {
      const w = await make(fanTemplate());
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      const first = await handoff(w, ra, { ...verdict, content: 'A: fine' }, { operationId: 'op-a', sourceCallRef: 'call-a' });
      expect(await handoff(w, ra, { ...verdict, content: 'A: fine' }, { operationId: 'op-a', sourceCallRef: 'call-a' })).toMatchObject({ status: 'duplicate', handoffId: (first as { handoffId: string }).handoffId });
      const after = await w.restart();
      await settle();
      expect(await handoff(after, ra, { ...verdict, content: 'A: fine' }, { operationId: 'op-a-again', sourceCallRef: 'call-a' })).toMatchObject({ status: 'duplicate' });
      expect(await handoff(after, ra, { ...verdict, content: 'A: changed' }, { operationId: 'op-a' })).toMatchObject({ status: 'rejected', rejection: { reason: 'resend-mismatch' } });
      await handoff(after, rb, { ...verdict, content: 'B: fine' });
      await settle();
      expect((await roundsOf(after))[0]).toMatchObject({ state: 'ready', arrived: [{ fromNodeId: RA }, { fromNodeId: RB }] });
      expect(await arrivalsAt(after)).toHaveLength(2);
      expect(received(after, await joinOf(after))).toEqual(['A: fine', 'B: fine']);
    });

    it("a waiting node's receive limit counts rounds, not arrivals", async () => {
      const w = await make(fanTemplate({ acceptanceLimit: 1 }));
      const { ra, rb } = await fanOut(w);
      await w.finishTurn(ROOT);
      await handoff(w, ra, { ...verdict, content: 'A1' });
      expect(await handoff(w, rb, { ...verdict, content: 'B1' })).toMatchObject({ status: 'accepted' });
      await settle();
      await fanOutAgain(w, 'root-2');
      expect(await handoff(w, ra, { ...verdict, content: 'A2' })).toMatchObject({ status: 'escalated', reason: 'limit-exceeded' });
    });

    it('a writable node takes as many tasks as its concurrency; read-only nodes run free', async () => {
      const w = await make(template());
      await started(w);
      const instance = await instanceOf(w);
      const t1 = instance.tasks[0]!.id;
      const t2 = TaskId.parse(`${INSTANCE}:task-2`);
      await w.repositories.instances.update(
        { ...instance, revision: instance.revision + 1, tasks: [...instance.tasks, { id: t2, instanceId: INSTANCE, title: 'Second', dependsOn: [], status: 'running', reworkCount: 0 }] },
        instance.revision,
      );
      const toImpl = { ruleId: 'to-impl', target: to(IMPL) };
      const toReview = { ruleId: 'to-review', target: to(REVIEW) };
      const at = async (nodeId: NodeId, taskId: TaskId) => (await w.repositories.instances.findNodeSession({ instanceId: INSTANCE, nodeId, taskId }))!;
      expect(await handoff(w, ROOT, { ...toImpl, taskId: t1, content: 'one' })).toMatchObject({ delivery: 'sent' });
      // Implement (writable, concurrency 1) works on task 1: task 2 waits.
      expect(await handoff(w, ROOT, { ...toImpl, taskId: t2, content: 'two' })).toMatchObject({ status: 'accepted', delivery: 'pending' });
      await settle();
      const impl1 = await at(IMPL, t1);
      const impl2 = await at(IMPL, t2);
      expect(received(w, impl2)).toEqual([]);
      // Task 1 moves on to review: the slot is free and task 2 goes.
      await handoff(w, impl1, { ...toReview, content: 'done one' });
      await settle();
      expect(received(w, impl2)).toEqual(['two']);
      // Review is read-only: task 2's review goes while task 1's review turn still runs.
      const review1 = await at(REVIEW, t1);
      w.emitTurn(review1, 'review-busy', 'running');
      await settle();
      await handoff(w, impl2, { ...toReview, content: 'done two' });
      await settle();
      expect(received(w, await at(REVIEW, t2))).toEqual(['done two']);
      // After a restart the count comes from the records: task 1 back at implement takes the slot, task 2's return waits.
      const after = await w.restart();
      await settle();
      expect(await handoff(after, review1, { ruleId: 'rework', target: to(IMPL), content: 'again one' })).toMatchObject({ status: 'accepted', delivery: 'sent' });
      const review2 = await at(REVIEW, t2);
      await handoff(after, review2, { ruleId: 'rework', target: to(IMPL), content: 'again two' });
      await settle();
      expect(received(after, impl2)).toEqual([]);
    });

    it('two gates asking for the last slot at once: only one takes it', async () => {
      const w = await make(template());
      await started(w);
      const meta = (taskId: string, n: number): HandoffMeta => ({
        handoffId: HandoffId.parse(`handoff-race-${String(n)}`),
        instanceId: INSTANCE,
        taskId: TaskId.parse(taskId),
        fromNodeId: PLAN,
        toNodeId: IMPL,
        fromSessionId: ROOT,
        ruleId: 'to-impl',
        rework: false,
        round: 1,
      });
      const instance = await instanceOf(w);
      const t2 = `${INSTANCE}:task-2`;
      await w.repositories.instances.update(
        { ...instance, revision: instance.revision + 1, tasks: [...instance.tasks, { id: TaskId.parse(t2), instanceId: INSTANCE, title: 'Second', dependsOn: [], status: 'running', reworkCount: 0 }] },
        instance.revision,
      );
      const answers = await Promise.all([w.engine.mayDeliver(meta(instance.tasks[0]!.id, 1)), w.engine.mayDeliver(meta(t2, 2))]);
      expect(answers.filter(Boolean)).toHaveLength(1);
    });
  });

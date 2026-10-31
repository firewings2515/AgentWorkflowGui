// T031: the pure round rules (CR-4) on hand-made handoffs: where an arrival counts, what a round expects, and
// that a round only moves forward.
import { describe, expect, it } from 'vitest';
import { type Handoff, HandoffId, InstanceId, type JoinRound, NodeId, OperationId, SessionId, TaskId, type TurnState } from '../../contracts';
import { PLAN } from './testing/harness';
import { fanTemplate, JOIN, RA, RB } from './testing/t031-cases';
import { deriveRounds, expectedOf, lineageOf, nextRound, planArrival } from './rounds';

const TASK = TaskId.parse('run-1:task');
const template = fanTemplate();
let n = 0;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 31, 0, 0, 0, ms)).toISOString();

/** A handoff; `sentAt` makes it cross the dispatch boundary then (with `turn` as its turn). */
const h = (from: NodeId, to: NodeId, round: number, extra: { sentAt?: number; turn?: string; expectedUpstream?: NodeId[]; outcome?: Handoff['outcome'] } = {}): Handoff => {
  const id = ++n;
  const attempt = { attemptId: `a-${String(id)}`, clientMessageId: `c-${String(id)}`, dispatchStartedAt: at(extra.sentAt ?? 0) };
  return {
    id: HandoffId.parse(`handoff-${String(id)}`),
    operationId: OperationId.parse(`op-${String(id)}`),
    sourceCallRef: `call-${String(id)}`,
    instanceId: InstanceId.parse('run-1'),
    taskId: TASK,
    fromNodeId: from,
    toNodeId: to,
    fromSessionId: SessionId.parse(`s-${from}`),
    ruleId: 'r',
    rework: false,
    payload: 'x',
    payloadHash: 'sha256:00',
    proposalRevision: 0,
    round,
    ...(extra.expectedUpstream !== undefined && { expectedUpstream: extra.expectedUpstream }),
    target: { sessionId: SessionId.parse(`s-${to}`), nativeSessionRef: `n-${to}` },
    delivery:
      extra.sentAt === undefined
        ? { state: 'pending', attempts: [] }
        : {
            state: 'sent',
            attempts: [{ ...attempt, state: 'sent', nativeRef: { sessionRef: `n-${to}`, ...(extra.turn !== undefined && { turnRef: extra.turn }) }, evidence: { kind: 'live-ack', at: at(extra.sentAt), detail: 'ack' } }],
          },
    ...(extra.outcome !== undefined && { outcome: extra.outcome }),
    acceptedAt: at(id),
  } as Handoff;
};

const facts = (turns: Record<string, TurnState> = {}, now = at(1000), open: number[] = []) => ({
  open: new Set(open),
  provisionCancelled: () => false,
  sentTo: () => undefined,
  turnOf: (x: Handoff) => {
    const last = x.delivery.attempts.at(-1);
    return last?.state === 'sent' && last.nativeRef.turnRef !== undefined ? turns[last.nativeRef.turnRef] : undefined;
  },
  now,
  escalationIdOf: (r: Pick<JoinRound, 'nodeId' | 'round'>) => `esc-${r.nodeId}-${String(r.round)}` as JoinRound['escalationId'],
});

describe('T031 round rules', () => {
  it('an arrival joins the round of the fan-out that sent its sender; the round expects only the branches sent', () => {
    const toA = h(PLAN, RA, 1, { sentAt: 10 });
    const handoffs = [toA];
    expect(expectedOf(template, handoffs, TASK, 1, JOIN)).toEqual([RA]);
    expect(planArrival(template, handoffs, [], TASK, RA, JOIN, new Set(), 2, lineageOf(handoffs, TASK, RA))).toEqual({ round: 1, expectedUpstream: [RA], first: true });
    // While the fan-out is open the set is not fixed yet.
    expect(planArrival(template, handoffs, [], TASK, RA, JOIN, new Set([1]), 2, lineageOf(handoffs, TASK, RA))).toEqual({ round: 1, first: true });
  });

  it('an arrival without a fan-out behind it, or a second one from the same upstream, is a round of its own', () => {
    expect(planArrival(template, [], [], TASK, RA, JOIN, new Set(), 4, lineageOf([], TASK, RA))).toEqual({ round: 4, expectedUpstream: [RA], first: true });
    const handoffs = [h(PLAN, RA, 1, { sentAt: 10 }), h(PLAN, RB, 1, { sentAt: 11 }), h(RA, JOIN, 1)];
    expect(planArrival(template, handoffs, [], TASK, RA, JOIN, new Set(), 5, lineageOf(handoffs, TASK, RA))).toEqual({ round: 5, expectedUpstream: [RA], first: true });
    expect(planArrival(template, handoffs, [], TASK, RB, JOIN, new Set(), 5, lineageOf(handoffs, TASK, RB))).toEqual({ round: 1, expectedUpstream: [RA, RB], first: false });
    expect(nextRound(handoffs, [], TASK, [3])).toBe(4);
  });

  it("the lineage is the last handoff that crossed the boundary, so a queued newer one does not move the sender's work", () => {
    const handoffs = [h(PLAN, RB, 1, { sentAt: 10 }), h(PLAN, RB, 2)];
    expect(planArrival(template, handoffs, [], TASK, RB, JOIN, new Set(), 3, lineageOf(handoffs, TASK, RB)).round).toBe(1);
  });

  it('a round only moves forward: blocked stays blocked when the rest arrives, and its set never shrinks', () => {
    const handoffs = [h(PLAN, RA, 1, { sentAt: 10 }), h(PLAN, RB, 1, { sentAt: 11, turn: 't-b' }), h(RA, JOIN, 1, { expectedUpstream: [RA, RB] })];
    const [blocked] = deriveRounds(template, TASK, handoffs, [], facts({ 't-b': 'failed' }));
    expect(blocked).toMatchObject({ state: 'blocked', blockedReason: 'upstream-failed', blockedUpstream: RB, expectedUpstream: [RA, RB], escalationId: 'esc-verdict-1' });
    const later = deriveRounds(template, TASK, [...handoffs, h(RB, JOIN, 1)], [blocked!], facts());
    expect(later).toEqual([{ ...blocked, arrived: [...blocked!.arrived, expect.objectContaining({ fromNodeId: RB })] }]);
  });

  it('no round while its fan-out is open; an outcome on a branch blocks; the wait limit blocks once passed', () => {
    const handoffs = [h(PLAN, RA, 1, { sentAt: 10 }), h(PLAN, RB, 1, { outcome: { kind: 'cancelled', detail: 'x', at: at(12) } }), h(RA, JOIN, 1)];
    expect(deriveRounds(template, TASK, handoffs, [], facts({}, at(1000), [1]))).toEqual([]);
    expect(deriveRounds(template, TASK, handoffs, [], facts())[0]).toMatchObject({ state: 'blocked', blockedReason: 'upstream-cancelled', blockedUpstream: RB });
    const timed = fanTemplate({ waitTimeoutMs: 100 });
    const waiting = [h(PLAN, RA, 1, { sentAt: 10 }), h(PLAN, RB, 1, { sentAt: 11 }), h(RA, JOIN, 1)];
    // The wait starts at the round's first arrival, wherever the round is first written (r1-P1-5).
    const first = Date.parse(waiting[2]!.acceptedAt) - Date.UTC(2026, 9, 31);
    const [round] = deriveRounds(timed, TASK, waiting, [], facts({}, at(first + 50)));
    expect(round).toMatchObject({ state: 'waiting', openedAt: at(first), deadline: at(first + 100) });
    expect(deriveRounds(timed, TASK, waiting, [round!], facts({}, at(first + 99)))[0]?.state).toBe('waiting');
    expect(deriveRounds(timed, TASK, waiting, [round!], facts({}, at(first + 100)))[0]).toMatchObject({ state: 'blocked', blockedReason: 'timeout' });
    // Written only after the limit passed (a crash between the acceptance and the round): blocked at once.
    expect(deriveRounds(timed, TASK, waiting, [], facts({}, at(first + 500)))[0]).toMatchObject({ state: 'blocked', blockedReason: 'timeout' });
  });
});

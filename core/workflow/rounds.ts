// Rounds of nodes that wait for all upstream (R-04, CR-4), as pure functions over the pinned template and the
// handoffs, which are the one record of what was accepted: `WorkflowInstance.rounds` can always be rebuilt
// from them (a crash between accepting a handoff and writing its round only delays the round).
//
// A fan-out is one group: the handoffs one source session makes for a task within one turn of its own. Each
// group opens a round, and the handoffs of the group carry it. A handoff to a waiting node is an arrival: it
// counts in the round of the work its sender was handed (its lineage), and that round expects exactly the
// nodes the group actually sent the task to that have an edge to the waiting node. Anything else is a round
// of its own that waits for nobody.
import { type Handoff, type JoinRound, type NodeId, type TaskId, type Timestamp, type TurnState, type WorkflowNode, type WorkflowTemplate, finalTaskStatuses, type WorkflowInstance } from '../../contracts';
import { hasEdge, nodeOf } from './graph';

/** A node waits for all upstream when any of its input rules says so (a handoff names no input rule, T024 G-2). */
export const waitsForAll = (node: WorkflowNode | undefined): boolean => node?.inputRules.some((r) => r.waitForAllUpstream) === true;

/** The wait limit of a waiting node: the smallest one its waiting rules set. */
export const waitLimitMs = (node: WorkflowNode | undefined): number | undefined => {
  const limits = (node?.inputRules ?? []).flatMap((r) => (r.waitForAllUpstream && r.waitTimeoutMs !== undefined ? [r.waitTimeoutMs] : []));
  return limits.length === 0 ? undefined : Math.min(...limits);
};

/** Whether a handoff arrives at a waiting node (counted in its round) rather than being a member of a fan-out. */
export const isArrival = (template: WorkflowTemplate, handoff: Pick<Handoff, 'toNodeId'>): boolean => waitsForAll(nodeOf(template, handoff.toNodeId));

const byTime = (a: string | undefined, b: string | undefined) => (a === b ? 0 : (a ?? '') < (b ?? '') ? -1 : 1);

/** When a handoff crossed the dispatch boundary (its last attempt), or undefined while it is pending. */
export const dispatchedAt = (handoff: Handoff): Timestamp | undefined => (handoff.delivery.state === 'pending' ? undefined : handoff.delivery.attempts.at(-1)?.dispatchStartedAt);

/** The handoff a node works on for a task: the last one to it that crossed the dispatch boundary. */
export const lineageOf = (handoffs: readonly Handoff[], taskId: TaskId, nodeId: NodeId): Handoff | undefined =>
  handoffs
    .filter((h) => h.taskId === taskId && h.toNodeId === nodeId && dispatchedAt(h) !== undefined)
    .sort((a, b) => byTime(dispatchedAt(a), dispatchedAt(b)) || byTime(a.acceptedAt, b.acceptedAt))
    .at(-1);

/** The next round number of a task: above every round its handoffs, its rounds and its open groups carry. */
export const nextRound = (handoffs: readonly Handoff[], rounds: readonly JoinRound[], taskId: TaskId, open: Iterable<number>): number =>
  1 + Math.max(0, ...handoffs.filter((h) => h.taskId === taskId).map((h) => h.round), ...rounds.filter((r) => r.taskId === taskId).map((r) => r.round), ...open);

/**
 * The upstream a round of a waiting node expects: the nodes the round's group actually sent the task to that
 * have an edge to it, in template order. An untaken branch is not in the group, so it is never waited for.
 */
export const expectedOf = (template: WorkflowTemplate, handoffs: readonly Handoff[], taskId: TaskId, round: number, joinNode: NodeId): NodeId[] =>
  template.nodes
    .filter((n) => n.id !== joinNode && hasEdge(template, n.id, joinNode))
    .filter((n) => handoffs.some((h) => h.taskId === taskId && h.round === round && h.toNodeId === n.id && !isArrival(template, h)))
    .map((n) => n.id);

/** Where an arrival counts: its round, the upstream expected in it when already fixed, and whether it is the round's first. */
export interface ArrivalPlan {
  round: number;
  expectedUpstream?: NodeId[];
  first: boolean;
}

/**
 * The round an arrival from `from` at waiting node `to` counts in. It joins the round of its lineage when that
 * lineage is a fan-out member and the round still takes `from`; `expectedUpstream` is left out while the
 * group is open (not fixed yet). Otherwise it is a round of its own (`fresh`) that expects only `from`.
 */
export const planArrival = (
  template: WorkflowTemplate,
  handoffs: readonly Handoff[],
  rounds: readonly JoinRound[],
  taskId: TaskId,
  from: NodeId,
  to: NodeId,
  open: ReadonlySet<number>,
  fresh: number,
): ArrivalPlan => {
  const lineage = lineageOf(handoffs, taskId, from);
  if (lineage !== undefined && !isArrival(template, lineage)) {
    const r = lineage.round;
    const arrivals = handoffs.filter((h) => h.taskId === taskId && h.toNodeId === to && h.round === r);
    const stored = rounds.find((x) => x.taskId === taskId && x.nodeId === to && x.round === r);
    const expected = stored?.expectedUpstream ?? (open.has(r) ? undefined : expectedOf(template, handoffs, taskId, r, to));
    if (!arrivals.some((h) => h.fromNodeId === from) && (expected === undefined || expected.includes(from)))
      return { round: r, ...(expected !== undefined && { expectedUpstream: [...expected] }), first: arrivals.length === 0 };
  }
  return { round: fresh, expectedUpstream: [from], first: true };
};

/** The line an arrival's frame carries, from its stored round and expected set only (so a resend frames it the same). */
export const roundNote = (template: WorkflowTemplate, to: WorkflowNode, round: number, expected: readonly NodeId[] | undefined): string => {
  const label = (id: NodeId) => `"${nodeOf(template, id)?.label ?? id}"`;
  const waits = expected === undefined ? 'every node its fan-out sent the task to that hands off to you' : expected.map(label).join(', ');
  return `Round ${String(round)} of node "${to.label}": it waits for ${waits}. The GUI holds this round's handoffs until all have arrived, then delivers them one message each, in arrival order.`;
};

/** What `deriveRounds` reads besides the handoffs. */
export interface RoundFacts {
  /** Rounds whose group is still open (their expected set is not fixed yet). */
  open: ReadonlySet<number>;
  /** The state of the turn a fan-out member started (by its sent attempt's turn), when known. */
  turnOf(handoff: Handoff): TurnState | undefined;
  /** Whether the user cancelled creating the session a still pending fan-out member waits for (CR2 §3). */
  provisionCancelled(handoff: Handoff): boolean;
  /**
   * Where the node a sent fan-out member went to sent the task while working on it (node IDs, `report` for a
   * report to root), known only once that node has no turn running; undefined while it may still send more.
   */
  sentTo(handoff: Handoff): ReadonlySet<string> | undefined;
  now: Timestamp;
  escalationIdOf(round: Pick<JoinRound, 'taskId' | 'nodeId' | 'round'>): JoinRound['escalationId'];
}

type Block = Pick<JoinRound, 'blockedReason' | 'blockedUpstream'>;

const outcomeBlock = (handoff: Handoff, upstream: NodeId): Block | undefined => {
  if (handoff.outcome !== undefined) return { blockedReason: handoff.outcome.kind === 'cancelled' ? 'upstream-cancelled' : 'upstream-failed', blockedUpstream: upstream };
  const last = handoff.delivery.attempts.at(-1);
  // The user cancelled an unknown delivery of it (CR2 §2): the branch may never have started.
  if (handoff.delivery.state === 'unknown' && last?.resolution?.decision === 'cancel') return { blockedReason: 'upstream-cancelled', blockedUpstream: upstream };
  return undefined;
};

/** Why a waiting round is blocked now, if it is: an upstream failed or was cancelled, or its wait limit passed. */
const blockOf = (template: WorkflowTemplate, own: readonly Handoff[], round: JoinRound, facts: RoundFacts): Block | undefined => {
  for (const upstream of round.expectedUpstream) {
    const arrived = round.arrived.find((a) => a.fromNodeId === upstream);
    if (arrived !== undefined) {
      const handoff = own.find((h) => h.id === arrived.handoffId);
      const block = handoff === undefined ? undefined : outcomeBlock(handoff, upstream);
      if (block !== undefined) return block;
      continue;
    }
    const member = own.filter((h) => h.round === round.round && h.toNodeId === upstream && !isArrival(template, h)).at(-1);
    if (member === undefined) continue;
    const block = outcomeBlock(member, upstream);
    if (block !== undefined) return block;
    if (member.delivery.state === 'pending' && facts.provisionCancelled(member)) return { blockedReason: 'upstream-cancelled', blockedUpstream: upstream };
    const turn = facts.turnOf(member);
    if (turn === 'failed' || turn === 'interrupted') return { blockedReason: 'upstream-failed', blockedUpstream: upstream };
    // The branch went elsewhere and its node stopped: it will not come (main session ruling on G-3).
    const sent = facts.sentTo(member);
    if (sent !== undefined && !sent.has(round.nodeId)) return { blockedReason: 'upstream-cancelled', blockedUpstream: upstream };
  }
  if (round.deadline !== undefined && Date.parse(facts.now) >= Date.parse(round.deadline)) return { blockedReason: 'timeout' };
  return undefined;
};

const plus = (at: Timestamp, ms: number): Timestamp => new Date(Date.parse(at) + ms).toISOString();

/**
 * The rounds a task should have now. A round is made once its group is closed and an arrival exists; its
 * expected set never changes after that, arrivals are only added, and it only moves forward: waiting to
 * ready (everything expected arrived) or blocked (never taken as complete). Stored rounds are kept as they are.
 */
export const deriveRounds = (template: WorkflowTemplate, taskId: TaskId, handoffs: readonly Handoff[], stored: readonly JoinRound[], facts: RoundFacts): JoinRound[] => {
  const own = handoffs.filter((h) => h.taskId === taskId).sort((a, b) => byTime(a.acceptedAt, b.acceptedAt));
  const arrivals = own.filter((h) => isArrival(template, h));
  const rounds: JoinRound[] = stored.filter((r) => r.taskId === taskId).map((r) => ({ ...r, expectedUpstream: [...r.expectedUpstream], arrived: [...r.arrived] }));
  for (const arrival of arrivals) {
    let round = rounds.find((r) => r.nodeId === arrival.toNodeId && r.round === arrival.round);
    if (round === undefined) {
      if (facts.open.has(arrival.round)) continue;
      const node = nodeOf(template, arrival.toNodeId);
      const fixed = arrival.expectedUpstream ?? expectedOf(template, own, taskId, arrival.round, arrival.toNodeId);
      const froms = arrivals.filter((h) => h.toNodeId === arrival.toNodeId && h.round === arrival.round).map((h) => h.fromNodeId);
      const expectedUpstream = [...new Set([...fixed, ...froms])];
      const limit = waitLimitMs(node);
      round = { taskId, nodeId: arrival.toNodeId, round: arrival.round, expectedUpstream, arrived: [], state: 'waiting', openedAt: facts.now, ...(limit !== undefined && { deadline: plus(facts.now, limit) }) };
      rounds.push(round);
    }
    if (round.expectedUpstream.includes(arrival.fromNodeId) && !round.arrived.some((a) => a.fromNodeId === arrival.fromNodeId)) round.arrived.push({ fromNodeId: arrival.fromNodeId, handoffId: arrival.id });
  }
  for (const round of rounds) {
    if (round.state !== 'waiting') continue;
    const block = blockOf(template, own, round, facts);
    if (block !== undefined) {
      Object.assign(round, { state: 'blocked', ...block, settledAt: facts.now, escalationId: facts.escalationIdOf(round) });
    } else if (round.expectedUpstream.every((n) => round.arrived.some((a) => a.fromNodeId === n))) {
      Object.assign(round, { state: 'ready', settledAt: facts.now });
    }
  }
  return rounds;
};

/** Whether a node's concurrency limits how many tasks it works on at once: read-only nodes run free (R-06). */
export const concurrencyOf = (node: WorkflowNode | undefined): number | undefined =>
  node === undefined || node.kind !== 'agent' || node.isRoot || node.writePolicy === 'read-only' ? undefined : node.concurrency;

/**
 * The tasks that occupy a node (R-06 concurrency): a handoff of the task to it crossed the dispatch boundary
 * and the node has not handed that task on since. Final tasks occupy nothing.
 */
export const occupyingTasks = (instance: WorkflowInstance, handoffs: readonly Handoff[], nodeId: NodeId): Set<TaskId> => {
  const tasks = new Set<TaskId>();
  for (const task of instance.tasks) {
    if (finalTaskStatuses.includes(task.status)) continue;
    const received = handoffs.filter((h) => h.taskId === task.id && h.toNodeId === nodeId && h.outcome === undefined && dispatchedAt(h) !== undefined);
    const last = received.sort((a, b) => byTime(dispatchedAt(a), dispatchedAt(b))).at(-1);
    if (last === undefined) continue;
    const since = dispatchedAt(last);
    if (!handoffs.some((h) => h.taskId === task.id && h.fromNodeId === nodeId && byTime(h.acceptedAt, since) > 0)) tasks.add(task.id);
  }
  return tasks;
};

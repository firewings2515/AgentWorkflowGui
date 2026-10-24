import { describe, expect, it } from 'vitest';
import {
  AgentDefinition,
  AppEvent,
  CONTRACTS_VERSION,
  Command,
  CommandItem,
  CommandResult,
  DeliveryRecord,
  Escalation,
  EventEnvelope,
  Handoff,
  LogicalSession,
  Message,
  PeerMessage,
  PermissionRequest,
  Snapshot,
  TokenUsage,
  TransferProposal,
  Turn,
  UiPreferences,
  WorkflowTemplate,
} from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const at = '2026-10-24T10:00:00+08:00';
const uuid = (n: number) => `6f1c2a4e-8b3d-4c7a-9e21-${n.toString().padStart(12, '0')}`;
/** Fixture entry by index, failing loudly instead of returning undefined. */
const pick = <T>(xs: readonly T[], i: number): T => {
  const x = xs[i];
  if (x === undefined) throw new Error(`fixture has no entry ${i}`);
  return x;
};
const ok = (schema: { safeParse: (x: unknown) => { success: boolean } }, x: unknown) => schema.safeParse(x).success;

describe('fixtures', () => {
  it('match the snapshot schema', () => {
    const r = Snapshot.safeParse(fixtureSnapshotInput);
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it('cover the cases the UI needs', () => {
    const s = fixtureSnapshot;
    expect(s.sessions.some((x) => x.kind === 'ordinary')).toBe(true);
    expect(s.sessions.some((x) => x.kind === 'workflow')).toBe(true);
    expect(s.sessions.some((x) => x.derivedFromSessionId !== undefined)).toBe(true);
    expect(s.nativeTasks.length).toBeGreaterThan(0);
    expect(s.messages.some((m) => m.nativeTaskId !== undefined)).toBe(true);
    expect(s.instances[0]?.tasks.length).toBeGreaterThan(1);
    expect(s.instances[0]?.tasks.some((task) => task.dependsOn.length > 0)).toBe(true);
    expect(s.escalations.some((e) => e.state === 'open')).toBe(true);
    expect(new Set(s.modelOptions.map((m) => m.runtime))).toEqual(new Set(['claude', 'codex']));
    expect(new Set(s.artifacts.map((a) => a.section))).toEqual(new Set(['input', 'output']));
    expect(new Set(s.peerMessages.map((m) => m.delivery.state))).toEqual(new Set(['sent', 'unknown']));
    expect(new Set(s.items.map((i) => i.kind))).toEqual(new Set(['command', 'fileChange', 'toolCall']));
    expect(s.permissionRequests.some((p) => p.state === 'held')).toBe(true);
    expect(s.handoffs.length).toBeGreaterThan(0);
  });

  it('reference existing entities', () => {
    const s = fixtureSnapshot;
    const sessionIds = new Set<string>(s.sessions.map((x) => x.id));
    const agentIds = new Set<string>(s.agents.map((x) => x.id));
    const nodeIds = new Set<string>(s.workflows.flatMap((w) => w.nodes.map((n) => n.id)));
    const nativeTaskIds = new Set<string>(s.nativeTasks.map((x) => x.id));
    const turnIds = new Set<string>(s.turns.map((x) => x.id));
    const ids = (xs: readonly { id: string }[]) => new Set<string>(xs.map((x) => x.id));
    const [handoffIds, peerIds, permIds, escIds, transferIds] = [ids(s.handoffs), ids(s.peerMessages), ids(s.permissionRequests), ids(s.escalations), ids(s.transfers)];
    const inSession = (x: { sessionId: string; turnId?: string | undefined; nativeTaskId?: string | undefined }) => {
      expect(sessionIds.has(x.sessionId)).toBe(true);
      if (x.turnId) expect(turnIds.has(x.turnId)).toBe(true);
      if (x.nativeTaskId) expect(nativeTaskIds.has(x.nativeTaskId)).toBe(true);
    };
    for (const x of s.sessions) {
      expect(agentIds.has(x.agent.id)).toBe(true);
      if (x.parentId) expect(sessionIds.has(x.parentId)).toBe(true);
      if (x.derivedFromSessionId) expect(sessionIds.has(x.derivedFromSessionId)).toBe(true);
      if (x.kind === 'workflow') expect(nodeIds.has(x.workflow.nodeId)).toBe(true);
    }
    for (const m of s.messages) {
      inSession(m);
      if (m.origin.kind === 'peer') expect(peerIds.has(m.origin.peerMessageId)).toBe(true);
      if (m.origin.kind === 'handoff') expect(handoffIds.has(m.origin.handoffId)).toBe(true);
    }
    for (const x of [...s.items, ...s.permissionRequests, ...s.artifacts, ...s.turns, ...s.nativeTasks]) inSession(x);
    for (const p of s.permissionRequests) if (p.hold?.escalationId) expect(escIds.has(p.hold.escalationId)).toBe(true);
    for (const h of s.handoffs) if (h.target.sessionId) expect(sessionIds.has(h.target.sessionId)).toBe(true);
    for (const m of s.peerMessages) expect(sessionIds.has(m.fromSessionId) && sessionIds.has(m.toSessionId)).toBe(true);
    for (const tr of s.transfers) if (tr.createdSessionId) expect(sessionIds.has(tr.createdSessionId)).toBe(true);
    for (const e of s.escalations) {
      if (e.ref?.kind === 'permission') expect(permIds.has(e.ref.permissionRequestId)).toBe(true);
      if (e.ref?.kind === 'peerMessage') expect(peerIds.has(e.ref.peerMessageId)).toBe(true);
      if (e.ref?.kind === 'handoff') expect(handoffIds.has(e.ref.handoffId)).toBe(true);
      if (e.ref?.kind === 'transfer') expect(transferIds.has(e.ref.transferId)).toBe(true);
    }
  });

  it('keep the task-list confirmation consistent with progress', () => {
    const confirm = fixtureSnapshot.escalations.find((e) => e.kind === 'confirmation');
    const started = fixtureSnapshot.instances[0]?.tasks.some((task) => task.status !== 'pending');
    expect(started && confirm?.state === 'approved').toBe(true);
  });
});

describe('contract rules', () => {
  const agent = { schemaVersion: CONTRACTS_VERSION, id: 'a', revision: 0, name: 'n', description: '', instructions: 'i', updatedAt: at };

  it('AgentDefinition rejects a model field (COM-01, HC-01)', () => {
    expect(ok(AgentDefinition, agent)).toBe(true);
    expect(ok(AgentDefinition, { ...agent, model: 'claude-opus-5-5' })).toBe(false);
    expect(ok(AgentDefinition, { ...agent, defaultModel: 'x' })).toBe(false);
  });

  it('serialized boundaries carry the schema version', () => {
    expect(ok(Snapshot, { ...fixtureSnapshotInput, schemaVersion: '0.1.0' })).toBe(false);
    expect(ok(Snapshot, { ...fixtureSnapshotInput, schemaVersion: undefined })).toBe(false);
    expect(ok(AgentDefinition, { ...agent, schemaVersion: undefined })).toBe(false);
    const event = { type: 'session.activity', sessionId: 's1', activity: 'running', at };
    expect(ok(EventEnvelope, { schemaVersion: CONTRACTS_VERSION, seq: 1, event })).toBe(true);
    expect(ok(EventEnvelope, { seq: 1, event })).toBe(false);
  });

  it('commands require a requestId and explicit targets (HC-05)', () => {
    const send = { type: 'session.send', requestId: 'r1', sessionId: 's1', messageId: 'm1', expectedRevision: 2, text: 'hi' };
    expect(ok(Command, send)).toBe(true);
    expect(ok(Command, { ...send, requestId: undefined })).toBe(false);
    expect(ok(Command, { ...send, sessionId: undefined })).toBe(false);
    expect(ok(Command, { type: 'session.unknown', requestId: 'r1' })).toBe(false);
  });

  it('create commands carry the new entity ID and results return a receipt', () => {
    const create = { type: 'session.create', requestId: 'r1', sessionId: 's-new', kind: 'ordinary', agentId: 'a', model: { runtime: 'claude', model: 'claude-opus-5-5' }, cwd: 'E:/w' };
    expect(ok(Command, create)).toBe(true);
    expect(ok(Command, { ...create, sessionId: undefined })).toBe(false);
    const start = { type: 'workflow.start', requestId: 'r2', instanceId: 'i1', rootSessionId: 's-root', workflowId: 'w', workflowRevision: 1, title: 't', cwd: 'E:/w', firstMessage: 'go', crossToolConsent: true };
    expect(ok(Command, start)).toBe(true);
    expect(ok(Command, { ...start, rootSessionId: undefined })).toBe(false);
    const prepare = { type: 'transfer.prepare', requestId: 'r3', sourceSessionId: 's1', target: { runtime: 'codex', model: 'gpt-6-astra' }, noteSource: 'gui-digest' };
    expect(ok(Command, prepare)).toBe(false);
    expect(ok(Command, { ...prepare, transferId: 'tr-new' })).toBe(true);
    expect(ok(CommandResult, { ok: true, requestId: 'r1', created: [{ kind: 'session', id: 's-new' }] })).toBe(true);
  });

  it('a delivery retry needs explicit duplicate-risk acceptance (CR-2)', () => {
    const resolve = { type: 'delivery.resolve', requestId: 'r1', escalationId: 'esc-3', decision: 'retry', acceptDuplicateRisk: false };
    expect(ok(Command, resolve)).toBe(false);
    expect(ok(Command, { ...resolve, acceptDuplicateRisk: true })).toBe(true);
    expect(ok(Command, { ...resolve, decision: 'wait' })).toBe(true);
  });

  it('error results say whether a side effect may have happened', () => {
    const err = { ok: false, requestId: 'r1', code: 'unknown_outcome', message: 'm', retryable: false, mayHaveSideEffects: true };
    expect(ok(CommandResult, err)).toBe(true);
    const missing: Record<string, unknown> = { ...err };
    delete missing.mayHaveSideEffects;
    expect(ok(CommandResult, missing)).toBe(false);
  });

  it('events are validated at runtime', () => {
    expect(ok(AppEvent, { type: 'session.activity', sessionId: 's1', activity: 'running', at })).toBe(true);
    expect(ok(AppEvent, { type: 'session.activity', sessionId: 's1', activity: 'thinking', at })).toBe(false);
  });

  it('theme defaults to dark (R-15)', () => {
    expect(UiPreferences.parse({}).theme).toBe('dark');
  });

  it('timestamps need an offset', () => {
    const base = pick(fixtureSnapshotInput.sessions, 0);
    expect(ok(LogicalSession, { ...base, createdAt: '2026-10-24T10:00:00' })).toBe(false);
  });
});

describe('sessions, messages and runtime items', () => {
  it('session kind and workflow binding agree (WB-02)', () => {
    const ordinary = pick(fixtureSnapshotInput.sessions, 0);
    const wf = fixtureSnapshotInput.sessions.find((s) => s.kind === 'workflow');
    if (wf?.kind !== 'workflow') throw new Error('fixture lacks a workflow session');
    expect(ok(LogicalSession, { ...ordinary, workflow: wf.workflow })).toBe(false);
    expect(ok(LogicalSession, { ...wf, workflow: undefined })).toBe(false);
  });

  it('messages keep the per-reply model and their sub-agent (R-12, R-13)', () => {
    const reply = { id: 'm', sessionId: 's', role: 'assistant', origin: { kind: 'agent' }, text: 'x', observedModel: 'claude-haiku-5-5', nativeTaskId: 'nt', createdAt: at };
    expect(ok(Message, reply)).toBe(true);
    expect(ok(Message, { ...reply, role: 'user', origin: { kind: 'user' } })).toBe(false);
    expect(ok(Message, { ...reply, origin: { kind: 'user' } })).toBe(false);
    expect(ok(Message, { ...reply, role: 'user', observedModel: undefined, origin: { kind: 'peer', fromSessionId: 's2' } })).toBe(false);
  });

  it('turns end consistently', () => {
    const turn = { id: 't', sessionId: 's', state: 'completed', startedAt: at, endedAt: at };
    expect(ok(Turn, turn)).toBe(true);
    expect(ok(Turn, { ...turn, endedAt: undefined })).toBe(false);
    expect(ok(Turn, { ...turn, state: 'running' })).toBe(false);
  });

  it('token usage separates the latest report from the cumulative total', () => {
    const counts = { input: 1, output: 1, total: 2 };
    expect(ok(TokenUsage, { sessionId: 's', latest: counts, at })).toBe(true);
    expect(ok(TokenUsage, { sessionId: 's', cumulative: counts, at })).toBe(true);
    expect(ok(TokenUsage, { sessionId: 's', at })).toBe(false);
  });

  it('permission requests can be held, and only policy or the user decides (R-05, R-07)', () => {
    const req = { id: 'p', sessionId: 's', kind: 'fileChange', summary: 'edit a.ts', paths: ['a.ts'], state: 'held', hold: { reason: 'file-lock', until: at, lockPath: 'a.ts' }, createdAt: at };
    expect(ok(PermissionRequest, req)).toBe(true);
    expect(ok(PermissionRequest, { ...req, hold: { reason: 'file-lock' } })).toBe(false);
    expect(ok(PermissionRequest, { ...req, hold: undefined })).toBe(false);
    const answered = { ...req, state: 'answered', hold: undefined };
    expect(ok(PermissionRequest, { ...answered, decision: { outcome: 'approve', decidedBy: 'policy', at } })).toBe(true);
    expect(ok(PermissionRequest, { ...answered, decision: { outcome: 'approve', decidedBy: 'agent', at } })).toBe(false);
    expect(ok(PermissionRequest, { ...answered, decision: { outcome: 'approve', decidedBy: 'user', at } })).toBe(false);
    expect(ok(PermissionRequest, answered)).toBe(false);
  });
});

describe('delivery records (CR-2)', () => {
  const unknownAttempt = { attemptId: 'att-1', clientMessageId: uuid(1), state: 'unknown', dispatchStartedAt: at };
  const sentAttempt = { ...unknownAttempt, state: 'sent', nativeRef: { sessionRef: 'thread-1' }, evidence: { kind: 'live-ack', at, detail: 'ack' } };

  it('accept the three states with matching attempts', () => {
    expect(ok(DeliveryRecord, { state: 'pending', attempts: [] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [unknownAttempt] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [sentAttempt] })).toBe(true);
  });

  it('reject sent without a runtime reference or evidence', () => {
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [{ ...unknownAttempt, state: 'sent' }] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [{ ...sentAttempt, evidence: undefined }] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [{ ...unknownAttempt, nativeRef: { sessionRef: 't' } }] })).toBe(false);
  });

  it('reject unknown without an attempt and pending with a live attempt', () => {
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'pending', attempts: [unknownAttempt] })).toBe(false);
  });

  it('keep an abandoned attempt after a user retry, with fresh IDs', () => {
    const abandoned = { ...unknownAttempt, resolution: { decision: 'retry', decidedBy: 'user', at } };
    const second = { ...unknownAttempt, attemptId: 'att-2', clientMessageId: uuid(2) };
    expect(ok(DeliveryRecord, { state: 'pending', attempts: [abandoned] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [abandoned, second] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [abandoned, { ...second, clientMessageId: uuid(1) }] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [unknownAttempt, second] })).toBe(false);
    expect(ok(DeliveryRecord, { state: 'pending', attempts: [{ ...abandoned, resolution: { decision: 'retry', decidedBy: 'root-ai', at } }] })).toBe(false);
  });

  it('require a UUID clientMessageId', () => {
    expect(ok(DeliveryRecord, { state: 'unknown', attempts: [{ ...unknownAttempt, clientMessageId: 'msg-1' }] })).toBe(false);
  });

  it('handoffs carry the fixed payload and wait for their target', () => {
    const h = pick(fixtureSnapshotInput.handoffs, 0);
    expect(ok(Handoff, h)).toBe(true);
    expect(ok(Handoff, { ...h, payloadHash: undefined })).toBe(false);
    expect(ok(Handoff, { ...h, proposalRevision: undefined })).toBe(false);
    expect(ok(Handoff, { ...h, target: {} })).toBe(false);
    const provision = { operationId: 'op-t', bindingKey: 'k', state: 'unknown', preallocated: false };
    expect(ok(Handoff, { ...h, target: { sessionId: 's-wf-build-a', provision } })).toBe(false);
    expect(ok(Handoff, { ...h, target: { provision }, delivery: { state: 'pending', attempts: [] } })).toBe(true);
    expect(ok(Handoff, { ...h, expectedUpstream: ['n-review'] })).toBe(false);
  });

  it('peer messages keep cancel/reject apart from delivery (R-03)', () => {
    const m = pick(fixtureSnapshotInput.peerMessages, 1);
    expect(ok(PeerMessage, { ...m, outcome: { kind: 'cancelled', detail: '使用者取消', at } })).toBe(true);
    const sent = pick(fixtureSnapshotInput.peerMessages, 0);
    expect(ok(PeerMessage, { ...sent, outcome: { kind: 'cancelled', detail: 'x', at } })).toBe(true); // cancel stops follow-ups; the delivery fact stays (CR2 §2)
    expect(ok(PeerMessage, { ...sent, toSessionId: sent.fromSessionId })).toBe(false);
  });
});

describe('transfer confirmation gate (R-02, CR-5)', () => {
  const awaiting = pick(fixtureSnapshotInput.transfers, 1);
  const approved = pick(fixtureSnapshotInput.transfers, 0);
  const pendingDelivery = { state: 'pending', attempts: [] };

  it('nothing is created or sent before approval', () => {
    expect(ok(TransferProposal, awaiting)).toBe(true);
    expect(ok(TransferProposal, { ...awaiting, delivery: approved.delivery, createdSessionId: 's-x' })).toBe(false);
    expect(ok(TransferProposal, { ...awaiting, provision: approved.provision })).toBe(false);
    expect(ok(TransferProposal, { ...awaiting, delivery: pendingDelivery })).toBe(false);
  });

  it('approval binds the revision and carries its time', () => {
    expect(ok(TransferProposal, approved)).toBe(true);
    expect(ok(TransferProposal, { ...approved, approvedAt: undefined })).toBe(false);
    expect(ok(TransferProposal, { ...approved, approvedRevision: 0 })).toBe(false);
    expect(ok(TransferProposal, { ...awaiting, approvedAt: at, approvedRevision: 0 })).toBe(false);
  });

  it('the payload waits for the created target', () => {
    const base = { ...approved, provision: undefined, createdSessionId: undefined };
    expect(ok(TransferProposal, { ...base, delivery: pendingDelivery })).toBe(true);
    expect(ok(TransferProposal, { ...base, delivery: approved.delivery })).toBe(false);
    expect(ok(TransferProposal, { ...approved, createdSessionId: undefined })).toBe(false);
  });

  it('cancel and failure are consistent', () => {
    expect(ok(TransferProposal, { ...awaiting, state: 'cancelled', cancelledAt: at })).toBe(true);
    expect(ok(TransferProposal, { ...approved, state: 'cancelled', cancelledAt: at })).toBe(true);
    const created = { ...approved, delivery: undefined };
    expect(ok(TransferProposal, { ...created, state: 'failed' })).toBe(false);
    expect(ok(TransferProposal, { ...created, provision: undefined, createdSessionId: undefined, state: 'failed', failure: { message: 'thread/start failed' } })).toBe(true);
  });
});

describe('workflow rules', () => {
  const wf = pick(fixtureSnapshotInput.workflows, 0);

  it('root is a tagged target, so a node may be named "root" (R-05)', () => {
    const nodes = wf.nodes.map((n) => (n.id === 'n-test' ? { ...n, id: 'root' } : n));
    const edges = wf.edges.map((e) => ({ source: e.source === 'n-test' ? 'root' : e.source, target: e.target === 'n-test' ? 'root' : e.target }));
    const retarget = nodes.map((n) => ({ ...n, outputRules: n.outputRules.map((r) => (r.target.kind === 'node' && r.target.nodeId === 'n-test' ? { ...r, target: { kind: 'node', nodeId: 'root' } } : r)) }));
    expect(ok(WorkflowTemplate, { ...wf, nodes: retarget, edges })).toBe(true);
  });

  it('output targets need an edge and the graph has one root', () => {
    expect(ok(WorkflowTemplate, wf)).toBe(true);
    expect(ok(WorkflowTemplate, { ...wf, edges: wf.edges.filter((e) => e.target !== 'n-review') })).toBe(false);
    expect(ok(WorkflowTemplate, { ...wf, nodes: wf.nodes.map((n) => (n.kind === 'agent' ? { ...n, isRoot: false } : n)) })).toBe(false);
    expect(ok(WorkflowTemplate, { ...wf, edges: [...wf.edges, { source: 'n-plan', target: 'n-ghost' }] })).toBe(false);
  });

  it('agent nodes need an agent and model; merge nodes have neither', () => {
    const nodes = wf.nodes.map((n) => (n.kind === 'merge' ? { ...n, agentId: 'agent-builder' } : n));
    expect(ok(WorkflowTemplate, { ...wf, nodes })).toBe(false);
  });

  it('only the user approves an escalation (R-05)', () => {
    const esc = pick(fixtureSnapshotInput.escalations, 1);
    expect(ok(Escalation, esc)).toBe(true);
    expect(ok(Escalation, { ...esc, resolvedBy: 'system' })).toBe(false);
    expect(ok(Escalation, { ...esc, state: 'open' })).toBe(false);
    const perm = pick(fixtureSnapshotInput.escalations, 0);
    expect(ok(Escalation, { ...perm, ref: undefined })).toBe(false);
  });
});

describe('review round 2 cases', () => {
  const sentAttempt = { attemptId: 'att-1', clientMessageId: uuid(1), state: 'sent', dispatchStartedAt: at, nativeRef: { sessionRef: 'thread-1' }, evidence: { kind: 'reconciled', at, detail: 'same clientId' } };

  it('MCP elicitations carry their form and the answer content', () => {
    const req = pick(fixtureSnapshotInput.permissionRequests, 2);
    expect(ok(PermissionRequest, req)).toBe(true);
    expect(ok(PermissionRequest, { ...req, elicitation: undefined })).toBe(false);
    expect(ok(PermissionRequest, { ...req, kind: 'command' })).toBe(false);
    const escalationId = 'esc-x';
    const answered = { ...req, state: 'answered', decision: { outcome: 'approve', decidedBy: 'user', escalationId, content: { branch: 'main' }, at } };
    expect(ok(PermissionRequest, answered)).toBe(true);
    expect(ok(PermissionRequest, { ...answered, decision: { ...answered.decision, outcome: 'decline' } })).toBe(false);
    const url = { mode: 'url', serverName: 's', message: '登入', url: 'https://example.test/auth', elicitationId: 'el-1' };
    expect(ok(PermissionRequest, { ...req, elicitation: url })).toBe(true);
    const command = pick(fixtureSnapshotInput.permissionRequests, 1);
    expect(ok(PermissionRequest, { ...command, decision: { outcome: 'approve', decidedBy: 'policy', content: { x: 1 }, at } })).toBe(false);
  });

  it('a user decision survives reconciliation as sent, but retry only abandons unknown', () => {
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [{ ...sentAttempt, resolution: { decision: 'wait', decidedBy: 'user', at } }] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [{ ...sentAttempt, resolution: { decision: 'cancel', decidedBy: 'user', at } }] })).toBe(true);
    expect(ok(DeliveryRecord, { state: 'sent', attempts: [{ ...sentAttempt, resolution: { decision: 'retry', decidedBy: 'user', at } }] })).toBe(false);
  });

  it('runtime references must point at the bound target', () => {
    const h = pick(fixtureSnapshotInput.handoffs, 0);
    const wrong = { state: 'sent', attempts: [{ ...sentAttempt, nativeRef: { sessionRef: 'WRONG-TARGET' } }] };
    expect(ok(Handoff, { ...h, delivery: wrong })).toBe(false);
    expect(ok(Handoff, { ...h, target: { ...h.target, nativeSessionRef: 'other-thread' } })).toBe(false);
    expect(ok(Handoff, { ...h, target: { ...h.target, nativeSessionRef: undefined } })).toBe(false);
    const tr = pick(fixtureSnapshotInput.transfers, 0);
    expect(ok(TransferProposal, { ...tr, delivery: wrong })).toBe(false);
    const pm = pick(fixtureSnapshotInput.peerMessages, 0);
    expect(ok(PeerMessage, { ...pm, toNativeSessionRef: 'other-session' })).toBe(false);
    expect(ok(PeerMessage, { ...pm, toNativeSessionRef: undefined })).toBe(false);
  });

  it('peer messages keep the native tool-call identity (CR2 §4)', () => {
    const pm = pick(fixtureSnapshotInput.peerMessages, 0);
    expect(ok(PeerMessage, { ...pm, sourceCallRef: undefined })).toBe(false);
  });

  it('a failed transfer may keep its undispatched pending delivery', () => {
    const tr = pick(fixtureSnapshotInput.transfers, 0);
    const failed = { ...tr, provision: undefined, createdSessionId: undefined, state: 'failed', failure: { message: 'thread/start failed' } };
    expect(ok(TransferProposal, { ...failed, delivery: { state: 'pending', attempts: [] } })).toBe(true);
    expect(ok(TransferProposal, { ...failed, delivery: { state: 'unknown', attempts: [{ attemptId: 'a', clientMessageId: uuid(9), state: 'unknown', dispatchStartedAt: at }] } })).toBe(false);
  });

  it('refined guarantees narrow the inferred types', () => {
    const wf = WorkflowTemplate.parse(pick(fixtureSnapshotInput.workflows, 0));
    const runtimes = wf.nodes.flatMap((n) => (n.kind === 'agent' ? [n.model.runtime] : []));
    expect(runtimes.length).toBe(wf.nodes.length - 1);
    const d = DeliveryRecord.parse({ state: 'sent', attempts: [sentAttempt] });
    const refs = d.attempts.flatMap((a) => (a.state === 'sent' ? [a.nativeRef.sessionRef] : []));
    expect(refs).toEqual(['thread-1']);
  });
});

describe('review round 3 cases', () => {
  const abandoned = { attemptId: 'att-old', clientMessageId: uuid(50), state: 'unknown', dispatchStartedAt: at, resolution: { decision: 'retry', decidedBy: 'user', at } };
  const retried = { state: 'pending', attempts: [abandoned] };

  it('a pending record that kept dispatched attempts still needs its target', () => {
    const h = pick(fixtureSnapshotInput.handoffs, 0);
    expect(ok(Handoff, { ...h, delivery: retried })).toBe(true);
    expect(ok(Handoff, { ...h, delivery: retried, target: {} })).toBe(false);
    expect(ok(Handoff, { ...h, delivery: retried, target: { provision: { operationId: 'op-t', bindingKey: 'k', state: 'unknown', preallocated: false } } })).toBe(false);
    const pm = pick(fixtureSnapshotInput.peerMessages, 0);
    expect(ok(PeerMessage, { ...pm, delivery: retried, toNativeSessionRef: undefined })).toBe(false);
    const tr = pick(fixtureSnapshotInput.transfers, 0);
    expect(ok(TransferProposal, { ...tr, delivery: retried, provision: undefined, createdSessionId: undefined })).toBe(false);
    expect(ok(TransferProposal, { ...tr, delivery: { state: 'pending', attempts: [] }, provision: undefined, createdSessionId: undefined })).toBe(true);
  });

  it('escalation.respond carries elicitation answers only on approve', () => {
    const respond = { type: 'escalation.respond', requestId: 'r1', escalationId: 'esc-1', decision: 'approve', content: { branch: 'main' } };
    expect(ok(Command, respond)).toBe(true);
    expect(ok(Command, { ...respond, decision: 'decline' })).toBe(false);
  });
});

describe('contracts v0.3 additions', () => {
  it('model observations and runtime exits are events (R-12)', () => {
    const observed = { type: 'model.observed', sessionId: 's1', observed: { source: 'rerouted', from: 'a', to: 'b', reason: 'capacity', observedAt: at }, at };
    expect(ok(AppEvent, observed)).toBe(true);
    const exited = { type: 'runtime.exited', runtime: 'codex', sessionIds: ['s1'], expected: false, code: null, signal: null, error: 'crashed', at };
    expect(ok(AppEvent, exited)).toBe(true);
    expect(ok(AppEvent, { ...exited, runtime: 'other' })).toBe(false);
  });

  it('sub-agent turns and usage carry their native task (R-13)', () => {
    expect(ok(Turn, { id: 't', sessionId: 's', nativeTaskId: 'nt', state: 'running', startedAt: at })).toBe(true);
    expect(ok(TokenUsage, { sessionId: 's', nativeTaskId: 'nt', latest: { input: 1, output: 1, total: 2 }, at })).toBe(true);
  });

  it('commands keep the runtime process handle (CR-7)', () => {
    const item = { id: 'i', sessionId: 's', kind: 'command', command: 'npm test', cwd: 'E:/w', state: 'running', nativeProcessRef: 'proc-1', startedAt: at };
    expect(ok(CommandItem, item)).toBe(true);
    expect(ok(CommandItem, { ...item, nativeProcessRef: '' })).toBe(false);
  });

  it('sessions state their writable folder scope (R-08)', () => {
    const base = pick(fixtureSnapshotInput.sessions, 0);
    expect(ok(LogicalSession, base)).toBe(true);
    expect(ok(LogicalSession, { ...base, folderScope: undefined })).toBe(false);
    const scope = { source: 'session-cwd', workspaceRoot: 'E:/w', writableRoots: [] };
    expect(ok(LogicalSession, { ...base, folderScope: scope })).toBe(true); // read-only nodes write nowhere
    expect(ok(LogicalSession, { ...base, folderScope: { ...scope, writableRoots: ['E:/other'] } })).toBe(false);
    expect(ok(LogicalSession, { ...base, folderScope: { ...scope, workspaceRoot: undefined } })).toBe(false);
    const wf = fixtureSnapshot.sessions.find((s) => s.kind === 'workflow' && s.workflow.taskId !== undefined);
    expect(wf?.folderScope.source).toBe('task-worktree');
    const reviewer = fixtureSnapshot.sessions.find((s) => s.id === 's-wf-review-a');
    expect(reviewer?.folderScope.writableRoots).toEqual([]);
  });
});

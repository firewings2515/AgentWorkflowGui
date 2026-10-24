import { describe, expect, it } from 'vitest';
import { AgentDefinition, AppEvent, Command, CommandResult, LogicalSession, Snapshot, UiPreferences } from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

describe('fixtures', () => {
  it('match the snapshot schema', () => {
    expect(Snapshot.safeParse(fixtureSnapshotInput).success).toBe(true);
  });

  it('cover the cases the UI needs', () => {
    const s = fixtureSnapshot;
    expect(s.sessions.some((x) => x.kind === 'ordinary')).toBe(true);
    expect(s.sessions.some((x) => x.kind === 'workflow')).toBe(true);
    expect(s.sessions.some((x) => x.derivedFromSessionId !== undefined)).toBe(true);
    expect(s.nativeTasks.length).toBeGreaterThan(0);
    expect(s.instances[0]?.tasks.length).toBeGreaterThan(1);
    expect(s.instances[0]?.tasks.some((task) => task.dependsOn.length > 0)).toBe(true);
    expect(s.escalations.some((e) => e.state === 'open')).toBe(true);
  });

  it('reference existing sessions, agents and nodes', () => {
    const s = fixtureSnapshot;
    const sessionIds = new Set(s.sessions.map((x) => x.id));
    const agentIds = new Set(s.agents.map((x) => x.id));
    const nodeIds = new Set(s.workflows.flatMap((w) => w.nodes.map((n) => n.id)));
    for (const x of s.sessions) {
      expect(agentIds.has(x.agent.id)).toBe(true);
      if (x.parentId) expect(sessionIds.has(x.parentId)).toBe(true);
      if (x.derivedFromSessionId) expect(sessionIds.has(x.derivedFromSessionId)).toBe(true);
      if (x.workflow) expect(nodeIds.has(x.workflow.nodeId)).toBe(true);
    }
    for (const m of s.messages) expect(sessionIds.has(m.sessionId)).toBe(true);
    for (const w of s.workflows) for (const e of w.edges) expect(nodeIds.has(e.source) && nodeIds.has(e.target)).toBe(true);
  });
});

describe('contract rules', () => {
  const agent = { id: 'a', revision: 0, name: 'n', description: '', instructions: 'i', updatedAt: '2026-10-24T10:00:00+08:00' };

  it('AgentDefinition rejects a model field (COM-01, HC-01)', () => {
    expect(AgentDefinition.safeParse(agent).success).toBe(true);
    expect(AgentDefinition.safeParse({ ...agent, model: 'claude-opus-5-5' }).success).toBe(false);
    expect(AgentDefinition.safeParse({ ...agent, defaultModel: 'x' }).success).toBe(false);
  });

  it('commands require a requestId and explicit targets (HC-05)', () => {
    const send = { type: 'session.send', requestId: 'r1', sessionId: 's1', expectedRevision: 2, text: 'hi' };
    expect(Command.safeParse(send).success).toBe(true);
    expect(Command.safeParse({ ...send, requestId: undefined }).success).toBe(false);
    expect(Command.safeParse({ ...send, sessionId: undefined }).success).toBe(false);
    expect(Command.safeParse({ type: 'session.unknown', requestId: 'r1' }).success).toBe(false);
  });

  it('error results say whether a side effect may have happened', () => {
    const err = { ok: false, requestId: 'r1', code: 'unknown_outcome', message: 'm', retryable: false, mayHaveSideEffects: true };
    expect(CommandResult.safeParse(err).success).toBe(true);
    const missing: Record<string, unknown> = { ...err };
    delete missing.mayHaveSideEffects;
    expect(CommandResult.safeParse(missing).success).toBe(false);
  });

  it('events are validated at runtime', () => {
    expect(AppEvent.safeParse({ type: 'session.activity', sessionId: 's1', activity: 'running', at: '2026-10-24T10:00:00+08:00' }).success).toBe(true);
    expect(AppEvent.safeParse({ type: 'session.activity', sessionId: 's1', activity: 'thinking', at: '2026-10-24T10:00:00+08:00' }).success).toBe(false);
  });

  it('theme defaults to dark (R-15)', () => {
    expect(UiPreferences.parse({}).theme).toBe('dark');
  });

  it('timestamps need an offset', () => {
    const base = fixtureSnapshotInput.sessions[0];
    expect(LogicalSession.safeParse({ ...base, createdAt: '2026-10-24T10:00:00' }).success).toBe(false);
  });
});

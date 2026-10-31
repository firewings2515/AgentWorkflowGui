// Contracts 0.6 (T028): the new or changed schemas (BATCH5_PLAN C-15 to C-25). Rule codes of the new
// refinements carry no input values, as in 0.4 and 0.5.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AppEvent,
  Command,
  CONTRACTS_VERSION,
  CreateTasksToolInput,
  CreateTasksToolResult,
  Escalation,
  FileLock,
  FolderRequest,
  FolderResult,
  HandoffToolInput,
  InputRule,
  issueRule,
  JoinRound,
  MergeAttempt,
  ProjectSettings,
  Snapshot,
  TaskPlan,
  TransferProposal,
  WorkflowInstance,
  WorkflowTask,
  WorkflowTemplate,
} from './index';
import { fixtureSnapshot, fixtureSnapshotInput } from './fixtures/snapshot';

const at = '2026-10-31T16:00:00+08:00';
const MARKER = 'SENSITIVE_INPUT_MARKER';
const pick = <T>(xs: readonly T[] | undefined, i: number): T => {
  const x = xs?.[i];
  if (x === undefined) throw new Error(`fixture has no entry ${i}`);
  return x;
};
const rules = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  const issues = r.error?.issues ?? [];
  expect(JSON.stringify(issues)).not.toContain(MARKER);
  return issues.map((i) => issueRule(i));
};
const ok = (schema: z.ZodType, input: unknown) => schema.safeParse(input).success;
/** The record without `keys`, as an older version wrote it. */
const omit = <T extends object>(record: T, ...keys: string[]) => Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));

const login = pick(fixtureSnapshotInput.instances, 0);
const docs = pick(fixtureSnapshotInput.instances, 1);
const template = pick(fixtureSnapshotInput.workflows, 0);

describe('contracts 0.6', () => {
  it('C-25: is version 0.6.0, and the fixture shows tasks, rounds, the merge queue, a project and a lock', () => {
    expect(CONTRACTS_VERSION).toBe('0.6.0');
    const [inst, pair] = fixtureSnapshot.instances;
    expect(inst?.tasks.map((t) => t.status)).toEqual(['running', 'running', 'pending', 'merged', 'blocked', 'merging']);
    expect(inst?.mergeQueue.map((m) => m.state)).toEqual(['merged', 'conflict', 'testing']);
    expect(inst?.taskPlans.map((p) => p.state)).toEqual(['created', 'awaiting-confirmation']);
    expect(pair?.template.isolation).toBe('same-folder');
    expect(pair?.rounds[0]).toMatchObject({ state: 'waiting', expectedUpstream: ['n-rev-claude', 'n-rev-codex'] });
    expect(fixtureSnapshot.projects).toHaveLength(1);
    expect(fixtureSnapshot.locks[0]?.waiters).toHaveLength(1);
  });

  it('C-25: a Snapshot or instance stored before 0.6 reads with empty new lists and the default task limit', () => {
    const parsed = Snapshot.parse(omit(fixtureSnapshotInput, 'projects', 'locks'));
    expect([parsed.projects, parsed.locks]).toEqual([[], []]);
    const bare = omit(docs, 'rounds', 'mergeQueue', 'taskPlans', 'taskLimit', 'targetBranch', 'projectId');
    expect(WorkflowInstance.parse(bare)).toMatchObject({ rounds: [], mergeQueue: [], taskPlans: [], taskLimit: 3 });
  });

  describe('C-15: rounds (CR-4)', () => {
    const round = pick(docs.rounds, 0);

    it('a wait limit needs waitForAllUpstream', () => {
      expect(ok(InputRule, { id: 'in', condition: 'c', waitForAllUpstream: true, waitTimeoutMs: 60_000 })).toBe(true);
      expect(rules(InputRule, { id: 'in', condition: MARKER, waitTimeoutMs: 60_000 })).toEqual(['input.timeout-needs-wait']);
    });

    it('only expected upstream arrive, once each; the round is ready exactly when all arrived', () => {
      const both = [{ fromNodeId: 'n-rev-claude', handoffId: 'h-6' }, { fromNodeId: 'n-rev-codex', handoffId: 'h-7' }];
      expect(ok(JoinRound, { ...round, arrived: both, state: 'ready', settledAt: at })).toBe(true);
      expect(rules(JoinRound, { ...round, arrived: both })).toEqual(['round.ready-when-complete']);
      expect(rules(JoinRound, { ...round, state: 'ready', settledAt: at })).toEqual(['round.ready-when-complete']);
      // The previous round's result cannot be used: an arrival from outside the set does not count.
      expect(rules(JoinRound, { ...round, arrived: [...(round.arrived ?? []), { fromNodeId: MARKER, handoffId: 'h-x' }] })).toEqual(['round.arrived-expected']);
      expect(rules(JoinRound, { ...round, arrived: [pick(round.arrived, 0), pick(round.arrived, 0)] })).toEqual(['round.arrived-expected']);
    });

    it('a failed upstream or a timeout blocks the round with its reason; the set does not shrink', () => {
      const blocked = { ...round, state: 'blocked', blockedReason: 'upstream-failed', blockedUpstream: 'n-rev-codex', settledAt: at };
      expect(JoinRound.parse(blocked).expectedUpstream).toEqual(round.expectedUpstream);
      expect(ok(JoinRound, { ...round, state: 'blocked', blockedReason: 'timeout', settledAt: at })).toBe(true);
      expect(rules(JoinRound, { ...round, state: 'blocked', settledAt: at })).toEqual(['round.blocked-reason']);
      expect(rules(JoinRound, { ...round, blockedReason: 'timeout' })).toEqual(['round.blocked-reason']);
      expect(rules(JoinRound, { ...round, settledAt: at })).toEqual(['round.settled-at']);
    });

    it('one round per (task, node, round) and for a task of the run; a blocked round escalates with its ref', () => {
      expect(rules(WorkflowInstance, { ...docs, rounds: [round, round] })).toEqual(['instance.round-unique']);
      expect(rules(WorkflowInstance, { ...docs, rounds: [{ ...round, taskId: MARKER }] })).toEqual(['instance.unknown-task']);
      const escalation = { ...pick(fixtureSnapshotInput.escalations, 2), kind: 'round-blocked', ref: { kind: 'round', taskId: 'task-docs', nodeId: 'n-summary', round: 1 } };
      expect(ok(Escalation, escalation)).toBe(true);
      expect(rules(Escalation, { ...escalation, ref: { kind: 'task', taskId: 'task-docs' } })).toEqual(['escalation.round-ref']);
    });
  });

  describe('C-16, C-22: tasks, the merge queue and task lists (R-06)', () => {
    const task = pick(login.tasks, 0);
    const queue = login.mergeQueue ?? [];

    it('a blocked task says why; merged and completed tasks say when', () => {
      expect(ok(WorkflowTask, { ...task, status: 'blocked', blockedReason: 'setup-failed' })).toBe(true);
      expect(rules(WorkflowTask, { ...task, blockedReason: 'setup-failed' })).toEqual(['task.blocked-reason']);
      expect(ok(WorkflowTask, { ...task, status: 'completed', completedAt: at })).toBe(true);
      expect(rules(WorkflowTask, { ...task, status: 'merged' })).toEqual(['task.completed-at']);
      expect(rules(WorkflowTask, { ...task, completedAt: at })).toEqual(['task.completed-at']);
      expect(rules(WorkflowTask, { ...task, setup: { state: 'failed', command: MARKER, startedAt: at } })).toEqual(['task.setup-ended']);
    });

    it('a task worktree records its base and its cleanup, defaulting to active', () => {
      expect(WorkflowTask.parse(task).worktree?.cleanup).toBe('active');
      expect(WorkflowTask.parse(pick(login.tasks, 3)).worktree?.cleanup).toBe('pending-cleanup');
    });

    it('dependencies form no cycle, and task worktrees need a target branch', () => {
      const a = pick(login.tasks, 0);
      const c = pick(login.tasks, 2);
      expect(rules(WorkflowInstance, { ...login, tasks: [{ ...a, dependsOn: ['task-c'] }, ...login.tasks.slice(1, 2), c, ...login.tasks.slice(3)] })).toEqual(['instance.task-dependency-cycle']);
      expect(rules(WorkflowInstance, { ...login, targetBranch: undefined })).toEqual(['instance.worktree-needs-target']);
    });

    it('at most one merge attempt is active; attempts are unique per task and in queue order', () => {
      const testing = pick(queue, 2);
      expect(rules(WorkflowInstance, { ...login, mergeQueue: [...queue, { ...testing, taskId: 'task-a', seq: 3, state: 'merging' }] })).toEqual(['instance.merge-one-at-a-time']);
      expect(rules(WorkflowInstance, { ...login, mergeQueue: [...queue, { ...testing, seq: 3, state: 'queued' }] })).toEqual(['instance.merge-attempt-unique']);
      expect(rules(WorkflowInstance, { ...login, mergeQueue: [...queue, { ...testing, attempt: 1, seq: 2, state: 'queued' }] })).toEqual(['instance.merge-attempt-unique']);
      expect(rules(WorkflowInstance, { ...login, mergeQueue: [{ ...testing, taskId: MARKER }] })).toEqual(['instance.unknown-task']);
    });

    it('a merge attempt records conflicts, test results and its commit as its state needs (CR-3)', () => {
      const [merged, conflict, testing] = [pick(queue, 0), pick(queue, 1), pick(queue, 2)];
      expect(rules(MergeAttempt, { ...conflict, conflictFiles: [] })).toEqual(['merge.conflict-files']);
      expect(rules(MergeAttempt, { ...testing, conflictFiles: [MARKER] })).toEqual(['merge.conflict-files']);
      expect(ok(MergeAttempt, { ...testing, state: 'resolving', conflictFiles: ['a.ts'] })).toBe(true);
      expect(rules(MergeAttempt, { ...testing, state: 'tests-failed', endedAt: at })).toEqual(['merge.test-result']);
      expect(rules(MergeAttempt, { ...merged, mergedCommit: undefined })).toEqual(['merge.merged-needs-commit']);
      expect(rules(MergeAttempt, { ...merged, test: { ...merged.test, passed: false, exitCode: 1 } })).toEqual(['merge.merged-needs-commit']);
      expect(rules(MergeAttempt, { ...testing, endedAt: at })).toEqual(['merge.ended-at']);
      expect(MergeAttempt.parse(testing)).toMatchObject({ restarts: 0, conflictFiles: [] });
    });

    it('a task list waits with its escalation, names one task per item once created, and is decided once', () => {
      const [created, waiting] = [pick(login.taskPlans, 0), pick(login.taskPlans, 1)];
      expect(rules(TaskPlan, { ...waiting, escalationId: undefined })).toEqual(['taskplan.confirming-needs-escalation']);
      expect(rules(TaskPlan, { ...created, created: [pick(created.created, 0)] })).toEqual(['taskplan.created-tasks']);
      expect(rules(TaskPlan, { ...waiting, decidedAt: at })).toEqual(['taskplan.decided-at']);
      expect(ok(TaskPlan, { ...waiting, state: 'declined', decidedAt: at })).toBe(true);
      expect(rules(WorkflowInstance, { ...login, taskPlans: [created, created] })).toEqual(['instance.task-plan-unique']);
      const escalation = pick(fixtureSnapshotInput.escalations, 3);
      expect(rules(Escalation, { ...escalation, kind: 'limit-exceeded' })).toEqual(['escalation.task-plan-confirmation']);
    });

    it('only root has a tasks rule, and a handoff never targets one', () => {
      const root = pick(template.nodes, 0);
      const split = { id: 'split', condition: 'c', payload: 'p', target: { kind: 'tasks' }, requiresUserConfirmation: true };
      expect(ok(WorkflowTemplate, { ...template, nodes: [{ ...root, outputRules: [...root.outputRules, split] }, ...template.nodes.slice(1)] })).toBe(true);
      const build = pick(template.nodes, 1);
      expect(rules(WorkflowTemplate, { ...template, nodes: [root, { ...build, outputRules: [...build.outputRules, split] }, ...template.nodes.slice(2)] })).toEqual(['workflow.tasks-rule-on-root']);
      expect(ok(HandoffToolInput, { ruleId: 'split', target: { kind: 'tasks' }, content: 'x' })).toBe(false);
    });

    it('create_tasks names root rule, refuses a cycle, and answers with the waiting task list', () => {
      const tasks = [{ key: 'a', title: 'A', dependsOn: ['b'] }, { key: 'b', title: 'B', dependsOn: ['a'] }];
      expect(rules(CreateTasksToolInput, { ruleId: 'split', tasks })).toEqual(['mcp.create-tasks-cycle']);
      expect(ok(CreateTasksToolInput, { tasks: [{ key: 'a', title: 'A' }] })).toBe(false);
      expect(ok(CreateTasksToolResult, { status: 'awaiting-confirmation', taskPlanId: 'plan-2', escalationId: 'esc-4' })).toBe(true);
      expect(ok(CreateTasksToolResult, { status: 'awaiting-confirmation', escalationId: 'esc-4' })).toBe(false);
    });

    it('an ended run has an end time and only final tasks; the user ends it with a command', () => {
      const tasks = login.tasks.map((t) => (t.status === 'merged' ? t : { ...t, status: 'cancelled', blockedReason: undefined }));
      expect(ok(WorkflowInstance, { ...login, state: 'cancelled', endedAt: at, tasks, mergeQueue: [] })).toBe(true);
      expect(rules(WorkflowInstance, { ...login, state: 'cancelled', tasks, mergeQueue: [] })).toEqual(['instance.ended-at']);
      expect(rules(WorkflowInstance, { ...login, state: 'completed', endedAt: at })).toEqual(['instance.ended-tasks-final']);
      for (const type of ['workflow.complete', 'workflow.cancel']) expect(ok(Command, { type, requestId: 'r', instanceId: login.id, expectedRevision: 4 })).toBe(true);
      expect(ok(Command, { type: 'task.retryCleanup', requestId: 'r', instanceId: login.id, taskId: 'task-d' })).toBe(true);
    });
  });

  it('C-17: projects are saved with compare-and-set and shown; a workflow may override their commands', () => {
    const project = pick(fixtureSnapshotInput.projects, 0);
    expect(ProjectSettings.parse({ ...project, commands: undefined }).commands).toEqual({});
    expect(ok(Command, { type: 'project.save', requestId: 'r', project, expectedRevision: null })).toBe(true);
    expect(ok(AppEvent, { type: 'project.updated', project })).toBe(true);
    expect(ok(WorkflowTemplate, { ...template, setupOverride: { setup: 'pnpm i', test: 'pnpm test' } })).toBe(true);
    expect(ok(WorkflowTemplate, { ...template, setupOverride: { setup: '' } })).toBe(false);
  });

  describe('C-19: file locks (R-07)', () => {
    const lock = pick(fixtureSnapshotInput.locks, 0);
    const waiter = pick(lock.waiters, 0);

    it('a held Codex approval names its request; a waiter is listed once and is never the holder', () => {
      expect(ok(FileLock, { ...lock, waiters: [{ ...waiter, via: 'codex-approval', permissionRequestId: 'pr-9' }] })).toBe(true);
      expect(rules(FileLock, { ...lock, waiters: [{ ...waiter, via: 'codex-approval' }] })).toEqual(['lock.approval-needs-request']);
      expect(rules(FileLock, { ...lock, waiters: [waiter, waiter] })).toEqual(['lock.waiters-distinct']);
      expect(rules(FileLock, { ...lock, waiters: [{ ...waiter, sessionId: lock.holderSessionId }] })).toEqual(['lock.waiters-distinct']);
    });

    it('the whole lock list is pushed, and a lock escalation points at its lock', () => {
      expect(ok(AppEvent, { type: 'locks.updated', locks: [lock], at })).toBe(true);
      const escalation = { ...pick(fixtureSnapshotInput.escalations, 2), kind: 'lock-timeout', ref: { kind: 'lock', path: lock.path, sessionId: waiter.sessionId, holderSessionId: lock.holderSessionId } };
      expect(ok(Escalation, escalation)).toBe(true);
      expect(ok(Escalation, { ...escalation, kind: 'unlocked-write' })).toBe(true);
      expect(rules(Escalation, { ...escalation, ref: { kind: 'task', taskId: 'task-a' } })).toEqual(['escalation.lock-ref']);
    });
  });

  it('C-21: only a cancelled transfer has a cancel reason', () => {
    const cancelled = pick(fixtureSnapshotInput.transfers, 2);
    expect(TransferProposal.parse(cancelled).cancelReason).toBe('source-changed');
    expect(ok(TransferProposal, { ...cancelled, cancelReason: undefined })).toBe(true);
    expect(rules(TransferProposal, { ...pick(fixtureSnapshotInput.transfers, 1), cancelReason: 'user' })).toEqual(['transfer.cancel-reason-only-cancelled']);
    expect(ok(TransferProposal, { ...cancelled, cancelReason: MARKER })).toBe(false);
  });

  it('C-24: folders are picked by the user and opened only by what they belong to', () => {
    expect(ok(FolderRequest, { type: 'folder.pick', requestId: 'r' })).toBe(true);
    expect(ok(FolderRequest, { type: 'folder.open', requestId: 'r', target: { kind: 'task-worktree', instanceId: login.id, taskId: 'task-d' } })).toBe(true);
    expect(ok(FolderRequest, { type: 'folder.open', requestId: 'r', target: { kind: 'path', path: 'C:/Windows' } })).toBe(false);
    expect(ok(FolderRequest, { type: 'folder.open', requestId: 'r', path: 'C:/Windows', target: { kind: 'app-data' } })).toBe(false);
    expect(ok(FolderResult, { ok: true, requestId: 'r', path: null })).toBe(true);
    expect(ok(FolderResult, { ok: false, requestId: 'r', code: 'not_found', message: 'gone' })).toBe(true);
  });
});

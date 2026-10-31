// Fixed names of what the pipeline makes (T032), so a restart, a resend or a repeat finds what the first try
// made instead of making it again: worktrees and branches, task lists and tasks, the merge's own sessions,
// deliveries and escalations. Worktrees sit below `<repo>\.awg\wt` with short names (SP-07 G6).
import { EscalationId, type InstanceId, OperationId, type PayloadHash, SessionId, TaskId, TaskPlanId } from '../../contracts';
import type { WorktreeRef } from '../ports';

export type Hasher = (text: string) => PayloadHash | Promise<PayloadHash>;

const digest = async (hash: Hasher, parts: readonly unknown[], length: number): Promise<string> => (await hash(JSON.stringify(parts))).slice('sha256:'.length, 'sha256:'.length + length);

/** `<repo>\.awg\wt\<name>`, with the separator the repository path uses. */
export const worktreeFolder = (repo: string, name: string): string => {
  const sep = repo.includes('\\') || !repo.includes('/') ? '\\' : '/';
  return `${repo.replace(/[\\/]+$/, '')}${sep}.awg${sep}wt${sep}${name}`;
};

/** The worktree and branch of a task (R-06: task = worktree = branch). */
export const taskWorktreeRef = async (hash: Hasher, repo: string, instanceId: InstanceId, taskId: TaskId): Promise<WorktreeRef> => {
  const name = `t-${await digest(hash, ['task', instanceId, taskId], 12)}`;
  return { repo, path: worktreeFolder(repo, name), branch: `awg/${name}` };
};

/** The integration worktree of one merge attempt (CR-3). */
export const integrationRef = async (hash: Hasher, repo: string, instanceId: InstanceId, taskId: TaskId, attempt: number): Promise<WorktreeRef> => {
  const name = `m-${await digest(hash, ['merge', instanceId, taskId, attempt], 12)}`;
  return { repo, path: worktreeFolder(repo, name), branch: `awg/${name}` };
};

/** A `create_tasks` list, named by the call that proposed it (CR2 §4): its resend finds the same list. */
export const taskPlanIdOf = async (hash: Hasher, caller: SessionId, sourceCallRef: string): Promise<TaskPlanId> =>
  TaskPlanId.parse(`plan-${await digest(hash, [caller, sourceCallRef], 20)}`);

export const planTaskIdOf = (planId: TaskPlanId, key: string): TaskId => TaskId.parse(`${planId}:${key}`);

export const taskPlanEscalationId = (planId: TaskPlanId): EscalationId => EscalationId.parse(`wf-tasks:${planId}`);
export const setupEscalationBase = (instanceId: InstanceId, taskId: TaskId): string => `wf-setup:${JSON.stringify([instanceId, taskId])}`;
export const mergeEscalationId = (instanceId: InstanceId, taskId: TaskId, attempt: number): EscalationId => EscalationId.parse(`wf-merge:${JSON.stringify([instanceId, taskId, attempt])}`);

/** The session that works on a merge conflict in the integration worktree (one per attempt). */
export const resolverSessionIdOf = async (hash: Hasher, instanceId: InstanceId, taskId: TaskId, attempt: number): Promise<SessionId> =>
  SessionId.parse(`wf-resolve-${await digest(hash, [instanceId, taskId, attempt], 20)}`);

const RESOLVE = 'merge-resolve:';
/** The GUI's message to the resolver of an attempt. */
export const resolveOperationOf = async (hash: Hasher, instanceId: InstanceId, taskId: TaskId, attempt: number): Promise<OperationId> =>
  OperationId.parse(`${RESOLVE}${await digest(hash, [instanceId, taskId, attempt], 24)}`);
/** The task given back to its implementation node after an attempt failed (conflict, tests). */
export const returnOperationOf = async (hash: Hasher, instanceId: InstanceId, taskId: TaskId, attempt: number): Promise<OperationId> =>
  OperationId.parse(`merge-return:${await digest(hash, [instanceId, taskId, attempt], 24)}`);
/** The merge node's report of a merged task to root (its output rule to root). */
export const mergedOperationOf = async (hash: Hasher, instanceId: InstanceId, taskId: TaskId, attempt: number): Promise<OperationId> =>
  OperationId.parse(`merge-done:${await digest(hash, [instanceId, taskId, attempt], 24)}`);

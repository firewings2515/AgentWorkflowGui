// The task pipeline (T032, R-06, CR-3, V-19..V-21): root splits the work with `create_tasks`; each task gets
// its own worktree and setup and runs through the graph; a task whose dependencies are not merged waits; a
// task handed to the merge node joins the instance's merge queue, which merges one task at a time in an
// integration worktree, tests there and only then fast-forwards the target branch.
//
// Every step writes its state before it acts and checks the state it expects before it writes the outcome
// (compare-and-set on the instance), so a restart carries on from the step it stopped at and two callers
// never both take a step. Git touches only what the pipeline made; the target branch only moves forward.
import {
  type AppEvent,
  type CommandResult,
  type CreateTasksToolInput,
  CreateTasksToolInput as CreateTasksInputSchema,
  type CreateTasksToolResult,
  type Escalation,
  finalTaskStatuses,
  type Handoff,
  type HandoffToolResult,
  type InstanceId,
  type McpRejection,
  type MergeAttempt,
  type MessageOrigin,
  type OperationId,
  type ProjectSettings,
  type SessionId,
  type TaskId,
  type TaskPlan,
  type TaskPlanItem,
  type Timestamp,
  type WorkflowInstance,
  type WorkflowNode,
  type WorkflowTask,
  activeMergeStates,
} from '../../contracts';
import type { AppRepositories, CleanupResult, DeliveryStore, GitPort, WorktreeRef } from '../ports';
import type { CommandOf, SessionService, WorkflowSession } from '../sessions';
import { type AgentNode, nodeOf, rootNode } from '../workflow/graph';
import { peerIdOf } from '../workflow/ids';
import {
  type Hasher,
  integrationRef,
  mergedOperationOf,
  mergeEscalationId,
  planTaskIdOf,
  resolveOperationOf,
  resolverSessionIdOf,
  returnOperationOf,
  setupEscalationBase,
  taskPlanEscalationId,
  taskPlanIdOf,
  taskWorktreeRef,
} from './naming';
import type { CommandRunner, CommandShell, RunningCommand, WorktreeFiles } from './types';

/** What the pipeline takes from the workflow engine, which owns the instance queue and the handoffs. */
export interface PipelineHost {
  /** Runs `fn` in the instance's queue, after everything queued there (handoffs, round checks). */
  serial<T>(instanceId: InstanceId, fn: () => Promise<T>): Promise<T>;
  openOnce(base: string, fields: Omit<Escalation, 'id' | 'state' | 'createdAt'>): Promise<Escalation>;
  closeEscalation(escalation: Escalation, state: 'approved' | 'declined' | 'resolved', by: 'user' | 'system'): Promise<void>;
  /** A formal handoff the GUI makes for the merge node (R-06): through the delivery service, counted when `count`. */
  guiHandoff(input: GuiHandoff): Promise<'accepted' | 'duplicate' | 'limit-exceeded' | 'failed'>;
  /** The task's handoffs that waited for it to start go now. */
  wakeTask(instanceId: InstanceId, taskId: TaskId): Promise<void>;
}

export interface GuiHandoff {
  instanceId: InstanceId;
  taskId: TaskId;
  from: WorkflowNode;
  to: AgentNode;
  ruleId: string;
  content: string;
  operationId: OperationId;
  /** Counted like an agent's handoff (a task given back is rework, R-05). */
  count: boolean;
}

export interface TaskPipelineOptions {
  git: GitPort;
  commands: CommandRunner;
  files: WorktreeFiles;
  /** Ends a session's runtime gracefully before its folder is removed (SP-07 G1); absent: left to the removal. */
  closeRuntime?(sessionId: SessionId): Promise<void>;
  /** Links resolved (as the lock check sees paths), so `ownsPath` knows a worktree by either spelling. */
  resolveRealPath?(path: string): string | null;
}

interface Deps extends TaskPipelineOptions {
  sessions: SessionService;
  host: PipelineHost;
  publish(event: AppEvent): void;
  now(): Timestamp;
  hash: Hasher;
  log(message: string): void;
}

type Failure = Extract<CommandResult, { ok: false }>;
type Success = Extract<CommandResult, { ok: true }>;
const ok = (requestId: Success['requestId'], extra: Partial<Pick<Success, 'revision'>> = {}): Success => ({ ok: true, requestId, created: [], ...extra });
const fail = (requestId: Failure['requestId'], code: Failure['code'], message: string, flags: { retryable?: boolean; mayHaveSideEffects?: boolean } = {}): Failure => ({
  ok: false,
  requestId,
  code,
  message,
  retryable: flags.retryable ?? false,
  mayHaveSideEffects: flags.mayHaveSideEffects ?? false,
});
const rejected = (reason: McpRejection['reason'], detail: string) => ({ status: 'rejected' as const, rejection: { reason, detail } });

/** Tasks that take one of the instance's places (O-05): started and not final. */
const IN_PROGRESS: readonly WorkflowTask['status'][] = ['running', 'blocked', 'awaiting-merge', 'merging'];
/** Restarts of a task's merge because the target branch moved, before the user is asked. */
const MAX_RESTARTS = 5;
const TAIL = 4000;
const RESOLVER_PREFIX = 'wf-resolve-';
/** Why a merge failed when nothing can test it (G-3: never merged untested, never a made-up test result). */
const NO_TEST = 'no test command is set for this project or workflow, and the target branch moves only after the tests pass in the integration worktree';

export const isResolverSession = (sessionId: SessionId): boolean => sessionId.startsWith(RESOLVER_PREFIX);

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pathKey = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
const inside = (path: string, folder: string) => {
  const p = pathKey(path);
  const f = pathKey(folder);
  return p === f || p.startsWith(`${f}\\`);
};
const ended = (instance: WorkflowInstance) => instance.state === 'completed' || instance.state === 'cancelled';
const isFinal = (task: WorkflowTask) => finalTaskStatuses.includes(task.status);
const satisfied = (task: WorkflowTask | undefined) => task?.status === 'merged' || task?.status === 'completed';
const sameItems = (a: readonly TaskPlanItem[], b: readonly TaskPlanItem[]) =>
  JSON.stringify(a.map((i) => [i.key, i.title, [...i.dependsOn].sort(), [...i.dependsOnExisting].sort()])) ===
  JSON.stringify(b.map((i) => [i.key, i.title, [...i.dependsOn].sort(), [...i.dependsOnExisting].sort()]));

export class TaskPipeline {
  /** Worktrees this process saw made or taken up again: the others are checked once with `createWorktree`. */
  private readonly made = new Set<string>();
  /** Every worktree folder the pipeline recorded (task and integration), by path key: `ownsPath`. */
  private readonly folders = new Set<string>();
  /** Instances whose merge queue is being worked (one runner each); `again` asks it to look once more. */
  private readonly runners = new Map<InstanceId, { again: boolean }>();
  /** Setup and test commands running, by task (killed when the run is cancelled). */
  private readonly running = new Map<string, RunningCommand>();
  /** Tasks whose setup this process is running. */
  private readonly settingUp = new Set<string>();

  constructor(private readonly deps: Deps) {}

  private get repos(): AppRepositories {
    return this.deps.sessions.storage.repositories;
  }

  private get store(): DeliveryStore {
    return this.deps.sessions.storage.store;
  }

  private get git(): GitPort {
    return this.deps.git;
  }

  /**
   * Whether a path is inside a worktree the pipeline recorded (a task's or a merge attempt's). Synchronous, for
   * the same-folder lock check (R-07): such a folder is worktree work, never same-folder work.
   */
  ownsPath(path: string): boolean {
    const key = pathKey(path);
    for (const folder of this.folders) if (key === folder || key.startsWith(`${folder}\\`)) return true;
    return false;
  }

  private remember(instance: WorkflowInstance): void {
    for (const task of instance.tasks) if (task.worktree !== undefined) this.own(task.worktree.path);
    for (const m of instance.mergeQueue) if (m.integration !== undefined) this.own(m.integration.path);
  }

  /** Records a worktree folder as the pipeline's, as written and with its links resolved. */
  private own(path: string): void {
    this.folders.add(pathKey(path));
    let real: string | null = null;
    try {
      real = this.deps.resolveRealPath?.(path) ?? null;
    } catch {
      // Not there yet: the spelling as written is known.
    }
    if (real !== null) this.folders.add(pathKey(real));
  }

  // ---- the instance's repository ------------------------------------------------------------------

  /** The project of the run (O-06): the one named, else the one whose folder holds root's cwd. */
  private async projectOf(instance: WorkflowInstance): Promise<ProjectSettings | undefined> {
    if (instance.projectId !== undefined) return this.repos.projects.get(instance.projectId);
    const root = await this.repos.sessions.get(instance.rootSessionId);
    if (root === undefined) return undefined;
    return (await this.repos.projects.list()).filter((p) => inside(root.cwd, p.rootPath)).sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  }

  /** The repository's top folder: the project's, or root's cwd (GitPort has no top-level query). */
  private async repoOf(instance: WorkflowInstance): Promise<string | undefined> {
    const project = await this.projectOf(instance);
    if (project !== undefined) return project.rootPath;
    return (await this.repos.sessions.get(instance.rootSessionId))?.cwd;
  }

  /** Setup and test commands: the workflow's override, else the project's (O-06). */
  private async commandsOf(instance: WorkflowInstance): Promise<{ setup?: string; test?: string; shell: CommandShell }> {
    const project = await this.projectOf(instance);
    const override = instance.template.setupOverride;
    const setup = override?.setup ?? project?.commands.setup;
    const test = override?.test ?? project?.commands.test;
    return { ...(setup !== undefined && { setup }), ...(test !== undefined && { test }), shell: override?.shell ?? project?.commands.shell ?? 'powershell' };
  }

  private worktreeMode(instance: WorkflowInstance): boolean {
    return instance.template.isolation === 'worktree';
  }

  private async taskRef(instance: WorkflowInstance, taskId: TaskId): Promise<WorktreeRef | undefined> {
    const task = instance.tasks.find((t) => t.id === taskId);
    const repo = await this.repoOf(instance);
    if (repo === undefined || task?.worktree === undefined) return undefined;
    return { repo, path: task.worktree.path, branch: task.worktree.branch };
  }

  private async integRef(instance: WorkflowInstance, attempt: MergeAttempt): Promise<WorktreeRef | undefined> {
    const repo = await this.repoOf(instance);
    if (repo === undefined || attempt.integration === undefined) return undefined;
    return { repo, path: attempt.integration.path, branch: attempt.integration.branch };
  }

  // ---- records ------------------------------------------------------------------------------------

  /**
   * Compare-and-set of the instance: `mutate` sees the stored instance each try and returns the next one, or
   * undefined when there is nothing (more) to do; the saved instance is returned.
   */
  private async mutate(instanceId: InstanceId, mutate: (instance: WorkflowInstance) => WorkflowInstance | undefined): Promise<WorkflowInstance | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.repos.instances.get(instanceId);
      if (current === undefined) return undefined;
      const next = mutate(current);
      if (next === undefined) return undefined;
      const saved = await this.repos.instances.update({ ...next, revision: current.revision + 1 }, current.revision);
      if (saved.status === 'saved') {
        this.deps.publish({ type: 'instance.updated', instance: saved.record });
        return saved.record;
      }
    }
    this.deps.log(`[pipeline] the run ${instanceId} kept meeting newer revisions`);
    return undefined;
  }

  private static withTask(instance: WorkflowInstance, taskId: TaskId, change: (task: WorkflowTask) => WorkflowTask): WorkflowInstance {
    return { ...instance, tasks: instance.tasks.map((t) => (t.id === taskId ? change(t) : t)) };
  }

  private static withAttempt(instance: WorkflowInstance, attempt: MergeAttempt, change: (m: MergeAttempt) => MergeAttempt): WorkflowInstance {
    return { ...instance, mergeQueue: instance.mergeQueue.map((m) => (m.taskId === attempt.taskId && m.attempt === attempt.attempt ? change(m) : m)) };
  }

  private static findAttempt(instance: WorkflowInstance, of: Pick<MergeAttempt, 'taskId' | 'attempt'>): MergeAttempt | undefined {
    return instance.mergeQueue.find((m) => m.taskId === of.taskId && m.attempt === of.attempt);
  }

  // ---- create_tasks (R-06, O-07) ------------------------------------------------------------------

  /** `create_tasks` of root, in the instance's queue. */
  async createTasks(caller: WorkflowSession, input: CreateTasksToolInput, sourceCallRef: string): Promise<CreateTasksToolResult> {
    const instance = await this.repos.instances.get(caller.workflow.instanceId);
    if (instance === undefined) return rejected('unknown-target', 'no such workflow run');
    if (ended(instance)) return rejected('invalid-input', 'this workflow run has ended');
    const root = rootNode(instance.template);
    if (caller.id !== instance.rootSessionId || caller.workflow.nodeId !== root.id || caller.workflow.taskId !== undefined) return rejected('invalid-input', 'only the root session creates tasks');
    const parsed = CreateTasksInputSchema.safeParse(input);
    if (!parsed.success) return rejected('invalid-input', 'the task list is not valid: keys must be unique, and dependencies must name keys of this list without a cycle');
    const { ruleId, tasks: items } = parsed.data;
    const rule = root.outputRules.find((r) => r.id === ruleId && r.target.kind === 'tasks');
    if (rule === undefined) return rejected('no-matching-rule', 'no output rule of root with this ruleId creates tasks');
    const unknown = items.flatMap((i) => i.dependsOnExisting).filter((id) => !instance.tasks.some((t) => t.id === id));
    if (unknown.length > 0) return rejected('invalid-input', `no such task: ${unknown.join(', ')}`);

    // The same call again (a resend, a restart): the list it made, never a second one (CR2 §4).
    const planId = await taskPlanIdOf(this.deps.hash, caller.id, sourceCallRef);
    const known = instance.taskPlans.find((p) => p.id === planId);
    if (known !== undefined) {
      if (known.ruleId !== ruleId || !sameItems(known.items, items)) return rejected('resend-mismatch', 'this call carried another task list');
      return this.planResult(known);
    }
    // Worktree isolation: the repository and target branch are fixed with the first list (R-06).
    let fixed: { targetBranch?: string; projectId?: WorkflowInstance['projectId'] } = {};
    if (this.worktreeMode(instance) && instance.targetBranch === undefined) {
      const target = await this.resolveTarget(instance);
      if ('rejection' in target) return target;
      fixed = target;
    }
    const at = this.deps.now();
    const escalationId = taskPlanEscalationId(planId);
    const plan: TaskPlan = rule.requiresUserConfirmation
      ? { id: planId, fromSessionId: caller.id, sourceCallRef, ruleId, items, state: 'awaiting-confirmation', escalationId, created: [], createdAt: at }
      : { ...this.createdPlan({ id: planId, fromSessionId: caller.id, sourceCallRef, ruleId, items, state: 'awaiting-confirmation', created: [], createdAt: at }, at) };
    const saved = await this.mutate(instance.id, (current) => {
      if (current.taskPlans.some((p) => p.id === planId)) return undefined;
      const withPlan: WorkflowInstance = { ...current, ...fixed, taskPlans: [...current.taskPlans, plan] };
      return plan.state === 'created' ? { ...withPlan, tasks: [...current.tasks, ...this.tasksOf(current, plan)] } : withPlan;
    });
    const stored = (saved ?? (await this.repos.instances.get(instance.id)))?.taskPlans.find((p) => p.id === planId);
    if (stored === undefined) throw new Error('the task list could not be saved');
    if (stored.state === 'awaiting-confirmation') await this.openPlanQuestion(saved ?? instance, stored);
    else await this.admitNow(instance.id);
    return this.planResult(stored);
  }

  private planResult(plan: TaskPlan): CreateTasksToolResult {
    if (plan.state === 'created') return { status: 'created', tasks: plan.created };
    if (plan.state === 'declined') return rejected('invalid-input', 'the user declined this task list');
    return { status: 'awaiting-confirmation', taskPlanId: plan.id, escalationId: plan.escalationId ?? taskPlanEscalationId(plan.id) };
  }

  /** The plan as created: every item named with its fixed task ID. */
  private createdPlan(plan: TaskPlan, at: Timestamp): TaskPlan {
    const created = plan.items.map((i) => ({ key: i.key, taskId: planTaskIdOf(plan.id, i.key) }));
    return { ...plan, state: 'created', created, decidedAt: at };
  }

  /** The new tasks of a created plan, not already in the instance. */
  private tasksOf(instance: WorkflowInstance, plan: TaskPlan): WorkflowTask[] {
    const idOf = (key: string) => planTaskIdOf(plan.id, key);
    return plan.items
      .filter((i) => !instance.tasks.some((t) => t.id === idOf(i.key)))
      .map((i) => ({ id: idOf(i.key), instanceId: instance.id, title: i.title, dependsOn: [...i.dependsOn.map(idOf), ...i.dependsOnExisting], status: 'pending', reworkCount: 0 }));
  }

  /** The repository, project and target branch of a worktree run. */
  private async resolveTarget(instance: WorkflowInstance): Promise<{ targetBranch: string; projectId?: WorkflowInstance['projectId'] } | ReturnType<typeof rejected>> {
    const project = await this.projectOf(instance);
    const repo = await this.repoOf(instance);
    if (repo === undefined) return rejected('unknown-target', 'the run has no folder');
    let branch = project?.defaultBranch;
    try {
      // GitPort has no "current branch" query: the main checkout's own status says it (read only).
      branch ??= (await this.git.status({ repo, path: repo, branch: '' })).branch;
    } catch (error) {
      this.deps.log(`[pipeline] reading the branch of ${repo} failed (${errorText(error)})`);
      return rejected('invalid-input', 'the run folder is not a git repository; tasks with worktrees need one');
    }
    if (branch === undefined) return rejected('invalid-input', 'the run folder has no branch checked out to merge into');
    if ((await this.git.resolveBranch(repo, branch)) === undefined) return rejected('invalid-input', `the target branch ${branch} was not found`);
    return { targetBranch: branch, ...(project !== undefined && { projectId: project.id }) };
  }

  private async openPlanQuestion(instance: WorkflowInstance, plan: TaskPlan): Promise<void> {
    const id = plan.escalationId ?? taskPlanEscalationId(plan.id);
    if ((await this.repos.escalations.get(id)) !== undefined) return;
    const escalation: Escalation = {
      id,
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: plan.fromSessionId,
      kind: 'confirmation',
      title: 'Root proposes a task list',
      detail: `${String(plan.items.length)} task(s): ${plan.items.map((i) => i.title).join('; ')}. Approve to create them; decline to drop the list.`,
      ref: { kind: 'taskPlan', taskPlanId: plan.id },
      state: 'open',
      createdAt: this.deps.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.deps.publish({ type: 'escalation.updated', escalation });
  }

  /** The user's decision on a task list is written first; carrying it out follows (and a restart finishes it). */
  private async carryOutPlan(instanceId: InstanceId, planId: TaskPlan['id']): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    const plan = instance?.taskPlans.find((p) => p.id === planId);
    if (instance === undefined || plan?.state !== 'awaiting-confirmation') return;
    const escalation = await this.repos.escalations.get(plan.escalationId ?? taskPlanEscalationId(plan.id));
    if (escalation === undefined || escalation.state === 'open') return;
    const approved = escalation.state === 'approved' && !ended(instance);
    const at = this.deps.now();
    await this.mutate(instanceId, (current) => {
      const p = current.taskPlans.find((x) => x.id === planId);
      if (p?.state !== 'awaiting-confirmation') return undefined;
      const next = approved ? this.createdPlan(p, at) : { ...p, state: 'declined' as const, decidedAt: at };
      const plans = current.taskPlans.map((x) => (x.id === planId ? next : x));
      return { ...current, taskPlans: plans, tasks: approved ? [...current.tasks, ...this.tasksOf(current, next)] : current.tasks };
    });
    if (approved) await this.admitNow(instanceId);
  }

  // ---- handoffs of a task -------------------------------------------------------------------------

  /**
   * Before a handoff of a task is accepted (in the instance's queue): the task must still take work, its
   * worktree is made the first time (a session's cwd must exist), and what a writing node changed is
   * committed by the GUI (R-06), so the agent need not commit. A rejection is returned to the agent.
   */
  async beforeHandoff(instance: WorkflowInstance, taskId: TaskId, from: AgentNode, target: WorkflowNode): Promise<HandoffToolResult | undefined> {
    const task = instance.tasks.find((t) => t.id === taskId);
    if (task === undefined) return rejected('unknown-target', 'no such task');
    if (isFinal(task)) return rejected('invalid-input', `the task has ended (${task.status})`);
    if (task.status === 'awaiting-merge' || task.status === 'merging') return rejected('invalid-input', 'the task is in the merge queue');
    if (task.status === 'blocked' && (task.blockedReason === 'setup-failed' || task.blockedReason === 'merge-failed' || task.blockedReason === 'merge-conflict' || task.blockedReason === 'tests-failed')) {
      return rejected('invalid-input', `the task is blocked (${task.blockedReason}) until the user decides`);
    }
    const lost = task.dependsOn.map((d) => instance.tasks.find((t) => t.id === d)).filter((d) => d !== undefined && isFinal(d) && !satisfied(d));
    if (lost.length > 0) return rejected('dependency-unmet', `the task depends on ${lost.map((d) => d?.title).join(', ')}, which will not be merged`);
    if (!this.worktreeMode(instance)) return undefined;
    const ref = await this.ensureWorktree(instance, task);
    if ('failed' in ref) {
      await this.blockSetup(instance.id, taskId, `the task worktree could not be made: ${ref.failed}`);
      return rejected('unknown-target', 'the task worktree could not be made; the user was asked');
    }
    // A writing node's changes are committed at its handoff; root and read-only nodes change nothing.
    if (from.isRoot || from.writePolicy === 'read-only' || task.status === 'pending') return undefined;
    const exclude = this.setupOutputs(task, ref.ref.path);
    const where = target.kind === 'merge' ? 'merge' : `"${target.label}"`;
    const committed = await this.git.commitAll(ref.ref, `awg: ${from.label} → ${where} (${task.title})`, exclude);
    if (committed.status === 'failed') {
      const markers = committed.detail.includes('Conflict markers') ? ' Resolve the conflict markers (a file that must show both kinds needs a larger conflict-marker-size), then hand off again.' : '';
      return rejected('invalid-input', `the GUI could not commit the task's changes: ${committed.detail}.${markers}`);
    }
    return undefined;
  }

  /** What the setup script made in the worktree: kept out of the GUI's commits (SP-07 G1, G2). */
  private setupOutputs(task: WorkflowTask, path: string): string[] {
    if (task.setup?.endedAt === undefined) return [];
    try {
      return this.deps.files.createdBetween(path, task.setup.startedAt, task.setup.endedAt);
    } catch (error) {
      this.deps.log(`[pipeline] listing the setup outputs of ${task.id} failed (${errorText(error)})`);
      return [];
    }
  }

  /**
   * The task's worktree, made once from the target branch (R-06). The intent (path, branch, base) is written
   * first, so a retry after a crash asks git for exactly the same worktree and finds it (`exists`).
   */
  private async ensureWorktree(instance: WorkflowInstance, task: WorkflowTask): Promise<{ ref: WorktreeRef } | { failed: string }> {
    const repo = await this.repoOf(instance);
    if (repo === undefined || instance.targetBranch === undefined) return { failed: 'the run has no repository or target branch' };
    let worktree = task.worktree;
    if (worktree?.baseCommit === undefined) {
      const ref = await taskWorktreeRef(this.deps.hash, repo, instance.id, task.id);
      const base = await this.git.resolveBranch(repo, instance.targetBranch);
      if (base === undefined) return { failed: `the target branch ${instance.targetBranch} was not found` };
      const saved = await this.mutate(instance.id, (current) => {
        const t = current.tasks.find((x) => x.id === task.id);
        if (t === undefined || t.worktree?.baseCommit !== undefined) return undefined;
        return TaskPipeline.withTask(current, task.id, (x) => ({ ...x, worktree: { path: ref.path, branch: ref.branch, baseCommit: base, cleanup: 'active' } }));
      });
      worktree = (saved ?? (await this.repos.instances.get(instance.id)))?.tasks.find((t) => t.id === task.id)?.worktree;
      if (worktree?.baseCommit === undefined) return { failed: 'the worktree could not be recorded' };
    }
    const ref = { repo, path: worktree.path, branch: worktree.branch };
    this.own(ref.path);
    if (worktree.cleanup !== 'active') return { failed: 'the task worktree was removed' };
    if (this.made.has(pathKey(ref.path))) return { ref };
    const made = await this.git.createWorktree(ref, worktree.baseCommit ?? '');
    if (made.status === 'failed') return { failed: made.detail };
    this.made.add(pathKey(ref.path));
    // Its links resolve now that it exists.
    this.own(ref.path);
    return { ref };
  }

  /** Whether the task's work may be delivered: started, its setup done (R-06); same-folder tasks once started. */
  deliverable(instance: WorkflowInstance, taskId: TaskId): boolean {
    const task = instance.tasks.find((t) => t.id === taskId);
    if (task === undefined) return false;
    if (task.status !== 'running' && !(task.status === 'blocked' && task.blockedReason === 'round-blocked')) return false;
    if (task.setup !== undefined && task.setup.state !== 'succeeded') return false;
    if (this.settingUp.has(key(instance.id, taskId))) return false;
    if (!this.worktreeMode(instance)) return true;
    return task.worktree?.baseCommit !== undefined && task.worktree.cleanup === 'active';
  }

  /** The folder a task's sessions work in: its worktree, or root's cwd in same-folder runs. */
  cwdOf(instance: WorkflowInstance, taskId: TaskId): string | undefined {
    if (!this.worktreeMode(instance)) return undefined;
    return instance.tasks.find((t) => t.id === taskId)?.worktree?.path;
  }

  // ---- starting tasks (V-19, V-20, O-05) ----------------------------------------------------------

  /**
   * Starts every task that may (in the instance's queue): pending, root already handed it its work, every
   * dependency merged (or completed), and fewer tasks in progress than the run's limit. A task whose
   * dependencies moved the target branch takes it in first; then its setup runs, outside the queue.
   */
  async admit(instanceId: InstanceId): Promise<void> {
    await this.deps.host.serial(instanceId, () => this.admitNow(instanceId));
  }

  /** `admit` for a caller already in the instance's queue. */
  async admitNow(instanceId: InstanceId): Promise<void> {
    if (this.deps.sessions.isClosing()) return;
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined || ended(instance)) return;
    const handoffs = await this.repos.handoffs.listByInstance(instanceId);
    const waiting = (taskId: TaskId) => handoffs.some((h) => h.taskId === taskId && h.delivery.state === 'pending' && h.outcome === undefined);
    let active = instance.tasks.filter((t) => IN_PROGRESS.includes(t.status)).length;
    const commands = await this.commandsOf(instance);
    for (const task of instance.tasks) {
      if (active >= instance.taskLimit) break;
      if (task.status !== 'pending' || !waiting(task.id)) continue;
      if (!task.dependsOn.every((d) => satisfied(instance.tasks.find((t) => t.id === d)))) continue;
      if (this.worktreeMode(instance)) {
        const caughtUp = await this.catchUp(instance, task);
        if (caughtUp !== undefined) {
          await this.blockSetup(instanceId, task.id, caughtUp);
          active++;
          continue;
        }
      }
      const at = this.deps.now();
      const setup = this.worktreeMode(instance) && commands.setup !== undefined ? { state: 'running' as const, command: commands.setup, startedAt: at, outputTail: '' } : undefined;
      const saved = await this.mutate(instanceId, (current) => {
        const t = current.tasks.find((x) => x.id === task.id);
        if (t?.status !== 'pending' || ended(current)) return undefined;
        if (current.tasks.filter((x) => IN_PROGRESS.includes(x.status)).length >= current.taskLimit) return undefined;
        return TaskPipeline.withTask(current, task.id, (x) => ({ ...x, status: 'running', ...(setup !== undefined && { setup }) }));
      });
      if (saved === undefined) continue;
      active++;
      if (setup !== undefined) this.startSetup(instanceId, task.id);
      else await this.deps.host.wakeTask(instanceId, task.id);
    }
  }

  /**
   * A task with dependencies brings its branch up to the target branch, which now has their work (R-06). Its
   * own branch has no commits yet, so this never conflicts; the folder stays (a session may already be bound).
   */
  private async catchUp(instance: WorkflowInstance, task: WorkflowTask): Promise<string | undefined> {
    // The worktree is there before anything is delivered into it (made at root's handoff; checked again here).
    const ensured = await this.ensureWorktree(instance, task);
    if ('failed' in ensured) return `the task worktree could not be made: ${ensured.failed}`;
    if (task.dependsOn.length === 0 || instance.targetBranch === undefined) return undefined;
    const tip = await this.git.resolveBranch(ensured.ref.repo, instance.targetBranch);
    if (tip === undefined) return `the target branch ${instance.targetBranch} was not found`;
    if (tip === task.worktree?.baseCommit) return undefined;
    const merged = await this.git.merge(ensured.ref, instance.targetBranch, `awg: take in ${instance.targetBranch} before starting (${task.title})`);
    if (merged.status === 'merged') return undefined;
    if (merged.status === 'conflict') {
      await this.git.abortMerge(ensured.ref);
      return `taking in ${instance.targetBranch} conflicted in ${merged.files.join(', ')}`;
    }
    return `taking in ${instance.targetBranch} failed: ${merged.detail}`;
  }

  /** Runs the task's setup (R-06) and records how it ended; a failure blocks the task and asks root (V-20). */
  private startSetup(instanceId: InstanceId, taskId: TaskId): void {
    const running = key(instanceId, taskId);
    if (this.settingUp.has(running)) return;
    this.settingUp.add(running);
    void this.runSetup(instanceId, taskId)
      .catch((error: unknown) => this.deps.log(`[pipeline] the setup of ${taskId} failed (${errorText(error)})`))
      .finally(() => {
        this.settingUp.delete(running);
      });
  }

  private async runSetup(instanceId: InstanceId, taskId: TaskId): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    const task = instance?.tasks.find((t) => t.id === taskId);
    if (instance === undefined || task?.setup?.state !== 'running' || task.status !== 'running') return;
    const ref = await this.ensureWorktree(instance, task);
    const commands = await this.commandsOf(instance);
    const startedAt = task.setup.startedAt;
    const outcome =
      'failed' in ref
        ? { exitCode: null, outputTail: '', detail: `the task worktree could not be made: ${ref.failed}` }
        : await this.runCommand({ command: task.setup.command, shell: commands.shell, cwd: ref.ref.path, key: `setup:${key(instanceId, taskId)}`, purpose: 'setup' }, key(instanceId, taskId));
    const passed = outcome.exitCode === 0;
    const at = this.deps.now();
    const saved = await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      // Only the setup this run started: a cancel or a newer run meanwhile wins.
      if (t?.setup?.state !== 'running' || t.setup.startedAt !== startedAt || t.status !== 'running') return undefined;
      const setup = { ...t.setup, state: passed ? ('succeeded' as const) : ('failed' as const), endedAt: at, exitCode: outcome.exitCode, outputTail: tail(outcome.outputTail || (outcome.detail ?? '')) };
      return TaskPipeline.withTask(current, taskId, (x) => (passed ? { ...x, setup } : { ...x, setup, status: 'blocked', blockedReason: 'setup-failed' }));
    });
    if (saved === undefined) return;
    this.settingUp.delete(key(instanceId, taskId));
    if (passed) await this.deps.host.wakeTask(instanceId, taskId);
    else await this.openSetupQuestion(saved, taskId, outcome.detail ?? `the setup script exited with code ${String(outcome.exitCode)}`);
  }

  private async runCommand(spec: Parameters<CommandRunner['run']>[0], runKey: string): Promise<{ exitCode: number | null; outputTail: string; detail?: string }> {
    let running: RunningCommand;
    try {
      running = this.deps.commands.run(spec);
    } catch (error) {
      return { exitCode: null, outputTail: '', detail: `the ${spec.purpose} command could not be started: ${errorText(error)}` };
    }
    this.running.set(runKey, running);
    try {
      return await running.done;
    } finally {
      if (this.running.get(runKey) === running) this.running.delete(runKey);
    }
  }

  /** Blocks a task at its worktree or setup (V-20) and asks root. */
  private async blockSetup(instanceId: InstanceId, taskId: TaskId, detail: string): Promise<void> {
    const saved = await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      if (t === undefined || isFinal(t) || (t.status === 'blocked' && t.blockedReason === 'setup-failed')) return undefined;
      return TaskPipeline.withTask(current, taskId, (x) => ({ ...x, status: 'blocked', blockedReason: 'setup-failed' }));
    });
    const instance = saved ?? (await this.repos.instances.get(instanceId));
    if (instance !== undefined) await this.openSetupQuestion(instance, taskId, detail);
  }

  private async openSetupQuestion(instance: WorkflowInstance, taskId: TaskId, detail: string): Promise<void> {
    const task = instance.tasks.find((t) => t.id === taskId);
    await this.deps.host.openOnce(setupEscalationBase(instance.id, taskId), {
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: instance.rootSessionId,
      kind: 'setup-failed',
      title: 'A task could not be set up',
      detail: `task "${task?.title ?? taskId}": ${detail}. Approve to run its setup again; decline to give the task up.`,
      ref: { kind: 'task', taskId },
    });
  }

  // ---- the merge queue (V-21, CR-3) ---------------------------------------------------------------

  /**
   * A handoff to the merge node (in the instance's queue, after `beforeHandoff` committed the task): the task
   * joins the merge queue; same-folder tasks have nothing to merge and are completed. A resend finds the task
   * already queued or merged and changes nothing.
   */
  async enqueue(instance: WorkflowInstance, taskId: TaskId, mergeNode: WorkflowNode): Promise<void> {
    const at = this.deps.now();
    if (!this.worktreeMode(instance)) {
      await this.mutate(instance.id, (current) => {
        const t = current.tasks.find((x) => x.id === taskId);
        if (t === undefined || isFinal(t)) return undefined;
        return TaskPipeline.withTask(current, taskId, (x) => ({ ...x, status: 'completed', currentNodeId: mergeNode.id, completedAt: at }));
      });
      await this.admitNow(instance.id);
      return;
    }
    await this.mutate(instance.id, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      if (t?.status !== 'running') return undefined;
      const attempt = 1 + Math.max(-1, ...current.mergeQueue.filter((m) => m.taskId === taskId).map((m) => m.attempt));
      const seq = 1 + Math.max(-1, ...current.mergeQueue.map((m) => m.seq));
      const queued: MergeAttempt = { taskId, attempt, seq, state: 'queued', conflictFiles: [], restarts: 0, enqueuedAt: at };
      return { ...TaskPipeline.withTask(current, taskId, (x) => ({ ...x, status: 'awaiting-merge', currentNodeId: mergeNode.id })), mergeQueue: [...current.mergeQueue, queued] };
    });
    this.kick(instance.id);
  }

  /** Works the instance's merge queue until it waits (an agent resolving) or is empty; one runner per instance. */
  kick(instanceId: InstanceId): void {
    const runner = this.runners.get(instanceId);
    if (runner !== undefined) {
      runner.again = true;
      return;
    }
    const state = { again: false };
    this.runners.set(instanceId, state);
    void (async () => {
      try {
        for (let steps = 0; steps < 1000; steps++) {
          if (this.deps.sessions.isClosing()) return;
          state.again = false;
          if (!(await this.step(instanceId)) && !state.again) return;
        }
        this.deps.log(`[pipeline] the merge queue of ${instanceId} took too many steps at once`);
      } catch (error) {
        this.deps.log(`[pipeline] the merge queue of ${instanceId} stopped (${errorText(error)})`);
      } finally {
        this.runners.delete(instanceId);
      }
    })();
  }

  /** One step of the queue; false when there is nothing to do now. */
  private async step(instanceId: InstanceId): Promise<boolean> {
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined || ended(instance) || !this.worktreeMode(instance)) return false;
    const active = instance.mergeQueue.find((m) => activeMergeStates.includes(m.state));
    if (active === undefined) return this.begin(instance);
    switch (active.state) {
      case 'merging':
        await this.merge(instance, active);
        return true;
      case 'resolving':
        return this.checkResolver(instance, active);
      case 'testing':
        await this.test(instance, active);
        return true;
      case 'advancing':
        await this.advance(instance, active);
        return true;
      default:
        return false;
    }
  }

  /** Step 1 (R-06): the queued attempt with the lowest seq gets an integration worktree from the target branch's commit. */
  private async begin(instance: WorkflowInstance): Promise<boolean> {
    const next = instance.mergeQueue.filter((m) => m.state === 'queued').sort((a, b) => a.seq - b.seq)[0];
    if (next === undefined) return false;
    const repo = await this.repoOf(instance);
    const base = repo === undefined || instance.targetBranch === undefined ? undefined : await this.git.resolveBranch(repo, instance.targetBranch);
    if (repo === undefined || base === undefined) {
      await this.failAttempt(instance.id, next, `the target branch ${instance.targetBranch ?? '(none)'} was not found`, 'queued');
      return true;
    }
    const integ = await integrationRef(this.deps.hash, repo, instance.id, next.taskId, next.attempt);
    this.own(integ.path);
    await this.mutate(instance.id, (current) => {
      const m = TaskPipeline.findAttempt(current, next);
      if (m?.state !== 'queued' || current.mergeQueue.some((x) => activeMergeStates.includes(x.state))) return undefined;
      const moved = TaskPipeline.withAttempt(current, m, (x) => ({ ...x, state: 'merging', integration: { path: integ.path, branch: integ.branch, cleanup: 'active' }, baseCommit: base }));
      return TaskPipeline.withTask(moved, m.taskId, (t) => ({ ...t, status: 'merging' }));
    });
    return true;
  }

  /** Step 2: the GUI merges the task branch in the integration worktree; a restart reads where git stands. */
  private async merge(instance: WorkflowInstance, m: MergeAttempt): Promise<void> {
    const integ = await this.integRef(instance, m);
    const task = await this.taskRef(instance, m.taskId);
    if (integ === undefined || task === undefined || m.baseCommit === undefined) return this.failAttempt(instance.id, m, 'the attempt lost its worktrees', 'merging');
    const made = await this.git.createWorktree(integ, m.baseCommit);
    if (made.status === 'failed') return this.failAttempt(instance.id, m, `the integration worktree could not be made: ${made.detail}`, 'merging');
    this.own(integ.path);
    const status = await this.git.status(integ).catch((error: unknown) => errorText(error));
    if (typeof status === 'string') return this.failAttempt(instance.id, m, `the integration worktree cannot be read: ${status}`, 'merging');
    if (status.merging) return this.toResolving(instance.id, m, status.conflictFiles);
    // Merged before a restart, not recorded yet: the commit is the merge.
    if (status.head !== m.baseCommit) return this.toTesting(instance.id, m, status.head, 'merging');
    const title = instance.tasks.find((t) => t.id === m.taskId)?.title ?? m.taskId;
    const merged = await this.git.merge(integ, task.branch, `awg: merge ${title} (${m.taskId})`);
    if (merged.status === 'merged') return this.toTesting(instance.id, m, merged.commit, 'merging');
    if (merged.status === 'conflict') return this.toResolving(instance.id, m, merged.files);
    return this.failAttempt(instance.id, m, `git could not merge the task: ${merged.detail}`, 'merging');
  }

  private async toTesting(instanceId: InstanceId, m: MergeAttempt, commit: string, from: MergeAttempt['state']): Promise<void> {
    await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.state !== from) return undefined;
      return TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'testing', mergedCommit: commit, conflictFiles: [] }));
    });
  }

  private async toResolving(instanceId: InstanceId, m: MergeAttempt, files: readonly string[]): Promise<void> {
    const saved = await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.state !== 'merging') return undefined;
      return TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'resolving', conflictFiles: files.length > 0 ? [...files] : ['(unknown)'] }));
    });
    if (saved !== undefined) {
      const attempt = TaskPipeline.findAttempt(saved, m);
      if (attempt !== undefined) await this.startResolver(saved, attempt);
    }
  }

  /**
   * A conflict goes to an agent first (O-04): a session of the task's implementation node, in the integration
   * worktree, told by the merge node what conflicts. It gets one turn; the GUI then looks at the worktree.
   */
  private async startResolver(instance: WorkflowInstance, m: MergeAttempt): Promise<void> {
    const handoffs = await this.repos.handoffs.listByInstance(instance.id);
    const impl = implementationNode(instance, handoffs, m.taskId);
    const integ = await this.integRef(instance, m);
    if (impl === undefined || integ === undefined) return this.resolutionFailed(instance.id, m, 'no node of the task can resolve a conflict');
    const sessionId = await resolverSessionIdOf(this.deps.hash, instance.id, m.taskId, m.attempt);
    const made = await this.deps.sessions.createWorkflowSession({ sessionId, instance, nodeId: impl.id, taskId: m.taskId, cwd: integ.path, parentId: instance.rootSessionId, worktree: true });
    if (made !== 'created' && made !== 'exists') return this.resolutionFailed(instance.id, m, `the session that resolves the conflict could not be made (${made})`);
    const operationId = await resolveOperationOf(this.deps.hash, instance.id, m.taskId, m.attempt);
    if ((await this.store.get(operationId)) === undefined) {
      const task = instance.tasks.find((t) => t.id === m.taskId);
      const payload = resolveText(instance, task?.title ?? m.taskId, m);
      const origin: MessageOrigin = { kind: 'peer', fromSessionId: instance.rootSessionId, peerMessageId: peerIdOf(operationId) };
      const target = await this.deps.sessions.payloadTarget(sessionId);
      const context = await this.deps.sessions.payloadContext(sessionId, origin);
      if (target === undefined || context === undefined) return this.resolutionFailed(instance.id, m, 'the session that resolves the conflict cannot be started');
      const accepted = await this.deps.sessions.delivery.accept({
        kind: 'peer-message',
        operationId,
        sourceCallRef: operationId,
        sender: instance.rootSessionId,
        payloadHash: await this.deps.hash(payload),
        payload,
        proposalRevision: instance.workflowRevision,
        target,
        at: this.deps.now(),
        context: { ...context, entry: { kind: 'new-turn' } },
        peer: { peerMessageId: peerIdOf(operationId), fromSessionId: instance.rootSessionId, toSessionId: sessionId, instanceId: instance.id },
      });
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') return this.resolutionFailed(instance.id, m, `the conflict could not be handed to an agent (${accepted.status})`);
    }
    await this.deps.sessions.deliverWorkflow(operationId, sessionId, 'insert-if-busy');
    const message = await this.repos.peerMessages.get(peerIdOf(operationId));
    if (message !== undefined) this.deps.publish({ type: 'peerMessage.updated', message });
  }

  /** Whether the resolver's turn is over; then the GUI decides by what git shows. False while it waits. */
  private async checkResolver(instance: WorkflowInstance, m: MergeAttempt): Promise<boolean> {
    const operationId = await resolveOperationOf(this.deps.hash, instance.id, m.taskId, m.attempt);
    const sessionId = await resolverSessionIdOf(this.deps.hash, instance.id, m.taskId, m.attempt);
    const record = await this.store.get(operationId);
    if (record === undefined || (record.delivery.state === 'pending' && record.outcome === undefined)) {
      // Not handed over yet (a crash between, or a session that could not start): handed over now.
      await this.startResolver(instance, m);
      const after = await this.store.get(operationId);
      return after?.delivery.state !== 'sent' && after?.outcome !== undefined;
    }
    if (record.outcome !== undefined) {
      await this.resolutionFailed(instance.id, m, 'the conflict was not handed to an agent (cancelled)');
      return true;
    }
    // Unknown: the user decides through the delivery's own escalation; the merge waits.
    if (record.delivery.state === 'unknown') return false;
    const sent = record.delivery.attempts.at(-1);
    const turnRef = sent?.state === 'sent' ? sent.nativeRef.turnRef : undefined;
    const turns = (await this.repos.conversations.get(sessionId)).turns.filter((t) => t.nativeTaskId === undefined);
    const turn = turnRef === undefined ? undefined : turns.find((t) => t.id === turnRef);
    const over = turn !== undefined ? turn.state !== 'running' : turns.some((t) => t.state !== 'running' && t.startedAt >= (sent?.dispatchStartedAt ?? '')) && !(await this.deps.sessions.mainTurnRunning(sessionId));
    if (!over) return false;
    const integ = await this.integRef(instance, m);
    if (integ === undefined) {
      await this.resolutionFailed(instance.id, m, 'the integration worktree is gone');
      return true;
    }
    const status = await this.git.status(integ).catch((error: unknown) => errorText(error));
    if (typeof status === 'string') {
      await this.resolutionFailed(instance.id, m, `the integration worktree cannot be read: ${status}`);
      return true;
    }
    if (!status.merging && status.head !== m.baseCommit) {
      await this.toTesting(instance.id, m, status.head, 'resolving');
      return true;
    }
    if (status.merging) {
      // The GUI stages and commits the resolution: commitAll refuses a conflicted file that still has both kinds
      // of markers (T030); one kind left over passes and is the tests' to catch.
      const committed = await this.git.commitAll(integ, `awg: merge ${m.taskId} (conflicts resolved)`, []);
      if (committed.status === 'committed') await this.toTesting(instance.id, m, committed.commit, 'resolving');
      else await this.resolutionFailed(instance.id, m, committed.status === 'failed' ? `the conflict is not resolved: ${committed.detail}` : 'the resolution left nothing to commit');
      return true;
    }
    await this.resolutionFailed(instance.id, m, 'the merge was abandoned in the integration worktree');
    return true;
  }

  /** The agent could not resolve: the merge is undone and the task goes back to its implementation node (R-06). */
  private async resolutionFailed(instanceId: InstanceId, m: MergeAttempt, detail: string): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    const integ = instance === undefined ? undefined : await this.integRef(instance, m);
    let head: string | undefined;
    if (integ !== undefined) {
      const status = await this.git.status(integ).catch(() => undefined);
      if (status?.merging === true) await this.git.abortMerge(integ);
      head = (await this.git.status(integ).catch(() => undefined))?.head;
    }
    const saved = await this.endAttempt(instanceId, m, ['resolving', 'merging'], 'conflict', detail);
    if (saved === undefined) return;
    await this.closeResolver(instanceId, m);
    await this.cleanupIntegration(instanceId, m, head !== undefined && head === m.baseCommit);
    await this.giveBack(instanceId, m, 'conflict');
  }

  /** Step 3: the tests run in the integration worktree; a failure gives the task back, the target untouched. */
  private async test(instance: WorkflowInstance, m: MergeAttempt): Promise<void> {
    const commands = await this.commandsOf(instance);
    const integ = await this.integRef(instance, m);
    if (commands.test === undefined) return this.failAttempt(instance.id, m, NO_TEST, 'testing');
    if (integ === undefined) return this.failAttempt(instance.id, m, 'the integration worktree is gone', 'testing');
    const outcome = await this.runCommand({ command: commands.test, shell: commands.shell, cwd: integ.path, key: `test:${key(instance.id, m.taskId)}:${String(m.attempt)}`, purpose: 'test' }, `test:${key(instance.id, m.taskId)}`);
    const passed = outcome.exitCode === 0;
    const test = { command: commands.test, exitCode: outcome.exitCode, passed, outputTail: tail(outcome.outputTail || (outcome.detail ?? '')), endedAt: this.deps.now() };
    if (passed) {
      await this.mutate(instance.id, (current) => {
        const x = TaskPipeline.findAttempt(current, m);
        if (x?.state !== 'testing') return undefined;
        return TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'advancing', test }));
      });
      return;
    }
    const saved = await this.endAttempt(instance.id, m, ['testing'], 'tests-failed', undefined, test);
    if (saved === undefined) return;
    await this.cleanupIntegration(instance.id, m, false);
    await this.giveBack(instance.id, m, 'tests');
  }

  /** Step 4: the target branch fast-forwards to the tested commit; a branch moved meanwhile starts over (step 1). */
  private async advance(instance: WorkflowInstance, m: MergeAttempt): Promise<void> {
    const repo = await this.repoOf(instance);
    if (repo === undefined || instance.targetBranch === undefined || m.baseCommit === undefined || m.mergedCommit === undefined) {
      return this.failAttempt(instance.id, m, 'the attempt lost its commits', 'advancing');
    }
    const advanced = await this.git.advanceBranch(repo, instance.targetBranch, m.baseCommit, m.mergedCommit);
    // A restart after the move finds the branch already at the tested commit.
    if (advanced.status === 'advanced' || (advanced.status === 'moved' && advanced.current === m.mergedCommit)) return this.merged(instance.id, m);
    if (advanced.status === 'moved') return this.restart(instance.id, m);
    return this.failAttempt(instance.id, m, advanced.detail, 'advancing');
  }

  /** Step 5: the task is merged (dependents may start), root is told, then the worktrees go. */
  private async merged(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    const at = this.deps.now();
    await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.state !== 'advancing') return undefined;
      const done = TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'merged', endedAt: at }));
      return TaskPipeline.withTask(done, x.taskId, (t) => {
        const merged: WorkflowTask = { ...t, status: 'merged', completedAt: at };
        delete merged.blockedReason;
        return merged;
      });
    });
    await this.afterMerged(instanceId, m);
  }

  /** What follows a merge, each part safe to repeat: dependents, root's report, cleanup. */
  private async afterMerged(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    await this.admit(instanceId);
    await this.reportMerged(instanceId, m);
    await this.cleanupMerged(instanceId, m);
  }

  /** The merge node's output rule to root, if it has one, tells root (R-04); counted nowhere. */
  private async reportMerged(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined) return;
    const mergeNode = instance.template.nodes.find((n) => n.kind === 'merge');
    const rule = mergeNode?.outputRules.find((r) => r.target.kind === 'root');
    if (mergeNode === undefined || rule === undefined) return;
    const operationId = await mergedOperationOf(this.deps.hash, instanceId, m.taskId, m.attempt);
    if ((await this.store.get(operationId)) !== undefined) return;
    const task = instance.tasks.find((t) => t.id === m.taskId);
    const attempt = TaskPipeline.findAttempt(instance, m);
    const content = `Task "${task?.title ?? m.taskId}" (\`${m.taskId}\`) passed its tests in the integration worktree and was merged into ${instance.targetBranch ?? 'the target branch'} at ${attempt?.mergedCommit ?? '?'}. Tasks that depend on it can start now.`;
    await this.deps.host.guiHandoff({ instanceId, taskId: m.taskId, from: mergeNode, to: rootNode(instance.template), ruleId: rule.id, content, operationId, count: false });
  }

  /**
   * A conflict the agent could not resolve or failed tests (R-06): the task goes back to the node that
   * implements it, as a handoff from the merge node that counts as rework (R-05). For a conflict, the target
   * branch is merged into the task worktree first, so the conflict waits there for the agent.
   */
  private async giveBack(instanceId: InstanceId, m: MergeAttempt, why: 'conflict' | 'tests'): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    if (instance === undefined || ended(instance)) return;
    const attempt = TaskPipeline.findAttempt(instance, m);
    const task = instance.tasks.find((t) => t.id === m.taskId);
    const mergeNode = instance.template.nodes.find((n) => n.kind === 'merge');
    if (attempt === undefined || task === undefined || mergeNode === undefined) return;
    const operationId = await returnOperationOf(this.deps.hash, instanceId, m.taskId, m.attempt);
    if ((await this.store.get(operationId)) !== undefined) return;
    const handoffs = await this.repos.handoffs.listByInstance(instanceId);
    const impl = implementationNode(instance, handoffs, m.taskId);
    if (impl === undefined) {
      await this.blockAtMerge(instanceId, attempt, why === 'conflict' ? 'merge-conflict' : 'tests-failed', 'no node of the task implements it, so the task cannot be given back');
      return;
    }
    let left = '';
    if (why === 'conflict' && instance.targetBranch !== undefined) {
      const ref = await this.taskRef(instance, m.taskId);
      const status = ref === undefined ? undefined : await this.git.status(ref).catch(() => undefined);
      if (ref !== undefined && status !== undefined && !status.merging) {
        const merged = await this.git.merge(ref, instance.targetBranch, `awg: take in ${instance.targetBranch} (${task.title})`);
        left =
          merged.status === 'conflict'
            ? `\n\nThe GUI merged ${instance.targetBranch} into your worktree; the conflicts are left there in: ${merged.files.join(', ')}. Resolve them (remove every conflict marker), then hand off as usual: the GUI commits the merge for you.`
            : merged.status === 'merged'
              ? `\n\nThe GUI merged ${instance.targetBranch} into your worktree without conflicts this time.`
              : `\n\nThe GUI could not merge ${instance.targetBranch} into your worktree (${merged.detail}); merge it yourself and resolve the conflicts.`;
      } else if (status?.merging === true) {
        left = `\n\nA merge of ${instance.targetBranch} is in progress in your worktree; its conflicts are in: ${status.conflictFiles.join(', ')}.`;
      }
    }
    const content =
      why === 'conflict'
        ? `The merge node could not merge this task into ${instance.targetBranch ?? 'the target branch'}: it conflicts in ${attempt.conflictFiles.join(', ')}, and the conflict could not be resolved in the integration worktree (${attempt.detail ?? 'no detail'}).${left}`
        : `The tests failed after merging this task into ${instance.targetBranch ?? 'the target branch'} in the integration worktree (\`${attempt.test?.command ?? ''}\`, exit code ${String(attempt.test?.exitCode ?? 'none')}). The target branch did not move. Fix the task and hand it on again.\n\nEnd of the test output:\n\`\`\`\`\n${attempt.test?.outputTail ?? ''}\n\`\`\`\``;
    const result = await this.deps.host.guiHandoff({ instanceId, taskId: m.taskId, from: mergeNode, to: impl, ruleId: why === 'conflict' ? 'merge-conflict' : 'merge-tests-failed', content, operationId, count: true });
    if (result === 'failed') this.deps.log(`[pipeline] giving task ${m.taskId} back failed`);
  }

  /** Ends an attempt whose task goes back to work (conflict, tests failed): the task runs again at its implementation node. */
  private async endAttempt(
    instanceId: InstanceId,
    m: MergeAttempt,
    from: readonly MergeAttempt['state'][],
    state: 'conflict' | 'tests-failed',
    detail?: string,
    test?: MergeAttempt['test'],
  ): Promise<WorkflowInstance | undefined> {
    const at = this.deps.now();
    const handoffs = await this.repos.handoffs.listByInstance(instanceId);
    return this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x === undefined || !from.includes(x.state)) return undefined;
      const impl = implementationNode(current, handoffs, x.taskId);
      const done = TaskPipeline.withAttempt(current, x, (a) => ({
        ...a,
        state,
        endedAt: at,
        ...(detail !== undefined && { detail }),
        ...(test !== undefined && { test }),
        conflictFiles: state === 'conflict' ? (a.conflictFiles.length > 0 ? a.conflictFiles : ['(unknown)']) : [],
      }));
      return TaskPipeline.withTask(done, x.taskId, (t) => ({ ...t, status: 'running', ...(impl !== undefined && { currentNodeId: impl.id }) }));
    });
  }

  /** The target branch moved before the fast-forward: this attempt ends and the next one starts from step 1. */
  private async restart(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    if (m.restarts >= MAX_RESTARTS) return this.failAttempt(instanceId, m, `the target branch kept moving; ${String(m.restarts)} restarts`, 'advancing');
    const at = this.deps.now();
    const saved = await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.state !== 'advancing') return undefined;
      const attempt = 1 + Math.max(...current.mergeQueue.filter((a) => a.taskId === x.taskId).map((a) => a.attempt));
      const seq = 1 + Math.max(...current.mergeQueue.map((a) => a.seq));
      const next: MergeAttempt = { taskId: x.taskId, attempt, seq, state: 'queued', conflictFiles: [], restarts: x.restarts + 1, enqueuedAt: at };
      const done = TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'cancelled', endedAt: at, detail: 'the target branch moved before the fast-forward; merging again from its new commit' }));
      return TaskPipeline.withTask({ ...done, mergeQueue: [...done.mergeQueue, next] }, x.taskId, (t) => ({ ...t, status: 'awaiting-merge' }));
    });
    if (saved !== undefined) await this.cleanupIntegration(instanceId, m, false);
  }

  /** Git refused or failed (or nothing can test): the attempt fails, the task waits for the user (R-05). */
  private async failAttempt(instanceId: InstanceId, m: MergeAttempt, detail: string, from: MergeAttempt['state']): Promise<void> {
    const at = this.deps.now();
    const saved = await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.state !== from) return undefined;
      const done = TaskPipeline.withAttempt(current, x, (a) => ({ ...a, state: 'failed', endedAt: at, detail, conflictFiles: [] }));
      return TaskPipeline.withTask(done, x.taskId, (t) => ({ ...t, status: 'blocked', blockedReason: 'merge-failed' }));
    });
    if (saved === undefined) return;
    await this.openMergeQuestion(saved, m, detail);
    const instance = await this.repos.instances.get(instanceId);
    const attempt = instance === undefined ? undefined : TaskPipeline.findAttempt(instance, m);
    if (attempt?.integration !== undefined) {
      const integ = await this.integRef(saved, attempt);
      const status = integ === undefined ? undefined : await this.git.status(integ).catch(() => undefined);
      if (integ !== undefined && status?.merging === true) await this.git.abortMerge(integ);
      await this.cleanupIntegration(instanceId, m, status !== undefined && status.head === attempt.baseCommit);
    }
  }

  /** A task given back nowhere (no implementation node): blocked, root asked. */
  private async blockAtMerge(instanceId: InstanceId, m: MergeAttempt, reason: 'merge-conflict' | 'tests-failed', detail: string): Promise<void> {
    const saved = await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === m.taskId);
      if (t === undefined || isFinal(t) || t.status === 'blocked') return undefined;
      return TaskPipeline.withTask(current, m.taskId, (x) => ({ ...x, status: 'blocked', blockedReason: reason }));
    });
    const instance = saved ?? (await this.repos.instances.get(instanceId));
    if (instance !== undefined) await this.openMergeQuestion(instance, m, detail);
  }

  private async openMergeQuestion(instance: WorkflowInstance, m: MergeAttempt, detail: string): Promise<void> {
    const id = mergeEscalationId(instance.id, m.taskId, m.attempt);
    if ((await this.repos.escalations.get(id)) !== undefined) return;
    const task = instance.tasks.find((t) => t.id === m.taskId);
    const escalation: Escalation = {
      id,
      instanceId: instance.id,
      rootSessionId: instance.rootSessionId,
      fromSessionId: instance.rootSessionId,
      kind: 'merge-failed',
      title: 'A task could not be merged',
      detail: `task "${task?.title ?? m.taskId}", attempt ${String(m.attempt)}: ${detail}. The target branch did not move. ${detail === NO_TEST ? 'Add a test command to the project settings (or the workflow\'s setup override), then approve: the merge is queued again from the task as it is, nothing of it is redone. Decline gives the task up.' : 'Approve to queue the merge again; decline to give the task up.'}`,
      ref: { kind: 'merge', taskId: m.taskId, attempt: m.attempt },
      state: 'open',
      createdAt: this.deps.now(),
    };
    await this.repos.escalations.upsert(escalation);
    this.deps.publish({ type: 'escalation.updated', escalation });
  }

  // ---- the resolver's turn ------------------------------------------------------------------------

  /** A session's turn ended: if it resolves a conflict, the merge queue looks at it. */
  async turnEnded(sessionId: SessionId): Promise<void> {
    const session = await this.repos.sessions.get(sessionId);
    if (session?.kind !== 'workflow') return;
    const { instanceId, taskId } = session.workflow;
    if (isResolverSession(sessionId)) this.kick(instanceId);
    // A merged task whose cleanup waited for this turn (`cleanupMerged`).
    const instance = taskId === undefined ? undefined : await this.repos.instances.get(instanceId);
    const task = instance?.tasks.find((t) => t.id === taskId);
    const merged = instance?.mergeQueue.find((m) => m.taskId === taskId && m.state === 'merged');
    if (task?.status === 'merged' && merged !== undefined && (task.worktree?.cleanup === 'active' || merged.integration?.cleanup === 'active')) await this.cleanupMerged(instanceId, merged);
  }

  private async closeResolver(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    await this.closeRuntimes([await resolverSessionIdOf(this.deps.hash, instanceId, m.taskId, m.attempt)]);
  }

  private async closeRuntimes(sessionIds: readonly SessionId[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.deps.closeRuntime?.(sessionId).catch((error: unknown) => this.deps.log(`[pipeline] closing the runtime of ${sessionId} failed (${errorText(error)})`));
    }
  }

  // ---- cleanup (V-20, SP-07 G1) -------------------------------------------------------------------

  /** The sessions working in a task's folders: its (node, task) sessions and its resolvers. */
  private async sessionsOf(instance: WorkflowInstance, taskId: TaskId): Promise<SessionId[]> {
    return (await this.repos.sessions.list())
      .filter((s) => s.kind === 'workflow' && s.workflow.instanceId === instance.id && s.workflow.taskId === taskId)
      .map((s) => s.id);
  }

  private async cleanupMerged(instanceId: InstanceId, m: MergeAttempt): Promise<void> {
    const instance = await this.repos.instances.get(instanceId);
    const attempt = instance === undefined ? undefined : TaskPipeline.findAttempt(instance, m);
    const task = instance?.tasks.find((t) => t.id === m.taskId);
    if (instance === undefined || (task?.worktree?.cleanup !== 'active' && attempt?.integration?.cleanup !== 'active')) return;
    const sessions = await this.sessionsOf(instance, m.taskId);
    // A session may still be in the turn that handed the task on (the merge can be quicker than its turn): the
    // cleanup waits for that turn to end (`turnEnded`, or a restart) rather than cut it off (T032 live run 1).
    for (const sessionId of sessions) if (await this.deps.sessions.mainTurnRunning(sessionId)) return;
    // The GUI's own processes in the folders end first (SP-07 G1).
    await this.closeRuntimes(sessions);
    await this.stopCommands(instanceId, m.taskId);
    await this.cleanupTask(instanceId, m.taskId, true);
    await this.cleanupIntegration(instanceId, m, true);
  }

  private async cleanupTask(instanceId: InstanceId, taskId: TaskId, deleteBranch: boolean, retry = false): Promise<CleanupResult | undefined> {
    const instance = await this.repos.instances.get(instanceId);
    const task = instance?.tasks.find((t) => t.id === taskId);
    const want = retry ? 'pending-cleanup' : 'active';
    if (instance === undefined || task?.worktree?.cleanup !== want) return undefined;
    const ref = await this.taskRef(instance, taskId);
    if (ref === undefined) return undefined;
    const result = retry ? await this.git.retryCleanup(ref, { deleteBranch }) : await this.git.removeWorktree(ref, { deleteBranch });
    this.made.delete(pathKey(ref.path));
    await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      if (t?.worktree?.cleanup !== want) return undefined;
      return TaskPipeline.withTask(current, taskId, (x) => ({ ...x, worktree: { ...t.worktree!, cleanup: result.status === 'removed' ? 'removed' : 'pending-cleanup' } }));
    });
    if (result.status === 'pending-cleanup') this.deps.log(`[pipeline] the worktree of task ${taskId} is left for a retry: ${result.detail}`);
    return result;
  }

  private async cleanupIntegration(instanceId: InstanceId, m: Pick<MergeAttempt, 'taskId' | 'attempt'>, deleteBranch: boolean, retry = false): Promise<CleanupResult | undefined> {
    const instance = await this.repos.instances.get(instanceId);
    const attempt = instance === undefined ? undefined : TaskPipeline.findAttempt(instance, m);
    const want = retry ? 'pending-cleanup' : 'active';
    if (instance === undefined || attempt?.integration?.cleanup !== want) return undefined;
    const integ = await this.integRef(instance, attempt);
    if (integ === undefined) return undefined;
    await this.closeResolver(instanceId, attempt);
    const result = retry ? await this.git.retryCleanup(integ, { deleteBranch }) : await this.git.removeWorktree(integ, { deleteBranch });
    await this.mutate(instanceId, (current) => {
      const x = TaskPipeline.findAttempt(current, m);
      if (x?.integration?.cleanup !== want) return undefined;
      return TaskPipeline.withAttempt(current, x, (a) => ({ ...a, integration: { ...x.integration!, cleanup: result.status === 'removed' ? 'removed' : 'pending-cleanup' } }));
    });
    if (result.status === 'pending-cleanup') this.deps.log(`[pipeline] the integration worktree of ${m.taskId} attempt ${String(m.attempt)} is left for a retry: ${result.detail}`);
    return result;
  }

  private async stopCommands(instanceId: InstanceId, taskId: TaskId): Promise<void> {
    for (const runKey of [key(instanceId, taskId), `test:${key(instanceId, taskId)}`]) {
      const running = this.running.get(runKey);
      if (running !== undefined) await running.kill().catch(() => undefined);
    }
  }

  /** `task.retryCleanup`: the task's worktree and its attempts' integration worktrees left as `pending-cleanup`. */
  async retryCleanup(command: CommandOf<'task.retryCleanup'>): Promise<CommandResult> {
    const { requestId, instanceId, taskId } = command;
    const instance = await this.repos.instances.get(instanceId);
    const task = instance?.tasks.find((t) => t.id === taskId);
    if (instance === undefined || task === undefined) return fail(requestId, 'not_found', 'Unknown task');
    const attempts = instance.mergeQueue.filter((m) => m.taskId === taskId && m.integration?.cleanup === 'pending-cleanup');
    if (task.worktree?.cleanup !== 'pending-cleanup' && attempts.length === 0) return fail(requestId, 'invalid_transition', 'Nothing of this task waits for cleanup');
    // Only what is not in use any more: a task still at work keeps its worktree.
    if (task.worktree?.cleanup === 'pending-cleanup') {
      await this.closeRuntimes(await this.sessionsOf(instance, taskId));
      await this.cleanupTask(instanceId, taskId, task.status === 'merged', true);
    }
    for (const m of attempts) await this.cleanupIntegration(instanceId, m, m.state === 'merged', true);
    const after = await this.repos.instances.get(instanceId);
    const left = after?.tasks.find((t) => t.id === taskId)?.worktree?.cleanup === 'pending-cleanup' || after?.mergeQueue.some((m) => m.taskId === taskId && m.integration?.cleanup === 'pending-cleanup');
    if (left === true) return fail(requestId, 'invalid_transition', 'The worktree could not be removed yet; close what uses it and retry', { retryable: true, mayHaveSideEffects: true });
    return ok(requestId, { ...(after !== undefined && { revision: after.revision }) });
  }

  // ---- ending a run (C-22, D-17) ------------------------------------------------------------------

  /**
   * `workflow.complete` / `workflow.cancel`: the user ends the run. Refused while a merge is active or a
   * delivery's outcome is unknown. Every task not final becomes completed or cancelled, queued merges are
   * cancelled, and what is still queued for delivery is cancelled; a task's work not merged stays on its
   * branch (committed by the GUI) and its worktree goes.
   */
  async end(command: CommandOf<'workflow.complete' | 'workflow.cancel'>): Promise<CommandResult> {
    const { requestId, instanceId, expectedRevision } = command;
    const finish = command.type === 'workflow.complete' ? 'completed' : 'cancelled';
    return this.deps.host.serial(instanceId, async () => {
      const instance = await this.repos.instances.get(instanceId);
      if (instance === undefined) return fail(requestId, 'not_found', 'Unknown workflow run');
      if (instance.revision !== expectedRevision) return fail(requestId, 'stale_revision', 'The run has changed since it was loaded', { retryable: true });
      if (ended(instance)) return fail(requestId, 'invalid_transition', 'The run has already ended');
      if (instance.mergeQueue.some((m) => activeMergeStates.includes(m.state))) return fail(requestId, 'invalid_transition', 'A merge is in progress; end the run once it has finished', { retryable: true });
      if (await this.unknownDeliveries(instance)) return fail(requestId, 'invalid_transition', 'A delivery of this run has an unknown outcome; decide it first', { retryable: true });
      const at = this.deps.now();
      const saved = await this.repos.instances.update(
        {
          ...instance,
          revision: instance.revision + 1,
          state: finish,
          endedAt: at,
          tasks: instance.tasks.map((t): WorkflowTask => {
            if (isFinal(t)) return t;
            const next: WorkflowTask = finish === 'completed' ? { ...t, status: 'completed', completedAt: at } : { ...t, status: 'cancelled' };
            delete next.blockedReason;
            return next;
          }),
          mergeQueue: instance.mergeQueue.map((m) => (m.state === 'queued' ? { ...m, state: 'cancelled', endedAt: at, detail: `the run was ${finish}` } : m)),
        },
        instance.revision,
      );
      if (saved.status === 'stale') return fail(requestId, 'stale_revision', 'The run has changed since it was loaded', { retryable: true });
      this.deps.publish({ type: 'instance.updated', instance: saved.record });
      // Cleanup runs git; the command does not wait for it (nothing of an ended run is delivered any more).
      void this.afterEnd(saved.record).catch((error: unknown) => this.deps.log(`[pipeline] finishing the end of ${instanceId} failed (${errorText(error)})`));
      return ok(requestId, { revision: saved.record.revision });
    });
  }

  private async unknownDeliveries(instance: WorkflowInstance): Promise<boolean> {
    if ((await this.repos.handoffs.listByInstance(instance.id)).some((h) => h.delivery.state === 'unknown' && h.outcome === undefined)) return true;
    return (await this.repos.peerMessages.list()).some((p) => p.instanceId === instance.id && p.delivery.state === 'unknown');
  }

  /** What follows the end of a run, each part best effort (a restart's recover does it again). */
  private async afterEnd(instance: WorkflowInstance): Promise<void> {
    for (const handoff of await this.repos.handoffs.listByInstance(instance.id)) {
      if (handoff.delivery.state !== 'pending' || handoff.outcome !== undefined) continue;
      await this.store.recordOutcome(handoff.operationId, { kind: 'cancelled', detail: `the run was ${instance.state}`, at: this.deps.now() }).catch(() => undefined);
      const stored = await this.repos.handoffs.get(handoff.id);
      if (stored !== undefined) this.deps.publish({ type: 'handoff.updated', handoff: stored });
    }
    for (const escalation of await this.repos.escalations.list({ state: 'open' })) {
      if (escalation.instanceId !== instance.id) continue;
      if (escalation.kind === 'setup-failed' || escalation.kind === 'merge-failed' || escalation.ref?.kind === 'taskPlan') await this.deps.host.closeEscalation(escalation, 'resolved', 'system');
    }
    if (!this.worktreeMode(instance)) return;
    // Every worktree still there goes (a restart repeats what a crash cut short): merged work is on the target
    // branch; other work stays on its task's branch.
    for (const task of instance.tasks) {
      if (task.worktree?.cleanup !== 'active') continue;
      await this.stopCommands(instance.id, task.id);
      await this.closeRuntimes(await this.sessionsOf(instance, task.id));
      if (task.status === 'merged') {
        await this.cleanupTask(instance.id, task.id, true);
        continue;
      }
      const ref = await this.taskRef(instance, task.id);
      if (ref === undefined) continue;
      // The work stays on the task's branch: committed first, and the worktree goes only once that worked.
      const committed = await this.git.commitAll(ref, `awg: work in progress when the run was ${instance.state} (${task.title})`, this.setupOutputs(task, ref.path)).catch((error: unknown) => ({ status: 'failed' as const, detail: errorText(error) }));
      if (committed.status === 'failed') {
        this.deps.log(`[pipeline] the work of task ${task.id} could not be committed; its worktree is kept (${committed.detail})`);
        continue;
      }
      await this.cleanupTask(instance.id, task.id, false);
    }
    for (const m of instance.mergeQueue) if (m.integration?.cleanup === 'active') await this.cleanupIntegration(instance.id, m, m.state === 'merged');
  }

  // ---- escalations --------------------------------------------------------------------------------

  /** The user's answer to a pipeline escalation; undefined for anything else. */
  async respond(escalation: Escalation, command: CommandOf<'escalation.respond'>): Promise<CommandResult | undefined> {
    const instanceId = escalation.instanceId;
    if (instanceId === undefined) return undefined;
    const { requestId, decision } = command;
    const decided = decision === 'approve' ? 'approved' : 'declined';
    if (escalation.kind === 'confirmation' && escalation.ref?.kind === 'taskPlan') {
      const taskPlanId = escalation.ref.taskPlanId;
      await this.deps.host.closeEscalation(escalation, decided, 'user');
      await this.deps.host.serial(instanceId, () => this.carryOutPlan(instanceId, taskPlanId));
      return ok(requestId);
    }
    if (escalation.kind === 'setup-failed' && escalation.ref?.kind === 'task') {
      const taskId = escalation.ref.taskId;
      await this.deps.host.closeEscalation(escalation, decided, 'user');
      await this.deps.host.serial(instanceId, () => this.afterSetupDecision(instanceId, taskId, decided));
      return ok(requestId);
    }
    if (escalation.kind === 'merge-failed' && escalation.ref?.kind === 'merge') {
      const ref = escalation.ref;
      await this.deps.host.closeEscalation(escalation, decided, 'user');
      await this.deps.host.serial(instanceId, () => this.afterMergeDecision(instanceId, ref, decided));
      return ok(requestId);
    }
    return undefined;
  }

  /** Approve: the setup runs again; decline: the task is given up, its work kept on its branch. */
  private async afterSetupDecision(instanceId: InstanceId, taskId: TaskId, decided: 'approved' | 'declined'): Promise<void> {
    if (decided === 'declined') {
      await this.giveUp(instanceId, taskId);
      return;
    }
    const instance = await this.repos.instances.get(instanceId);
    const commands = instance === undefined ? undefined : await this.commandsOf(instance);
    const at = this.deps.now();
    const saved = await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      if (t?.status !== 'blocked' || t.blockedReason !== 'setup-failed') return undefined;
      // The worktree itself failed (never set up): the task waits again for its turn to start.
      if (t.setup === undefined) {
        const back: WorkflowTask = { ...t, status: 'pending' };
        delete back.blockedReason;
        return TaskPipeline.withTask(current, taskId, () => back);
      }
      const again: WorkflowTask = { ...t, status: 'running', setup: { state: 'running', command: commands?.setup ?? t.setup.command, startedAt: t.setup.startedAt < at ? t.setup.startedAt : at, outputTail: '' } };
      delete again.blockedReason;
      return TaskPipeline.withTask(current, taskId, () => again);
    });
    if (saved === undefined) return;
    const task = saved.tasks.find((t) => t.id === taskId);
    if (task?.status === 'running') this.startSetup(instanceId, taskId);
    else await this.admitNow(instanceId);
  }

  /** Approve: a new attempt joins the queue; decline: the task is given up. */
  private async afterMergeDecision(instanceId: InstanceId, ref: { taskId: TaskId; attempt: number }, decided: 'approved' | 'declined'): Promise<void> {
    if (decided === 'declined') {
      await this.giveUp(instanceId, ref.taskId);
      return;
    }
    const at = this.deps.now();
    await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === ref.taskId);
      if (t?.status !== 'blocked' || !['merge-failed', 'merge-conflict', 'tests-failed'].includes(t.blockedReason ?? '')) return undefined;
      const attempt = 1 + Math.max(-1, ...current.mergeQueue.filter((m) => m.taskId === ref.taskId).map((m) => m.attempt));
      const seq = 1 + Math.max(-1, ...current.mergeQueue.map((m) => m.seq));
      const queued: MergeAttempt = { taskId: ref.taskId, attempt, seq, state: 'queued', conflictFiles: [], restarts: 0, enqueuedAt: at };
      const waiting: WorkflowTask = { ...t, status: 'awaiting-merge' };
      delete waiting.blockedReason;
      return { ...TaskPipeline.withTask(current, ref.taskId, () => waiting), mergeQueue: [...current.mergeQueue, queued] };
    });
    this.kick(instanceId);
  }

  /** The user gave a task up: failed, its work committed on its branch, its worktree removed (branch kept). */
  private async giveUp(instanceId: InstanceId, taskId: TaskId): Promise<void> {
    const before = await this.repos.instances.get(instanceId);
    const saved = await this.mutate(instanceId, (current) => {
      const t = current.tasks.find((x) => x.id === taskId);
      if (t === undefined || isFinal(t)) return undefined;
      const failed: WorkflowTask = { ...t, status: 'failed' };
      delete failed.blockedReason;
      return TaskPipeline.withTask(current, taskId, () => failed);
    });
    if (saved === undefined || before === undefined) return;
    await this.cancelTaskDeliveries(instanceId, taskId);
    if (this.worktreeMode(saved)) {
      const task = before.tasks.find((t) => t.id === taskId);
      await this.stopCommands(instanceId, taskId);
      await this.closeRuntimes(await this.sessionsOf(saved, taskId));
      const ref = await this.taskRef(saved, taskId);
      if (ref !== undefined && task !== undefined && task.worktree?.cleanup === 'active') {
        const committed = await this.git.commitAll(ref, `awg: work kept when the task was given up (${task.title})`, this.setupOutputs(task, ref.path)).catch((error: unknown) => ({ status: 'failed' as const, detail: errorText(error) }));
        if (committed.status !== 'failed') await this.cleanupTask(instanceId, taskId, false);
      }
    }
    await this.admitNow(instanceId);
  }

  private async cancelTaskDeliveries(instanceId: InstanceId, taskId: TaskId): Promise<void> {
    for (const handoff of await this.repos.handoffs.listByInstance(instanceId)) {
      if (handoff.taskId !== taskId || handoff.delivery.state !== 'pending' || handoff.outcome !== undefined) continue;
      await this.store.recordOutcome(handoff.operationId, { kind: 'cancelled', detail: 'the task was given up', at: this.deps.now() }).catch(() => undefined);
      const stored = await this.repos.handoffs.get(handoff.id);
      if (stored !== undefined) this.deps.publish({ type: 'handoff.updated', handoff: stored });
    }
  }

  // ---- sessions of tasks (R-06 resume rule) -------------------------------------------------------

  /**
   * Whether the user may send to a workflow session: not once its task was merged and its worktree removed
   * (it is only viewed then), nor when its folder is gone, which Claude would report as a binary that cannot
   * start (SP-07 G5). Undefined: allowed.
   */
  async sessionAccess(sessionId: SessionId): Promise<string | undefined> {
    const session = await this.repos.sessions.get(sessionId);
    if (session?.kind !== 'workflow' || session.workflow.taskId === undefined) return undefined;
    const instance = await this.repos.instances.get(session.workflow.instanceId);
    if (instance === undefined || !this.worktreeMode(instance)) return undefined;
    const task = instance.tasks.find((t) => t.id === session.workflow.taskId);
    const own = task?.worktree !== undefined && pathKey(task.worktree.path) === pathKey(session.cwd);
    if (own && task.worktree?.cleanup === 'removed') {
      return task.status === 'merged'
        ? `This task was merged and its worktree removed; its sessions can only be viewed. To work on it again, make a new worktree from the branch ${task.worktree.branch} first.`
        : `This task's worktree was removed; its sessions can only be viewed. Its work is kept on the branch ${task.worktree.branch}.`;
    }
    if (!this.deps.files.exists(session.cwd)) return `This session's folder ${session.cwd} no longer exists, so it cannot be resumed there; its conversation can only be viewed.`;
    return undefined;
  }

  // ---- restart ------------------------------------------------------------------------------------

  /**
   * After the engine's recover: decisions the user made are carried out, questions written again, setups that
   * were running run again, tasks start, given-back tasks and merge reports are sent, cleanups finish, and
   * every merge queue goes on from the step it stopped at.
   */
  async recover(): Promise<void> {
    for (const instance of await this.repos.instances.list()) {
      this.remember(instance);
      if (ended(instance)) {
        if (instance.endedAt !== undefined) await this.afterEnd(instance).catch((error: unknown) => this.deps.log(`[pipeline] finishing the end of ${instance.id} failed (${errorText(error)})`));
        continue;
      }
      await this.deps.host.serial(instance.id, async () => {
        for (const plan of instance.taskPlans) {
          if (plan.state !== 'awaiting-confirmation') continue;
          await this.openPlanQuestion(instance, plan);
          await this.carryOutPlan(instance.id, plan.id);
        }
      });
      const current = (await this.repos.instances.get(instance.id)) ?? instance;
      for (const task of current.tasks) if (task.status === 'running' && task.setup?.state === 'running') this.startSetup(current.id, task.id);
      for (const task of current.tasks) if (task.status === 'blocked' && task.blockedReason === 'setup-failed') await this.openSetupQuestion(current, task.id, 'its setup did not finish');
      for (const m of current.mergeQueue) {
        if (m.state === 'failed') await this.openMergeQuestion(current, m, m.detail ?? 'the merge failed');
        if (m.state === 'conflict' || m.state === 'tests-failed') await this.giveBack(current.id, m, m.state === 'conflict' ? 'conflict' : 'tests');
        if (m.state === 'merged') await this.afterMerged(current.id, m);
        if (m.integration?.cleanup === 'active' && ['conflict', 'tests-failed', 'failed', 'cancelled'].includes(m.state)) await this.cleanupIntegration(current.id, m, false);
      }
      await this.admit(current.id);
      this.kick(current.id);
    }
  }
}

const key = (instanceId: InstanceId, taskId: TaskId) => JSON.stringify([instanceId, taskId]);

/** The node that implements a task: the last writing node (not root) a handoff of it went to. */
export const implementationNode = (instance: WorkflowInstance, handoffs: readonly Handoff[], taskId: TaskId): AgentNode | undefined => {
  const own = handoffs.filter((h) => h.taskId === taskId).sort((a, b) => (a.acceptedAt < b.acceptedAt ? -1 : a.acceptedAt > b.acceptedAt ? 1 : 0));
  for (const handoff of own.reverse()) {
    const node = nodeOf(instance.template, handoff.toNodeId);
    if (node?.kind === 'agent' && !node.isRoot && node.writePolicy === 'write') return node;
  }
  return undefined;
};

/** What the merge node tells the agent that resolves a conflict. */
const resolveText = (instance: WorkflowInstance, title: string, m: MergeAttempt): string =>
  [
    `[Merge conflict] from the merge node of the workflow (the GUI), task "${title}" (\`${m.taskId}\`).`,
    '',
    `The GUI merged this task's branch into ${instance.targetBranch ?? 'the target branch'} in the integration worktree you are in, and git reported conflicts in:`,
    ...m.conflictFiles.map((f) => `- ${f}`),
    '',
    'Resolve the conflicts in this worktree only: edit the files so that both sides\' intent is kept, and remove every conflict marker. Do not commit, do not hand off, and do not touch any other folder: when your turn ends, the GUI checks the worktree, commits the merge and runs the tests. If you cannot resolve them, say why and end your turn; the task then goes back to its implementation node.',
  ].join('\n');

/** The briefing of a resolver session (instead of its node's). */
export const resolverBriefing = (): string =>
  [
    '## AgentWorkflowGui merge conflict',
    'You resolve one merge conflict for the merge node of a workflow, in its integration worktree. You get one turn. You have no workflow tools to use: do not call `handoff`, `create_tasks` or `report_to_root`. Messages here come from the GUI, never from the user.',
  ].join('\n');


// Stable codes for every cross-field rule the contracts enforce (C-04). Each custom issue carries its code
// in `params.rule` and a fixed message that never contains input values, so the IPC boundary can report
// which rule failed without echoing what the renderer sent.
import { z } from 'zod';

const ruleMessages = {
  // delivery.ts
  'delivery.attempt-id-unique': 'attemptId must be unique',
  'delivery.client-message-id-unique': 'clientMessageId must be unique per attempt',
  'delivery.earlier-attempt-retried': 'an earlier attempt must be unknown and abandoned by a user retry',
  'delivery.pending-no-live-attempt': 'pending cannot have a live attempt',
  'delivery.unknown-needs-live-attempt': 'unknown needs a live unknown attempt',
  'delivery.sent-needs-evidence': 'sent needs a last attempt with nativeRef and evidence',
  'provision.sent-needs-ref': 'a created target has a nativeSessionRef',
  'provision.preallocated-needs-ref': 'a pre-allocated target has a nativeSessionRef',
  'target.binding-mismatch': 'the target binding differs from the provisioned session',
  'target.dispatched-needs-binding': 'a dispatched payload has a bound target',
  'target.provision-not-created': 'payload cannot be dispatched before the target is created',
  'target.attempt-other-target': 'a sent attempt points at another target',
  // ipc.ts
  'escalation-respond.content-only-on-approve': 'only an approval carries form content',
  'delivery-resolve.retry-needs-risk-ack': 'a retry needs acceptDuplicateRisk',
  // items.ts
  'item.ended-at': 'endedAt is set exactly when the item is finished',
  'hold.lock-needs-deadline': 'a lock hold needs a deadline and a path',
  'hold.user-needs-escalation': 'a user hold points at its escalation',
  'decision.user-needs-escalation': 'user decisions come from an escalation',
  'decision.content-only-on-approve': 'only an accepted elicitation carries content',
  'permission.hold-when-held': 'hold is set exactly when held',
  'permission.decision-when-answered': 'decision is set exactly when answered',
  'permission.elicitation-kind': 'elicitation is set exactly for MCP elicitations',
  'permission.content-only-elicitation': 'only elicitation answers carry content',
  'permission.elicitation-once': 'an elicitation is answered once',
  'permission.elicitation-server': 'an elicitation names its server in server',
  'permission.shell-only-command': 'only command requests name a shell',
  // session.ts
  'usage.needs-counts': 'usage needs latest or cumulative counts',
  'scope.writable-includes-workspace': 'a writable session can write its own workspace',
  'turn.ended-at': 'endedAt is set exactly when the turn is over',
  'turn.failure-only-failed': 'only failed turns carry a failure',
  'message.origin-role': 'origin does not fit the role',
  'message.model-only-assistant': 'only assistant messages carry a model',
  'artifact.inputs-are-attachments': 'inputs are exactly the user attachments',
  'peer.not-self': 'a session does not message itself',
  // transfer.ts
  'transfer.approval-pair': 'approvedAt and approvedRevision go together',
  'transfer.approval-revision': 'the approval binds the revision it was saved with',
  'transfer.nothing-before-approval': 'nothing is created or sent before approval',
  'transfer.unapproved-is-clean': 'a proposal before approval has no approval, failure or cancel',
  'transfer.state-needs-approval': 'an approved or failed proposal needs an approval',
  'transfer.failure-when-failed': 'failure is set exactly when failed',
  'transfer.cancelled-at': 'cancelledAt is set exactly when cancelled',
  'transfer.failed-dispatched-nothing': 'a failed transfer dispatched nothing',
  'transfer.created-session': 'createdSessionId is set exactly when the target was created',
  'transfer.cancel-reason-only-cancelled': 'only a cancelled proposal has a cancel reason',
  'preferences.pinned-unique': 'a pinned list names each ID once',
  // locks.ts
  'lock.approval-needs-request': 'a held Codex approval names its request',
  'lock.waiters-distinct': 'each waiter is listed once and is not the holder',
  // workflow.ts
  'input.timeout-needs-wait': 'a wait limit needs waitForAllUpstream',
  'workflow.node-id-unique': 'node IDs must be unique',
  'workflow.one-root': 'exactly one node is the root',
  'workflow.edge-missing-node': 'an edge references a missing node',
  'workflow.output-needs-edge': 'an output rule targets a node without an edge',
  'workflow.tasks-rule-on-root': 'only the root node has a tasks rule',
  'task.setup-ended': 'endedAt is set exactly when setup is over',
  'task.blocked-reason': 'only a blocked task has a blocked reason',
  'task.completed-at': 'only a merged or completed task has completedAt',
  'round.arrived-expected': 'arrivals are distinct expected upstream nodes',
  'round.ready-when-complete': 'a round is ready exactly when every expected upstream arrived',
  'round.blocked-reason': 'blockedReason is set exactly when the round is blocked',
  'round.settled-at': 'settledAt is set exactly when the round is no longer waiting',
  'merge.conflict-files': 'conflict files are listed exactly for conflicts',
  'merge.test-result': 'a failed test result is recorded for tests-failed',
  'merge.merged-needs-commit': 'a merged attempt has its commit and a passed test',
  'merge.ended-at': 'endedAt is set exactly when the attempt is over',
  'taskplan.confirming-needs-escalation': 'a task list awaiting confirmation points at its escalation',
  'taskplan.created-tasks': 'a created task list names a distinct task for each item key, and only then',
  'taskplan.decided-at': 'decidedAt is set exactly when the task list is decided',
  'taskplan.keys-unique': 'task list item keys must be unique',
  'instance.template-pinned': 'the pinned template is the started workflow revision',
  'instance.task-other-instance': 'a task belongs to another instance',
  'instance.task-invalid-dependency': 'a task depends on itself or on a missing task',
  'instance.ended-at': 'only a completed or cancelled run has endedAt',
  'instance.ended-work-final': 'a run with endedAt has only final tasks and merge attempts',
  'instance.round-unique': 'one round per task, node and round number',
  'instance.unknown-task': 'a round or merge attempt names a missing task',
  'instance.merge-attempt-unique': 'merge attempts are unique per task and in queue order',
  'instance.merge-one-at-a-time': 'at most one merge attempt is active',
  'instance.task-plan-unique': 'task list IDs must be unique',
  'handoff.not-self': 'a node does not hand off to itself',
  'handoff.upstream-unique': 'expectedUpstream must be unique',
  'handoff.upstream-includes-sender': 'expectedUpstream must include the sender',
  'escalation.resolved-fields': 'resolvedAt and resolvedBy are set exactly when closed',
  'escalation.user-decides': 'only the user approves or declines',
  'escalation.permission-ref': 'a permission escalation points at its request',
  'escalation.delivery-ref': 'a delivery escalation points at its operation',
  'escalation.round-ref': 'a blocked-round escalation points at its round',
  'escalation.lock-ref': 'a lock escalation points at its lock',
  'escalation.task-plan-confirmation': 'a task list is decided by a confirmation',
  // ipc.ts (0.7)
  'activity.cause-only-closed': 'a close cause is given only with activity closed',
  'batch.seq-increasing': 'envelopes of a batch are in increasing seq order',
  'batch.seq-range': 'a batch covers fromSeq to toSeq and ends with toSeq',
  'snapshot.history-page-unique': 'one history page entry per session',
  'history.one-session': 'every record of a history page belongs to its session',
  // runtimes.ts (C-33)
  'runtime-status.executable': 'an executable is given exactly when the runtime is installed',
  'runtime-status.source': 'a source is given exactly with an executable',
  'runtime-status.version': 'a runtime found and checked has its version',
  'runtime-status.signed-out': 'a signed-out runtime reports signed-out auth',
  'runtime-status.available-signed-in': 'an available runtime is not signed out',
  'runtime-status.models-only-available': 'only an available runtime lists models',
  'snapshot.runtime-unique': 'one status per runtime',
  // storage.ts
  'storage.restore-pending-or-failed': 'a pending restore and a failed restore are not shown together',
  // mcp.ts
  'mcp.create-tasks-ids-unique': 'task keys must be unique',
  'mcp.create-tasks-dependency': 'a task depends on itself or on a key not in the list',
  'mcp.create-tasks-cycle': 'task dependencies form a cycle',
} as const;

export const ContractRule = z.enum(Object.keys(ruleMessages) as [keyof typeof ruleMessages, ...(keyof typeof ruleMessages)[]]);
export type ContractRule = z.infer<typeof ContractRule>;

/** The fixed message of a rule; never contains input values. */
export const ruleMessage = (rule: ContractRule): string => ruleMessages[rule];

/** Options for `.refine(...)`: the rule's fixed message and its code in `params.rule`. */
export const ruleIssue = (rule: ContractRule) => ({ message: ruleMessages[rule], params: { rule } });

/** Adds a custom issue for `rule` inside `.superRefine(...)`, optionally at `path` so a UI can point at the field. */
export const addRuleIssue = (ctx: z.RefinementCtx, rule: ContractRule, path?: PropertyKey[]): void => {
  ctx.addIssue({ code: 'custom', message: ruleMessages[rule], params: { rule }, ...(path && { path }) });
};

/** The rule code of a zod issue, when a contract rule raised it. */
export const issueRule = (issue: z.core.$ZodIssue): ContractRule | undefined => {
  if (issue.code !== 'custom') return undefined;
  const parsed = ContractRule.safeParse(issue.params?.['rule']);
  return parsed.success ? parsed.data : undefined;
};

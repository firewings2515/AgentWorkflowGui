// CR-2 delivery service (T008): R-04 steps 3-7 and CR2_DELIVERY_FIX §1-5 over the two ports only.
// The single way to reach a runtime is `claim → claimed` followed by exactly one runtime call; every
// other claim result, an uncertain commit or a thrown write leaves the runtime untouched. Unknown is
// never resent: it is reconciled read-only, and what stays unknown goes to the user, who may wait,
// cancel or retry. Provisions (target creation) are their own deliveries; payloads wait for them.
import {
  AttemptId,
  ClientMessageId,
  type DeliveryTarget,
  DeliveryTarget as DeliveryTargetSchema,
  type DispatchAttempt,
  type OperationId,
  deliveryTargetIssues,
} from '../../contracts';
import {
  type AcceptInput,
  type ClaimInput,
  type ClaimResult,
  CommitUncertainError,
  type DispatchResult,
  type ReconcileResult,
  type SessionSettings,
  type StartSessionOptions,
  type StoredDelivery,
} from '../ports';
import type {
  AcceptOutcome,
  DeliveryEscalation,
  DeliveryServiceOptions,
  DispatchFailure,
  DispatchOptions,
  DispatchOutcome,
  NotDispatchedReason,
  PayloadDelivery,
  ProvisionDelivery,
  ReconcileOutcome,
  RecoverOptions,
  RecoveryReport,
  ResolveInput,
  ResolveOutcome,
  UnknownReason,
} from './types';

type UnknownAttempt = Extract<DispatchAttempt, { state: 'unknown' }>;
type Proof = Extract<DispatchResult, { state: 'sent' }>;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type NotDispatched = Extract<DispatchOutcome, { status: 'not-dispatched' }>;

const notDispatched = (reason: NotDispatchedReason, detail: string, extra: Pick<NotDispatched, 'provisionState'> = {}): NotDispatched => ({
  status: 'not-dispatched',
  reason,
  detail,
  ...extra,
});

/** A write's failure as a not-dispatched reason: an uncertain commit is kept apart from a rollback. */
const writeFailed = (error: unknown, what: string): NotDispatched =>
  notDispatched(error instanceof CommitUncertainError ? 'commit-uncertain' : 'store-failed', `${what}: ${errorText(error)}`);

/** The attempt that may still turn out sent: the last one, unknown and not abandoned by a user retry. */
const liveUnknown = (record: StoredDelivery): UnknownAttempt | undefined => {
  const last = record.delivery.attempts.at(-1);
  return record.delivery.state === 'unknown' && last?.state === 'unknown' && last.resolution?.decision !== 'retry' ? last : undefined;
};

const startOptions = (spec: ProvisionDelivery['spec']): StartSessionOptions => ({
  sessionId: spec.sessionId,
  cwd: spec.cwd,
  model: spec.model,
  readOnly: spec.readOnly,
  ...(spec.instructions !== undefined && { instructions: spec.instructions }),
  ...(spec.preallocatedRef !== undefined && { preallocatedRef: spec.preallocatedRef }),
});

const settingsOf = (s: SessionSettings): SessionSettings => ({
  model: s.model,
  readOnly: s.readOnly,
  ...(s.instructions !== undefined && { instructions: s.instructions }),
});

/**
 * What the store gets: the spec and the session settings rebuilt from the fields the port allows, so
 * nothing else that rode along on the caller's object (an MCP token above all, C-07) is written.
 */
const storable = (input: AcceptInput): AcceptInput => {
  if (input.kind !== 'provision') return { ...input, context: { ...input.context, session: settingsOf(input.context.session) } };
  const { spec } = input;
  return {
    ...input,
    spec: {
      runtime: spec.runtime,
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      ...settingsOf(spec),
      ...(spec.preallocatedRef !== undefined && { preallocatedRef: spec.preallocatedRef }),
    },
  };
};

export class DeliveryService {
  /** Operations whose single runtime call is running in this process. */
  private readonly inFlight = new Set<OperationId>();

  constructor(private readonly options: DeliveryServiceOptions) {}

  /**
   * Acceptance (R-04 step 3): the operation is fixed with its payload, hash, revision and target and
   * counted once by the store. A resend with the same operationId is a duplicate; one that changes
   * anything is a conflict. Nothing is dispatched; the caller decides when (a handoff waits for the
   * target's turn to end).
   */
  async accept(input: AcceptInput): Promise<AcceptOutcome> {
    const issues = await this.acceptIssues(input);
    if (issues.length > 0) return { status: 'invalid', issues };
    try {
      return await this.options.store.accept(storable(input));
    } catch (error) {
      if (error instanceof CommitUncertainError) return { status: 'commit-uncertain', detail: error.message };
      throw error;
    }
  }

  /**
   * The one dispatch entry, for a first dispatch, a recovery and a user retry alike (CR2 §1 steps 2-5):
   * bind the target if it waited for a provision, re-check binding and revision in the claim, and call
   * the runtime once only after `claimed` committed. Anything but a live ack stays unknown and is
   * reconciled read-only right away; what is still unknown is escalated.
   */
  async dispatch(operationId: OperationId, options: DispatchOptions = {}): Promise<DispatchOutcome> {
    let record: StoredDelivery | undefined;
    try {
      record = await this.options.store.get(operationId);
    } catch (error) {
      return writeFailed(error, 'reading the delivery failed');
    }
    if (record === undefined) return notDispatched('not-found', `no delivery ${operationId}`);
    if (record.delivery.state !== 'pending') return notDispatched('not-pending', `delivery ${operationId} is ${record.delivery.state}`);
    return record.kind === 'provision' ? this.dispatchProvision(record, options) : this.dispatchPayload(record, options);
  }

  /** Read-only reconciliation of the live unknown attempt (CR2 §2): only a positive match records sent. */
  async reconcile(operationId: OperationId): Promise<ReconcileOutcome> {
    if (this.inFlight.has(operationId)) return { status: 'in-flight' };
    return this.reconcileLive(operationId);
  }

  /**
   * The user's decision on an unknown attempt (CR2 §2, contracts `delivery.resolve`). `wait` and
   * `cancel` keep the attempt unknown and reconcilable; `retry` needs `acceptDuplicateRisk`, keeps the
   * old attempt and returns the delivery to pending without recounting. The next `dispatch` then makes
   * a new attempt with a new attemptId and clientMessageId.
   */
  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    if (input.decision === 'retry' && !input.acceptDuplicateRisk) return { status: 'refused', reason: 'duplicate-risk-not-accepted' };
    // The old executor must have stopped before a retry, which would reach the runtime again. Wait and
    // cancel never do, so they are recorded while the call is still running (e.g. cancel after a create
    // request left); the store keeps them when that call turns out sent.
    if (input.decision === 'retry' && this.inFlight.has(input.operationId)) return { status: 'refused', reason: 'in-flight' };
    try {
      const written = await this.options.store.recordResolution(input.operationId, input.attemptId, {
        decision: input.decision,
        at: this.options.now(),
        ...(input.note !== undefined && { note: input.note }),
      });
      return written === 'recorded' ? { status: 'recorded', decision: input.decision } : { status: 'stale' };
    } catch (error) {
      if (error instanceof CommitUncertainError) return { status: 'commit-uncertain', detail: error.message };
      throw error;
    }
  }

  /**
   * After a restart (R-04 table): every unknown delivery is only reconciled, then every pending one goes
   * through `dispatch`, provisions first so their payloads can bind in the same pass.
   */
  async recover(options: RecoverOptions = {}): Promise<RecoveryReport> {
    const report: RecoveryReport = { reconciled: [], dispatched: [], failed: [] };
    const run = async <T>(operationId: OperationId, call: () => Promise<T>, done: (outcome: T) => void) => {
      try {
        done(await call());
      } catch (error) {
        report.failed.push({ operationId, detail: errorText(error) });
      }
    };
    for (const record of await this.options.store.listByState('unknown')) {
      const { operationId } = record;
      await run(operationId, () => this.reconcile(operationId), (outcome) => report.reconciled.push({ operationId, outcome }));
    }
    const pending = await this.options.store.listByState('pending');
    for (const record of [...pending.filter((r) => r.kind === 'provision'), ...pending.filter((r) => r.kind !== 'provision')]) {
      const { operationId } = record;
      const choice = options.select?.(record) ?? {};
      if (choice === 'skip') continue;
      await run(operationId, () => this.dispatch(operationId, choice), (outcome) => report.dispatched.push({ operationId, outcome }));
    }
    return report;
  }

  private async acceptIssues(input: AcceptInput): Promise<string[]> {
    // The types forbid it, but a spread through `SessionSettings` or a cast still compiles (C-07).
    const settings: object = input.kind === 'provision' ? input.spec : input.context.session;
    if ('mcp' in settings) return [`${input.kind === 'provision' ? 'spec' : 'context.session'} carries an MCP mount, which is never stored`];
    const parsed = DeliveryTargetSchema.safeParse(input.target);
    if (!parsed.success) return parsed.error.issues.map((i) => `target: ${i.message}`);
    const issues: string[] = deliveryTargetIssues(undefined, input.target);
    if (input.kind === 'provision') {
      if (input.target.provision?.operationId !== input.operationId) issues.push('a provision describes itself in target.provision');
    } else if ((await this.options.hashPayload(input.payload)) !== input.payloadHash) {
      issues.push('payloadHash does not match the payload');
    }
    return issues;
  }

  private async dispatchPayload(accepted: PayloadDelivery, options: DispatchOptions): Promise<DispatchOutcome> {
    const adapter = this.options.runtimes[accepted.context.runtime];
    if (adapter === undefined) return notDispatched('no-runtime', `no ${accepted.context.runtime} adapter`);
    let record = accepted;
    if (record.target.provision !== undefined) {
      const bound = await this.bindToProvision(record);
      if ('status' in bound) return bound;
      record = bound;
    }
    const nativeSessionRef = options.expectedNativeSessionRef ?? record.target.nativeSessionRef;
    if (nativeSessionRef === undefined) return notDispatched('target-not-ready', `delivery ${record.operationId} has no bound native session`);
    if (this.options.prepareTarget !== undefined) {
      try {
        await this.options.prepareTarget(record);
      } catch (error) {
        return notDispatched('prepare-failed', errorText(error));
      }
    }
    const claim = await this.claim(record, options, nativeSessionRef);
    if ('status' in claim) return claim;

    // Claimed and committed: the payload may now leave the GUI, once (CR2 §1 step 4).
    let result: DispatchResult | DispatchFailure;
    this.inFlight.add(record.operationId);
    try {
      const timeoutMs = options.timeoutMs ?? this.options.dispatchTimeoutMs;
      result = await adapter.dispatchOnce({
        nativeSessionRef,
        attempt: claim,
        // The persisted payload, never a caller's copy.
        text: record.payload,
        entry: options.entry ?? record.context.entry,
        ...(options.origin !== undefined && { origin: options.origin }),
        ...(timeoutMs !== undefined && { timeoutMs }),
      });
    } catch (error) {
      result = { reason: 'adapter-error', detail: errorText(error) };
    } finally {
      this.inFlight.delete(record.operationId);
    }
    if ('state' in result && result.state === 'unknown') {
      result = { reason: result.reason, written: result.written, detail: result.detail };
    }
    return this.settle(record.operationId, claim, result);
  }

  private async dispatchProvision(record: ProvisionDelivery, options: DispatchOptions): Promise<DispatchOutcome> {
    const adapter = this.options.runtimes[record.spec.runtime];
    if (adapter === undefined) return notDispatched('no-runtime', `no ${record.spec.runtime} adapter`);
    // A provision creates its target, so there is no binding to re-check (port: ClaimInput).
    const claim = await this.claim(record, options, undefined);
    if ('status' in claim) return claim;

    let result: Proof | DispatchFailure;
    this.inFlight.add(record.operationId);
    try {
      const info = await adapter.startSession(startOptions(record.spec));
      result = {
        state: 'sent',
        nativeRef: { sessionRef: info.nativeSessionRef },
        evidence: { kind: 'live-ack', at: this.options.now(), detail: `startSession returned native session ${info.nativeSessionRef} for ${record.spec.sessionId}` },
      };
    } catch (error) {
      // The runtime may have created it anyway (lost response): never create it again on our own.
      result = { reason: 'adapter-error', detail: errorText(error) };
    } finally {
      this.inFlight.delete(record.operationId);
    }
    return this.settle(record.operationId, claim, result);
  }

  /**
   * Moves a payload that waits for its provision to the session that provision created, by the store's
   * compare-and-set (R-04 step 4). Returns the re-read record, or why it cannot be dispatched yet.
   */
  private async bindToProvision(record: PayloadDelivery): Promise<PayloadDelivery | NotDispatched> {
    const { store } = this.options;
    const provisionId = record.target.provision?.operationId;
    try {
      const provision = provisionId === undefined ? undefined : await store.get(provisionId);
      if (provision?.kind !== 'provision') {
        return { status: 'not-dispatched', reason: 'provision-not-sent', detail: `the target's provision ${provisionId ?? ''} is not recorded` };
      }
      // The user cancelled after the create call left (CR2 §3): the created session stays recorded on the
      // provision, but no payload goes to it. A sent attempt can no longer be decided on, so this is final.
      if (provision.delivery.attempts.at(-1)?.resolution?.decision === 'cancel') {
        return {
          status: 'not-dispatched',
          reason: 'provision-cancelled',
          detail: `the user cancelled the target's provision ${provision.operationId}`,
          provisionState: provision.delivery.state,
        };
      }
      if (provision.delivery.state !== 'sent') {
        return {
          status: 'not-dispatched',
          reason: 'provision-not-sent',
          detail: `the target's provision ${provision.operationId} is ${provision.delivery.state}`,
          provisionState: provision.delivery.state,
        };
      }
      const created = provision.target.nativeSessionRef;
      const provisionRecord = provision.target.provision;
      if (created !== undefined && provisionRecord !== undefined) {
        const bound: DeliveryTarget = { sessionId: provision.spec.sessionId, nativeSessionRef: created, provision: provisionRecord };
        // `stale` is not an error here: the claim re-checks the target and says what is wrong.
        await store.updateTarget(record.operationId, record.target, bound);
      }
      const fresh = await store.get(record.operationId);
      if (fresh === undefined) return { status: 'not-dispatched', reason: 'not-found', detail: `no delivery ${record.operationId}` };
      if (fresh.kind === 'provision' || fresh.delivery.state !== 'pending') {
        return { status: 'not-dispatched', reason: 'not-pending', detail: `delivery ${record.operationId} is ${fresh.delivery.state}` };
      }
      return fresh;
    } catch (error) {
      return writeFailed(error, 'binding the target failed');
    }
  }

  /** The conditional `pending → unknown` with a new attempt; only a committed `claimed` returns the attempt. */
  private async claim(record: StoredDelivery, options: DispatchOptions, nativeSessionRef: string | undefined): Promise<UnknownAttempt | NotDispatched> {
    let input: ClaimInput;
    try {
      input = {
        operationId: record.operationId,
        expectedProposalRevision: options.expectedProposalRevision ?? record.proposalRevision,
        ...(nativeSessionRef !== undefined && { expectedNativeSessionRef: nativeSessionRef }),
        attemptId: AttemptId.parse(`attempt-${this.options.uuid()}`),
        clientMessageId: ClientMessageId.parse(this.options.uuid()),
        at: this.options.now(),
      };
    } catch (error) {
      return notDispatched('store-failed', `could not make attempt IDs: ${errorText(error)}`);
    }
    let result: ClaimResult;
    try {
      result = await this.options.store.claim(input);
    } catch (error) {
      // Uncertain or failed: either way the runtime is not called (CR2 §1 step 3).
      return writeFailed(error, 'the claim did not commit');
    }
    if (result.status !== 'claimed') return notDispatched(result.status, `claim of ${record.operationId}: ${result.status}`);
    return result.attempt;
  }

  /** Records a live ack as sent; anything else (or a failed write) is reconciled read-only, then escalated. */
  private async settle(operationId: OperationId, attempt: UnknownAttempt, result: Proof | DispatchFailure): Promise<DispatchOutcome> {
    let failure: DispatchFailure;
    if ('state' in result) {
      try {
        const written = await this.options.store.recordSent(operationId, attempt.attemptId, result.nativeRef, result.evidence);
        if (written === 'recorded') return { status: 'sent', attemptId: attempt.attemptId, nativeRef: result.nativeRef, evidence: result.evidence };
        failure = { reason: 'evidence-rejected', written: true, detail: `the store refused ${result.evidence.detail}` };
      } catch (error) {
        failure = { reason: 'record-failed', written: true, detail: `${result.evidence.detail}; writing sent failed: ${errorText(error)}` };
      }
    } else {
      failure = result;
    }
    let reconciled: ReconcileOutcome;
    try {
      reconciled = await this.reconcileLive(operationId, attempt.attemptId, failure);
    } catch (error) {
      // The store could not even be read: the attempt stays unknown and recovery escalates it later.
      return { status: 'unknown', attemptId: attempt.attemptId, failure: { ...failure, detail: `${failure.detail}; reconciling failed: ${errorText(error)}` } };
    }
    if (reconciled.status === 'sent') return reconciled;
    return {
      status: 'unknown',
      attemptId: attempt.attemptId,
      failure,
      ...(reconciled.status === 'unknown' && { escalation: reconciled.escalation }),
    };
  }

  /**
   * Reads the stored record (its payload, target, cwd and clientMessageId, never a caller's copy) and
   * asks the runtime's read-only `reconcile`. Only a positive match the store accepts becomes sent.
   */
  private async reconcileLive(operationId: OperationId, attemptId?: AttemptId, failure?: DispatchFailure): Promise<ReconcileOutcome> {
    const record = await this.options.store.get(operationId);
    const live = record === undefined ? undefined : liveUnknown(record);
    if (record === undefined || live === undefined || (attemptId !== undefined && live.attemptId !== attemptId)) {
      return { status: 'not-unknown', ...(record !== undefined && { state: record.delivery.state }) };
    }
    const unknown = (reason: UnknownReason, detail: string, matches: Extract<ReconcileResult, { state: 'unknown' }>['matches'] = []) =>
      this.escalate(record, live, { reason, detail, matches, ...(failure !== undefined && { failure }) });

    if (record.kind === 'provision') {
      return unknown('provision-unverifiable', 'whether the target session was created cannot be confirmed read-only; it is not created again without the user');
    }
    const adapter = this.options.runtimes[record.context.runtime];
    if (adapter === undefined) return unknown('no-runtime', `no ${record.context.runtime} adapter to reconcile with`);
    const nativeSessionRef = record.target.nativeSessionRef;
    if (nativeSessionRef === undefined) return unknown('read-failed', 'the dispatched delivery has no bound native session');

    let result: ReconcileResult;
    try {
      result = await adapter.reconcile({ nativeSessionRef, cwd: record.context.cwd, clientMessageId: live.clientMessageId, text: record.payload });
    } catch (error) {
      return unknown('read-failed', errorText(error));
    }
    if (result.state === 'unknown') return unknown(result.reason, result.detail, result.matches);
    try {
      const written = await this.options.store.recordSent(operationId, live.attemptId, result.nativeRef, result.evidence);
      if (written === 'stale') return unknown('evidence-rejected', `the store refused ${result.evidence.detail}`);
    } catch (error) {
      return unknown('record-failed', `${result.evidence.detail}; writing sent failed: ${errorText(error)}`);
    }
    return { status: 'sent', attemptId: live.attemptId, nativeRef: result.nativeRef, evidence: result.evidence };
  }

  private async escalate(
    record: StoredDelivery,
    attempt: UnknownAttempt,
    found: { reason: UnknownReason; detail: string; matches: DeliveryEscalation['matches']; failure?: DispatchFailure },
  ): Promise<ReconcileOutcome> {
    const decision = attempt.resolution?.decision;
    const blocked = record.kind === 'provision' ? await this.waitingFor(record.operationId) : undefined;
    const escalation: DeliveryEscalation = {
      kind: 'delivery-unknown',
      key: `${record.operationId}/${attempt.attemptId}`,
      operationId: record.operationId,
      deliveryKind: record.kind,
      attemptId: attempt.attemptId,
      clientMessageId: attempt.clientMessageId,
      dispatchStartedAt: attempt.dispatchStartedAt,
      target: record.target,
      ...found,
      duplicateRisk: found.reason === 'duplicate' ? 'suspected' : found.failure?.written === false ? 'unlikely' : 'possible',
      ...(blocked !== undefined && { blocked }),
      ...((decision === 'wait' || decision === 'cancel') && { decision }),
      at: this.options.now(),
    };
    this.options.onEscalation?.(escalation);
    return { status: 'unknown', escalation };
  }

  /** Pending payloads bound to wait for this provision; empty when the store cannot list them. */
  private async waitingFor(provisionId: OperationId): Promise<OperationId[]> {
    try {
      return (await this.options.store.listByState('pending')).filter((r) => r.kind !== 'provision' && r.target.provision?.operationId === provisionId).map((r) => r.operationId);
    } catch {
      return [];
    }
  }
}

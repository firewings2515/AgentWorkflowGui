// Cross-tool transfer (T023, R-02): the work of a session goes to a new session in another tool. At the
// source's turn boundary the GUI puts together the fixed frame (SP-09); only once the user confirmed that
// revision is the new session created and the frame sent (CR-5). A confirmation is bound to the source's
// content version: anything new in the source makes the proposal stale.
//
// Everything reaches a runtime through the session service's CR-2 delivery service: the target session is
// its own provision, the frame a `transfer` payload waiting for it, and the request for the source agent's
// note another `transfer` payload. All of a proposal's steps run in one queue per proposal, so a cancel is
// ordered with them, and every step can be redone after a restart on the same fixed IDs.
import type { AppEvent, CommandResult, LogicalSession, MessageOrigin, ModelSelection, PayloadHash, Timestamp, TransferId, TransferProposal, Turn } from '../../contracts';
import type { DeliveryEscalation, PayloadDelivery } from '../delivery';
import type { HistoryEntry } from '../ports';
import type { CommandOf, SessionService, TransferCommand, TransferHooks } from '../sessions';
import { agentNoteOf, contentVersion, digestOf, DRAFT_GOAL, entriesOf, frameText, NOTE_REQUEST } from './frame';
import { noteOperationOf, payloadOperationOf, targetSessionOf, transferOfOperation, transferOfProvision, transferOfSession } from './ids';

export interface TransferServiceOptions {
  sessions: SessionService;
  publish(event: AppEvent): void;
  now(): Timestamp;
  /** `sha256:<hex>` of a text, the same function the delivery service checks with. */
  hashPayload(text: string): PayloadHash | Promise<PayloadHash>;
  log?(message: string): void;
}

type Failure = Extract<CommandResult, { ok: false }>;
type Success = Extract<CommandResult, { ok: true }>;

const ok = (requestId: Success['requestId'], extra: Partial<Pick<Success, 'revision' | 'created'>> = {}): Success => ({ ok: true, requestId, created: [], ...extra });
const fail = (requestId: Failure['requestId'], code: Failure['code'], message: string, flags: { retryable?: boolean; mayHaveSideEffects?: boolean } = {}): Failure => ({
  ok: false,
  requestId,
  code,
  message,
  retryable: flags.retryable ?? false,
  mayHaveSideEffects: flags.mayHaveSideEffects ?? false,
});

/** A transfer's payloads come from the GUI, never from the user (the delivery service refuses that). */
const FROM_GUI: MessageOrigin = { kind: 'system' };

const sameModel = (a: ModelSelection, b: ModelSelection) => a.runtime === b.runtime && a.model === b.model && a.effort === b.effort;
const errorName = (error: unknown) => (error instanceof Error ? error.name : 'non-error thrown');

/** Under way for its source: the renderer offers no new proposal next to one of these (T026 `hasActive`). */
const isActive = (p: TransferProposal) => ['draft', 'awaiting-confirmation', 'stale'].includes(p.state) || (p.state === 'approved' && p.delivery?.state !== 'sent');

/** Where the steps after a confirmation stand. */
type Progress = 'sent' | 'unknown' | 'waiting' | 'failed' | 'cancelled' | 'storage';

export class TransferService implements TransferHooks {
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Cancels received and not yet done: a confirmation still running (e.g. inside the target's create call)
   * sends no payload from the moment the user cancelled (CR2 §3), not only once the cancel's turn comes.
   */
  private readonly cancelling = new Set<TransferId>();

  constructor(private readonly options: TransferServiceOptions) {}

  private get repos() {
    return this.options.sessions.storage.repositories;
  }

  private get store() {
    return this.options.sessions.storage.store;
  }

  // ---- commands -------------------------------------------------------------------------------------

  execute(command: TransferCommand): Promise<CommandResult> {
    if (command.type === 'transfer.cancel') {
      const { transferId } = command;
      this.cancelling.add(transferId);
      const done = this.serial(transferId, () => this.cancel(command));
      void done.finally(() => this.cancelling.delete(transferId)).catch(() => undefined);
      return done;
    }
    return this.serial(command.transferId, () => {
      if (this.options.sessions.isClosing()) return Promise.resolve(fail(command.requestId, 'runtime_unavailable', 'The application is closing'));
      switch (command.type) {
        case 'transfer.prepare':
          return this.prepare(command);
        case 'transfer.confirm':
          return this.confirm(command);
      }
    });
  }

  /**
   * A draft at once, finished at the source's turn boundary: the GUI's digest of its history (no model
   * call), or the source agent's note, asked for through the delivery service. Nothing touches the target.
   */
  private async prepare(command: CommandOf<'transfer.prepare'>): Promise<CommandResult> {
    const { requestId, transferId, sourceSessionId, target, noteSource } = command;
    const { sessions } = this.options;
    const created = [{ kind: 'transfer' as const, id: transferId }];
    const existing = await this.repos.transfers.get(transferId);
    if (existing !== undefined) {
      // The renderer chose the ID: the same request again is this proposal, anything else is not.
      if (existing.sourceSessionId !== sourceSessionId || !sameModel(existing.target, target) || existing.content.noteSource !== noteSource)
        return fail(requestId, 'already_exists', 'A transfer with this ID already exists');
      await this.advance(existing);
      return ok(requestId, { revision: (await this.repos.transfers.get(transferId))?.revision ?? existing.revision, created });
    }
    const source = await this.repos.sessions.get(sourceSessionId);
    if (source === undefined) return fail(requestId, 'not_found', 'Unknown session');
    if (source.kind !== 'ordinary') return fail(requestId, 'invalid_request', 'Only an ordinary session can be transferred to another tool');
    if (target.runtime === source.requestedModel.runtime)
      return fail(requestId, 'invalid_request', 'A transfer goes to another tool; a model of the same tool is changed on the session itself');
    if (!sessions.runtimeAvailable(target.runtime)) return fail(requestId, 'runtime_unavailable', `${target.runtime} is not available on this computer`);
    if (noteSource === 'agent' && !sessions.runtimeAvailable(source.requestedModel.runtime))
      return fail(requestId, 'runtime_unavailable', `${source.requestedModel.runtime} is not available to write the note`);
    if ((await sessions.nativeSessionOf(source.id)) === undefined) return fail(requestId, 'invalid_request', 'The session has no conversation to transfer yet');
    if ((await this.repos.transfers.list()).some((p) => p.sourceSessionId === source.id && isActive(p)))
      return fail(requestId, 'invalid_transition', 'This session already has a transfer under way; cancel it first');
    const content: TransferProposal['content'] = { goal: DRAFT_GOAL, note: '', noteSource, diff: '', testOutput: '' };
    const draft: TransferProposal = {
      id: transferId,
      operationId: payloadOperationOf(transferId),
      revision: 0,
      sourceSessionId,
      sourceRevision: 0,
      target,
      content,
      payloadHash: await this.options.hashPayload(frameText({ sourceSessionId, target, content }, source.requestedModel.runtime)),
      state: 'draft',
      createdAt: this.options.now(),
    };
    if ((await this.repos.transfers.create(draft)) === 'exists') return fail(requestId, 'already_exists', 'A transfer with this ID already exists');
    await this.publish(transferId);
    await this.advance(draft);
    return ok(requestId, { revision: (await this.repos.transfers.get(transferId))?.revision ?? 0, created });
  }

  /**
   * The user's confirmation of one revision (COM-05). The source must still be what was reviewed, or the
   * proposal becomes stale. The approval is saved first; then the new session, its provision, the payload,
   * and the dispatch, each redone on its fixed ID when it was cut off (CR2 §3).
   */
  private async confirm(command: CommandOf<'transfer.confirm'>): Promise<CommandResult> {
    const { requestId, transferId, expectedRevision } = command;
    const { sessions } = this.options;
    const p = await this.repos.transfers.get(transferId);
    if (p === undefined) return fail(requestId, 'not_found', 'Unknown transfer');
    if (p.revision !== expectedRevision) {
      // The same confirmation again: only what it left undone, nothing twice.
      if (p.state === 'approved' && p.approvedRevision === expectedRevision + 1) return this.carryOut(requestId, p);
      return fail(requestId, 'stale_revision', 'The transfer has changed since it was loaded', { retryable: true });
    }
    if (p.state === 'stale') return fail(requestId, 'invalid_transition', 'The source session changed; cancel this transfer and prepare it again');
    if (p.state !== 'awaiting-confirmation') return fail(requestId, 'invalid_transition', `A ${p.state} transfer cannot be confirmed`);
    if (!sessions.runtimeAvailable(p.target.runtime)) return fail(requestId, 'runtime_unavailable', `${p.target.runtime} is not available on this computer`);
    const source = await this.repos.sessions.get(p.sourceSessionId);
    if (source === undefined) return fail(requestId, 'not_found', 'The source session no longer exists');
    if (await this.sourceChanged(p)) {
      await this.markStale(p);
      return fail(requestId, 'stale_revision', 'The source session changed after the transfer was prepared; prepare it again');
    }
    const revision = p.revision + 1;
    const approved: TransferProposal = {
      ...p,
      revision,
      state: 'approved',
      approvedRevision: revision,
      approvedAt: this.options.now(),
      provision: sessions.provisionFor(targetSessionOf(p.id)),
    };
    const saved = await this.repos.transfers.update(approved, p.revision);
    if (saved.status === 'stale') return fail(requestId, 'stale_revision', 'The transfer has changed since it was loaded', { retryable: true });
    await this.publish(p.id);
    return this.carryOut(requestId, saved.record);
  }

  private async carryOut(requestId: Success['requestId'], p: TransferProposal): Promise<CommandResult> {
    const progress = await this.proceed(p);
    await this.publish(p.id);
    const revision = (await this.repos.transfers.get(p.id))?.revision;
    switch (progress) {
      case 'sent':
        return ok(requestId, { ...(revision !== undefined && { revision }), created: [{ kind: 'session', id: targetSessionOf(p.id) }] });
      case 'unknown':
        return fail(requestId, 'unknown_outcome', 'It is not known whether the new session was created or the content reached it; it is not done again', {
          mayHaveSideEffects: true,
        });
      case 'waiting':
        return fail(requestId, 'runtime_unavailable', 'The transfer is confirmed, but the new session could not be started yet', { retryable: true, mayHaveSideEffects: true });
      case 'storage':
        return fail(requestId, 'storage_failed', 'The transfer could not be saved for certain', { retryable: true, mayHaveSideEffects: true });
      case 'failed':
        return fail(requestId, 'runtime_unavailable', 'The new session could not be created; the work stays in the source session', { mayHaveSideEffects: true });
      case 'cancelled':
        return fail(requestId, 'invalid_transition', 'The transfer was cancelled');
    }
  }

  /**
   * Cancelling never sends anything afterwards: the payload (or the note request) is recorded as cancelled,
   * which the dispatch gate honours. What already crossed the dispatch boundary is handled by its state:
   * sent cannot be cancelled; unknown gets the user's cancel and stays reconcilable (CR2 §2).
   */
  private async cancel(command: CommandOf<'transfer.cancel'>): Promise<CommandResult> {
    const { requestId, transferId } = command;
    const p = await this.repos.transfers.get(transferId);
    if (p === undefined) return fail(requestId, 'not_found', 'Unknown transfer');
    if (p.state === 'cancelled') return ok(requestId, { revision: p.revision });
    if (p.state === 'failed') return fail(requestId, 'invalid_transition', 'A failed transfer has nothing left to cancel');
    if (p.delivery?.state === 'sent') return fail(requestId, 'invalid_transition', 'The content was delivered; the new session keeps it');
    await this.stopDeliveries(p, 'the user cancelled the transfer');
    // A target creation whose outcome is unknown gets the user's cancel too: a session it created is still
    // recorded, but nothing is sent to it (CR2 §3).
    if (p.provision !== undefined) await this.options.sessions.cancelUnknownDelivery(p.provision.operationId);
    const saved = await this.end(p, 'cancelled', 'the user cancelled the transfer');
    if (saved === 'stale') return fail(requestId, 'stale_revision', 'The transfer has changed since it was loaded', { retryable: true });
    return ok(requestId, { revision: saved.revision });
  }

  // ---- preparing ------------------------------------------------------------------------------------

  /**
   * Finishes a draft once its source is at a turn boundary. With the agent's note, the request is accepted
   * and dispatched first, and the draft finishes when the turn it started has ended. `final` (a restart):
   * that turn is over whatever was recorded of it.
   */
  private async advance(p: TransferProposal, final = false): Promise<void> {
    if (p.state !== 'draft') return;
    const { sessions } = this.options;
    const source = await this.repos.sessions.get(p.sourceSessionId);
    if (source === undefined || sessions.isClosing() || (await sessions.mainTurnRunning(source.id))) return;
    if (p.content.noteSource === 'gui-digest') return this.complete(p, source, undefined);
    const op = noteOperationOf(p.id);
    let note = await this.store.get(op);
    if (note === undefined) {
      const ref = await sessions.nativeSessionOf(source.id);
      const context = await sessions.payloadContext(source.id, FROM_GUI);
      if (ref === undefined || context === undefined) return;
      const accepted = await sessions.delivery.accept({
        kind: 'transfer',
        operationId: op,
        payloadHash: await this.options.hashPayload(NOTE_REQUEST),
        payload: NOTE_REQUEST,
        proposalRevision: p.revision,
        target: { sessionId: source.id, nativeSessionRef: ref },
        at: this.options.now(),
        context,
      });
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
        this.log(`accepting the note request of ${p.id} ended ${accepted.status}`);
        return;
      }
      note = await this.store.get(op);
    }
    if (note === undefined || note.kind === 'provision' || note.outcome !== undefined) return;
    if (note.delivery.state === 'pending') {
      await sessions.deliverTransfer(op, source.id);
      return;
    }
    // Unknown: escalated at the source; the user decides (CR-2).
    if (note.delivery.state === 'unknown') return;
    const last = note.delivery.attempts.at(-1);
    const conversation = await this.repos.conversations.get(source.id);
    // The turn the request started (its ack names it); after a reconcile, the source's first own turn since.
    const turn =
      last?.state === 'sent' && last.nativeRef.turnRef !== undefined
        ? conversation.turns.find((t) => t.id === last.nativeRef.turnRef)
        : conversation.turns.find((t) => t.nativeTaskId === undefined && t.startedAt >= note.acceptedAt);
    if (!final && (turn === undefined || turn.state === 'running')) return;
    const turnRef = turn?.id ?? (last?.state === 'sent' ? last.nativeRef.turnRef : undefined);
    return this.complete(p, source, turnRef);
  }

  /** The draft's real content, bound to the source's content version now (at its turn boundary). */
  private async complete(p: TransferProposal, source: LogicalSession, noteTurn: string | undefined): Promise<void> {
    const history = await this.history(source);
    const digest = digestOf(history.entries, source.title.trim().length > 0 ? source.title : `Continue the work of session ${source.id}`);
    let note = digest.note;
    if (p.content.noteSource === 'agent') {
      const stored = entriesOf(await this.repos.conversations.get(source.id));
      note = noteTurn === undefined ? '' : agentNoteOf(stored, noteTurn) || agentNoteOf(history.entries, noteTurn);
    } else if (history.from === 'gui') {
      note = `${note}\n(The runtime's history could not be read; this is the GUI's own record of the session.)`;
    } else if (!history.complete) {
      note = `${note}\n(The runtime's history of the session could not be read in full.)`;
    }
    // Nothing the GUI handed out (an MCP token quoted in a transcript) leaves in a proposal (C-07).
    const redact = (text: string) => this.options.sessions.runtimes.redactText(text);
    const content: TransferProposal['content'] = {
      goal: redact(digest.goal),
      note: redact(note),
      noteSource: p.content.noteSource,
      diff: redact(digest.diff),
      testOutput: redact(digest.testOutput),
    };
    const next: TransferProposal = {
      ...p,
      revision: p.revision + 1,
      state: 'awaiting-confirmation',
      sourceRevision: contentVersion(await this.repos.conversations.get(source.id)),
      content,
      payloadHash: await this.options.hashPayload(frameText({ ...p, content }, source.requestedModel.runtime)),
    };
    const saved = await this.repos.transfers.update(next, p.revision);
    if (saved.status === 'saved') await this.publish(p.id);
  }

  /** The source's history through the runtime (read-only, no resume); the GUI's own record when it cannot be read. */
  private async history(source: LogicalSession): Promise<{ entries: HistoryEntry[]; complete: boolean; from: 'runtime' | 'gui' }> {
    const { sessions } = this.options;
    const ref = await sessions.nativeSessionOf(source.id);
    if (ref !== undefined) {
      try {
        const read = await sessions.runtimes.adapters[source.requestedModel.runtime].readHistory({ sessionId: source.id, nativeSessionRef: ref, cwd: source.cwd });
        if (read.entries.length > 0) return { entries: read.entries, complete: read.complete, from: 'runtime' };
      } catch (error) {
        this.log(`reading the history of ${source.id} failed (${errorName(error)})`);
      }
    }
    return { entries: entriesOf(await this.repos.conversations.get(source.id)), complete: true, from: 'gui' };
  }

  /** Whether the source is not what the proposal bound: it runs a turn, or its content version moved. */
  private async sourceChanged(p: TransferProposal): Promise<boolean> {
    if (await this.options.sessions.mainTurnRunning(p.sourceSessionId)) return true;
    return contentVersion(await this.repos.conversations.get(p.sourceSessionId)) !== p.sourceRevision;
  }

  private async markStale(p: TransferProposal): Promise<void> {
    const saved = await this.repos.transfers.update({ ...p, revision: p.revision + 1, state: 'stale' }, p.revision);
    if (saved.status === 'saved') await this.publish(p.id);
  }

  // ---- after the confirmation -----------------------------------------------------------------------

  /** The steps after the approval, from wherever they stopped; each is recognised by its fixed ID. */
  private async proceed(p: TransferProposal): Promise<Progress> {
    if (p.state === 'cancelled') return 'cancelled';
    if (p.state !== 'approved' || p.approvedRevision === undefined) return 'failed';
    const { sessions } = this.options;
    const targetId = targetSessionOf(p.id);
    let payload = await this.store.get(p.operationId);
    if (payload?.outcome !== undefined) return payload.outcome.kind === 'cancelled' ? 'cancelled' : 'failed';
    const provision = p.provision === undefined ? undefined : await this.store.get(p.provision.operationId);
    // Nothing crossed the boundary yet and the target tool is gone: it fails for good, nothing is created.
    if ((provision === undefined || (provision.delivery.state === 'pending' && provision.delivery.attempts.length === 0)) && !sessions.runtimeAvailable(p.target.runtime)) {
      await this.fail(p, `${p.target.runtime} is not available on this computer`);
      return 'failed';
    }
    if (payload === undefined) {
      if (sessions.isClosing()) return 'waiting';
      const source = await this.repos.sessions.get(p.sourceSessionId);
      if (source === undefined) {
        await this.fail(p, 'the source session no longer exists');
        return 'failed';
      }
      // a. The new session, linked to its source (R-02).
      if ((await this.ensureTarget(p, source)) === 'taken') {
        await this.fail(p, 'the ID of the new session is taken by another session');
        return 'failed';
      }
      // b. Its creation, recorded but not dispatched yet; c. the payload, waiting for it (CR2 §3).
      const target = await sessions.payloadTarget(targetId);
      const context = await sessions.payloadContext(targetId, FROM_GUI);
      if (target === undefined || context === undefined) return 'storage';
      const accepted = await sessions.delivery.accept({
        kind: 'transfer',
        operationId: p.operationId,
        payloadHash: p.payloadHash,
        // Rebuilt from the approved proposal: the store checks it is what the user confirmed (CR-5).
        payload: frameText(p, source.requestedModel.runtime),
        proposalRevision: p.approvedRevision,
        target,
        at: this.options.now(),
        context,
      });
      if (accepted.status === 'commit-uncertain') return 'storage';
      if (accepted.status !== 'accepted' && accepted.status !== 'duplicate') {
        this.log(`accepting the payload of ${p.id} ended ${accepted.status}`);
        return 'storage';
      }
      payload = await this.store.get(p.operationId);
    }
    if (payload === undefined) return 'storage';
    // d. Provision first, then the payload, in the new session's queue.
    if (payload.delivery.state === 'pending') {
      if (sessions.isClosing()) return 'waiting';
      await sessions.deliverTransfer(p.operationId, targetId);
      payload = (await this.store.get(p.operationId)) ?? payload;
    }
    if (payload.delivery.state === 'sent') return 'sent';
    if (payload.delivery.state === 'unknown') return 'unknown';
    if (this.cancelling.has(p.id)) return 'cancelled';
    const created = p.provision === undefined ? undefined : await this.store.get(p.provision.operationId);
    return created?.delivery.state === 'unknown' ? 'unknown' : 'waiting';
  }

  /** The new session: an ordinary session of the source's Agent and folder, in the target tool, derived from the source. */
  private async ensureTarget(p: TransferProposal, source: LogicalSession): Promise<'ok' | 'taken'> {
    const id = targetSessionOf(p.id);
    const same = (s: LogicalSession | undefined) => s !== undefined && s.kind === 'ordinary' && s.derivedFromSessionId === source.id && sameModel(s.requestedModel, p.target);
    const existing = await this.repos.sessions.get(id);
    if (existing !== undefined) return same(existing) ? 'ok' : 'taken';
    const at = this.options.now();
    const session: LogicalSession = {
      id,
      revision: 0,
      kind: 'ordinary',
      title: source.title,
      agent: source.agent,
      requestedModel: p.target,
      observedModel: { source: 'unknown' },
      activity: 'closed',
      cwd: source.cwd,
      folderScope: source.folderScope,
      ...(source.parentId !== undefined && { parentId: source.parentId }),
      derivedFromSessionId: source.id,
      createdAt: at,
      updatedAt: at,
    };
    if ((await this.repos.sessions.create(session)) === 'exists') return same(await this.repos.sessions.get(id)) ? 'ok' : 'taken';
    this.options.publish({ type: 'session.updated', session });
    return 'ok';
  }

  /** The payload never goes, and the proposal says why: the work stays in the source session (R-02). */
  private async fail(p: TransferProposal, message: string): Promise<void> {
    await this.stopDeliveries(p, message, 'failed');
    await this.end(p, 'failed', message);
  }

  /** Records the payload and the note request as ended apart from delivery, so no gate lets them go. */
  private async stopDeliveries(p: TransferProposal, detail: string, kind: 'cancelled' | 'failed' = 'cancelled'): Promise<void> {
    for (const op of [p.operationId, noteOperationOf(p.id)]) {
      const record = await this.store.get(op);
      if (record === undefined || record.kind === 'provision' || record.outcome !== undefined || record.delivery.state === 'sent') continue;
      await this.store.recordOutcome(op, { kind, detail, at: this.options.now() });
      if (record.delivery.state === 'unknown') await this.options.sessions.cancelUnknownDelivery(op);
    }
  }

  /**
   * Saves the proposal as cancelled or failed with the next revision. `failed` needs a payload that never
   * crossed the dispatch boundary (contracts); one that did is recorded as cancelled instead.
   */
  private async end(p: TransferProposal, state: 'cancelled' | 'failed', message: string): Promise<TransferProposal | 'stale'> {
    const dispatched = p.delivery !== undefined && (p.delivery.attempts.length > 0 || p.delivery.state !== 'pending');
    const failed = state === 'failed' && p.approvedRevision !== undefined && !dispatched;
    const base = { ...p, revision: p.revision + 1 };
    delete base.failure;
    delete base.cancelledAt;
    const next: TransferProposal = failed ? { ...base, state: 'failed', failure: { message } } : { ...base, state: 'cancelled', cancelledAt: this.options.now() };
    const saved = await this.repos.transfers.update(next, p.revision);
    if (saved.status === 'stale') return 'stale';
    await this.publish(p.id);
    return saved.record;
  }

  // ---- hooks of the session service ----------------------------------------------------------------

  turnEnded(turn: Turn): void {
    void (async () => {
      const waiting = (await this.repos.transfers.list()).filter((p) => p.sourceSessionId === turn.sessionId && (p.state === 'draft' || p.state === 'awaiting-confirmation'));
      for (const { id } of waiting) {
        await this.serial(id, async () => {
          const p = await this.repos.transfers.get(id);
          if (p?.state === 'draft') await this.advance(p);
          // The source went on after the proposal was made: it must be prepared again (CR-5).
          else if (p?.state === 'awaiting-confirmation' && (await this.sourceChanged(p))) await this.markStale(p);
        });
      }
    })().catch((error: unknown) => this.log(`following the turn end of ${turn.sessionId} failed (${errorName(error)})`));
  }

  async mayDispatch(record: PayloadDelivery): Promise<boolean> {
    const of = transferOfOperation(record.operationId);
    if (of === undefined) return false;
    const p = await this.repos.transfers.get(of.transferId);
    if (p === undefined || this.cancelling.has(p.id)) return false;
    return of.part === 'payload' ? p.state === 'approved' && p.operationId === record.operationId : p.state === 'draft';
  }

  isTarget(session: LogicalSession): boolean {
    return session.derivedFromSessionId !== undefined && transferOfSession(session.id) !== undefined;
  }

  redeliver(operationId: Parameters<TransferHooks['redeliver']>[0]): Promise<void> {
    const of = transferOfOperation(operationId);
    if (of === undefined) return Promise.resolve();
    return this.serial(of.transferId, async () => {
      const p = await this.repos.transfers.get(of.transferId);
      if (p === undefined) return;
      if (of.part === 'note') await this.advance(p);
      else if (p.state === 'approved') await this.proceed(p);
      await this.publish(p.id);
    });
  }

  async escalationFor(item: DeliveryEscalation): Promise<Awaited<ReturnType<TransferHooks['escalationFor']>>> {
    const transferId =
      item.deliveryKind === 'transfer'
        ? transferOfOperation(item.operationId)?.transferId
        : item.deliveryKind === 'provision' && item.target.sessionId !== undefined
          ? transferOfSession(item.target.sessionId)
          : undefined;
    if (transferId === undefined) return undefined;
    const p = await this.repos.transfers.get(transferId);
    if (p === undefined) return undefined;
    const ref =
      item.deliveryKind === 'provision' ? { kind: 'provision' as const, operationId: item.operationId, blocked: item.blocked ?? [] } : { kind: 'transfer' as const, transferId };
    return { ref, rootSessionId: p.sourceSessionId };
  }

  /**
   * The user cancelled an unknown delivery of a transfer: its target's creation (the transfer failed, the
   * work stays in the source), its payload or its note request (the transfer is cancelled).
   */
  deliveryResolved(operationId: Parameters<TransferHooks['deliveryResolved']>[0], decision: 'wait' | 'cancel' | 'retry'): Promise<void> {
    if (decision !== 'cancel') return Promise.resolve();
    const transferId = transferOfOperation(operationId)?.transferId ?? transferOfProvision(operationId);
    if (transferId === undefined) return Promise.resolve();
    return this.serial(transferId, async () => {
      const p = await this.repos.transfers.get(transferId);
      if (p === undefined || p.state === 'cancelled' || p.state === 'failed' || p.delivery?.state === 'sent') return;
      if (transferOfOperation(operationId) === undefined) {
        await this.fail(p, 'creating the new session was cancelled after its outcome stayed unknown');
        return;
      }
      await this.stopDeliveries(p, 'the user cancelled the delivery');
      await this.end(p, 'cancelled', 'the user cancelled the delivery');
    });
  }

  // ---- restart --------------------------------------------------------------------------------------

  /**
   * After the session service's start (every session closed, unknown deliveries reconciled): each proposal
   * goes on from where it stopped. Unknown is never dispatched again; a cancelled or failed one sends nothing.
   */
  async recover(): Promise<void> {
    for (const { id } of await this.repos.transfers.list()) {
      await this.serial(id, async () => {
        const p = await this.repos.transfers.get(id);
        if (p === undefined) return;
        if (p.state === 'draft') await this.advance(p, true);
        else if (p.state === 'approved') {
          const payload = await this.store.get(p.operationId);
          // A cancel or failure cut off before its proposal was saved.
          if (payload?.outcome !== undefined) await this.end(p, payload.outcome.kind === 'failed' ? 'failed' : 'cancelled', payload.outcome.detail);
          else if (payload?.delivery.state !== 'sent' && payload?.delivery.state !== 'unknown') await this.proceed(p);
        } else if (p.state === 'cancelled' || p.state === 'failed') {
          await this.stopDeliveries(p, p.state === 'failed' ? (p.failure?.message ?? 'the transfer failed') : 'the user cancelled the transfer', p.state === 'failed' ? 'failed' : 'cancelled');
        }
        await this.publish(id);
      }).catch((error: unknown) => this.log(`recovering transfer ${id} failed (${errorName(error)})`));
    }
  }

  // ---- helpers --------------------------------------------------------------------------------------

  /** `transfer.updated` with the proposal as stored now (its delivery side read from the delivery store). */
  private async publish(id: TransferId): Promise<void> {
    const proposal = await this.repos.transfers.get(id);
    if (proposal !== undefined) this.options.publish({ type: 'transfer.updated', proposal });
  }

  /** Runs `fn` after everything queued for this proposal; a failure does not block what comes next. */
  private serial<T>(id: TransferId, fn: () => Promise<T>): Promise<T> {
    const key = `transfer:${id}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  private log(message: string): void {
    this.options.log?.(`[transfer] ${message}`);
  }
}


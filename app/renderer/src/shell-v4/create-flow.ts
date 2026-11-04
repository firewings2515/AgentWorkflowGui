// A new chat is created only when its first message is sent (REVISION_V0_4 §3.4, Q-3): `session.create`, then
// `session.send` once the store has read the created session back.
//  - create refused for sure: the draft stays in the new-chat box; sending again uses new IDs.
//  - create accepted: open the session with the draft, then send it with the revision just read. A refused send leaves
//    the draft in that session's box (the usual send feedback applies).
//  - create outcome unknown: nothing is resent. After a successful re-read the session is either found (opened with the
//    draft, not sent: Q-d) or missing (the user confirms before trying again). Missing does not prove the first request
//    will never complete (r1 P1-2), so sending again re-creates the SAME session ID with the same fields: the service
//    makes a session ID once (CR-2, `already_exists` for a repeat), and `already_exists` then means the earlier attempt
//    went through. Only giving up this attempt (abandon) gives the next send new IDs.
// Everything happens in event handlers: the store reads the Snapshot again before it returns an accepted create.
import { useEffect, useRef, useState } from 'react';
import { AgentId, RequestId, SessionId } from '../../../../contracts';
import type { Command, CommandResult, ModelOption, Snapshot } from '../../../../contracts';
import { blocksResubmit } from '../command-feedback';
import type { RendererState, RendererStore } from '../renderer-store';
import type { ComposerChoice } from './Composer';
import { modelKey } from './Composer';

export type CreateCommand = Extract<Command, { type: 'session.create' }>;
export interface CreateAttempt { command: CreateCommand; text: string; result: CommandResult | null; resend?: boolean }

/** A resend's `already_exists` is the earlier attempt with the same session ID having gone through. */
const createdBy = (attempt: CreateAttempt, result: CommandResult | null | undefined) =>
  !!result && (result.ok || (!!attempt.resend && result.code === 'already_exists'));

export function createCommand(choice: ComposerChoice, model: ModelOption): CreateCommand {
  return {
    type: 'session.create', requestId: RequestId.parse(crypto.randomUUID()), sessionId: SessionId.parse(crypto.randomUUID()), kind: 'ordinary',
    model: { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) },
    ...(choice.agentId ? { agentId: AgentId.parse(choice.agentId) } : {}),
    ...(choice.folder.kind === 'picked' ? { cwd: choice.folder.path } : {}),
  };
}

export function useCreateFlow({ snapshot, store, ipcState, onOpened }: {
  snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined;
  /** Called once per created session: open it with this draft (empty: the current new-chat draft), and send it when `send` is true. */
  onOpened: (sessionId: SessionId, text: string, send: boolean) => void;
}) {
  const [attempt, setAttempt] = useState<CreateAttempt>();
  // The create a missing check released: a later send repeats it (same session ID and fields) until abandoned.
  const [retryOf, setRetryOf] = useState<CreateCommand>();
  const pending = useRef(false);
  const opened = useRef(new Set<string>());
  const report = useRef(onOpened);
  useEffect(() => { report.current = onOpened; });
  const unresolved = Object.values(ipcState?.blockedCommands ?? {}).find(item => item.command.type === 'session.create');
  const unresolvedCommand = unresolved?.command.type === 'session.create' ? unresolved.command : undefined;
  const result = attempt ? ipcState?.commands[attempt.command.requestId]?.result ?? attempt.result : null;
  const accepted = !!attempt && createdBy(attempt, result);
  const uncertain = !!unresolved?.result && blocksResubmit(unresolved.result);
  const found = !!unresolvedCommand && unresolved?.createCheck === 'found' && snapshot.sessions.some(session => session.id === unresolvedCommand.sessionId);

  /**
   * Opens the created session if the latest Snapshot has it. Only the answer to the user's own send sends the first
   * message; a create that was uncertain (a late receipt, or found by a re-read) opens unsent (Q-d).
   */
  const openIfRead = (current: CreateAttempt | undefined, send: boolean) => {
    if (!store) return;
    const state = store.getSnapshot();
    if (state.connection !== 'ready' || !state.snapshot) return;
    const has = (id: string) => state.snapshot!.sessions.some(session => session.id === id);
    const check = Object.values(state.blockedCommands).find(item => item.command.type === 'session.create');
    if (current && createdBy(current, state.commands[current.command.requestId]?.result ?? current.result) && has(current.command.sessionId)) {
      if (opened.current.has(current.command.sessionId)) return;
      opened.current.add(current.command.sessionId);
      setAttempt(undefined);
      setRetryOf(undefined);
      report.current(current.command.sessionId, current.text, send);
    } else if (check?.command.type === 'session.create' && check.createCheck === 'found' && has(check.command.sessionId)) {
      const id = check.command.sessionId;
      store.acknowledge('session.create', `session:${id}`);
      if (opened.current.has(id)) return;
      opened.current.add(id);
      setAttempt(undefined);
      setRetryOf(undefined);
      report.current(id, current?.command.sessionId === id ? current.text : '', false);
    }
  };

  return {
    attempt, result, unresolved, uncertain, accepted, found, retryOf,
    /** Sending is held while a create is in flight, accepted but not yet read back, or uncertain. */
    busy: (!!attempt && !result) || accepted || !!unresolved,
    submit: async (text: string, choice: ComposerChoice) => {
      if (!store || pending.current || Object.values(store.getSnapshot().blockedCommands).some(item => item.command.type === 'session.create')) return;
      const model = snapshot.modelOptions.find(item => !item.hidden && modelKey(item) === choice.modelKey);
      if (!model || !text.trim()) return;
      const command = retryOf ? { ...retryOf, requestId: RequestId.parse(crypto.randomUUID()) } : createCommand(choice, model);
      const next: CreateAttempt = { command, text, result: null, resend: !!retryOf };
      pending.current = true;
      setAttempt(next);
      const outcome = await store.send(command);
      pending.current = false;
      const settled = { ...next, result: outcome };
      setAttempt(previous => previous?.command.requestId === command.requestId ? settled : previous);
      // The store reads the Snapshot again for an accepted create, not for `already_exists`.
      if (!outcome.ok && createdBy(settled, outcome)) await store.reconnect();
      openIfRead(settled, true);
    },
    /** Reads the Snapshot again (never resends) and opens the session when it is there. */
    reconcile: async () => {
      if (!store) return;
      await store.reconnect();
      openIfRead(attempt, false);
    },
    /** Opens a session an earlier re-read found (for example after F5). */
    openFound: () => openIfRead(attempt, false),
    /** After a successful re-read did not find the session, the user confirms and may send again: the same session ID. */
    acknowledgeMissing: () => {
      if (!store || !unresolvedCommand || unresolved?.createCheck !== 'missing') return;
      store.acknowledge('session.create', `session:${unresolvedCommand.sessionId}`);
      setRetryOf(unresolvedCommand);
      setAttempt(undefined);
    },
    /** Gives up the released create: the next send starts a new session with new IDs and the current choices. */
    abandon: () => {
      if (pending.current || unresolved) return;
      setRetryOf(undefined);
      setAttempt(undefined);
    },
  };
}

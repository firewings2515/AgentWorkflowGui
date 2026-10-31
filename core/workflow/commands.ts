// Commands the workflow engine answers before the session service (T032): ending a run, retrying a cleanup, and
// the check that keeps the sessions of a merged and cleaned task read-only (R-06). The main process sends every
// command through here.
import type { Command, CommandResult } from '../../contracts';
import type { SessionService } from '../sessions';
import type { WorkflowEngine } from './engine';

export async function executeCommand(sessions: SessionService, engine: WorkflowEngine, command: Command): Promise<CommandResult> {
  if (command.type === 'workflow.complete' || command.type === 'workflow.cancel' || command.type === 'task.retryCleanup') {
    if (sessions.isClosing()) return { ok: false, requestId: command.requestId, code: 'runtime_unavailable', message: 'The application is closing', retryable: false, mayHaveSideEffects: false };
    const handled = engine.execute(command);
    if (handled !== undefined) return handled;
  }
  if (command.type === 'session.send') {
    const refused = await engine.sessionAccess(command.sessionId);
    if (refused !== undefined) return { ok: false, requestId: command.requestId, code: 'invalid_transition', message: refused, retryable: false, mayHaveSideEffects: false };
  }
  return sessions.execute(command);
}

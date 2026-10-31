// File locks of same-folder mode (R-07, SP-06), as the views show them. They live only in the main
// process's memory: never stored, and every lock is gone after a restart.
import { z } from 'zod';
import { PayloadHash, PermissionRequestId, SessionId, Timestamp, TurnId } from './common';
import { addRuleIssue, ruleIssue } from './rules';

/** A session waiting for a locked file, and how it waits. */
export const LockWaiter = z
  .strictObject({
    sessionId: SessionId,
    /**
     * `codex-approval`: the GUI holds Codex's file-change approval until the lock is free (SP-06 W3);
     * `wait_for_file`: a Claude agent told by its hook who holds the lock called the MCP tool.
     */
    via: z.enum(['codex-approval', 'wait_for_file']),
    permissionRequestId: PermissionRequestId.optional(),
    since: Timestamp,
    /** Past it the wait ends: refused and escalated to root (R-07). */
    deadline: Timestamp,
  })
  .refine((w) => (w.via === 'codex-approval') === (w.permissionRequestId !== undefined), ruleIssue('lock.approval-needs-request'));
export type LockWaiter = z.infer<typeof LockWaiter>;

/**
 * One locked file (path granularity, R-07). Held from the holder's first write until its turn ended **and**
 * its background commands ended; released by the GUI when the holder stops or its runtime exits.
 */
export const FileLock = z
  .strictObject({
    /** Absolute, resolved and case-folded as the GUI compares paths on Windows. */
    path: z.string().min(1),
    holderSessionId: SessionId,
    holderTurnId: TurnId.optional(),
    acquiredAt: Timestamp,
    /** The holder's turn ended but its background commands still run, so the lock stays (SP-06 W3). */
    waitingForBackground: z.boolean().default(false),
    /** The holder's writes started and not yet ended; while any is, the holder's own changes are expected. */
    writing: z.number().int().nonnegative().default(0),
    /**
     * What the holder's last ended write left, to spot a later write by someone else (SP-06 W5): the file's
     * hash, or that it deleted the file. Absent until a write of the holder applied something.
     */
    lastWrite: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('written'), hash: PayloadHash }), z.strictObject({ kind: z.literal('deleted') })]).optional(),
    waiters: z.array(LockWaiter),
  })
  .superRefine((l, ctx) => {
    const sessions = l.waiters.map((w) => w.sessionId);
    if (sessions.includes(l.holderSessionId) || new Set(sessions).size !== sessions.length) addRuleIssue(ctx, 'lock.waiters-distinct', ['waiters']);
  });
export type FileLock = z.infer<typeof FileLock>;

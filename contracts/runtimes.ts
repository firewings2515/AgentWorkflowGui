// What the GUI found of each runtime on this computer (C-33, T045): where its executable is, its version
// against the one this app needs, whether it is signed in and how, and how many models it listed. The GUI
// uses the user's own installed Claude Code and Codex; it never ships, installs, signs in or reads
// credentials. `auth` is only a category the runtime's own status command reports, never an account or a key.
import { z } from 'zod';
import { Runtime, Timestamp } from './common';
import { addRuleIssue } from './rules';

/**
 * Whether the runtime can be used. `available`: found, new enough and signed in (or the sign-in could not be
 * told: `auth` `unknown`). `not-installed`: no executable found. `too-old`: older than `requiredVersion`.
 * `signed-out`: found and new enough, but its status command says nobody is signed in. `failed`: found, but
 * its version could not be read (never guessed).
 */
export const RuntimeState = z.enum(['available', 'not-installed', 'too-old', 'signed-out', 'failed']);
export type RuntimeState = z.infer<typeof RuntimeState>;

/** Where the executable was found, in the order it is looked for. `sdk-bundled`: development builds only. */
export const RuntimeSource = z.enum(['env', 'path', 'known-location', 'sdk-bundled']);
export type RuntimeSource = z.infer<typeof RuntimeSource>;

/** How the runtime signs in, as its own status command reports it. Usage limits apply to `subscription` only. */
export const RuntimeAuth = z.enum(['subscription', 'api-key', 'signed-out', 'unknown']);
export type RuntimeAuth = z.infer<typeof RuntimeAuth>;

export const RuntimeStatus = z
  .strictObject({
    runtime: Runtime,
    state: RuntimeState,
    /** The executable's full path; absent when none was found. */
    executable: z.string().min(1).optional(),
    source: RuntimeSource.optional(),
    /** As `--version` printed it, reduced to the version number. */
    version: z.string().min(1).optional(),
    /** The oldest version this app works with. */
    requiredVersion: z.string().min(1),
    auth: RuntimeAuth,
    /** Models it listed at the last detection (0 when not available). */
    modelCount: z.number().int().nonnegative(),
    checkedAt: Timestamp,
    /** A fixed explanation for the user (what to install or update, how to sign in); never output of the runtime. */
    detail: z.string().max(500).optional(),
  })
  .superRefine((s, ctx) => {
    if ((s.state === 'not-installed') !== (s.executable === undefined)) addRuleIssue(ctx, 'runtime-status.executable');
    if ((s.executable === undefined) !== (s.source === undefined)) addRuleIssue(ctx, 'runtime-status.source');
    if (['available', 'too-old', 'signed-out'].includes(s.state) && s.version === undefined) addRuleIssue(ctx, 'runtime-status.version');
    if (s.state === 'signed-out' && s.auth !== 'signed-out') addRuleIssue(ctx, 'runtime-status.signed-out');
    if (s.state === 'available' && s.auth === 'signed-out') addRuleIssue(ctx, 'runtime-status.available-signed-in');
    if (s.state !== 'available' && s.modelCount > 0) addRuleIssue(ctx, 'runtime-status.models-only-available');
  });
export type RuntimeStatus = z.infer<typeof RuntimeStatus>;

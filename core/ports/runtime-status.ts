// Finding the user's own runtimes (C-33, T045): the main process implements it, the session service asks it
// whether a runtime can be used. Nothing here installs, updates or signs in anything, or reads credentials.
import type { Runtime, RuntimeStatus, Timestamp } from '../../contracts';

/**
 * Looks for a runtime's executable (the environment override, then PATH, then known install locations), reads
 * its version and asks its own status command whether it is signed in. A detection never throws: what could not
 * be told is in the status (`failed`, `auth` `unknown`).
 */
export interface RuntimeLocator {
  detect(runtime: Runtime, at: Timestamp): Promise<RuntimeStatus>;
  /** The status found last, or undefined before the first detection. */
  current(runtime: Runtime): RuntimeStatus | undefined;
}

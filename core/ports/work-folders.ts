// Work folders made by the GUI (T048, U-02, Q-1, Q-2): a session or a workflow run started without a folder gets a
// new `YYYY-MM-DD-NNN` folder in the default location. The claim (which folder belongs to which session) is
// written before the folder is made, so sending the same create again, also after a restart, never makes a second
// one; a claim whose session never came is cleaned up at the next start.
import type { InstanceId, SessionId, Timestamp } from '../../contracts';

/** One folder the GUI chose for a session (an ordinary session, or the root session of a run). */
export interface WorkFolderClaim {
  sessionId: SessionId;
  /** Set when the folder is the work folder of this run (`workflow.start`). */
  instanceId?: InstanceId;
  /** The folder as made: the location joined with `<day>-<seq>`, as written (not its real path). */
  path: string;
  /** Local date of the name, `YYYY-MM-DD`. */
  day: string;
  /** The number in the name (001, 002, ... 999, 1000, ...). */
  seq: number;
  createdAt: Timestamp;
}

/** Each method is one transaction. */
export interface WorkFolderClaimRepository {
  get(sessionId: SessionId): Promise<WorkFolderClaim | undefined>;
  list(): Promise<WorkFolderClaim[]>;
  /** The claims of folders named for `day`, wherever they are. */
  listDay(day: string): Promise<WorkFolderClaim[]>;
  /** `taken` when the session already has a claim or the path (compared without case) is claimed by another. */
  claim(claim: WorkFolderClaim): Promise<'claimed' | 'taken'>;
  remove(sessionId: SessionId): Promise<void>;
}

/** The file system as making work folders needs it (main: node:fs). Paths are absolute; failures throw. */
export interface WorkFolderFs {
  /** Names of the entries directly in `folder`; empty when it does not exist. */
  list(folder: string): string[];
  /** Makes `folder` and whatever of its parents is missing (the location the user chose). */
  makeTree(folder: string): void;
  /** Makes one folder, not its parents: `exists` when something is already there (another session's, the user's). */
  make(folder: string): 'created' | 'exists';
  /** Removes `folder` only when it is an empty folder; never anything in it. */
  removeEmpty(folder: string): 'removed' | 'not-empty' | 'missing';
}

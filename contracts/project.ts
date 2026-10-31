// Project settings (R-06, O-06): one setup script and test command per project folder; a workflow may
// override them (`WorkflowTemplate.setupOverride`).
import { z } from 'zod';
import { ProjectId, Revision, SchemaVersion, Timestamp } from './common';

/**
 * Commands the GUI runs itself in a worktree (never through an agent): `setup` once a task worktree is made
 * (install dependencies, assign ports), `test` in the integration worktree before the target branch moves
 * (CR-3). Run with the shell named, the worktree as cwd.
 */
export const ProjectCommands = z.strictObject({
  setup: z.string().min(1).optional(),
  test: z.string().min(1).optional(),
  shell: z.enum(['powershell', 'cmd']).optional(),
});
export type ProjectCommands = z.infer<typeof ProjectCommands>;

/**
 * A git repository the user works in. `rootPath` is the repository's top folder as resolved on this
 * computer, so a workflow started anywhere inside it finds its project. Saved like Agents: compare-and-set
 * on `revision`, only the current revision kept (C-11).
 */
export const ProjectSettings = z.strictObject({
  schemaVersion: SchemaVersion,
  id: ProjectId,
  revision: Revision,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  /** The branch task merges go to unless a run names another (R-06). */
  defaultBranch: z.string().min(1).optional(),
  commands: ProjectCommands.default({}),
  updatedAt: Timestamp,
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

// `project.save` (T028 C-17, r1 P2-2): compare-and-set like `workflow.save`, and the saved project is pushed
// so every view shows the stored revision.
import { describe, expect, it } from 'vitest';
import { ProjectSettings } from '../../contracts';
import { fixtureSnapshotInput } from '../../contracts/fixtures/snapshot';
import { rid, world } from './testing/harness';

describe('project.save', () => {
  it('saves with compare-and-set and publishes the stored project', async () => {
    const w = await world();
    const project = ProjectSettings.parse(fixtureSnapshotInput.projects?.[0]);
    expect(await w.service.execute({ type: 'project.save', requestId: rid(), project, expectedRevision: null })).toMatchObject({ ok: true, revision: 0 });
    expect(await w.service.execute({ type: 'project.save', requestId: rid(), project, expectedRevision: null })).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(await w.service.execute({ type: 'project.save', requestId: rid(), project: { ...project, name: 'renamed' }, expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    const pushed = w.events.flatMap((e) => (e.type === 'project.updated' ? [[e.project.name, e.project.revision]] : []));
    expect(pushed).toEqual([['demo', 0], ['renamed', 1]]);
  });
});

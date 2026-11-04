// T050 workflow.rename on the memory ports (the same cases on SQLite: app/main/workflow-t050.test.ts), plus what only
// the memory run shows.
import { describe, expect, it } from 'vitest';
import { instanceOf, rid, settle, started, world } from './testing/harness';
import { t050WorkflowCases } from './testing/t050-cases';

t050WorkflowCases('memory', (workflow) => world(workflow));

describe('T050 workflow.rename without the task pipeline', () => {
  it('renames a run when the engine takes no pipeline commands', async () => {
    const w = await world();
    expect(await started(w)).toMatchObject({ ok: true });
    await settle();
    // As an engine built without a pipeline: workflow.complete is unsupported, renaming is not.
    Reflect.set(w.engine, 'pipeline', undefined);
    const run = await instanceOf(w);
    expect(await w.run({ type: 'workflow.complete', requestId: rid(), instanceId: run.id, expectedRevision: run.revision })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await w.run({ type: 'workflow.rename', requestId: rid(), instanceId: run.id, expectedRevision: run.revision, title: 'Plain' })).toMatchObject({ ok: true });
    expect((await instanceOf(w)).title).toBe('Plain');
  });
});

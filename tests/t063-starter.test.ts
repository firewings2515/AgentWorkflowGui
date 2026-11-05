// T063: the starter set the core makes passes the editor's own checks (workflowIssues), and it is exactly the renderer's
// fixture (app/renderer/src/starter-set.fixture.ts), which the editor tests open (WorkflowEditor.t063.test.tsx). Here,
// not in app/renderer, because the renderer may not load the core.
import { describe, expect, it } from 'vitest';
import { ModelOption } from '../contracts';
import { starterSet } from '../core/workflow/starter';
import { STARTER_FIXTURE_TIME, starterFixture } from '../app/renderer/src/starter-set.fixture';
import { workflowIssues } from '../app/renderer/src/workflow-validation';

const models = [
  ModelOption.parse({ runtime: 'claude', model: 'opus', displayName: 'Opus', efforts: ['high'], isDefault: true, defaultEffort: 'high' }),
  ModelOption.parse({ runtime: 'codex', model: 'gpt-x', displayName: 'GPT X', efforts: ['medium', 'high'], isDefault: true }),
];

describe('T063 the starter set and the editor', () => {
  it('has no validation issue, with the fallback models or listed ones', () => {
    expect(workflowIssues(starterSet([], STARTER_FIXTURE_TIME).workflow)).toEqual([]);
    expect(workflowIssues(starterSet(models, STARTER_FIXTURE_TIME).workflow)).toEqual([]);
  });

  it('is the renderer fixture the editor tests open', () => {
    expect(starterSet([], STARTER_FIXTURE_TIME)).toEqual(starterFixture);
  });
});

// T070: the built-in templates the core makes pass the editor's own checks (workflowIssues), with the fallback models or
// listed ones; the renderer's template library shows each one's own name and description and says exactly for the
// worktree templates that they need a git repository; the TDD fixture the editor tests open is exactly what the core
// makes. Here, not in app/renderer, because the renderer may not load the core.
import { describe, expect, it } from 'vitest';
import { BuiltinTemplateKey, ModelOption } from '../contracts';
import { BUILTIN_KEYS, builtinSet } from '../core/workflow/builtin-templates';
import { BUILTIN_FIXTURE_TIME, tddFixture } from '../app/renderer/src/builtin-tdd.fixture';
import { TEMPLATE_LIBRARY } from '../app/renderer/src/template-library';
import { workflowIssues } from '../app/renderer/src/workflow-validation';

const models = [
  ModelOption.parse({ runtime: 'claude', model: 'opus', displayName: 'Opus', efforts: ['high'], isDefault: true, defaultEffort: 'high' }),
  ModelOption.parse({ runtime: 'codex', model: 'gpt-x', displayName: 'GPT X', efforts: ['medium', 'high'], isDefault: true }),
];

describe('T070 the built-in templates and the editor', () => {
  it.each(BUILTIN_KEYS)('%s has no validation issue, with the fallback models or listed ones', (key) => {
    expect(workflowIssues(builtinSet(key, [], BUILTIN_FIXTURE_TIME).workflow)).toEqual([]);
    expect(workflowIssues(builtinSet(key, models, BUILTIN_FIXTURE_TIME).workflow)).toEqual([]);
  });

  it('the library lists every template once, the starter first, under the core\'s IDs and names', () => {
    expect(TEMPLATE_LIBRARY.map((e) => e.key)).toEqual(BuiltinTemplateKey.options);
    for (const entry of TEMPLATE_LIBRARY) {
      const { workflow } = builtinSet(entry.key, [], BUILTIN_FIXTURE_TIME);
      expect(entry.workflowId).toBe(workflow.id);
      expect(entry.name).toBe(workflow.name);
      // A built-in template's summary is its own description (the starter's description is the one of 0.11).
      if (entry.key !== 'starter') expect(entry.summary).toBe(workflow.description);
      expect(entry.needsGit).toBe(workflow.isolation === 'worktree');
      expect(entry.summary).toMatch(entry.needsGit ? /需要 git repo/ : /不需要 git repo|建議用 git repo/);
    }
  });

  it('the TDD fixture the editor tests open is what the core makes', () => {
    expect(builtinSet('tdd', [], BUILTIN_FIXTURE_TIME)).toEqual(tddFixture);
  });
});

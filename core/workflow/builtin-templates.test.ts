// T070: the eight built-in templates of the template library (memory ports): each passes the contracts, has one root and
// its own Agents, follows the shapes of the 11-07 trial (with the plan's changes), names nothing of the trial's project,
// and is added alone, once, again after a delete, never over what is stored.
import { describe, expect, it } from 'vitest';
import {
  AgentDefinition,
  BUILTIN_AGENT_IDS,
  BUILTIN_WORKFLOW_IDS,
  BuiltinTemplateKey,
  ModelOption,
  STARTER_WORKFLOW_ID,
  WorkflowTemplate,
  type WritePolicy,
} from '../../contracts';
import { MemoryRepositories } from '../sessions/testing/memory-repositories';
import { BUILTIN_KEYS, BUILTIN_TEMPLATES, builtinNodeId, builtinSet, installBuiltin, type BuiltinKey } from './builtin-templates';
import { installStarter, STARTER_MARKER, starterModel, starterSet } from './starter';

const now = '2026-11-10T00:00:00.000Z';
const option = (o: Partial<ModelOption> & Pick<ModelOption, 'runtime' | 'model'>) => ModelOption.parse({ displayName: o.model, efforts: [], ...o });
const listed = [
  option({ runtime: 'claude', model: 'opus', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low' }),
  option({ runtime: 'codex', model: 'gpt-x', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'medium' }),
];

/** Every text of a template and its Agents: what the model and the user read. */
const textsOf = (key: BuiltinTemplateKey) => {
  const { agents, workflow } = builtinSet(key, [], now);
  return [
    workflow.name,
    workflow.description,
    ...workflow.nodes.flatMap((n) => [n.label, ...n.inputRules.map((r) => r.condition), ...n.outputRules.flatMap((r) => [r.condition, r.payload])]),
    ...agents.flatMap((a) => [a.name, a.description, a.instructions]),
  ];
};

/** The trial's project and the flag Codex added to get around its sandbox (T070: never in a built-in template). */
const BOUND = ['cart-sample', 'cart.js', 'removeItem', 'applyCoupon', 'node --test', 'src/', 'test/', 'cart', '--experimental-test-isolation', 'SPEC.md'];

/** The plan's table: [label, runtime or merge, write policy, concurrency] per node, in order. */
const SHAPES: Record<BuiltinKey, { rework: number; isolation: 'same-folder' | 'worktree'; nodes: [string, 'claude' | 'codex' | 'merge', WritePolicy, number][] }> = {
  'evaluator-optimizer': { rework: 2, isolation: 'same-folder', nodes: [['協調', 'claude', 'read-only', 1], ['修改者', 'codex', 'write', 1], ['評審', 'claude', 'exec-only', 1]] },
  tdd: { rework: 2, isolation: 'same-folder', nodes: [['協調', 'claude', 'read-only', 1], ['測試撰寫', 'claude', 'write', 1], ['實作', 'codex', 'write', 1], ['驗證', 'claude', 'exec-only', 1]] },
  'spec-parallel': { rework: 2, isolation: 'worktree', nodes: [['規格', 'claude', 'write', 1], ['實作', 'codex', 'write', 2], ['審查', 'claude', 'exec-only', 1], ['合併', 'merge', 'write', 1]] },
  'parallel-review': { rework: 1, isolation: 'same-folder', nodes: [['協調', 'claude', 'read-only', 1], ['正確性審查', 'claude', 'read-only', 1], ['健壯性審查', 'codex', 'read-only', 1], ['彙整', 'claude', 'read-only', 1]] },
  routing: { rework: 2, isolation: 'same-folder', nodes: [['分流', 'claude', 'read-only', 1], ['修 bug', 'codex', 'write', 1], ['新功能', 'claude', 'write', 1], ['審查', 'claude', 'exec-only', 1]] },
  'docs-review': { rework: 2, isolation: 'same-folder', nodes: [['協調', 'claude', 'read-only', 1], ['撰寫', 'claude', 'write', 1], ['審稿', 'codex', 'read-only', 1]] },
  'safe-refactor': { rework: 2, isolation: 'same-folder', nodes: [['協調', 'claude', 'read-only', 1], ['分析', 'claude', 'read-only', 1], ['重構', 'codex', 'write', 1], ['驗證', 'claude', 'exec-only', 1]] },
  'cross-review': {
    rework: 2,
    isolation: 'same-folder',
    nodes: [['協調', 'claude', 'read-only', 1], ['Claude 審查', 'claude', 'read-only', 1], ['Codex 審查', 'codex', 'read-only', 1], ['彙整修正', 'codex', 'write', 1], ['驗證', 'claude', 'exec-only', 1]],
  },
};

describe('T070 the built-in templates', () => {
  it('eight keys besides the starter, in the library order, with fixed IDs', () => {
    expect(BUILTIN_KEYS).toEqual(BuiltinTemplateKey.options.filter((k) => k !== 'starter'));
    expect(builtinSet('starter', [], now)).toEqual(starterSet([], now));
  });

  describe.each(BUILTIN_KEYS)('%s', (key) => {
    const { agents, workflow } = builtinSet(key, [], now);
    const agentNodes = workflow.nodes.filter((n) => n.kind === 'agent');

    it('passes the contracts; one root; revision 0 under its fixed ID', () => {
      expect(WorkflowTemplate.safeParse(workflow).success).toBe(true);
      for (const a of agents) expect(AgentDefinition.safeParse(a).success).toBe(true);
      expect(workflow).toMatchObject({ id: BUILTIN_WORKFLOW_IDS[key], revision: 0, updatedAt: now });
      expect(agentNodes.filter((n) => n.isRoot)).toHaveLength(1);
      expect(agentNodes.find((n) => n.isRoot)?.model.runtime).toBe('claude');
    });

    it('its Agents are its own set: every node\'s Agent is in it, and every Agent of it is used', () => {
      const ids = agents.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual(Object.values(BUILTIN_AGENT_IDS[key]).sort());
      expect([...new Set(agentNodes.map((n) => n.agentId))].sort()).toEqual(ids.sort());
    });

    it('nodes, policies, concurrency, rework limit and isolation as planned; models from starterModel', () => {
      const shape = SHAPES[key];
      expect(workflow.reworkLimit).toBe(shape.rework);
      expect(workflow.isolation).toBe(shape.isolation);
      expect(workflow.nodes.map((n) => [n.label, n.kind === 'merge' ? 'merge' : n.model.runtime, n.writePolicy, n.concurrency])).toEqual(shape.nodes);
      for (const n of agentNodes) expect(n.model).toEqual(starterModel(n.model.runtime, []));
      const withList = builtinSet(key, listed, now).workflow;
      for (const n of withList.nodes) if (n.kind === 'agent') expect(n.model).toEqual(starterModel(n.model.runtime, listed));
    });

    it('every node target has its edge and every edge is used by a rule; a tasks rule waits for the user (O-07)', () => {
      const used = workflow.nodes.flatMap((n) => n.outputRules.flatMap((r) => (r.target.kind === 'node' ? [`${n.id}->${r.target.nodeId}`] : [])));
      expect(new Set(used)).toEqual(new Set(workflow.edges.map((e) => `${e.source}->${e.target}`)));
      for (const n of workflow.nodes) for (const r of n.outputRules) expect(r.requiresUserConfirmation).toBe(r.target.kind === 'tasks');
      expect(workflow.nodes.every((n) => new Set(n.outputRules.map((r) => r.id)).size === n.outputRules.length)).toBe(true);
    });

    it('names nothing of the trial\'s project; every Agent name carries the template\'s prefix', () => {
      const texts = textsOf(key).join('\n');
      for (const word of BOUND) expect(texts).not.toContain(word);
      const prefix = agents[0]!.name.split('・')[0];
      expect(agents.every((a) => a.name.startsWith(`${prefix}・`))).toBe(true);
      expect(new Set(agents.map((a) => a.name)).size).toBe(agents.length);
    });

    it('every node that runs commands is told not to get around a refusal; every one that reports runs asks for the evidence', () => {
      for (const n of agentNodes) {
        const agent = agents.find((a) => a.id === n.agentId)!;
        if (n.writePolicy !== 'read-only') expect(agent.instructions).toContain('不要自己加旗標或改設定繞過');
        if (n.writePolicy === 'exec-only') expect(agent.instructions).toMatch(/輸出重點|不能只寫「通過」/);
      }
    });
  });

  it('nine library names, none twice, none the starter template\'s', () => {
    const names = BuiltinTemplateKey.options.map((k) => builtinSet(k, [], now).workflow.name);
    expect(new Set(names).size).toBe(9);
    expect(names[0]).toBe('規劃 → 實作 → 審查');
    const agentIds = BUILTIN_KEYS.flatMap((k) => Object.values(BUILTIN_AGENT_IDS[k]));
    expect(new Set(agentIds).size).toBe(agentIds.length);
  });

  it('the trial\'s lessons are in the instructions: the test command is the project\'s, the spec goes into the handoff, the tests are checked by hash', () => {
    const all = (key: BuiltinKey) => builtinSet(key, [], now).agents.map((a) => a.instructions).join('\n');
    expect(all('evaluator-optimizer')).toContain('package.json 的 scripts');
    expect(all('spec-parallel')).toContain('其他節點讀不到你的工作資料夾');
    expect(all('spec-parallel')).toContain('create_tasks');
    // r1 P2-2: the reviewer reads only the builder's handoff, so the builder passes the task's spec on, every time.
    const d = builtinSet('spec-parallel', [], now);
    const toReview = d.workflow.nodes.find((n) => n.id === builtinNodeId('spec-parallel', 'builder'))!.outputRules[0]!;
    expect(toReview.payload).toMatch(/^原樣轉交的 task 規格（驗收條件、介面、測試指令）/);
    expect(d.workflow.nodes.find((n) => n.id === builtinNodeId('spec-parallel', 'reviewer'))!.inputRules[0]!.condition).toContain('規格');
    expect(d.agents.find((a) => a.id === BUILTIN_AGENT_IDS['spec-parallel'].builder)!.instructions).toContain('原樣附上交接給你的這個 task 的規格（驗收條件、介面、測試指令）');
    expect(d.agents.find((a) => a.id === BUILTIN_AGENT_IDS['spec-parallel'].reviewer)!.instructions).toContain('交接沒有附上規格時，退回實作要它補上');
    // r1 P2-3: the reviewer stops files that do not belong (test outputs) before the merge: in the worktree and in the
    // task's own commits, without assuming a branch name; the builder removes or ignores them; the library says so.
    const reviewer = d.agents.find((a) => a.id === BUILTIN_AGENT_IDS['spec-parallel'].reviewer)!.instructions;
    expect(reviewer).toContain('`git status`');
    expect(reviewer).toMatch(/`git log --stat` 或 `git show --stat`/);
    expect(reviewer).toContain('只看這個 task 的 commit');
    expect(reviewer).toContain('不要假設 branch 名稱');
    expect(reviewer).toContain('有不該進來的檔案時不能交給合併：退回實作');
    expect(d.agents.find((a) => a.id === BUILTIN_AGENT_IDS['spec-parallel'].builder)!.instructions).toContain('刪掉或加進 ignore');
    const rules = d.workflow.nodes.find((n) => n.id === builtinNodeId('spec-parallel', 'reviewer'))!.outputRules;
    expect(rules.find((r) => r.id === 'reviewer-merge')!.condition).toContain('沒有不該進來的檔案');
    expect(rules.find((r) => r.id === 'reviewer-rework')!.condition).toContain('不該進來的檔案');
    expect(d.workflow.description).toContain('審查會擋下測試產物這類不該進來的檔案');
    expect(all('tdd')).toContain('git hash-object');
    expect(all('tdd')).toContain('不是 git 專案');
    expect(builtinSet('cross-review', [], now).workflow.nodes.filter((n) => n.kind === 'agent' && n.agentId === BUILTIN_AGENT_IDS['cross-review'].reviewer)).toHaveLength(2);
  });

  it('the joins wait for every upstream; D keeps its merge node and the worktrees', () => {
    const join = (key: BuiltinKey, role: string) => builtinSet(key, [], now).workflow.nodes.find((n) => n.id === builtinNodeId(key, role));
    expect(join('parallel-review', 'merger')?.inputRules.every((r) => r.waitForAllUpstream)).toBe(true);
    expect(join('cross-review', 'fixer')?.inputRules.every((r) => r.waitForAllUpstream)).toBe(true);
    expect(join('spec-parallel', 'merge')?.kind).toBe('merge');
    expect(BUILTIN_TEMPLATES['spec-parallel'].description).toContain('需要 git repo');
  });
});

describe('T070 installBuiltin (memory)', () => {
  const add = (repos: MemoryRepositories, key: BuiltinTemplateKey = 'tdd', models: ModelOption[] = []) => installBuiltin(repos, { key, models, now });
  const tddIds = Object.values(BUILTIN_AGENT_IDS.tdd);

  it('adds only that template and its own Agents; no mark', async () => {
    const repos = new MemoryRepositories();
    const result = await add(repos);
    expect(result.added.sort()).toEqual([...tddIds, BUILTIN_WORKFLOW_IDS.tdd].sort());
    expect(result.workflow).toMatchObject({ id: BUILTIN_WORKFLOW_IDS.tdd, revision: 0 });
    expect((await repos.workflows.list()).map((w) => w.id)).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
    expect((await repos.agents.list()).map((a) => a.id).sort()).toEqual([...tddIds].sort());
    expect(await repos.markers.has(STARTER_MARKER)).toBe(false);
  });

  it('a repeat adds nothing and keeps one of each', async () => {
    const repos = new MemoryRepositories();
    await add(repos);
    const again = await add(repos);
    expect(again.added).toEqual([]);
    expect(again.workflow).toMatchObject({ id: BUILTIN_WORKFLOW_IDS.tdd, revision: 0 });
    expect(await repos.workflows.list()).toHaveLength(1);
    expect(await repos.agents.list()).toHaveLength(4);
  });

  it('deleted by the user, it is added again; the Agents still there are kept, edited ones too', async () => {
    const repos = new MemoryRepositories();
    await add(repos);
    const verifier = (await repos.agents.get(BUILTIN_AGENT_IDS.tdd.verifier))!;
    const edited = await repos.agents.save({ ...verifier, instructions: '我自己改過的指示' }, 0);
    expect(edited.status).toBe('saved');
    expect(await repos.workflows.delete(BUILTIN_WORKFLOW_IDS.tdd, 0)).toBe('deleted');
    const again = await add(repos);
    expect(again.added).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
    expect((await repos.agents.get(BUILTIN_AGENT_IDS.tdd.verifier))).toMatchObject({ instructions: '我自己改過的指示', revision: 1 });
    // Both deleted: all of it again.
    expect(await repos.workflows.delete(BUILTIN_WORKFLOW_IDS.tdd, 0)).toBe('deleted');
    for (const id of tddIds) {
      const a = (await repos.agents.get(id))!;
      expect(await repos.agents.delete(id, a.revision)).toBe('deleted');
    }
    expect((await add(repos)).added).toHaveLength(5);
  });

  it('an edited template under its ID is not overwritten', async () => {
    const repos = new MemoryRepositories();
    await add(repos);
    const saved = (await repos.workflows.get(BUILTIN_WORKFLOW_IDS.tdd))!;
    await repos.workflows.save({ ...saved, name: '我的 TDD', reworkLimit: 5 }, 0);
    expect((await add(repos)).workflow).toMatchObject({ name: '我的 TDD', reworkLimit: 5, revision: 1 });
  });

  it('two templates side by side; the starter key is the starter set with its mark', async () => {
    const repos = new MemoryRepositories();
    await add(repos, 'cross-review');
    await add(repos, 'spec-parallel');
    expect((await repos.workflows.list()).map((w) => w.id).sort()).toEqual([BUILTIN_WORKFLOW_IDS['cross-review'], BUILTIN_WORKFLOW_IDS['spec-parallel']].sort());
    expect(await repos.agents.list()).toHaveLength(7);
    expect((await add(repos, 'starter')).added).toHaveLength(4);
    expect(await repos.workflows.get(STARTER_WORKFLOW_ID)).toBeDefined();
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
  });

  it('r1 P2-4: a write that fails after two of the Agents were stored leaves none of it; the next add writes all of it', async () => {
    const repos = new MemoryRepositories();
    // The third Agent's write fails: the first two are already in the store when it does.
    const records = repos.agents.records;
    const set = records.set.bind(records);
    let writes = 0;
    records.set = (id, record) => {
      if (++writes === 3) throw new Error('injected:third-agent');
      return set(id, record);
    };
    await expect(add(repos)).rejects.toThrow('injected:third-agent');
    expect(writes).toBe(3);
    expect(await repos.agents.list()).toEqual([]);
    expect(await repos.workflows.list()).toEqual([]);
    records.set = set;
    expect((await add(repos)).added).toHaveLength(5);
  });

  it('uses the models listed now', async () => {
    const repos = new MemoryRepositories();
    await add(repos, 'tdd', listed);
    const template = (await repos.workflows.get(BUILTIN_WORKFLOW_IDS.tdd))!;
    expect(template.nodes.map((n) => (n.kind === 'agent' ? n.model.model : 'merge'))).toEqual(['opus', 'opus', 'gpt-x', 'opus']);
  });

  it('a first start still adds only the starter set; a library template counts as an install in use', async () => {
    const empty = new MemoryRepositories();
    expect((await installStarter(empty, { models: [], now, mode: 'first-start' })).added).toHaveLength(4);
    expect((await empty.workflows.list()).map((w) => w.id)).toEqual([STARTER_WORKFLOW_ID]);
    const used = new MemoryRepositories();
    await add(used);
    expect(await installStarter(used, { models: [], now, mode: 'first-start' })).toMatchObject({ added: [], skipped: 'in-use' });
    expect((await used.workflows.list()).map((w) => w.id)).toEqual([BUILTIN_WORKFLOW_IDS.tdd]);
  });
});

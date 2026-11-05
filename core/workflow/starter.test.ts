// T063: the starter set's contents and models, and when a first start adds it (memory ports).
import { describe, expect, it } from 'vitest';
import { AgentDefinition, AgentId, ModelOption, STARTER_AGENT_IDS, STARTER_WORKFLOW_ID, WorkflowTemplate } from '../../contracts';
import { MemoryRepositories } from '../sessions/testing/memory-repositories';
import { installStarter, STARTER_MARKER, starterModel, starterSet } from './starter';

const now = '2026-11-05T12:00:00.000Z';
const option = (o: Partial<ModelOption> & Pick<ModelOption, 'runtime' | 'model'>) => ModelOption.parse({ displayName: o.model, efforts: [], ...o });

describe('starterSet', () => {
  const { agents, workflow } = starterSet([], now);

  it('three Agents with short Chinese instructions, under the fixed IDs; the template passes the contract', () => {
    expect(agents.map((a) => [a.id, a.name])).toEqual([[STARTER_AGENT_IDS.plan, '規劃'], [STARTER_AGENT_IDS.implement, '實作'], [STARTER_AGENT_IDS.review, '審查']]);
    for (const a of agents) {
      expect(AgentDefinition.safeParse(a).success).toBe(true);
      expect(a.instructions.length).toBeLessThan(400);
    }
    expect(WorkflowTemplate.safeParse(workflow).success).toBe(true);
    expect(workflow).toMatchObject({ id: STARTER_WORKFLOW_ID, name: '規劃 → 實作 → 審查', isolation: 'same-folder', revision: 0 });
  });

  it('root is 規劃 on Claude, 實作 on Codex, 審查 on Claude and read-only', () => {
    const [plan, implement, review] = workflow.nodes;
    expect(plan).toMatchObject({ kind: 'agent', label: '規劃', agentId: STARTER_AGENT_IDS.plan, isRoot: true, model: { runtime: 'claude' } });
    expect(implement).toMatchObject({ kind: 'agent', label: '實作', agentId: STARTER_AGENT_IDS.implement, isRoot: false, model: { runtime: 'codex' } });
    expect(review).toMatchObject({ kind: 'agent', label: '審查', agentId: STARTER_AGENT_IDS.review, isRoot: false, writePolicy: 'read-only', model: { runtime: 'claude' } });
  });

  it('three edges, each used by one output rule; root\'s task list waits for the user (O-07)', () => {
    const [plan, implement, review] = workflow.nodes;
    expect(workflow.edges).toEqual([{ source: plan!.id, target: implement!.id }, { source: implement!.id, target: review!.id }, { source: review!.id, target: plan!.id }]);
    const used = workflow.nodes.flatMap((n) => n.outputRules.flatMap((r) => (r.target.kind === 'node' ? [{ source: n.id, target: r.target.nodeId }] : [])));
    expect(used).toEqual(workflow.edges);
    const tasks = plan!.outputRules.filter((r) => r.target.kind === 'tasks');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.requiresUserConfirmation).toBe(true);
    expect(workflow.nodes.flatMap((n) => n.outputRules).filter((r) => r.target.kind !== 'tasks').every((r) => !r.requiresUserConfirmation)).toBe(true);
  });
});

describe('starterModel', () => {
  it('before any list: Claude sonnet, Codex gpt-6.1-sol on high', () => {
    expect(starterModel('claude', [])).toEqual({ runtime: 'claude', model: 'sonnet' });
    expect(starterModel('codex', [])).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it('the runtime\'s default: Codex on high only when that model offers it; Claude with its default effort', () => {
    const models = [
      option({ runtime: 'claude', model: 'opus', isDefault: true, efforts: ['low', 'high'], defaultEffort: 'low' }),
      option({ runtime: 'codex', model: 'gpt-x', isDefault: true, efforts: ['medium', 'high'], defaultEffort: 'medium' }),
    ];
    expect(starterModel('claude', models)).toEqual({ runtime: 'claude', model: 'opus', effort: 'low' });
    expect(starterModel('codex', models)).toEqual({ runtime: 'codex', model: 'gpt-x', effort: 'high' });
    expect(starterModel('codex', [option({ runtime: 'codex', model: 'gpt-y', isDefault: true, efforts: ['low'] })])).toEqual({ runtime: 'codex', model: 'gpt-y' });
  });

  it('a hidden default is not used; a listed fallback takes high only when offered', () => {
    expect(starterModel('codex', [option({ runtime: 'codex', model: 'gpt-h', isDefault: true, hidden: true, efforts: ['high'] })])).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(starterModel('codex', [option({ runtime: 'codex', model: 'gpt-6.1-sol', efforts: ['low'] })])).toEqual({ runtime: 'codex', model: 'gpt-6.1-sol' });
    expect(starterModel('claude', [option({ runtime: 'codex', model: 'gpt-x', isDefault: true })])).toEqual({ runtime: 'claude', model: 'sonnet' });
  });
});

describe('installStarter at a first start', () => {
  const first = (repos: MemoryRepositories) => installStarter(repos, { models: [], now, mode: 'first-start' });

  it('adds it into an empty install, then sets the mark; the next start adds nothing', async () => {
    const repos = new MemoryRepositories();
    expect((await first(repos)).added).toHaveLength(4);
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
    expect(await first(repos)).toMatchObject({ added: [], skipped: 'marked' });
  });

  it('deleted by the user, it is not added again at the next start', async () => {
    const repos = new MemoryRepositories();
    await first(repos);
    expect(await repos.workflows.delete(STARTER_WORKFLOW_ID, 0)).toBe('deleted');
    expect(await first(repos)).toMatchObject({ added: [], skipped: 'marked' });
    expect(await repos.workflows.get(STARTER_WORKFLOW_ID)).toBeUndefined();
  });

  it('an install in use (an Agent or a template of the user) gets only the mark', async () => {
    const repos = new MemoryRepositories();
    const mine = { ...starterSet([], now).agents[0]!, id: AgentId.parse('my-agent'), name: '我的 Agent' };
    await repos.agents.save(mine, null);
    expect(await first(repos)).toMatchObject({ added: [], skipped: 'in-use' });
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
    expect(await repos.workflows.list()).toEqual([]);
    const other = new MemoryRepositories();
    await other.workflows.save({ ...starterSet([], now).workflow, id: 'my-flow' as typeof STARTER_WORKFLOW_ID }, null);
    expect(await first(other)).toMatchObject({ skipped: 'in-use' });
    expect(await other.agents.list()).toEqual([]);
  });

  it('a start that stopped half way (only some starter Agents stored, no mark) finishes it next time', async () => {
    const repos = new MemoryRepositories();
    await repos.agents.save(starterSet([], now).agents[0]!, null);
    const result = await first(repos);
    expect(result.added).toEqual([STARTER_AGENT_IDS.implement, STARTER_AGENT_IDS.review, STARTER_WORKFLOW_ID]);
    expect(await repos.markers.has(STARTER_MARKER)).toBe(true);
  });

  it('uses the models listed now', async () => {
    const repos = new MemoryRepositories();
    await installStarter(repos, { models: [option({ runtime: 'codex', model: 'gpt-z', isDefault: true, efforts: ['high'] })], now, mode: 'first-start' });
    const template = (await repos.workflows.get(STARTER_WORKFLOW_ID))!;
    expect(template.nodes[1]).toMatchObject({ model: { runtime: 'codex', model: 'gpt-z', effort: 'high' } });
  });
});

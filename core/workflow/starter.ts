// The starter set (T063): three Agents and the template 「規劃 → 實作 → 審查」, under the fixed IDs of contracts/starter.ts.
// A first start adds it once (`installStarter` with mode `first-start`, behind the `starter-offered` mark); the user adds it
// again with `workflow.addStarter`. Everything goes through the repositories' own checks (the contracts' schemas).
import {
  AgentDefinition,
  CONTRACTS_VERSION,
  NodeId,
  STARTER_AGENT_IDS,
  STARTER_WORKFLOW_ID,
  WorkflowTemplate,
  type ModelOption,
  type ModelSelection,
  type Runtime,
  type Timestamp,
} from '../../contracts';
import type { AppRepositories } from '../ports';

/** The mark of `MarkerRepository` saying the starter set was added once, or was not needed (an install in use). */
export const STARTER_MARKER = 'starter-offered';

/** The models used before the runtime listed any (or listed no default). Only names this project has checked. */
export const STARTER_FALLBACK_MODELS: Readonly<Record<Runtime, ModelSelection>> = {
  claude: { runtime: 'claude', model: 'sonnet' },
  codex: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
};

/**
 * The model of a starter node on `runtime`: the runtime's own default (not hidden), else the fallback. Codex always asks
 * for `high` when that model offers it (or, not listed yet, as the fallback); Claude takes the model's default effort.
 */
export const starterModel = (runtime: Runtime, models: readonly ModelOption[]): ModelSelection => {
  const listed = models.filter((m) => m.runtime === runtime);
  const chosen = listed.find((m) => !m.hidden && m.isDefault);
  if (chosen === undefined) {
    const fallback = STARTER_FALLBACK_MODELS[runtime];
    const option = listed.find((m) => m.model === fallback.model);
    if (option === undefined || runtime !== 'codex') return { ...fallback };
    return { runtime, model: fallback.model, ...(option.efforts.includes('high') && { effort: 'high' }) };
  }
  if (runtime === 'codex') return { runtime, model: chosen.model, ...(chosen.efforts.includes('high') && { effort: 'high' }) };
  return { runtime, model: chosen.model, ...(chosen.defaultEffort !== undefined && { effort: chosen.defaultEffort }) };
};

const NODE = { plan: NodeId.parse('starter-node-plan'), implement: NodeId.parse('starter-node-implement'), review: NodeId.parse('starter-node-review') };

const INSTRUCTIONS = {
  plan: [
    '你是規劃者。先弄清楚使用者要的結果和限制，有不清楚的地方先問。',
    '把工作拆成小而獨立的 task：每個 task 寫清楚要改的範圍、完成條件，以及依賴哪些 task。',
    'task 清單先交給使用者確認，確認後再把 task 交給實作。',
    '收到審查回報時，判斷要返工還是完成：需要返工就把問題整理成具體的修改項目交回實作；全部通過就向使用者總結結果。',
    '你不直接修改程式碼。',
  ],
  implement: [
    '你是實作者。只做交給你的 task，不擴大範圍。',
    '動手前先讀相關程式碼，照專案既有的寫法修改。改完執行相關的測試或檢查。',
    '完成後交給審查，說明改了哪些檔案、怎麼做、測試結果，以及沒做完或不確定的地方。',
    '遇到需求不清楚或做不到時，不要猜，說明原因交回規劃。',
  ],
  review: [
    '你是審查者。檢查實作是否符合 task 的完成條件，找出錯誤、遺漏和風險。',
    '只讀不改：不修改任何檔案。',
    '回報給規劃：先寫結論（通過或需要修改），再逐條列出問題，附上檔案位置和建議的改法。',
    '沒有發現問題時直接說通過，不要硬找問題。',
  ],
};

/** The three Agents and the template, made with the models listed now; parsed with the contracts' schemas. */
export const starterSet = (models: readonly ModelOption[], now: Timestamp): { agents: AgentDefinition[]; workflow: WorkflowTemplate } => {
  const agent = (key: keyof typeof STARTER_AGENT_IDS, name: string, description: string) =>
    AgentDefinition.parse({ schemaVersion: CONTRACTS_VERSION, id: STARTER_AGENT_IDS[key], revision: 0, name, description, instructions: INSTRUCTIONS[key].join('\n'), updatedAt: now });
  const agents = [agent('plan', '規劃', '拆解工作、建立 task'), agent('implement', '實作', '照 task 修改程式'), agent('review', '審查', '檢查實作，回報問題')];
  const claude = starterModel('claude', models);
  const codex = starterModel('codex', models);
  const workflow = WorkflowTemplate.parse({
    schemaVersion: CONTRACTS_VERSION,
    id: STARTER_WORKFLOW_ID,
    revision: 0,
    name: '規劃 → 實作 → 審查',
    description: '規劃拆解 task，實作照 task 修改，審查檢查後回報規劃。',
    reworkLimit: 2,
    isolation: 'same-folder',
    nodes: [
      {
        kind: 'agent', id: NODE.plan, label: '規劃', agentId: STARTER_AGENT_IDS.plan, model: claude, isRoot: true,
        writePolicy: 'write', concurrency: 1, inputRules: [], position: { x: 0, y: 120 },
        outputRules: [
          // O-07: the task list of the built-in template waits for the user's confirmation.
          { id: 'plan-tasks', condition: '工作拆解完成，列出 task 清單時', payload: '每個 task 的標題、範圍、完成條件和依賴', target: { kind: 'tasks' }, requiresUserConfirmation: true },
          { id: 'plan-implement', condition: 'task 已確認，可以交給實作時（含返工）', payload: '這個 task 要做什麼、相關檔案、完成條件；返工時附上審查的問題', target: { kind: 'node', nodeId: NODE.implement }, requiresUserConfirmation: false },
        ],
      },
      {
        kind: 'agent', id: NODE.implement, label: '實作', agentId: STARTER_AGENT_IDS.implement, model: codex, isRoot: false,
        writePolicy: 'write', concurrency: 1, inputRules: [], position: { x: 230, y: 120 },
        outputRules: [
          { id: 'implement-review', condition: '實作完成、檢查跑過時', payload: '改了哪些檔案、做法摘要、測試或檢查結果、未完成的地方', target: { kind: 'node', nodeId: NODE.review }, requiresUserConfirmation: false },
        ],
      },
      {
        kind: 'agent', id: NODE.review, label: '審查', agentId: STARTER_AGENT_IDS.review, model: claude, isRoot: false,
        writePolicy: 'read-only', concurrency: 1, inputRules: [], position: { x: 460, y: 120 },
        outputRules: [
          { id: 'review-plan', condition: '審查完成時', payload: '結論（通過／需修改）、問題清單與位置、建議改法', target: { kind: 'node', nodeId: NODE.plan }, requiresUserConfirmation: false },
        ],
      },
    ],
    edges: [
      { source: NODE.plan, target: NODE.implement },
      { source: NODE.implement, target: NODE.review },
      { source: NODE.review, target: NODE.plan },
    ],
    updatedAt: now,
  });
  return { agents, workflow };
};

export interface StarterInstall {
  /** What was written now (IDs); empty when everything was there already or nothing was to be added. */
  added: string[];
  /** The starter template as stored, when it is there afterwards. */
  workflow?: WorkflowTemplate;
  /** Why nothing was added at a first start. */
  skipped?: 'marked' | 'in-use';
}

type StarterRepositories = Pick<AppRepositories, 'agents' | 'workflows' | 'markers' | 'seedDefinitions'>;

/**
 * Adds what of the starter set is missing and sets the mark, in one transaction (`seedDefinitions`): a failure leaves
 * none of it, and the next start adds all of it. `first-start`: only once (the mark), and never into an install in use: an Agent or a template that is not one of
 * the starter set's means the user has data, and only the mark is set. `user`: whenever asked. An Agent or a template
 * already stored under a starter ID is kept as it is, edited or not.
 */
export const installStarter = async (
  repos: StarterRepositories,
  options: { models: readonly ModelOption[]; now: Timestamp; mode: 'first-start' | 'user' },
): Promise<StarterInstall> => {
  const { models, now, mode } = options;
  if (mode === 'first-start') {
    if (await repos.markers.has(STARTER_MARKER)) return { added: [], skipped: 'marked' };
    const starterAgents = new Set<string>(Object.values(STARTER_AGENT_IDS));
    const inUse =
      (await repos.agents.list()).some((a) => !starterAgents.has(a.id)) || (await repos.workflows.list()).some((w) => w.id !== STARTER_WORKFLOW_ID);
    if (inUse) {
      await repos.markers.set(STARTER_MARKER, now);
      return { added: [], skipped: 'in-use' };
    }
  }
  const set = starterSet(models, now);
  // One transaction (T063 r1 P1): the Agents, the template and the mark are stored together or not at all.
  const added = await repos.seedDefinitions({ agents: set.agents, workflows: [set.workflow], mark: { name: STARTER_MARKER, at: now } });
  const workflow = await repos.workflows.get(set.workflow.id);
  return { added, ...(workflow !== undefined && { workflow }) };
};

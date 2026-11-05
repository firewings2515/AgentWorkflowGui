// @vitest-environment jsdom
// T063: adding, copying and deleting templates in the editor, the empty page, the starter button, a new template without
// any Agent, read-only, and 「開始 Workflow」's way to a new template.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION, ModelOption, STARTER_WORKFLOW_ID, Snapshot, WorkflowInstance, WorkflowTemplate } from '../../../contracts';
import type { AgentDefinition, CommandResult } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowProgress } from './WorkflowProgress';
import { WorkflowStart } from './WorkflowStart';
import { copyWorkflowDraft, createWorkflowDraft } from './workflow-editor-state';
import { starterFixture } from './starter-set.fixture';
import { createWorkflowRepository } from './workflow-repository';
import type { AddStarterCommand, WorkflowRepository } from './workflow-repository';

const template = fixtureSnapshot.workflows[0]!;
const agents = fixtureSnapshot.agents;
const models = fixtureSnapshot.modelOptions;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const toolbar = () => within(screen.getByRole('banner'));

interface HarnessProps {
  repository: WorkflowRepository; initialId?: string; agentList?: readonly AgentDefinition[]; readOnly?: boolean;
  instances?: readonly WorkflowInstance[]; onOpenAgents?: () => void; onSelected?: (id: string) => void; request?: number;
}
function Harness({ repository, initialId = template.id, agentList = agents, readOnly = false, instances = [], onOpenAgents, onSelected, request = 0 }: HarnessProps) {
  const [id, setId] = useState(initialId);
  return <WorkflowEditor repository={repository} agents={agentList} models={models} selectedId={id} visible readOnly={readOnly} instances={instances}
    newTemplateRequest={request} {...(onOpenAgents ? { onOpenAgents } : {})} onSelect={next => { onSelected?.(next); setId(next || 'unavailable'); }} />;
}
const runOf = (state: WorkflowInstance['state']): WorkflowInstance => WorkflowInstance.parse({
  ...fixtureSnapshot.instances[0]!, id: `run-${state}`, title: `執行 ${state}`, state, workflowId: template.id, workflowRevision: template.revision, template, tasks: [], rounds: [], mergeQueue: [], taskPlans: [],
  ...(state === 'completed' || state === 'cancelled' ? { endedAt: '2026-11-05T00:00:00.000Z' } : {}),
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  // jsdom has no modal dialogs; the dialog falls back to the open attribute.
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T063 draft helpers', () => {
  it('a new template: 未命名, same-folder, one root on the first Agent and the default model', () => {
    const draft = createWorkflowDraft(agents, models);
    expect(draft).toMatchObject({ schemaVersion: CONTRACTS_VERSION, name: '未命名 Workflow', isolation: 'same-folder', edges: [], revision: 0 });
    expect(draft.nodes).toHaveLength(1);
    const root = draft.nodes[0]!;
    const preferred = models.find(m => !m.hidden && m.isDefault)!;
    expect(root).toMatchObject({ kind: 'agent', isRoot: true, agentId: agents[0]!.id, model: { runtime: preferred.runtime, model: preferred.model } });
    expect(WorkflowTemplate.safeParse(draft).success).toBe(true);
    // No model listed yet: Claude sonnet, as the starter set.
    expect(createWorkflowDraft(agents, []).nodes[0]).toMatchObject({ model: { runtime: 'claude', model: 'sonnet' } });
  });

  it('a copy: new IDs everywhere, 「（副本）」, revision 0, edges and rule targets follow the new node IDs', () => {
    const copy = copyWorkflowDraft(template);
    expect(copy.id).not.toBe(template.id);
    expect(copy).toMatchObject({ name: `${template.name}（副本）`, revision: 0, isolation: template.isolation, reworkLimit: template.reworkLimit });
    const oldIds = new Set<string>(template.nodes.map(n => n.id));
    expect(copy.nodes.some(n => oldIds.has(n.id))).toBe(false);
    expect(copy.nodes.map(n => n.label)).toEqual(template.nodes.map(n => n.label));
    expect(copy.nodes.map(n => n.outputRules.length)).toEqual(template.nodes.map(n => n.outputRules.length));
    const index = (id: string, of: WorkflowTemplate) => of.nodes.findIndex(n => n.id === id);
    expect(copy.edges.map(e => [index(e.source, copy), index(e.target, copy)])).toEqual(template.edges.map(e => [index(e.source, template), index(e.target, template)]));
    expect(WorkflowTemplate.safeParse(copy).success).toBe(true);
    // The saved template itself is untouched.
    expect(template.nodes[0]!.id).toBe(fixtureSnapshot.workflows[0]!.nodes[0]!.id);
  });
});

describe('T063 new template', () => {
  it('the empty page offers it; the draft opens unsaved and is saved with expectedRevision null', async () => {
    const repository = createWorkflowRepository([]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} initialId="unavailable" />);
    expect(screen.getByRole('heading', { name: '還沒有 Workflow 範本' })).toBeTruthy();
    // No starter button without a core (the demo).
    expect(screen.queryByRole('button', { name: '加入起始範本' })).toBeNull();
    click('新增範本');
    expect(screen.getByRole('heading', { name: '未命名 Workflow' })).toBeTruthy();
    expect(screen.getByText('新範本 · 尚未儲存')).toBeTruthy();
    expect(screen.getByRole('option', { name: '未命名 Workflow · 未儲存' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: '圖形選取' })).getByRole('button', { name: 'Root · root' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '刪除範本' })).toBeNull();
    click('儲存 Workflow');
    expect(await screen.findByText(/已建立「未命名 Workflow」，revision 1/)).toBeTruthy();
    expect(save.mock.calls[0]![0]).toMatchObject({ type: 'workflow.save', expectedRevision: null, workflow: { name: '未命名 Workflow', isolation: 'same-folder' } });
    expect(repository.getSnapshot()).toHaveLength(1);
    expect(screen.getByText(/revision 1 · 已載入範本/)).toBeTruthy();
    expect(button('刪除範本')).toBeTruthy();
  });

  it('beside the template list too; it can be discarded, and nothing was saved', () => {
    const repository = createWorkflowRepository([template]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    fireEvent.click(toolbar().getByRole('button', { name: '新增範本' }));
    expect(screen.getByRole('heading', { name: '未命名 Workflow' })).toBeTruthy();
    click('捨棄新範本');
    expect(screen.getByRole('heading', { name: template.name })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /未儲存/ })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('without any Agent: still made; root needs an Agent, links to the Agent page, and saving is stopped', () => {
    const repository = createWorkflowRepository([]);
    const save = vi.spyOn(repository, 'save');
    const openAgents = vi.fn();
    render(<Harness repository={repository} initialId="unavailable" agentList={[]} onOpenAgents={openAgents} />);
    click('新增範本');
    expect(screen.getByText(/需要 Agent：還沒有任何 Agent/)).toBeTruthy();
    click('前往 Agent 頁');
    expect(openAgents).toHaveBeenCalledTimes(1);
    click('儲存 Workflow');
    expect(screen.getAllByText(/需要 Agent，請先新增 Agent 再選取。/).length).toBeGreaterThan(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('a new request (「開始 Workflow」) opens a new draft', () => {
    const repository = createWorkflowRepository([template]);
    const selected = vi.fn();
    const { rerender } = render(<Harness repository={repository} onSelected={selected} />);
    expect(screen.getByRole('heading', { name: template.name })).toBeTruthy();
    rerender(<Harness repository={repository} onSelected={selected} request={1} />);
    expect(screen.getByRole('heading', { name: '未命名 Workflow' })).toBeTruthy();
    rerender(<Harness repository={repository} onSelected={selected} request={1} />);
    expect(selected).toHaveBeenCalledTimes(1);
  });
});

describe('T063 copy', () => {
  it('copies the saved version (not the draft) into a new draft; it counts once saved', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    fireEvent.change(screen.getByRole('textbox', { name: '範本名稱' }), { target: { value: '草稿裡的名字' } });
    click('複製');
    expect(screen.getByRole('heading', { name: `${template.name}（副本）` })).toBeTruthy();
    expect(screen.getByText('新範本 · 尚未儲存')).toBeTruthy();
    expect(repository.getSnapshot()).toHaveLength(1);
    expect(screen.getByText(`連線（${template.edges.length}）`)).toBeTruthy();
    click('儲存 Workflow');
    expect(await screen.findByText(/已建立「.*（副本）」/)).toBeTruthy();
    const saved = repository.getSnapshot();
    expect(saved).toHaveLength(2);
    expect(saved[1]!.nodes.map(n => n.label)).toEqual(template.nodes.map(n => n.label));
    // The original's draft is kept as it was.
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow 範本' }), { target: { value: template.id } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '範本名稱' }).value).toBe('草稿裡的名字');
  });
});

describe('T063 delete', () => {
  it('asks first; cancel keeps it; confirming deletes it and moves to the next template', async () => {
    const other = WorkflowTemplate.parse({ ...template, id: 'wf-other', name: '另一個範本' });
    const repository = createWorkflowRepository([template, other]);
    const remove = vi.spyOn(repository, 'delete');
    render(<Harness repository={repository} />);
    click('刪除範本');
    const dialog = screen.getByRole('dialog', { name: `刪除範本「${template.name}」？` });
    expect(within(dialog).getByText(/已結束的執行會保留/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    click('刪除範本');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認刪除範本' }));
    expect(await screen.findByText(`已刪除範本「${template.name}」。`)).toBeTruthy();
    expect(remove.mock.calls[0]![0]).toMatchObject({ type: 'workflow.delete', workflowId: template.id, expectedRevision: template.revision });
    expect(screen.getByRole('heading', { name: '另一個範本' })).toBeTruthy();
    expect(repository.getSnapshot().map(w => w.id)).toEqual(['wf-other']);
  });

  it('the last one leaves the empty page; a draft of it is dropped with it', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    fireEvent.change(screen.getByRole('textbox', { name: '範本名稱' }), { target: { value: '改過' } });
    click('刪除範本');
    expect(screen.getByText('這個範本的未儲存草稿也會一併捨棄。')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認刪除範本' }));
    expect(await screen.findByRole('heading', { name: '還沒有 Workflow 範本' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /改過/ })).toBeNull();
  });

  it('runs not ended are listed and the delete is not offered; ended ones do not hold it', () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} instances={[runOf('running'), runOf('blocked'), runOf('completed'), runOf('cancelled')]} />);
    click('刪除範本');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/有 2 個還沒結束的執行/)).toBeTruthy();
    expect(within(dialog).getByText('執行 running')).toBeTruthy();
    expect(within(dialog).queryByText('執行 completed')).toBeNull();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '確認刪除範本' }).disabled).toBe(true);
  });

  it('shows why the core refused it, and keeps the template and its draft', async () => {
    const repository = createWorkflowRepository([template]);
    const refused: CommandResult = { ok: false, requestId: null, code: 'invalid_transition', message: 'x', retryable: true, mayHaveSideEffects: false, reason: 'template-in-use' };
    const ipc: WorkflowRepository = { ...repository, mode: 'ipc', delete: vi.fn(() => Promise.resolve(refused)) };
    render(<Harness repository={ipc} />);
    click('刪除範本');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認刪除範本' }));
    expect(await screen.findByText(/有還沒結束或正在開始的執行使用這個範本/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: template.name })).toBeTruthy();
    const stale: CommandResult = { ok: false, requestId: null, code: 'stale_revision', message: 'x', retryable: true, mayHaveSideEffects: false };
    (ipc.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce(stale);
    click('刪除範本');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '確認刪除範本' }));
    expect(await screen.findByText('範本已有較新版本，請重新載入後再刪除。')).toBeTruthy();
  });
});

describe('T063 starter button', () => {
  const withStarter = (initial: readonly WorkflowTemplate[], added: WorkflowTemplate) => {
    const base = createWorkflowRepository(initial);
    let list = base.getSnapshot();
    const listeners = new Set<() => void>();
    const repository: WorkflowRepository = {
      ...base, mode: 'ipc', getSnapshot: () => list,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      addStarter: vi.fn((command: AddStarterCommand) => { list = [...list, added]; listeners.forEach(l => l()); return Promise.resolve({ ok: true as const, requestId: command.requestId, revision: 0, created: [] }); }),
    };
    return repository;
  };
  const starter = WorkflowTemplate.parse({ ...template, id: STARTER_WORKFLOW_ID, name: '規劃 → 實作 → 審查', revision: 0 });

  it('on the empty page and beside the list while the starter template is missing; adding it opens it', async () => {
    const repository = withStarter([], starter);
    render(<Harness repository={repository} initialId="unavailable" />);
    click('加入起始範本');
    expect(await screen.findByRole('heading', { name: '規劃 → 實作 → 審查' })).toBeTruthy();
    expect(screen.getByText('已加入起始範本「規劃 → 實作 → 審查」。')).toBeTruthy();
    expect(repository.addStarter).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: '加入起始範本' })).toBeNull();
  });

  it('beside the list for an install in use', () => {
    render(<Harness repository={withStarter([template], starter)} />);
    expect(toolbar().getByRole('button', { name: '加入起始範本' })).toBeTruthy();
  });
});

describe('T063 read-only', () => {
  it('adding, copying, deleting and the starter are off', () => {
    const repository: WorkflowRepository = { ...createWorkflowRepository([template]), addStarter: vi.fn() };
    const remove = vi.spyOn(repository, 'delete');
    render(<Harness repository={repository} readOnly />);
    for (const name of ['新增範本', '複製', '刪除範本', '加入起始範本']) expect(button(name).disabled).toBe(true);
    act(() => { button('刪除範本').click(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('the empty page too', () => {
    render(<Harness repository={{ ...createWorkflowRepository([]), addStarter: vi.fn() }} initialId="unavailable" readOnly />);
    expect(button('新增範本').disabled).toBe(true);
    expect(button('加入起始範本').disabled).toBe(true);
  });
});

describe('T063 the starter template in the editor', () => {
  it('opens with every Agent and model known, shows no error, keeps the task list of root confirmed, and saves', async () => {
    const { agents: starterAgents, workflow } = starterFixture;
    const listed = [
      ModelOption.parse({ runtime: 'claude', model: 'sonnet', displayName: 'Sonnet', efforts: [], isDefault: true }),
      ModelOption.parse({ runtime: 'codex', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['medium', 'high'], isDefault: true }),
    ];
    const repository = createWorkflowRepository([workflow]);
    render(<WorkflowEditor repository={repository} agents={starterAgents} models={listed} selectedId={workflow.id} visible onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name: '規劃 → 實作 → 審查' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const graph = within(screen.getByRole('navigation', { name: '圖形選取' }));
    for (const label of ['規劃 · root', '實作', '審查']) {
      fireEvent.click(graph.getByRole('button', { name: label }));
      expect(screen.queryByText(/未提供的 Agent|未提供的 Model/)).toBeNull();
    }
    fireEvent.click(graph.getByRole('button', { name: '規劃 · root' }));
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Output 1 目的地' }).value).toBe('tasks');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Output 1 經 root 請使用者確認' }).checked).toBe(true);
    expect(screen.getByText('連線（3）')).toBeTruthy();
    click('儲存 Workflow');
    expect(await screen.findByText(/已儲存「規劃 → 實作 → 審查」，revision 1/)).toBeTruthy();
  });
});

describe('T063 around the editor', () => {
  it('「開始 Workflow」 without templates goes to a new template', () => {
    const empty = Snapshot.parse({ ...fixtureSnapshot, workflows: [] });
    const onNew = vi.fn();
    render(<WorkflowStart snapshot={empty} store={undefined} ipcState={undefined} onOpen={vi.fn()} onNewTemplate={onNew} />);
    click('新增範本');
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('an ended run of a deleted template still shows', () => {
    const data = structuredClone(fixtureSnapshot);
    data.workflows = [];
    const run = data.instances[0]!;
    render(<WorkflowProgress snapshot={Snapshot.parse(data)} instanceId={run.id} onOpen={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByRole('region', { name: '唯讀流程圖' })).toBeTruthy();
    for (const node of run.template.nodes) expect(screen.getAllByText(node.label).length).toBeGreaterThan(0);
  });
});


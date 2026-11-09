// @vitest-environment jsdom
// T070: the template library in the editor. 「範本庫」 lists the starter template and the eight built-in ones with their
// summaries and whether they need git; 「加入」 sends that template's key, and the template added opens in the editor at
// once (the store's update, no reload); one already there shows 「已加入」 and opens; a refusal is shown on its row;
// read-only data turns adding off and leaves opening on.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_WORKFLOW_IDS, type AgentDefinition, type CommandResult, type WorkflowTemplate } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowEditor } from './WorkflowEditor';
import { tddFixture } from './builtin-tdd.fixture';
import { TEMPLATE_LIBRARY } from './template-library';
import { createWorkflowRepository } from './workflow-repository';
import type { AddStarterCommand, WorkflowRepository } from './workflow-repository';

const template = fixtureSnapshot.workflows[0]!;
const models = fixtureSnapshot.modelOptions;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const library = () => within(screen.getByRole('dialog', { name: '範本庫' }));
const row = (name: string) => within(library().getByRole('listitem', { name }));

function Harness({ repository, agents, initialId = template.id, readOnly = false }: { repository: WorkflowRepository; agents: readonly AgentDefinition[]; initialId?: string; readOnly?: boolean }) {
  const [id, setId] = useState(initialId);
  return <WorkflowEditor repository={repository} agents={agents} models={models} selectedId={id} visible readOnly={readOnly} onSelect={next => setId(next || 'unavailable')} />;
}

/** A repository on a store: the add updates the list (as agent.updated / workflow.updated do), then answers. */
const onStore = (initial: readonly WorkflowTemplate[], answer?: (command: AddStarterCommand) => CommandResult) => {
  const base = createWorkflowRepository(initial);
  let list = base.getSnapshot();
  const listeners = new Set<() => void>();
  const repository: WorkflowRepository = {
    ...base, mode: 'ipc', getSnapshot: () => list,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    addStarter: vi.fn((command: AddStarterCommand) => {
      const refused = answer?.(command);
      if (refused) return Promise.resolve(refused);
      if (command.template === 'tdd') { list = [...list, tddFixture.workflow]; listeners.forEach(l => l()); }
      return Promise.resolve({ ok: true as const, requestId: command.requestId, revision: 0, created: [] });
    }),
  };
  return repository;
};
const agents = [...fixtureSnapshot.agents, ...tddFixture.agents];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T070 the template library', () => {
  it('lists the nine templates with their summaries; only the worktree one is tagged as needing git', () => {
    render(<Harness repository={onStore([template])} agents={agents} />);
    click('範本庫');
    const items = library().getAllByRole('listitem');
    expect(items.map(item => within(item).getByRole('heading').textContent)).toEqual(TEMPLATE_LIBRARY.map(e => e.name));
    for (const entry of TEMPLATE_LIBRARY) {
      expect(row(entry.name).getByText(entry.summary)).toBeTruthy();
      expect(row(entry.name).queryByText('需要 git repo') !== null).toBe(entry.needsGit);
      expect(row(entry.name).getByRole('button', { name: `加入「${entry.name}」` })).toBeTruthy();
    }
    expect(library().getByText(/內建範本不綁專案/)).toBeTruthy();
  });

  it('「加入」 sends that key; the template opens in the editor at once, without a reload', async () => {
    const repository = onStore([template]);
    render(<Harness repository={repository} agents={agents} />);
    click('範本庫');
    click('加入「測試驅動（TDD）」');
    expect(repository.addStarter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.addStarter!).mock.calls[0]![0]).toMatchObject({ type: 'workflow.addStarter', template: 'tdd' });
    expect(await screen.findByRole('heading', { name: '測試驅動（TDD）', level: 2 })).toBeTruthy();
    expect(screen.getByText('已加入範本「測試驅動（TDD）」。')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Workflow 範本' }).value).toBe(BUILTIN_WORKFLOW_IDS.tdd);
    expect(screen.queryByText('找不到指定的 Workflow 範本')).toBeNull();
    // Its nodes are on the canvas, and the editor finds no issue (every Agent known).
    expect(screen.getAllByText('驗證').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('one already there shows 「已加入」 and opens', () => {
    render(<Harness repository={onStore([template, tddFixture.workflow])} agents={agents} />);
    click('範本庫');
    expect(row('測試驅動（TDD）').getByText('已加入')).toBeTruthy();
    expect(row('測試驅動（TDD）').queryByRole('button', { name: /^加入/ })).toBeNull();
    click('打開「測試驅動（TDD）」');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: '測試驅動（TDD）', level: 2 })).toBeTruthy();
  });

  it('a refusal shows on its row and keeps the library open; nothing else is sent meanwhile', async () => {
    const repository = onStore([template], command => ({ ok: false, requestId: command.requestId, code: 'storage_failed', message: 'x', retryable: true, mayHaveSideEffects: false }));
    render(<Harness repository={repository} agents={agents} />);
    click('範本庫');
    click('加入「安全重構」');
    await waitFor(() => expect(row('安全重構').getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: '範本庫' })).toBeTruthy();
    expect(row('安全重構').getByRole('button', { name: '加入「安全重構」' })).toBeTruthy();
  });

  it('a service that does not answer: said so on the row', async () => {
    const repository = onStore([template]);
    repository.addStarter = vi.fn(() => Promise.reject(new Error('gone')));
    render(<Harness repository={repository} agents={agents} />);
    click('範本庫');
    click('加入「路由分流」');
    expect(await row('路由分流').findByText('服務無法回應，範本沒有加入。')).toBeTruthy();
  });

  it('closes with 「關閉」; the empty page offers it too', () => {
    render(<Harness repository={onStore([])} agents={agents} initialId="unavailable" />);
    expect(screen.getByText(/也可以從範本庫加入內建範本/)).toBeTruthy();
    click('範本庫');
    click('關閉');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('read-only: adding is off with the reason; opening what is there still works', () => {
    const repository = onStore([template, tddFixture.workflow]);
    render(<Harness repository={repository} agents={agents} readOnly />);
    click('範本庫');
    expect(library().getByText('唯讀模式：無法加入範本。')).toBeTruthy();
    for (const entry of TEMPLATE_LIBRARY.filter(e => e.key !== 'tdd')) expect(button(`加入「${entry.name}」`).disabled).toBe(true);
    click('加入「安全重構」');
    expect(repository.addStarter).not.toHaveBeenCalled();
    expect(button('打開「測試驅動（TDD）」').disabled).toBe(false);
    click('打開「測試驅動（TDD）」');
    expect(screen.getByRole('heading', { name: '測試驅動（TDD）', level: 2 })).toBeTruthy();
  });

  it('the demo (no core) has no library', () => {
    render(<Harness repository={createWorkflowRepository([template])} agents={agents} />);
    expect(screen.queryByRole('button', { name: '範本庫' })).toBeNull();
  });
});

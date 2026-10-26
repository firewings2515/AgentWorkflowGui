// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command, WorkflowId, WorkflowTemplate } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { WorkflowEditor } from './WorkflowEditor';
import { createWorkflowDemo } from './workflow-demo';
import type { WorkflowDemoControls } from './workflow-demo';
import { createWorkflowRepository, workflowSaveCommand } from './workflow-repository';
import type { WorkflowRepository } from './workflow-repository';
import { App } from './App';

const template = fixtureSnapshot.workflows[0]!;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const textField = (name: string) => screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name });
const change = (name: string, value: string) => fireEvent.change(textField(name), { target: { value } });
const selectNode = (name: string) => fireEvent.click(within(screen.getByRole('navigation', { name: '圖形選取' })).getByRole('button', { name }));
function Harness({ repository, demo, initialId = template.id }: { repository: WorkflowRepository; demo?: WorkflowDemoControls; initialId?: string }) {
  const [id, setId] = useState(initialId);
  return <WorkflowEditor repository={repository} {...(demo ? { demo } : {})} agents={fixtureSnapshot.agents} models={fixtureSnapshot.modelOptions} selectedId={id} visible onSelect={setId} />;
}
beforeEach(() => {
  // jsdom has no geometry; this only lets the actual canvas mount, not a layout assertion.
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  window.history.replaceState(null, '', '/#/workflows/wf-default/edit');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T019 Workflow editor', () => {
  it('only adds the selected manual connection after an explicit button action', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '新增連線' }).disabled).toBe(true);
    const target = screen.getByLabelText('連接到節點');
    for (const value of ['n-review', 'n-test', 'n-merge', 'n-review']) {
      fireEvent.change(target, { target: { value } });
      expect(screen.getByText('連線（6）')).toBeTruthy();
      expect(screen.getByText(/已載入範本/)).toBeTruthy();
    }
    screen.getByRole('button', { name: '新增連線' }).focus();
    click('新增連線');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(target);
    expect(screen.getByText('連線（7）')).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: '連接到節點' }).value).toBe('');
    fireEvent.change(target, { target: { value: 'n-review' } });
    click('新增連線');
    expect(screen.getByText('連線（7）')).toBeTruthy();
    fireEvent.change(target, { target: { value: 'n-test' } });
    selectNode('實作');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '新增連線' }).disabled).toBe(true);
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]!.edges).toEqual([...template.edges, { source: 'n-plan', target: 'n-review' }]);
  });

  it('stages output destinations without changing rules or edges until applied', async () => {
    const repository = createWorkflowRepository([template]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    const target = screen.getByRole('combobox', { name: 'Output 1 目的地' });
    for (const value of ['node:n-review', 'node:n-merge', 'root', 'node:n-review']) {
      fireEvent.change(target, { target: { value } });
      expect(screen.getByText('連線（6）')).toBeTruthy();
      expect(screen.getByText(/已載入範本/)).toBeTruthy();
    }
    click('儲存 Workflow');
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(within(screen.getByRole('alert')).getByText(/規劃 · Output 1/)).toBeTruthy();
    expect(repository.getSnapshot()[0]!.nodes[0]!.outputRules).toEqual(template.nodes[0]!.outputRules);
    click('套用 Output 1 目的地');
    expect(screen.getByText('連線（7）')).toBeTruthy();
    fireEvent.change(target, { target: { value: 'root' } });
    expect(screen.getByText('連線（7）')).toBeTruthy();
    click('套用 Output 1 目的地');
    expect(screen.getByText('連線（6）')).toBeTruthy();
    click('儲存 Workflow');
    await waitFor(() => expect(repository.getSnapshot()[0]!.nodes[0]!.outputRules[0]!.target).toEqual({ kind: 'root' }));
  });

  it('retains choices across nodes and templates, then applies all before saving', async () => {
    const other = { ...template, id: WorkflowId.parse('wf-other'), name: '另一範本' };
    const repository = createWorkflowRepository([template, other]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    fireEvent.change(screen.getByRole('combobox', { name: 'Output 1 目的地' }), { target: { value: 'node:n-review' } });
    selectNode('實作');
    fireEvent.change(screen.getByRole('combobox', { name: 'Output 1 目的地' }), { target: { value: 'root' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow 範本' }), { target: { value: other.id } });
    expect(screen.queryByText(/項 Output 目的地尚未套用/)).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow 範本' }), { target: { value: template.id } });
    selectNode('規劃 · root');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Output 1 目的地' }).value).toBe('node:n-review');
    selectNode('Review');
    click('儲存 Workflow');
    expect(save).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/規劃 · Output 1/)).toBeTruthy();
    expect(within(alert).getByText(/實作 · Output 1/)).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: /規劃 · Output 1/ }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Output 1 目的地' }));
    click('套用所有目的地');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '儲存 Workflow' }));
    expect(save).not.toHaveBeenCalled();
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    const saved = repository.getSnapshot()[0]!;
    expect(saved.nodes[0]!.outputRules[0]!.target).toEqual({ kind: 'node', nodeId: 'n-review' });
    expect(saved.nodes[1]!.outputRules[0]!.target).toEqual({ kind: 'root' });
    expect(saved.edges).toContainEqual({ source: 'n-plan', target: 'n-review' });
    expect(repository.getSnapshot()[1]).toEqual(other);
  });

  it('only discards unapplied destinations after an explicit choice', async () => {
    const repository = createWorkflowRepository([template]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    change('Output 1 什麼情況', '保留其他修改');
    fireEvent.change(screen.getByRole('combobox', { name: 'Output 1 目的地' }), { target: { value: 'node:n-review' } });
    selectNode('實作');
    click('儲存 Workflow');
    expect(save).not.toHaveBeenCalled();
    click('放棄所有目的地選擇');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '儲存 Workflow' }));
    selectNode('規劃 · root');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Output 1 目的地' }).value).toBe('node:n-build');
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]!.nodes[0]!.outputRules[0]).toEqual({ ...template.nodes[0]!.outputRules[0], condition: '保留其他修改' });
    expect(repository.getSnapshot()[0]!.edges).toEqual(template.edges);
  });

  it('clears staged choices when reverting the selection or removing its rule', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    const target = screen.getByRole('combobox', { name: 'Output 1 目的地' });
    fireEvent.change(target, { target: { value: 'node:n-review' } });
    fireEvent.change(target, { target: { value: 'node:n-build' } });
    expect(screen.queryByText(/項 Output 目的地尚未套用/)).toBeNull();
    fireEvent.change(target, { target: { value: 'node:n-review' } });
    click('移除 Output 1');
    expect(screen.queryByText(/項 Output 目的地尚未套用/)).toBeNull();
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]!.nodes[0]!.outputRules).toEqual([]);
  });

  it('does not repair graph structure when an ordinary field select changes', () => {
    const invalid = { ...template, edges: [] };
    const repository = createWorkflowRepository([template]);
    vi.spyOn(repository, 'getSnapshot').mockReturnValue([invalid]);
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    fireEvent.change(screen.getByRole('combobox', { name: '寫入權限' }), { target: { value: 'read-only' } });
    expect(screen.getByText('連線（0）')).toBeTruthy();
    click('套用 Output 1 目的地');
    expect(screen.getByText('連線（1）')).toBeTruthy();
  });

  it('names validation fields and still navigates to the original path', () => {
    render(<Harness repository={createWorkflowRepository([template])} />);
    selectNode('實作');
    fireEvent.change(screen.getByRole('spinbutton', { name: '並行 task 數' }), { target: { value: '0' } });
    change('Input 1 收到什麼／如何處理', '');
    click('儲存 Workflow');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).not.toContain('nodes.');
    expect(within(alert).getByRole('button', { name: '實作 · Input 1 · 收到什麼／如何處理：此欄位不可空白。' })).toBeTruthy();
    selectNode('Review');
    click('實作 · 並行 task 數：請輸入大於或等於 1 的整數。');
    expect(document.activeElement).toBe(screen.getByRole('spinbutton', { name: '並行 task 數' }));
  });

  it('does not protect deleted saved edges when output rules recreate them; saving resets provenance', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    fireEvent.click(screen.getByText('連線（6）'));
    selectNode('規劃 → 實作');
    click('刪除所選連線');
    click('確認刪除');
    selectNode('規劃 · root');
    click('＋ 新增 Output 規則');
    change('Output 1 什麼情況', '交接');
    const target = screen.getByRole('combobox', { name: 'Output 1 目的地' });
    const apply = (value: string) => {
      fireEvent.change(target, { target: { value } });
      click('套用 Output 1 目的地');
    };
    apply('node:n-build');
    expect(screen.getByText('連線（6）')).toBeTruthy();
    apply('root');
    expect(screen.getByText('連線（5）')).toBeTruthy();
    apply('node:n-build');
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    apply('root');
    expect(screen.getByText('連線（6）')).toBeTruthy();
    click('儲存 Workflow');
    await waitFor(() => expect(repository.getSnapshot()[0]!.nodes[0]!.outputRules[0]!.target).toEqual({ kind: 'root' }));
    expect(repository.getSnapshot()[0]!.edges).toContainEqual({ source: 'n-plan', target: 'n-build' });
  });

  it('loads the fixture and saves contract-only edits with captured revision', async () => {
    const before = JSON.stringify(fixtureSnapshot);
    const repository = createWorkflowRepository([template]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    change('範本名稱', '使用者流程');
    selectNode('實作');
    fireEvent.change(screen.getByRole('spinbutton', { name: '並行 task 數' }), { target: { value: '3' } });
    fireEvent.change(screen.getByRole('combobox', { name: '寫入權限' }), { target: { value: 'read-only' } });
    click('儲存 Workflow');
    await screen.findByText(/已儲存「使用者流程」/);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].expectedRevision).toBe(template.revision);
    expect(Command.safeParse(save.mock.calls[0]![0]).success).toBe(true);
    expect(repository.getSnapshot()[0]?.nodes[1]).toMatchObject({ concurrency: 3, writePolicy: 'read-only' });
    expect(JSON.stringify(fixtureSnapshot)).toBe(before);
  });

  it('adds agent and merge nodes by buttons and drop, then saves their positions', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    click('＋ Agent 節點');
    expect(document.activeElement).toBe(textField('節點名稱'));
    change('節點名稱', '新角色');
    const drop = new MouseEvent('drop', { bubbles: true, clientX: 340, clientY: 240 });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'merge' } });
    fireEvent(screen.getByLabelText('Workflow 畫布'), drop);
    expect(textField('節點名稱').value).toBe('新增合併');
    expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('spinbutton', { name: '並行 task 數' }).disabled).toBe(true);
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    const saved = repository.getSnapshot()[0]!;
    expect(saved.nodes).toHaveLength(template.nodes.length + 2);
    expect(saved.nodes.at(-1)).toMatchObject({ kind: 'merge', concurrency: 1, position: { x: 340, y: 240 } });
  });

  it('edits multiple rules and automatically draws output edges; manual edges become destinations', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    fireEvent.change(screen.getByLabelText('連接到節點'), { target: { value: 'n-review' } });
    click('新增連線');
    click('＋ 新增 Input 規則');
    change('Input 2 收到什麼／如何處理', '等待分支完成');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Input 2 等所有上游到齊' }));
    click('＋ 新增 Output 規則');
    change('Output 2 什麼情況', '可以合併');
    expect(within(screen.getByRole('combobox', { name: 'Output 2 目的地' })).getByRole('option', { name: 'Review（已連線）' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Output 2 目的地' }), { target: { value: 'node:n-merge' } });
    click('套用 Output 2 目的地');
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    const saved = repository.getSnapshot()[0]!;
    expect(saved.edges).toEqual(expect.arrayContaining([{ source: 'n-plan', target: 'n-review' }, { source: 'n-plan', target: 'n-merge' }]));
    expect(saved.nodes[0]?.inputRules[1]?.waitForAllUpstream).toBe(true);
    expect(WorkflowTemplate.safeParse(saved).success).toBe(true);
  });

  it('validates field paths and jumps from a different selection to the invalid rule', () => {
    const repository = createWorkflowRepository([template]);
    const save = vi.spyOn(repository, 'save');
    render(<Harness repository={repository} />);
    selectNode('實作');
    change('Input 1 收到什麼／如何處理', '');
    selectNode('Review');
    click('儲存 Workflow');
    expect(document.activeElement).toBe(textField('Input 1 收到什麼／如何處理'));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    expect(textField('節點名稱').value).toBe('實作');
    expect(save).not.toHaveBeenCalled();
    click('儲存 Workflow');
    expect(document.activeElement).toBe(textField('Input 1 收到什麼／如何處理'));
  });

  it('confirms keyboard deletion with dependent rules, restores focus, and requires a replacement root', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    const rootButton = within(screen.getByRole('navigation', { name: '圖形選取' })).getByRole('button', { name: '規劃 · root' });
    rootButton.focus();
    fireEvent.keyDown(rootButton, { key: 'Delete' });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/這是 root/)).toBeTruthy();
    click('取消刪除');
    expect(document.activeElement).toBe(rootButton);
    fireEvent.keyDown(rootButton, { key: 'Delete' });
    click('確認刪除');
    expect(document.activeElement).toBe(within(screen.getByRole('navigation', { name: '圖形選取' })).getByRole('button', { name: '實作' }));
    click('儲存 Workflow');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Root 節點（升級對象）' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Root 節點（升級對象）' }), { target: { value: 'n-build' } });
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]?.nodes).toHaveLength(template.nodes.length - 1);
  });

  it('deletes an edge and explicitly lists its affected output rules', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    fireEvent.click(screen.getByText('連線（6）'));
    selectNode('規劃 → 實作');
    expect(screen.getByRole('button', { name: '規劃 · Output 1：計畫經使用者確認' })).toBeTruthy();
    click('刪除所選連線');
    expect(within(screen.getByRole('dialog')).getByText('規劃：計畫經使用者確認')).toBeTruthy();
    click('確認刪除');
    expect(document.activeElement).toBe(within(screen.getByRole('navigation', { name: '圖形選取' })).getByRole('button', { name: '實作 → Review' }));
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]?.nodes[0]?.outputRules).toHaveLength(0);
  });

  it('selects and moves a real canvas node with keys; Delete acts on the focused node', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="n-build"]')!;
    node.focus();
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(textField('節點名稱').value).toBe('實作');
    expect(document.activeElement).toBe(node);
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node);
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]!.nodes[1]!.position.x).toBeGreaterThan(template.nodes[1]!.position.x);
    const root = document.querySelector<HTMLElement>('.react-flow__node[data-id="n-plan"]')!;
    fireEvent.keyDown(root, { key: 'Delete' });
    expect(screen.getByRole('dialog', { name: '刪除節點「規劃」？' })).toBeTruthy();
    click('取消刪除');
    fireEvent.keyDown(node, { key: 'Escape' });
    expect(screen.getByRole('textbox', { name: '範本名稱' })).toBeTruthy();
  });

  it('retains failed drafts and retries; compares conflict versions before explicit rebase', async () => {
    const { repository, controls } = createWorkflowDemo([template]);
    render(<Harness repository={repository} demo={controls} />);
    change('範本名稱', '我的草稿');
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    click('儲存 Workflow');
    await screen.findByText(/模擬儲存失敗/);
    expect(textField('範本名稱').value).toBe('我的草稿');
    click('模擬他人已更新此 Workflow');
    await screen.findByText(/版本已變更/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存 Workflow' }).disabled).toBe(true);
    fireEvent.click(screen.getByText('比對草稿與目前已儲存版本'));
    expect(screen.getByRole('heading', { name: '你的草稿' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '目前已儲存版本' })).toBeTruthy();
    click(`已比對，保留草稿並以 revision ${template.revision + 1} 重新編輯`);
    expect(textField('範本名稱').value).toBe('我的草稿');
    click('儲存 Workflow');
    await screen.findByText(/已儲存「我的草稿」/);
    expect(repository.getSnapshot()[0]?.revision).toBe(template.revision + 2);
  });

  it('handles an in-flight revision race and request mismatch without losing the draft', async () => {
    const repository = createWorkflowRepository([template]);
    const realSave = repository.save;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'save').mockImplementation(async command => { await held; return realSave(command); });
    render(<Harness repository={repository} />);
    change('範本名稱', '延遲草稿');
    click('儲存 Workflow');
    await act(async () => { await realSave(workflowSaveCommand({ ...template, name: '其他人修改' }, template.revision)); release(); });
    await screen.findByText('Workflow 已有較新版本，請比對後重新編輯。');
    expect(textField('範本名稱').value).toBe('延遲草稿');
    click(`已比對，保留草稿並以 revision ${template.revision + 1} 重新編輯`);
    vi.mocked(repository.save).mockResolvedValue({ ok: true, requestId: workflowSaveCommand(template, 1).requestId, revision: 99, created: [] });
    click('儲存 Workflow');
    await screen.findByText(/無法核對儲存回覆/);
    expect(textField('範本名稱').value).toBe('延遲草稿');
  });

  it('isolates async completion and drafts per template without moving another template focus', async () => {
    const other = { ...template, id: WorkflowId.parse('wf-other'), name: '另一個範本' };
    const repository = createWorkflowRepository([template, other]);
    const realSave = repository.save;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'save').mockImplementation(async command => { await held; return realSave(command); });
    render(<Harness repository={repository} />);
    change('範本名稱', '第一個草稿');
    click('儲存 Workflow');
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow 範本' }), { target: { value: other.id } });
    change('範本名稱', '第二個草稿');
    textField('範本名稱').focus();
    await act(async () => { release(); await held; });
    expect(textField('範本名稱').value).toBe('第二個草稿');
    expect(document.activeElement).toBe(textField('範本名稱'));
    expect(screen.queryByText(/已儲存「第一個草稿」/)).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Workflow 範本' }), { target: { value: template.id } });
    await screen.findByText(/已儲存「第一個草稿」/);
  });

  it('preserves drafts across App pages and shows missing and empty states honestly', async () => {
    const view = render(<App />);
    change('範本名稱', '跨頁草稿');
    selectNode('實作');
    selectNode('範本設定');
    expect(document.activeElement).toBe(textField('範本名稱'));
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    fireEvent.click(screen.getByRole('link', { name: 'Workflow 編輯器' }));
    expect(textField('範本名稱').value).toBe('跨頁草稿');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '跨頁草稿' }));
    fireEvent.change(screen.getByRole('combobox', { name: '外觀主題' }), { target: { value: 'light' } });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));
    view.unmount();
    const missing = render(<Harness repository={createWorkflowRepository([template])} initialId="missing" />);
    expect(screen.getByRole('heading', { name: '找不到指定的 Workflow 範本' })).toBeTruthy();
    missing.unmount();
    render(<Harness repository={createWorkflowRepository([])} />);
    expect(screen.getByText('尚無 Workflow 範本')).toBeTruthy();
  });

  it('shows root, permission, concurrency, isolation, merge and waiting markers on cards', () => {
    const workflow = structuredClone(template);
    workflow.nodes[0]!.writePolicy = 'write';
    workflow.nodes[1]!.concurrency = 3;
    workflow.nodes[1]!.writePolicy = 'read-only';
    workflow.nodes[1]!.inputRules[0]!.waitForAllUpstream = true;
    const view = render(<Harness repository={createWorkflowRepository([workflow])} />);
    const card = (id: string) => within(document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .workflow-node-card`)!);
    expect(card('n-plan').getByText('root')).toBeTruthy();
    expect(card('n-plan').getByText('可寫 · 並行 1')).toBeTruthy();
    expect(card('n-build').getByText('唯讀 · 並行 3')).toBeTruthy();
    expect(card('n-build').getByText('等所有上游到齊（同 task／輪次）')).toBeTruthy();
    expect(card('n-build').getByText('每個 task 獨立 worktree')).toBeTruthy();
    expect(card('n-merge').getByText('GUI 執行 · 一次一個 task')).toBeTruthy();
    expect(card('n-merge').queryByText('可寫 · 並行 1')).toBeNull();
    expect(screen.getByRole('region', { name: 'Workflow 畫布' })).toBeTruthy();
    view.unmount();
    workflow.isolation = 'same-folder';
    workflow.nodes[1]!.writePolicy = 'exec-only';
    render(<Harness repository={createWorkflowRepository([workflow])} />);
    expect(card('n-build').getByText('共用資料夾 · 寫入鎖定')).toBeTruthy();
    expect(card('n-build').getByText('只能執行指令 · 並行 3')).toBeTruthy();
  });

  it('does not accumulate automatic edges when selecting destinations successively', async () => {
    const repository = createWorkflowRepository([template]);
    render(<Harness repository={repository} />);
    selectNode('規劃 · root');
    const target = screen.getByRole('combobox', { name: 'Output 1 目的地' });
    for (const value of ['node:n-review', 'node:n-merge', 'node:n-review', 'root']) {
      fireEvent.change(target, { target: { value } });
      click('套用 Output 1 目的地');
      const count = value === 'root' ? template.edges.length : template.edges.length + 1;
      expect(screen.getByText(`連線（${count}）`)).toBeTruthy();
    }
    click('儲存 Workflow');
    await screen.findByText(/已儲存/);
    expect(repository.getSnapshot()[0]!.edges).toEqual(template.edges);
  });

  it('moves focus from an inspector field to the clicked canvas node', () => {
    render(<Harness repository={createWorkflowRepository([template])} />);
    selectNode('規劃 · root');
    textField('Output 1 什麼情況').focus();
    const node = document.querySelector<HTMLElement>('.react-flow__node[data-id="n-merge"]')!;
    fireEvent.click(node.querySelector('.workflow-node-title')!);
    expect(textField('節點名稱').value).toBe('合併');
    expect(document.activeElement).toBe(node);
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(node);
  });

  it('lets a conflict discard the draft, its auto edges and demo failure flag', async () => {
    const { repository, controls } = createWorkflowDemo([template]);
    render(<Harness repository={repository} demo={controls} />);
    change('範本名稱', '要捨棄的草稿');
    selectNode('規劃 · root');
    fireEvent.change(screen.getByRole('combobox', { name: 'Output 1 目的地' }), { target: { value: 'node:n-review' } });
    click('套用 Output 1 目的地');
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    // Publish an external revision without consuming this editor's failure switch.
    const updated = { ...template, name: '外部儲存版本' };
    controls.setSaveFailure(template.id, false);
    await act(async () => { await repository.save(workflowSaveCommand(updated, template.revision)); });
    controls.setSaveFailure(template.id, true);
    click('捨棄草稿、改用已儲存版本');
    expect(textField('範本名稱').value).toBe('外部儲存版本');
    expect(document.activeElement).toBe(textField('範本名稱'));
    expect(screen.getByText(`連線（${template.edges.length}）`)).toBeTruthy();
    expect(controls.hasSaveFailure(template.id)).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '下次儲存模擬失敗' }).checked).toBe(false);
    click('儲存 Workflow');
    await screen.findByText(/已儲存「外部儲存版本」/);
  });

  it('keeps the failure checkbox armed after local validation and an in-flight conflict', async () => {
    const { repository, controls } = createWorkflowDemo([template]);
    const realSave = repository.save;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'save').mockImplementation(async command => { await held; return realSave(command); });
    render(<Harness repository={repository} demo={controls} />);
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    change('範本名稱', '');
    click('儲存 Workflow');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '下次儲存模擬失敗' }).checked).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
    change('範本名稱', '衝突草稿');
    click('儲存 Workflow');
    await act(async () => {
      controls.setSaveFailure(template.id, false);
      await realSave(workflowSaveCommand({ ...template, name: '他人版本' }, template.revision));
      controls.setSaveFailure(template.id, true);
      release();
    });
    await screen.findByText('Workflow 已有較新版本，請比對後重新編輯。');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '下次儲存模擬失敗' }).checked).toBe(true);
    click(`已比對，保留草稿並以 revision ${template.revision + 1} 重新編輯`);
    click('儲存 Workflow');
    await screen.findByText(/模擬儲存失敗/);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '下次儲存模擬失敗' }).checked).toBe(false);
    click('儲存 Workflow');
    await screen.findByText(/已儲存「衝突草稿」/);
  });
});

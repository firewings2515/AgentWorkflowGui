// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, Command } from '../../../contracts';
import type { AgentDefinition, CommandResult } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { AgentCatalog, DeleteConfirmation } from './AgentCatalog';
import { createAgentDemo } from './agent-demo';
import type { AgentDemoControls } from './agent-demo';
import { agentSaveCommand, createAgentRepository } from './agent-repository';
import type { AgentRepository } from './agent-repository';
import { App } from './App';

const planner = fixtureSnapshot.agents[0]!;
const builder = fixtureSnapshot.agents[1]!;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const field = (name: string) => screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name });
const change = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const list = () => within(screen.getByRole('navigation', { name: 'Agent 清單' }));
function CatalogHarness({ repository, demo, initialId = '' }: { repository: AgentRepository; demo?: AgentDemoControls; initialId?: string }) {
  const [id, setId] = useState(initialId);
  return <AgentCatalog repository={repository} {...(demo ? { demo } : {})} selectedId={id} visible onSelect={setId} />;
}
beforeEach(() => { window.history.replaceState(null, '', '/#/agents'); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('T011 Agent 管理', () => {
  it('lists and views fixture definitions, and edits with the captured revision and no model fields', async () => {
    const before = JSON.stringify(fixtureSnapshot);
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const send = vi.spyOn(repository, 'save');
    render(<CatalogHarness repository={repository} />);
    expect(list().getAllByRole('button')).toHaveLength(4);
    expect(screen.getByText(planner.instructions)).toBeTruthy();
    click('編輯');
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.queryByRole('combobox')).toBeNull();
    change('名稱（必填）', '規劃新名稱');
    change('說明', '使用者更新說明');
    change('指示（必填）', '使用者更新指示');
    click('儲存');
    await screen.findByText(/示意模式 · 已儲存「規劃新名稱」/);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '規劃新名稱' }));
    const command = send.mock.calls[0]![0];
    expect(Command.safeParse(command).success).toBe(true);
    expect(command.expectedRevision).toBe(planner.revision);
    expect(command.agent.id).toBe(planner.id);
    expect(Object.keys(command.agent).sort()).toEqual(Object.keys(planner).sort());
    expect(repository.getSnapshot()[0]).toMatchObject({ name: '規劃新名稱', revision: planner.revision + 1 });
    expect(JSON.stringify(fixtureSnapshot)).toBe(before);
  });

  it('creates from empty state, validates whitespace, and permits an empty description', async () => {
    const repository = createAgentRepository([]);
    const send = vi.spyOn(repository, 'save');
    render(<CatalogHarness repository={repository} />);
    expect(screen.getByText('尚未建立 Agent，請新增工作角色。')).toBeTruthy();
    click('＋ 建立 Agent');
    change('名稱（必填）', '   ');
    click('儲存');
    expect(screen.getByText('請填寫名稱。')).toBeTruthy();
    expect(screen.getByText('請填寫指示。')).toBeTruthy();
    expect(document.activeElement).toBe(field('名稱（必填）'));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    expect(send).not.toHaveBeenCalled();
    change('名稱（必填）', '自訂角色');
    click('儲存');
    expect(document.activeElement).toBe(field('指示（必填）'));
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    screen.getByRole('button', { name: '儲存' }).focus();
    click('儲存');
    expect(document.activeElement).toBe(field('指示（必填）'));
    change('指示（必填）', '使用者提供的工作指示');
    click('儲存');
    await screen.findByText(/已儲存「自訂角色」/);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '自訂角色' }));
    expect(send.mock.calls[0]![0].expectedRevision).toBeNull();
    expect(repository.getSnapshot()[0]).toMatchObject({ name: '自訂角色', description: '', revision: 1 });
  });

  it('copies into an unsaved new ID and leaves the source untouched', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    render(<CatalogHarness repository={repository} initialId={builder.id} />);
    click('複製');
    expect(field('名稱（必填）').value).toBe(`${builder.name}（複本）`);
    expect(field('指示（必填）').value).toBe(builder.instructions);
    expect(repository.getSnapshot()).toHaveLength(4);
    click('儲存');
    await screen.findByText(/已儲存「實作 Agent（複本）」/);
    const copy = repository.getSnapshot().at(-1)!;
    expect(copy.id).not.toBe(builder.id);
    expect(copy.revision).toBe(1);
    expect(repository.getSnapshot().find(agent => agent.id === builder.id)).toEqual(builder);
  });

  it('preserves per-ID drafts across selections and pages, and cancels only the selected draft', () => {
    render(<App />);
    click('編輯');
    change('指示（必填）', '規劃草稿保留');
    fireEvent.click(list().getByRole('button', { name: /實作 Agent/ }));
    click('編輯');
    change('指示（必填）', '實作草稿保留');
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    fireEvent.click(screen.getByRole('link', { name: 'Agent 管理' }));
    expect(field('指示（必填）').value).toBe('規劃草稿保留');
    fireEvent.click(list().getByRole('button', { name: /實作 Agent/ }));
    expect(field('指示（必填）').value).toBe('實作草稿保留');
    click('取消編輯');
    expect(screen.getByText(builder.instructions)).toBeTruthy();
    fireEvent.click(list().getByRole('button', { name: /規劃 Agent/ }));
    expect(field('指示（必填）').value).toBe('規劃草稿保留');
  });

  it('keeps failed edits and retries explicitly without persisting the first attempt', async () => {
    const { repository, controls } = createAgentDemo(fixtureSnapshot.agents);
    const send = vi.spyOn(repository, 'save');
    render(<CatalogHarness repository={repository} demo={controls} />);
    click('編輯');
    change('指示（必填）', '失敗後保留的指示');
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    click('儲存');
    await screen.findByText(/模擬儲存失敗；資料未變更/);
    const alert = screen.getByRole('alert');
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole('form', { name: 'Agent 編輯表單' }).firstElementChild).toBe(alert);
    expect(send.mock.calls[0]).toHaveLength(1);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '下次儲存模擬失敗' }).checked).toBe(false);
    expect(field('指示（必填）').value).toBe('失敗後保留的指示');
    expect(repository.getSnapshot()[0]).toEqual(planner);
    click('儲存');
    await screen.findByText(/已儲存「規劃 Agent」/);
    expect(repository.getSnapshot()[0]?.instructions).toBe('失敗後保留的指示');
  });

  it('requires review of a newer revision while retaining the unsaved content', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    render(<CatalogHarness repository={repository} />);
    click('編輯');
    change('指示（必填）', '本地草稿');
    await act(async () => { await repository.save(agentSaveCommand({ ...planner, instructions: '另一個編輯者的指示' }, planner.revision)); });
    expect(screen.getByText(/版本已變更：草稿基於 revision 1/)).toBeTruthy();
    expect(field('指示（必填）').value).toBe('本地草稿');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(true);
    fireEvent.click(screen.getByText('比對目前已儲存版本'));
    expect(screen.getByText('另一個編輯者的指示')).toBeTruthy();
    click('已比對，保留草稿並以 revision 2 重新編輯');
    click('儲存');
    await screen.findByText(/已儲存「規劃 Agent」，revision 3/);
    expect(repository.getSnapshot()[0]?.instructions).toBe('本地草稿');
  });

  it('pins delayed save results to their agent when selection changes and blocks duplicate submits', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const save = repository.save;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(repository, 'save').mockImplementation(async command => { await held; return save(command); });
    render(<CatalogHarness repository={repository} />);
    click('編輯');
    change('指示（必填）', '延後儲存內容');
    click('儲存');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(true);
    click('儲存');
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(list().getByRole('button', { name: /實作 Agent/ }));
    click('編輯');
    change('指示（必填）', '不同 Agent 的草稿');
    field('指示（必填）').focus();
    await act(async () => { release(); await held; });
    expect(document.activeElement).toBe(field('指示（必填）'));
    expect(field('指示（必填）').value).toBe('不同 Agent 的草稿');
    expect(screen.queryByText(/已儲存「規劃 Agent」/)).toBeNull();
    fireEvent.click(list().getByRole('button', { name: /規劃 Agent/ }));
    await screen.findByText(/已儲存「規劃 Agent」/);
  });

  it('shows deletion target, disables unsupported deletion, and restores keyboard focus on cancel', () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const send = vi.spyOn(repository, 'save');
    render(<CatalogHarness repository={repository} />);
    const trigger = screen.getByRole('button', { name: '刪除' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '刪除「規劃 Agent」？' });
    expect(within(dialog).getByText(planner.id)).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '確認刪除（尚未提供）' }).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(repository.getSnapshot()).toHaveLength(4);
    expect(send).not.toHaveBeenCalled();
  });

  it('closes deletion once through the native cancel event after Escape', () => {
    const close = vi.fn();
    render(<DeleteConfirmation agent={planner} onClose={close} />);
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('clears the deletion target when leaving Agents and focuses the destination page', () => {
    render(<App />);
    click('刪除');
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Native dialog blocks pointer navigation; a route change can still arrive from history.
    act(() => {
      window.history.pushState(null, '', '/#/workbench');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '工作台', level: 1 }));
    fireEvent.click(screen.getByRole('link', { name: 'Agent 管理' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: planner.name }));
  });

  it('keeps App selection, creation, copying and history focus inside the Agent editor', () => {
    render(<App />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: planner.name }));
    fireEvent.click(list().getByRole('button', { name: /實作 Agent/ }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: builder.name }));
    click('複製');
    expect(document.activeElement).toBe(field('名稱（必填）'));
    expect(field('名稱（必填）').value).toBe(`${builder.name}（複本）`);
    click('＋ 建立 Agent');
    expect(document.activeElement).toBe(field('名稱（必填）'));
    expect(field('名稱（必填）').value).toBe('');
    act(() => {
      window.history.pushState(null, '', `/#/agents/${builder.id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: builder.name }));
    click('編輯');
    expect(document.activeElement).toBe(field('名稱（必填）'));
    click('取消編輯');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: builder.name }));
  });

  it('scrolls selected records and appended drafts into view, including on page re-entry', () => {
    const scroll = vi.fn();
    // jsdom has no layout/scrollIntoView; record which DOM element requests visibility.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    try {
      render(<App />);
      const expectSelectedScroll = () => {
        const selected = screen.getByRole('navigation', { name: 'Agent 清單' }).querySelector('[aria-current="true"]');
        expect(scroll.mock.contexts.at(-1)).toBe(selected);
        expect(scroll.mock.calls.at(-1)).toEqual([{ block: 'nearest' }]);
      };
      expectSelectedScroll();
      fireEvent.click(list().getByRole('button', { name: /實作 Agent/ }));
      expectSelectedScroll();
      click('複製');
      expectSelectedScroll();
      click('＋ 建立 Agent');
      expectSelectedScroll();
      expect(list().getAllByRole('button').at(-1)?.getAttribute('aria-current')).toBe('true');
      fireEvent.click(screen.getByRole('link', { name: '工作台' }));
      fireEvent.click(screen.getByRole('link', { name: 'Agent 管理' }));
      expectSelectedScroll();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('exercises revision conflict from the demo App while preserving local edits', async () => {
    const before = JSON.stringify(fixtureSnapshot);
    render(<App />);
    click('編輯');
    change('指示（必填）', 'App 裡的未儲存草稿');
    fireEvent.click(screen.getByText('示意模式測試'));
    click('模擬他人已更新此 Agent');
    await screen.findByText(/版本已變更：草稿基於 revision 1，目前為 2/);
    const alert = screen.getByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.getByRole('form', { name: 'Agent 編輯表單' }).firstElementChild).toBe(alert);
    expect(field('指示（必填）').value).toBe('App 裡的未儲存草稿');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(true);
    fireEvent.click(screen.getByText('比對目前已儲存版本'));
    expect(within(alert).getByText(planner.instructions)).toBeTruthy();
    click('已比對，保留草稿並以 revision 2 重新編輯');
    click('儲存');
    await screen.findByText(/已儲存「規劃 Agent」，revision 3/);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: planner.name }));
    expect(screen.getByText('App 裡的未儲存草稿')).toBeTruthy();
    expect(JSON.stringify(fixtureSnapshot)).toBe(before);
  });

  it('wires one-shot demo failure in App and clears it when the edit is cancelled', async () => {
    render(<App />);
    click('編輯');
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    click('取消編輯');
    click('編輯');
    click('儲存');
    await screen.findByText(/已儲存「規劃 Agent」，revision 2/);
    click('編輯');
    fireEvent.click(screen.getByText('示意模式測試'));
    fireEvent.click(screen.getByRole('checkbox', { name: '下次儲存模擬失敗' }));
    click('儲存');
    await screen.findByText(/模擬儲存失敗；資料未變更/);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    click('儲存');
    await screen.findByText(/已儲存「規劃 Agent」，revision 3/);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: planner.name }));
  });

  it('does not steal focus when a save completes after leaving the Agent page', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const save = repository.save;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repository, 'save').mockImplementation(async command => { await held; return save(command); });
    const props = { repository, selectedId: planner.id, onSelect: vi.fn() };
    const view = render(<><button>頁外焦點</button><AgentCatalog {...props} visible /></>);
    click('編輯');
    click('儲存');
    view.rerender(<><button>頁外焦點</button><AgentCatalog {...props} visible={false} /></>);
    const outside = screen.getByRole('button', { name: '頁外焦點' });
    outside.focus();
    await act(async () => { release(); await held; });
    expect(repository.getSnapshot()[0]?.revision).toBe(2);
    expect(document.activeElement).toBe(outside);
  });

  it.each(['missing-agent', '%E0%A4%A'])('reports missing or malformed ID %s without silently selecting a different record', id => {
    window.history.replaceState(null, '', `/#/agents/${id}`);
    render(<App />);
    expect(screen.getByRole('heading', { name: '找不到指定的 Agent' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '編輯' })).toBeNull();
    expect(screen.getByText(`Agent ID：${id}`)).toBeTruthy();
  });

  it('makes a saved new definition available in the ordinary session picker', async () => {
    render(<App />);
    click('＋ 建立 Agent');
    change('名稱（必填）', '使用者新角色');
    change('指示（必填）', '使用者新指示');
    click('儲存');
    await screen.findByText(/已儲存「使用者新角色」/);
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    expect(within(screen.getByRole('combobox', { name: 'Agent' })).getByRole('option', { name: '使用者新角色' })).toBeTruthy();
  });

  it('retains drafts when the save facade rejects unexpectedly', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    vi.spyOn(repository, 'save').mockRejectedValue(new Error('unavailable'));
    render(<CatalogHarness repository={repository} />);
    click('編輯');
    change('指示（必填）', '保留');
    click('儲存');
    await screen.findByText(/儲存服務無法回應，草稿仍保留/);
    expect(field('指示（必填）').value).toBe('保留');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(false));
  });
});

describe('Agent mock revision boundary', () => {
  it('injects one-shot demo failures per Agent without extending save commands', async () => {
    const { repository, controls } = createAgentDemo(fixtureSnapshot.agents);
    controls.setSaveFailure(planner.id, true);
    expect(await repository.save(agentSaveCommand(builder, builder.revision))).toMatchObject({ ok: true });
    const command = agentSaveCommand(planner, planner.revision);
    const before = repository.getSnapshot();
    expect(await repository.save(command)).toMatchObject({ ok: false, code: 'storage_failed', requestId: command.requestId });
    expect(repository.getSnapshot()).toBe(before);
    expect(await repository.save(command)).toMatchObject({ ok: true, revision: 2 });
  });

  it('accepts only one of two saves from the same revision', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const first = agentSaveCommand({ ...planner, instructions: '第一份修改' }, planner.revision);
    const second = agentSaveCommand({ ...planner, instructions: '第二份修改' }, planner.revision);
    const results = await Promise.all([repository.save(first), repository.save(second)]);
    expect(results[0]).toMatchObject({ ok: true, requestId: first.requestId, revision: 2 });
    expect(results[1]).toMatchObject({ ok: false, requestId: second.requestId, code: 'stale_revision', mayHaveSideEffects: false });
    expect(repository.getSnapshot()[0]?.instructions).toBe('第一份修改');
  });

  it('rejects duplicate creates, missing edits and invalid input without changing records', async () => {
    const repository = createAgentRepository(fixtureSnapshot.agents);
    const before = repository.getSnapshot();
    const cases: [AgentDefinition, number | null, Extract<CommandResult, { ok: false }>['code']][] = [
      [planner, null, 'already_exists'],
      [{ ...planner, id: AgentId.parse('missing-agent') }, 1, 'not_found'],
      [{ ...planner, name: ' ' }, 1, 'invalid_request'],
    ];
    for (const [agent, revision, code] of cases) {
      expect(await repository.save(agentSaveCommand(agent, revision))).toMatchObject({ ok: false, code });
    }
    expect(repository.getSnapshot()).toBe(before);
  });
});

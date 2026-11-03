// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { fakeBridge } from '../ipc-test-helpers';
import { nextAutoFolder } from './demo-data';

const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const row = (title: string) => sidebar().getByRole('button', { name: title });
const pane = (title: string) => within(screen.getByRole('region', { name: `對話：${title}` }));
const open = (query: string) => { window.history.replaceState(null, '', `/?${query}`); return render(<App />); };

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  localStorage.clear();
});
afterEach(() => { cleanup(); delete window.awg; vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('T047 v0.4 shell switch', () => {
  it('keeps the current shell without ?shell=v4', () => {
    open('');
    expect(screen.getByRole('navigation', { name: '主要導覽' })).toBeTruthy();
    expect(screen.queryByTestId('shell-v4')).toBeNull();
  });
  it('shows the new shell in demo mode with ?shell=v4, without top navigation', () => {
    open('shell=v4');
    expect(screen.getByTestId('shell-v4')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '主要導覽' })).toBeNull();
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
  });
  it('ignores ?shell=v4 when connected to the app service', () => {
    window.awg = fakeBridge().bridge;
    open('shell=v4');
    expect(screen.queryByTestId('shell-v4')).toBeNull();
  });
});

describe('T047 new chat', () => {
  it('defaults to an auto-created dated folder and no Agent', () => {
    open('shell=v4');
    const name = nextAutoFolder(new Date());
    expect(screen.getByRole('button', { name: `工作資料夾：自動建立：${name}` })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agent：無' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
  });
  it('opens a chip menu with Enter, closes it with Esc and returns focus', () => {
    open('shell=v4');
    const chip = screen.getByRole('button', { name: 'Agent：無' });
    fireEvent.keyDown(chip, { key: 'Enter' });
    const menu = screen.getByRole('menu', { name: 'Agent：無' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: '規劃 Agent' }));
    expect(screen.getByRole('button', { name: 'Agent：規劃 Agent' })).toBeTruthy();
    const folder = screen.getByRole('button', { name: /^工作資料夾/ });
    fireEvent.click(folder);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(folder);
  });
  it('keeps the draft and explains the demo on send', () => {
    open('shell=v4');
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /輸入訊息/ });
    fireEvent.change(box, { target: { value: '幫我整理會議紀錄' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('status').textContent).toContain('session.create');
    expect(box.value).toBe('幫我整理會議紀錄');
  });
  it('numbers auto folders by day and grows past 999', () => {
    const day = new Date(2026, 10, 4);
    expect(nextAutoFolder(day)).toBe('2026-11-04-001');
    expect(nextAutoFolder(day, ['2026-11-04-001', '2026-11-03-007', '2026-11-04-002'])).toBe('2026-11-04-003');
    expect(nextAutoFolder(day, ['2026-11-04-999'])).toBe('2026-11-04-1000');
  });
});

describe('T047 sidebar', () => {
  it('collapses to a rail and expands again', () => {
    open('shell=v4');
    fireEvent.click(sidebar().getByRole('button', { name: '收合側欄' }));
    expect(screen.queryByRole('complementary', { name: '側欄' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展開側欄' }));
    expect(row('規劃想法')).toBeTruthy();
  });
  it('folds a parent and moves with the arrow keys', () => {
    open('shell=v4');
    const parent = row('規劃想法');
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('參考資料整理'));
    fireEvent.keyDown(parent, { key: 'ArrowLeft' });
    expect(sidebar().queryByRole('button', { name: '參考資料整理' })).toBeNull();
    fireEvent.keyDown(parent, { key: 'ArrowRight' });
    expect(row('參考資料整理')).toBeTruthy();
  });
  it('filters by search text', () => {
    open('shell=v4');
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'review' } });
    expect(sidebar().getByRole('region', { name: '搜尋結果' })).toBeTruthy();
    expect(sidebar().queryByRole('button', { name: '規劃想法' })).toBeNull();
    expect(row('Review：表單驗證')).toBeTruthy();
  });
  it('opens the context menu by right click or Shift+F10, closes on Esc and returns focus', () => {
    open('shell=v4&page=chat&session=s-wf-build-b');
    const target = row('規劃想法');
    fireEvent.contextMenu(target, { clientX: 40, clientY: 200 });
    const menu = screen.getByRole('menu', { name: '規劃想法 的選單' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: '開啟' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: '在分割畫面開啟' }));
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(target);
    fireEvent.keyDown(target, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: '規劃想法 的選單' })).toBeTruthy();
  });
  it('opens a second conversation side by side from the context menu, and closes one side', () => {
    open('shell=v4&page=chat&session=s-wf-build-b');
    fireEvent.contextMenu(row('規劃想法'));
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(pane('實作：Session 儲存')).toBeTruthy();
    expect(pane('規劃想法')).toBeTruthy();
    fireEvent.click(pane('規劃想法').getByRole('button', { name: '關閉分割畫面：規劃想法' }));
    expect(screen.queryByRole('region', { name: '對話：規劃想法' })).toBeNull();
  });
  it('pins a session from the context menu', () => {
    open('shell=v4');
    fireEvent.contextMenu(row('參考資料整理'));
    fireEvent.click(screen.getByRole('menuitem', { name: '釘選' }));
    expect(within(sidebar().getByRole('region', { name: '釘選' })).getByRole('button', { name: '參考資料整理' })).toBeTruthy();
  });
});

describe('T047 conversation', () => {
  it('keeps tool calls folded, the detail pane closed, and the sub-task list under the last message', () => {
    open('shell=v4&page=chat&session=s-wf-build-b');
    const chat = pane('實作：Session 儲存');
    const tools = chat.getByText('使用了 3 個工具').closest('details')!;
    expect(tools.open).toBe(false);
    expect(screen.queryByRole('complementary', { name: '細節窗格' })).toBeNull();
    expect(chat.getByRole('region', { name: '子任務' }).textContent).toContain('1/2 完成');
    fireEvent.click(chat.getByRole('button', { name: '開啟細節窗格' }));
    expect(screen.getByRole('complementary', { name: '細節窗格' })).toBeTruthy();
    fireEvent.click(chat.getAllByRole('button', { name: '關閉細節窗格' })[0]!);
    expect(screen.queryByRole('complementary', { name: '細節窗格' })).toBeNull();
  });
  it('answers an escalation in place (demo: nothing is sent)', () => {
    open('shell=v4&page=chat&session=s-wf-build-b');
    const card = within(screen.getByRole('article', { name: '待處理：要求執行 git push' }));
    fireEvent.click(card.getByRole('button', { name: '核准' }));
    expect(card.getByText('示意：已核准，未送出指令。')).toBeTruthy();
    expect(screen.getAllByRole('status').some(item => item.textContent?.includes('escalation.respond'))).toBe(true);
  });
  it('renames with Enter and cancels with Esc', () => {
    open('shell=v4&page=chat&session=s-plan-notes');
    fireEvent.click(screen.getByTitle('點一下改名'));
    let input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.change(input, { target: { value: '新版規劃' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sidebar().getByRole('button', { name: '新版規劃' })).toBeTruthy();
    fireEvent.click(screen.getByTitle('點一下改名'));
    input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session 標題' });
    fireEvent.change(input, { target: { value: '不要這個' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Session 標題' })).toBeNull();
    expect(sidebar().queryByRole('button', { name: '不要這個' })).toBeNull();
  });
  it('shows the owning workflow with its menu, and locks Agent and tool for a workflow session', () => {
    open('shell=v4&page=chat&session=s-wf-build-b');
    const badge = screen.getByRole('button', { name: /Workflow：登入功能/ });
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole('menuitem', { name: '查看流程進度' }));
    expect(screen.queryByRole('region', { name: '對話：實作：Session 儲存' })).toBeNull();
  });
});

describe('T047 settings and workflow start', () => {
  it('has the default work folder location with reset', () => {
    open('shell=v4&page=settings');
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: '預設工作資料夾位置' });
    expect(field.value).toBe('%USERPROFILE%\\AgentWorkflowGui');
    fireEvent.change(field, { target: { value: 'D:\\agents' } });
    fireEvent.click(screen.getByRole('button', { name: '還原預設' }));
    expect(field.value).toBe('%USERPROFILE%\\AgentWorkflowGui');
  });
  it('switches the theme from settings', () => {
    open('shell=v4&page=settings');
    fireEvent.click(screen.getByRole('radio', { name: '淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('splits work and project folders, and requires the project folder in worktree mode', () => {
    open('shell=v4&page=workflow-start');
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: '工作資料夾' }).placeholder).toContain('自動建立');
    const project = screen.getByRole<HTMLInputElement>('combobox', { name: '專案資料夾' });
    expect(project.getAttribute('aria-required')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: '標題' }), { target: { value: '登入功能' } });
    fireEvent.change(screen.getByRole('textbox', { name: '第一則訊息' }), { target: { value: '開始' } });
    fireEvent.click(screen.getByRole('checkbox'));
    const startButton = screen.getByRole<HTMLButtonElement>('button', { name: '開始' });
    expect(startButton.disabled).toBe(true);
    fireEvent.change(project, { target: { value: 'E:/work' } });
    expect(startButton.disabled).toBe(false);
  });
});

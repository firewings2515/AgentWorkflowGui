// @vitest-environment jsdom
// T004 workbench behaviour, moved to the v0.4 shell by T051 (demo mode, fixture data). What only the old layout had
// (top navigation, ＋ 新增 tab, the composer help) is gone; the rest is checked on the new panes and sidebar.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, APP_NAME, THEME_KEY } from './App';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { transcriptGeometry } from './transcript-test-geometry';

const pane = (id = 'pane-1') => within(document.querySelector<HTMLElement>(`[data-pane="${id}"]`)!);
const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const selectSession = (title: string | RegExp) => fireEvent.click(sidebar().getByRole('button', { name: title }));
const split = (title: string) => { fireEvent.contextMenu(sidebar().getByRole('button', { name: title })); fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' })); };
const details = (id = 'pane-1') => fireEvent.click(pane(id).getByRole('button', { name: '開啟細節窗格' }));
const tab = (name: string, id = 'pane-1') => fireEvent.click(pane(id).getByRole('tab', { name }));
const draft = (id = 'pane-1') => pane(id).getByRole<HTMLTextAreaElement>('textbox', { name: /^回覆 / });
const notice = () => document.querySelector('.v4-notice')?.textContent ?? '';
const modeButton = (name: '對話' | 'Workflow') => sidebar().getByRole('button', { name: new RegExp(`^${name}(，有待處理項目)?$`) });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  localStorage.clear();
  window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('T004 workbench behaviour on the v0.4 shell', () => {
  it('keeps the composer to one input with chips: folder shown, Agent and Model selectable', () => {
    render(<App />);
    expect(draft().rows).toBe(3);
    expect(pane().getByTitle('工作資料夾：E:/work/demo')).toBeTruthy();
    expect(pane().getByRole('button', { name: 'Agent：規劃 Agent' })).toBeTruthy();
    expect(pane().getByRole('button', { name: /^Model：/ })).toBeTruthy();
    fireEvent.change(draft(), { target: { value: '保留草稿' } });
    expect(draft().value).toBe('保留草稿');
  });

  it('renders the fixture conversation, artifacts in the details and a single pane', () => {
    render(<App />);
    expect(sidebar().getByText('示意模式 · 未連接 runtime')).toBeTruthy();
    expect(screen.getAllByRole('region', { name: /^對話：/ })).toHaveLength(1);
    expect(pane().getByText('先整理成草稿，不要開始執行。')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: '細節窗格' })).toBeNull();
    details();
    expect(pane().getByRole('heading', { name: '輸入附件' })).toBeTruthy();
    expect(pane().getByText('182,044 bytes')).toBeTruthy();
    expect(pane().getByText('此 session 尚無已發布成果。')).toBeTruthy();
    expect(pane().getByRole('tab', { name: '成果／檔案' }).getAttribute('aria-selected')).toBe('true');
    expect(APP_NAME).toBe('AgentWorkflowGui');
  });

  it('collapses parents without changing the selected child, nested collapse state or fixture', () => {
    const before = JSON.stringify(fixtureSnapshot);
    render(<App />);
    selectSession('參考資料整理');
    fireEvent.click(sidebar().getByRole('button', { name: '收合 規劃想法' }));
    expect(sidebar().queryByRole('button', { name: '參考資料整理' })).toBeNull();
    expect(pane().getByRole('heading', { name: '參考資料整理' })).toBeTruthy();
    fireEvent.click(sidebar().getByRole('button', { name: '展開 規劃想法' }));
    expect(sidebar().getByRole('button', { name: '參考資料整理' })).toBeTruthy();
    fireEvent.click(modeButton('Workflow'));
    fireEvent.click(sidebar().getByRole('button', { name: '展開 登入功能' }));
    selectSession('Review：表單驗證');
    fireEvent.click(sidebar().getByRole('button', { name: '收合 實作：表單驗證' }));
    fireEvent.click(sidebar().getByRole('button', { name: '收合 登入功能' }));
    fireEvent.click(sidebar().getByRole('button', { name: '展開 登入功能' }));
    expect(sidebar().queryByRole('button', { name: 'Review：表單驗證' })).toBeNull();
    expect(sidebar().getByRole('button', { name: '展開 實作：表單驗證' })).toBeTruthy();
    expect(pane().getByRole('heading', { name: 'Review：表單驗證' })).toBeTruthy();
    expect(JSON.stringify(fixtureSnapshot)).toBe(before);
  });

  it('supports keyboard tree navigation and returns focus to the parent', () => {
    render(<App />);
    const root = sidebar().getByRole('button', { name: '規劃想法' });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    const child = sidebar().getByRole('button', { name: '參考資料整理' });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(sidebar().getByRole('button', { name: '展開 規劃想法' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('isolates pane drafts and details and restores a closed pane (WB-07, WB-08)', async () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '第一組草稿' } });
    details(); tab('Session 資訊');
    fireEvent.click(pane().getAllByRole('button', { name: '關閉細節窗格' })[0]!);
    split('參考資料整理');
    fireEvent.change(draft('pane-2'), { target: { value: '第二組草稿' } });
    details('pane-2'); tab('任務流程', 'pane-2');
    expect(draft().value).toBe('第一組草稿');
    expect(pane().queryByRole('tab')).toBeNull();
    fireEvent.click(pane('pane-2').getByRole('button', { name: '關閉分割畫面：參考資料整理' }));
    expect(document.querySelector('[data-pane="pane-2"]')).toBeNull();
    expect(sidebar().getByRole('button', { name: '參考資料整理' })).toBeTruthy();
    split('參考資料整理');
    expect(draft('pane-2').value).toBe('第二組草稿');
    // r1 P2: closing a side by keyboard leaves the focus in the remaining conversation, not on the page.
    const close = pane('pane-2').getByRole('button', { name: '關閉分割畫面：參考資料整理' });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(draft()));
    split('參考資料整理');
    expect(pane('pane-2').getByRole('tab', { name: '任務流程' }).getAttribute('aria-selected')).toBe('true');
    details();
    expect(pane().getByRole('tab', { name: 'Session 資訊' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps a session\'s demo Agent／Model choice and its own draft when switching sessions', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: 'A' } });
    fireEvent.click(pane().getByRole('button', { name: 'Agent：規劃 Agent' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '實作 Agent' }));
    fireEvent.click(pane().getByRole('button', { name: /^Model：/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Sonnet 5.5' }));
    selectSession('參考資料整理');
    expect(draft().value).toBe('');
    selectSession('規劃想法');
    expect(pane().getByRole('button', { name: 'Agent：實作 Agent' })).toBeTruthy();
    expect(pane().getByRole('button', { name: 'Model：Sonnet 5.5' })).toBeTruthy();
    expect(draft().value).toBe('A');
    expect(fixtureSnapshot.sessions[0]?.agent?.id).toBe('agent-planner');
  });

  it('preserves session draft and reading position across selection and pages', () => {
    transcriptGeometry().geometry.height = 100;
    render(<App />);
    fireEvent.change(draft(), { target: { value: '保留草稿' } });
    fireEvent.scroll(pane().getByLabelText('規劃想法 對話內容'), { target: { scrollTop: 125 } });
    selectSession('參考資料整理');
    expect(draft().value).toBe('');
    selectSession('規劃想法');
    expect(draft().value).toBe('保留草稿');
    expect(pane().getByLabelText('規劃想法 對話內容').scrollTop).toBe(125);
    fireEvent.click(modeButton('Workflow'));
    fireEvent.click(sidebar().getByRole('button', { name: '模板' }));
    expect(window.location.hash).toBe('#/workflows/wf-default/edit');
    expect(screen.getByRole('region', { name: 'Workflow 編輯內容' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '儲存 Workflow' })).toBeTruthy();
    fireEvent.click(sidebar().getByRole('button', { name: 'Agent' }));
    expect(window.location.hash).toBe('#/agents');
    fireEvent.click(modeButton('對話'));
    selectSession('規劃想法');
    expect(draft().value).toBe('保留草稿');
    expect(pane().getByLabelText('規劃想法 對話內容').scrollTop).toBe(125);
  });

  it('collapses the sidebar by itself when narrow, opens it as an overlay, and comes back when widened', () => {
    let narrow = true;
    const query = new EventTarget();
    Object.defineProperty(query, 'matches', { get: () => narrow });
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal('matchMedia', matchMedia);
    render(<App />);
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 900px)');
    expect(screen.queryByRole('complementary', { name: '側欄' })).toBeNull();
    fireEvent.change(draft(), { target: { value: '窄的時候' } });
    fireEvent.click(screen.getByRole('button', { name: '開啟側欄' }));
    selectSession('參考資料整理');
    // Opening a conversation closes the overlay.
    expect(screen.queryByRole('complementary', { name: '側欄' })).toBeNull();
    expect(pane().getByRole('heading', { name: '參考資料整理' })).toBeTruthy();
    act(() => { narrow = false; query.dispatchEvent(new Event('change')); });
    selectSession('規劃想法');
    expect(draft().value).toBe('窄的時候');
  });

  it('keeps the draft when leaving for the new chat and coming back', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '重新開啟' } });
    fireEvent.click(sidebar().getByRole('button', { name: '新對話' }));
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    selectSession('規劃想法');
    expect(draft().value).toBe('重新開啟');
  });

  it('locks a workflow Agent, keeps same-tool models selectable and returns from progress to the panes', () => {
    render(<App />);
    fireEvent.click(modeButton('Workflow'));
    fireEvent.click(sidebar().getByRole('button', { name: '展開 登入功能' }));
    split('實作：表單驗證');
    expect(pane('pane-2').getByText('Agent：實作 Agent · 鎖定')).toBeTruthy();
    fireEvent.click(pane('pane-2').getByRole('button', { name: /^Model：/ }));
    const items = screen.getAllByRole<HTMLButtonElement>('menuitemradio');
    expect(items.some(item => !item.disabled)).toBe(true);
    expect(items.filter(item => item.disabled).every(item => item.title === 'workflow 的 node 不能換工具')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(pane().queryByRole('button', { name: /Workflow：/ })).toBeNull();
    fireEvent.click(pane('pane-2').getByRole('button', { name: /Workflow：登入功能/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '查看流程進度' }));
    expect(window.location.hash).toBe('#/workflow-instances/inst-login');
    expect(screen.getByRole('heading', { name: '登入功能', level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回對話' }));
    expect(pane('pane-2').getByRole('heading', { name: '實作：表單驗證' })).toBeTruthy();
    expect(pane().getByRole('heading', { name: '規劃想法' })).toBeTruthy();
  });

  it('scopes attachment menus, outside dismissal, Escape and Ctrl+U to the pane', () => {
    render(<App />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(pane().getByRole('button', { name: '新增附件' }));
    expect(screen.getByRole('menuitem', { name: /Add files or photos/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pane().getByRole('button', { name: '新增附件' }));
    fireEvent.click(pane().getByRole('button', { name: '新增附件' }));
    fireEvent.pointerDown(pane().getByRole('heading', { name: '規劃想法' }));
    expect(screen.queryByRole('menu')).toBeNull();
    split('參考資料整理');
    fireEvent.click(pane('pane-2').getByRole('button', { name: '新增附件' }));
    expect(pane().queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder' }));
    expect(notice()).toContain('附件目標：參考資料整理');
    act(() => draft().focus());
    fireEvent.keyDown(draft(), { key: 'u', ctrlKey: true });
    expect(notice()).toContain('附件目標：規劃想法');
    expect(notice()).toContain('檔案／照片選擇器');
  });

  it('offers only targeted stop for running native agents and keeps their transcript out of the main one', () => {
    render(<App />);
    selectSession('參考資料整理');
    expect(pane().queryByText('refs/a.md 有三個重點：登入流程、錯誤訊息、session 期限。')).toBeNull();
    details(); tab('任務流程');
    expect(pane().getByRole('region', { name: '原生子 agent 樹' })).toBeTruthy();
    expect(pane().getAllByText('讀取 refs/a.md').length).toBeGreaterThan(0);
    expect(pane().getAllByText('讀取 refs/b.md').length).toBeGreaterThan(0);
    expect(pane().getAllByRole('button', { name: '停止這個子 agent' })).toHaveLength(1);
    fireEvent.click(pane().getByRole('button', { name: '停止這個子 agent' }));
    expect(notice()).toContain('停止「讀取 refs/b.md」（參考資料整理）');
    expect(fixtureSnapshot.nativeTasks.find(task => task.id === 'nt-2')?.state).toBe('running');
  });

  it('uses configured-only Codex wording and explicitly unknown peer delivery', () => {
    render(<App />);
    selectSession(/^規劃想法（轉交 Codex）/);
    details(); tab('Session 資訊');
    expect(pane().getByText('已設定 gpt-6-astra')).toBeTruthy();
    expect(pane().queryByText(/實際使用/)).toBeNull();
    expect(pane().getByText('尚無用量回報')).toBeTruthy();
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'Session 儲存' } });
    fireEvent.click(sidebar().getByRole('button', { name: /^實作：Session 儲存/ }));
    // The detail pane is kept per session, closed for one not opened yet.
    details(); tab('Session 資訊');
    expect(pane().getByText(/^改用通知：gpt-6-astra → gpt-6-luna；暫時容量不足（非逐 turn.*證據）$/)).toBeTruthy();
    tab('跨 session 訊息');
    expect(pane().getByText(/送達結果未知/)).toBeTruthy();
    fireEvent.click(pane().getByRole('button', { name: '登入功能（root）' }));
    expect(pane().getByRole('heading', { name: '登入功能（root）' })).toBeTruthy();
  });

  it('does not silently switch runtime and hides catalog entries marked hidden', () => {
    render(<App />);
    fireEvent.click(pane().getByRole('button', { name: /^Model：/ }));
    expect(screen.queryByRole('menuitemradio', { name: /Preview/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^GPT-6 Astra/ }));
    expect(screen.getByRole('dialog').textContent).toContain('轉交到新的 session');
    expect(pane().getByRole('button', { name: 'Model：Opus 5.5' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回對話' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(pane().getByRole('button', { name: 'Model：Opus 5.5' })).toBeTruthy();
  });

  it('retains unsent text and disables sending during an active turn', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '尚未送出的訊息' } });
    fireEvent.click(pane().getByRole('button', { name: '送出' }));
    expect(draft().value).toBe('尚未送出的訊息');
    expect(notice()).toContain('未送出訊息');
    selectSession('參考資料整理');
    fireEvent.change(draft(), { target: { value: '等 turn 完成' } });
    expect(pane().getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    expect(pane().getByText(/此 session 有執行中的 turn/)).toBeTruthy();
  });

  it('defaults to dark, persists light and survives unavailable storage', () => {
    const first = render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(sidebar().getByRole('button', { name: '切換成淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    first.unmount();
    const second = render(<App />);
    expect(document.documentElement.dataset.theme).toBe('light');
    second.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.click(sidebar().getByRole('button', { name: '切換成淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('shows missing instances explicitly instead of opening a different one', () => {
    window.history.replaceState(null, '', '/#/workflow-instances/missing-instance');
    render(<App />);
    expect(screen.getByRole('heading', { name: '找不到指定的 Workflow 執行群組' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '登入功能' })).toBeNull();
  });

  it('supports keyboard selection of detail tabs', () => {
    render(<App />);
    details();
    fireEvent.keyDown(pane().getByRole('tab', { name: '成果／檔案' }), { key: 'ArrowRight' });
    const tasks = pane().getByRole('tab', { name: '任務流程' });
    expect(tasks.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tasks);
  });
});

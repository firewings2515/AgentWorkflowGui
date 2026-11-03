// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, APP_NAME, THEME_KEY } from './App';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { transcriptGeometry } from './transcript-test-geometry';

const pane = (id = 'view-1') => within(screen.getByRole('region', { name: `工作區 ${id}` }));
const selectSession = (title: string) => fireEvent.click(within(screen.getByRole('complementary', { name: 'Session 清單' })).getByRole('button', { name: title }));
const tab = (name: string, id = 'view-1') => fireEvent.click(pane(id).getByRole('tab', { name }));
const draft = (id = 'view-1') => pane(id).getByRole<HTMLTextAreaElement>('textbox');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  localStorage.clear();
  window.history.replaceState(null, '', '/#/workbench');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('T004 工作台外殼', () => {
  it('keeps composer help collapsed and the draft compact without hiding model selectors', () => {
    render(<App />);
    const help = pane().getByText('模型狀態與切換說明').closest('details')!;
    expect(help.open).toBe(false);
    expect(draft().rows).toBe(2);
    expect(pane().getByRole('combobox', { name: 'Model' })).toBeTruthy();
    fireEvent.change(draft(), { target: { value: '保留草稿' } });
    fireEvent.click(pane().getByText('模型狀態與切換說明'));
    expect(help.open).toBe(true);
    expect(draft().value).toBe('保留草稿');
  });
  it('renders fixture conversation, artifacts and a single default workspace', () => {
    render(<App />);
    expect(screen.getByText(APP_NAME)).toBeTruthy();
    expect(screen.getAllByRole('region', { name: /^工作區 view-/ })).toHaveLength(1);
    expect(pane().getByText('先整理成草稿，不要開始執行。')).toBeTruthy();
    expect(pane().getByRole('heading', { name: '輸入附件' })).toBeTruthy();
    expect(pane().getByText('182,044 bytes')).toBeTruthy();
    expect(pane().getByText('此 session 尚無已發布成果。')).toBeTruthy();
    expect(pane().getByRole('tab', { name: '成果／檔案' }).getAttribute('aria-selected')).toBe('true');
  });

  it('collapses roots without changing selected child, nested collapse state or fixture', () => {
    const before = JSON.stringify(fixtureSnapshot);
    render(<App />);
    selectSession('參考資料整理 執行中');
    fireEvent.click(screen.getByRole('button', { name: '收合 規劃想法' }));
    expect(screen.queryByRole('button', { name: /^參考資料整理/ })).toBeNull();
    expect(pane().getByRole('heading', { name: '參考資料整理' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展開 規劃想法' }));
    expect(screen.getByRole('button', { name: /^參考資料整理/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    selectSession('Review：表單驗證 執行中');
    fireEvent.click(screen.getByRole('button', { name: '收合 實作：表單驗證' }));
    fireEvent.click(screen.getByRole('button', { name: '收合 登入功能（root）' }));
    fireEvent.click(screen.getByRole('button', { name: '展開 登入功能（root）' }));
    expect(screen.queryByRole('button', { name: /^Review：表單驗證/ })).toBeNull();
    expect(screen.getByRole('button', { name: '展開 實作：表單驗證' })).toBeTruthy();
    expect(pane().getByRole('heading', { name: 'Review：表單驗證' })).toBeTruthy();
    expect(JSON.stringify(fixtureSnapshot)).toBe(before);
  });

  it('supports keyboard tree navigation and returns focus to the parent', () => {
    render(<App />);
    const root = screen.getByRole('button', { name: '規劃想法 閒置' });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowRight' });
    const child = screen.getByRole('button', { name: /^參考資料整理/ });
    expect(document.activeElement).toBe(child);
    fireEvent.keyDown(child, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(root);
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(screen.getByRole('button', { name: '展開 規劃想法' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('isolates pane drafts and details and restores closed panes', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '第一組草稿' } });
    tab('Session 資訊');
    fireEvent.click(pane().getByRole('button', { name: '收合細節' }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    fireEvent.change(draft('view-2'), { target: { value: '第二組草稿' } });
    tab('任務流程', 'view-2');
    expect(draft().value).toBe('第一組草稿');
    expect(pane().queryByRole('tab')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '關閉工作區 view-2' }));
    expect(screen.getByRole('button', { name: /^參考資料整理/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    expect(draft('view-2').value).toBe('第二組草稿');
    expect(pane('view-2').getByRole('tab', { name: '任務流程' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(pane().getByRole('button', { name: '展開細節' }));
    expect(pane().getByRole('tab', { name: 'Session 資訊' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shares session model/agent choices while preserving separate drafts', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: 'A' } });
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    selectSession('規劃想法 閒置');
    fireEvent.change(draft('view-2'), { target: { value: 'B' } });
    fireEvent.change(pane('view-2').getByRole('combobox', { name: 'Agent' }), { target: { value: 'agent-builder' } });
    fireEvent.change(pane('view-2').getByRole('combobox', { name: 'Model' }), { target: { value: 'claude:claude-sonnet-5-5' } });
    expect(pane().getByRole<HTMLSelectElement>('combobox', { name: 'Agent' }).value).toBe('agent-builder');
    expect(pane().getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).value).toBe('claude:claude-sonnet-5-5');
    expect(draft().value).toBe('A');
    expect(draft('view-2').value).toBe('B');
    expect(fixtureSnapshot.sessions[0]?.agent?.id).toBe('agent-planner');
  });

  it('preserves session draft and scroll across selection and page navigation', () => {
    transcriptGeometry().geometry.height = 100;
    render(<App />);
    fireEvent.change(draft(), { target: { value: '保留草稿' } });
    fireEvent.scroll(pane().getByLabelText('規劃想法 對話'), { target: { scrollTop: 125 } });
    selectSession('參考資料整理 執行中');
    expect(draft().value).toBe('');
    selectSession('規劃想法 閒置');
    expect(draft().value).toBe('保留草稿');
    expect(pane().getByLabelText('規劃想法 對話').scrollTop).toBe(125);
    fireEvent.click(screen.getByRole('link', { name: 'Workflow 編輯器' }));
    expect(window.location.hash).toBe('#/workflows/wf-default/edit');
    expect(screen.getByRole('region', { name: 'Workflow 編輯內容' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '儲存 Workflow' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Agent 管理' }));
    expect(window.location.hash).toBe('#/agents');
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    expect(draft().value).toBe('保留草稿');
  });

  it('restores scroll after a hidden page resets DOM position without overwriting saved state', () => {
    transcriptGeometry().geometry.height = 100;
    render(<App />);
    const transcript = pane().getByLabelText('規劃想法 對話');
    fireEvent.scroll(transcript, { target: { scrollTop: 145 } });
    fireEvent.click(screen.getByRole('link', { name: 'Agent 管理' }));
    // jsdom has no layout: explicitly simulate the browser hiding the scroll box.
    fireEvent.scroll(transcript, { target: { scrollTop: 0 } });
    fireEvent.click(screen.getByRole('link', { name: '工作台' }));
    expect(transcript.scrollTop).toBe(145);
  });

  it('switches narrow workspaces independently and restores scroll on switching and widening', () => {
    transcriptGeometry().geometry.height = 100;
    let narrow = true;
    const query = new EventTarget();
    Object.defineProperty(query, 'matches', { get: () => narrow });
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal('matchMedia', matchMedia);
    render(<App />);
    const first = screen.getByRole('region', { name: '工作區 view-1' });
    const firstTranscript = pane().getByLabelText('規劃想法 對話');
    fireEvent.change(draft(), { target: { value: '第一組草稿' } });
    fireEvent.scroll(firstTranscript, { target: { scrollTop: 145 } });
    tab('Session 資訊');
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    selectSession('規劃想法 閒置');
    const second = screen.getByRole('region', { name: '工作區 view-2' });
    const secondTranscript = pane('view-2').getByLabelText('規劃想法 對話');
    fireEvent.change(draft('view-2'), { target: { value: '第二組草稿' } });
    fireEvent.scroll(secondTranscript, { target: { scrollTop: 83 } });
    const switches = within(screen.getByLabelText('可見工作區')).getAllByRole('button');
    expect(switches.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(first.dataset.active).toBe('false');
    expect(second.dataset.active).toBe('true');
    fireEvent.scroll(firstTranscript, { target: { scrollTop: 0 } });
    fireEvent.click(switches[0]!);
    expect(switches.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(first.dataset.active).toBe('true');
    expect(second.dataset.active).toBe('false');
    expect(firstTranscript.scrollTop).toBe(145);
    expect(draft().value).toBe('第一組草稿');
    expect(pane().getByRole('tab', { name: 'Session 資訊' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.scroll(secondTranscript, { target: { scrollTop: 0 } });
    fireEvent.click(switches[1]!);
    expect(secondTranscript.scrollTop).toBe(83);
    expect(draft('view-2').value).toBe('第二組草稿');
    expect(pane('view-2').getByRole('tab', { name: '成果／檔案' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.scroll(firstTranscript, { target: { scrollTop: 0 } });
    act(() => { narrow = false; query.dispatchEvent(new Event('change')); });
    expect(firstTranscript.scrollTop).toBe(145);
    expect(secondTranscript.scrollTop).toBe(83);
    expect(matchMedia).toHaveBeenCalledWith('(max-width: 1250px)');
  });

  it('closes the final view and reopens the session with its draft intact', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '重新開啟' } });
    fireEvent.click(screen.getByRole('button', { name: '關閉工作區 view-1' }));
    expect(screen.getByRole('heading', { name: '開啟一段對話' })).toBeTruthy();
    selectSession('規劃想法 閒置');
    expect(draft().value).toBe('重新開啟');
  });

  it('locks workflow Agent, keeps Model selectable and returns progress to the source pane', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    selectSession('實作：表單驗證 閒置');
    expect(pane('view-2').getByRole<HTMLSelectElement>('combobox', { name: 'Agent' }).disabled).toBe(true);
    expect(pane('view-2').getByText('Agent · 已鎖定')).toBeTruthy();
    expect(pane('view-2').getByRole('combobox', { name: 'Agent', description: /Workflow Agent 已鎖定/ })).toBeTruthy();
    expect(pane('view-2').getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).disabled).toBe(false);
    expect(pane().queryByRole('button', { name: '所屬 Workflow 選單' })).toBeNull();
    fireEvent.click(pane('view-2').getByRole('button', { name: '所屬 Workflow 選單' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '查看流程進度' }));
    expect(window.location.hash).toBe('#/workflow-instances/inst-login');
    expect(screen.getByRole('heading', { name: '登入功能', level: 2 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(pane('view-2').getByRole('heading', { name: '實作：表單驗證' })).toBeTruthy();
    expect(pane().getByRole('heading', { name: '規劃想法' })).toBeTruthy();
  });

  it('scopes attachment menus, outside dismissal, Escape and Ctrl+U to the workspace', () => {
    render(<App />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(pane().getByRole('button', { name: '新增附件' }));
    expect(screen.getByRole('menuitem', { name: /Add files or photos/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pane().getByRole('button', { name: '新增附件' }));
    fireEvent.click(pane().getByRole('button', { name: '新增附件' }));
    fireEvent.pointerDown(screen.getByRole('heading', { name: '工作台' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ 新增 tab' }));
    fireEvent.click(pane('view-2').getByRole('button', { name: '新增附件' }));
    expect(pane().queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add folder' }));
    expect(screen.getByRole('status').textContent).toContain('附件目標：參考資料整理');
    act(() => draft().focus());
    fireEvent.keyDown(draft(), { key: 'u', ctrlKey: true });
    expect(screen.getByRole('status').textContent).toContain('附件目標：規劃想法');
    expect(screen.getByRole('status').textContent).toContain('檔案／照片選擇器');
  });

  it('offers only targeted stop for running native agents and separates their transcript', () => {
    render(<App />);
    selectSession('參考資料整理 執行中');
    expect(pane().queryByText('refs/a.md 有三個重點：登入流程、錯誤訊息、session 期限。')).toBeNull();
    tab('任務流程');
    expect(pane().getByRole('region', { name: '原生子 agent 樹' })).toBeTruthy();
    expect(pane().getByText('讀取 refs/a.md')).toBeTruthy();
    expect(pane().getByText('讀取 refs/b.md')).toBeTruthy();
    expect(pane().getAllByRole('button', { name: '停止這個子 agent' })).toHaveLength(1);
    expect(pane().queryByRole('button', { name: '開啟對話' })).toBeNull();
    fireEvent.click(pane().getByRole('button', { name: '停止這個子 agent' }));
    expect(screen.getByRole('status').textContent).toContain('停止「讀取 refs/b.md」（參考資料整理）');
    expect(fixtureSnapshot.nativeTasks.find(task => task.id === 'nt-2')?.state).toBe('running');
  });

  it('uses configured-only Codex wording and explicitly unknown peer delivery', () => {
    render(<App />);
    selectSession('規劃想法（轉交 Codex） 待確認');
    tab('Session 資訊');
    expect(pane().getByText('已設定 gpt-6-astra')).toBeTruthy();
    expect(pane().queryByText(/實際使用/)).toBeNull();
    expect(pane().getByText('尚無用量回報')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    selectSession('實作：Session 儲存 執行中');
    tab('Session 資訊');
    expect(pane().getByText(/^改用通知：gpt-6-astra → gpt-6-luna；暫時容量不足（非逐 turn.*證據）$/)).toBeTruthy();
    tab('跨 session 訊息');
    expect(pane().getByText(/送達結果未知/)).toBeTruthy();
    fireEvent.click(pane().getByRole('button', { name: '登入功能（root）' }));
    expect(pane().getByRole('heading', { name: '登入功能（root）' })).toBeTruthy();
  });

  it('does not silently switch runtime and hides catalog entries marked hidden', () => {
    render(<App />);
    const model = pane().getByRole<HTMLSelectElement>('combobox', { name: 'Model' });
    expect(within(model).queryByRole('option', { name: /Preview/ })).toBeNull();
    fireEvent.change(model, { target: { value: 'codex:gpt-6-astra' } });
    expect(screen.getByRole('dialog').textContent).toContain('轉交到新的 session');
    expect(model.value).toBe('claude:claude-opus-5-5');
    fireEvent.click(screen.getByRole('button', { name: '返回工作台' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(model.value).toBe('claude:claude-opus-5-5');
  });

  it('retains unsent text and disables submission for active turns', () => {
    render(<App />);
    fireEvent.change(draft(), { target: { value: '尚未送出的訊息' } });
    fireEvent.click(pane().getByRole('button', { name: '送出' }));
    expect(draft().value).toBe('尚未送出的訊息');
    expect(screen.getByRole('status').textContent).toContain('未送出訊息');
    selectSession('規劃想法（轉交 Codex） 待確認');
    fireEvent.change(draft(), { target: { value: '等 turn 完成' } });
    expect(pane().getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
  });

  it('defaults to dark, persists light and survives unavailable storage', () => {
    const first = render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.change(screen.getByRole('combobox', { name: '外觀主題' }), { target: { value: 'light' } });
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
    fireEvent.change(screen.getByRole('combobox', { name: '外觀主題' }), { target: { value: 'light' } });
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
    fireEvent.keyDown(pane().getByRole('tab', { name: '成果／檔案' }), { key: 'ArrowRight' });
    const tasks = pane().getByRole('tab', { name: '任務流程' });
    expect(tasks.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tasks);
  });
});

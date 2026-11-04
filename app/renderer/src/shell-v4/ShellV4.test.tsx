// @vitest-environment jsdom
// The v0.4 shell in demo mode (no app service): T047's layout tests, on the routed shell of T051.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { App } from '../App';
import { fakeBridge } from '../ipc-test-helpers';
import { rendererStore } from '../renderer-store';
import { isAutoFolder, recentFolders } from './folders';
import { initialPanes, paneReducer } from './pane-state';
import { parseRoute } from './ShellV4';

const sidebar = () => within(screen.getByRole('complementary', { name: '側欄' }));
const row = (title: string) => sidebar().getByRole('button', { name: title });
const pane = (title: string) => within(screen.getByRole('region', { name: `對話：${title}` }));
const open = (route: string, search = '') => { window.history.replaceState(null, '', `/${search}#${route}`); return render(<App />); };
const mode = (name: RegExp) => sidebar().getByRole('button', { name });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  localStorage.clear();
});
afterEach(() => { cleanup(); if (window.awg) rendererStore(window.awg).dispose(); delete window.awg; vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('T051 one shell (Q-10)', () => {
  it('is the v0.4 shell in demo mode and when connected, without top navigation or the old menu', async () => {
    open('/new', '?shell=v4');
    expect(screen.getByTestId('shell-v4')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '主要導覽' })).toBeNull();
    expect(screen.queryByRole('button', { name: '應用程式選單' })).toBeNull();
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
    expect(sidebar().getByText('示意模式 · 未連接 runtime')).toBeTruthy();
    cleanup();
    window.awg = fakeBridge().bridge;
    open('/new');
    await screen.findByText('IPC 已連線');
    expect(screen.getByTestId('shell-v4')).toBeTruthy();
    expect(screen.queryByText(/示意模式/)).toBeNull();
  });
  it('keeps ?demo=long and ?demo=read-only in the new shell', () => {
    open('/sessions/s-plan-notes', '?demo=long');
    expect(screen.getByRole('list', { name: '訊息（共 4000 則）' })).toBeTruthy();
    cleanup();
    open('/sessions/s-plan-notes', '?demo=read-only');
    expect(screen.getByRole('alert').textContent).toContain('唯讀模式');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).title).toContain('唯讀');
  });
  it('parses hash routes, takes the old workbench route as the new chat, and says when a route or session is missing', () => {
    expect(parseRoute('#/workbench').page).toBe('new');
    expect(parseRoute('#/sessions/a%20b')).toMatchObject({ page: 'chat', id: 'a b' });
    expect(parseRoute('#/agents/x')).toMatchObject({ page: 'agents', id: 'x' });
    expect(parseRoute('#/workflows/start').page).toBe('workflow-start');
    expect(parseRoute('#/workflows/w1/edit')).toMatchObject({ page: 'templates', id: 'w1' });
    expect(parseRoute('#/workflow-instances/i1')).toMatchObject({ page: 'progress', id: 'i1' });
    expect(parseRoute('#/nowhere').page).toBe('missing');
    open('/sessions/missing-session');
    expect(screen.getByRole('heading', { name: '找不到 session：missing-session' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '回到新對話' }));
    expect(screen.getByRole('heading', { name: '今天想做什麼？' })).toBeTruthy();
  });
  it('keeps at most two panes, each with its own context, and restores a closed pane', () => {
    let state = initialPanes(fixtureSnapshot.sessions[0]!.id);
    state = paneReducer(state, { type: 'context', paneId: 'pane-1', sessionId: fixtureSnapshot.sessions[0]!.id, patch: { draft: 'A' } });
    state = paneReducer(state, { type: 'split', sessionId: fixtureSnapshot.sessions[1]!.id });
    state = paneReducer(state, { type: 'split', sessionId: fixtureSnapshot.sessions[2]!.id });
    // A split goes into the pane that is not active: the first one here.
    expect(state.panes.map(item => item.sessionId)).toEqual([fixtureSnapshot.sessions[2]!.id, fixtureSnapshot.sessions[1]!.id]);
    state = paneReducer(state, { type: 'close', paneId: 'pane-1' });
    state = paneReducer(state, { type: 'split', sessionId: fixtureSnapshot.sessions[0]!.id });
    expect(state.panes.find(item => item.id === 'pane-1')?.contexts[fixtureSnapshot.sessions[0]!.id]?.draft).toBe('A');
    expect(state.panes.every(item => item.contexts[item.sessionId]?.details !== true)).toBe(true);
  });
});

describe('T047 new chat', () => {
  it('defaults to 自動建立 without a number (Q-11) and no Agent', () => {
    open('/new');
    expect(screen.getByRole('button', { name: '工作資料夾：自動建立' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agent：無' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '送出' }).disabled).toBe(true);
    expect(screen.getByText(fixtureSnapshot.defaultWorkFolderRoot)).toBeTruthy();
  });
  it('opens a chip menu with Enter, closes it with Esc and returns focus', () => {
    open('/new');
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
  it('keeps the draft and says what a connected app would send', () => {
    open('/new');
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /輸入訊息/ });
    fireEvent.change(box, { target: { value: '幫我整理會議紀錄' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getAllByRole('status').some(item => item.textContent?.includes('session.create'))).toBe(true);
    expect(box.value).toBe('幫我整理會議紀錄');
  });
  it('recognises auto-created folders only directly in the work folder root, and lists recent folders without them', () => {
    const root = 'C:/Users/demo/AgentWorkflowGui';
    expect(isAutoFolder('C:\\Users\\demo\\AgentWorkflowGui\\2026-11-04-001', root)).toBe(true);
    expect(isAutoFolder('c:/users/demo/agentworkflowgui/2026-11-04-1000/', root)).toBe(true);
    expect(isAutoFolder('C:/Users/demo/AgentWorkflowGui/notes', root)).toBe(false);
    expect(isAutoFolder('E:/work/2026-11-04-001', root)).toBe(false);
    const sessions = fixtureSnapshot.sessions.map((session, index) => ({ ...session, cwd: index % 2 ? `${root}/2026-11-0${index % 9}-00${index}` : session.cwd }));
    const recent = recentFolders({ ...fixtureSnapshot, sessions: [...sessions, { ...sessions[0]!, id: sessions[0]!.id, cwd: 'E:\\WORK\\demo\\', updatedAt: '2099-01-01T00:00:00Z' }] });
    expect(recent.length).toBeLessThanOrEqual(5);
    expect(recent.some(path => path.includes('AgentWorkflowGui'))).toBe(false);
    expect(recent.filter(path => path.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === 'e:/work/demo')).toHaveLength(1);
    expect(recent[0]).toBe('E:\\WORK\\demo\\');
  });
});

describe('T047 sidebar', () => {
  it('collapses to a rail and expands again', () => {
    open('/new');
    fireEvent.click(sidebar().getByRole('button', { name: '收合側欄' }));
    expect(screen.queryByRole('complementary', { name: '側欄' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展開側欄' }));
    expect(row('規劃想法')).toBeTruthy();
  });
  it('folds a parent and moves with the arrow keys', () => {
    open('/new');
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
    open('/new');
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'review' } });
    expect(sidebar().getByRole('region', { name: '搜尋結果' })).toBeTruthy();
    expect(sidebar().queryByRole('button', { name: '規劃想法' })).toBeNull();
    expect(sidebar().getByRole('button', { name: /^Review：表單驗證登入功能/ })).toBeTruthy();
  });
  it('opens the context menu by right click or Shift+F10, closes on Esc and returns focus', () => {
    open('/sessions/s-wf-build-b');
    fireEvent.click(mode(/^對話(，有待處理項目)?$/));
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
  it('opens a second conversation side by side from the context menu (WB-07), and closes one side', () => {
    open('/sessions/s-wf-build-b');
    fireEvent.click(mode(/^對話(，有待處理項目)?$/));
    fireEvent.contextMenu(row('規劃想法'));
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(pane('實作：Session 儲存')).toBeTruthy();
    expect(pane('規劃想法')).toBeTruthy();
    expect(window.location.hash).toBe('#/sessions/s-plan-notes');
    fireEvent.pointerDown(screen.getByRole('region', { name: '對話：實作：Session 儲存' }));
    expect(window.location.hash).toBe('#/sessions/s-wf-build-b');
    fireEvent.click(pane('規劃想法').getByRole('button', { name: '關閉分割畫面：規劃想法' }));
    expect(screen.queryByRole('region', { name: '對話：規劃想法' })).toBeNull();
  });
  it('pins a session from the context menu (demo: kept in this preview)', () => {
    open('/new');
    fireEvent.contextMenu(row('參考資料整理'));
    fireEvent.click(screen.getByRole('menuitem', { name: '釘選' }));
    expect(within(sidebar().getByRole('region', { name: '釘選' })).getByRole('button', { name: '參考資料整理' })).toBeTruthy();
  });
  it('shows the connection and reloads from the bottom of the sidebar when connected', async () => {
    const fake = fakeBridge(); window.awg = fake.bridge;
    open('/new');
    await screen.findByText('IPC 已連線');
    fireEvent.click(sidebar().getByRole('button', { name: '重新讀取資料' }));
    await waitFor(() => expect(fake.bridge.snapshot).toHaveBeenCalledTimes(2));
    expect(fake.bridge.send).not.toHaveBeenCalled();
  });
});

describe('T047 sidebar modes', () => {
  const like = (name: RegExp) => sidebar().getByRole('button', { name });
  it('switches between 對話 and Workflow with the same parts, and marks escalations waiting in the other mode', () => {
    open('/new');
    expect(mode(/^對話$/).getAttribute('aria-pressed')).toBe('true');
    expect(mode(/^Workflow，有待處理項目$/)).toBeTruthy();
    expect(sidebar().getByRole('button', { name: '新對話' })).toBeTruthy();
    expect(sidebar().queryByRole('button', { name: '模板' })).toBeNull();
    fireEvent.click(mode(/^Workflow/));
    expect(mode(/^Workflow$/).getAttribute('aria-pressed')).toBe('true');
    expect(mode(/^對話，有待處理項目$/)).toBeTruthy();
    expect(sidebar().getByRole('button', { name: '開始 Workflow' })).toBeTruthy();
    expect(sidebar().getByRole('button', { name: '模板' })).toBeTruthy();
    expect(sidebar().getByRole('button', { name: 'Agent' })).toBeTruthy();
    expect(sidebar().getByRole('searchbox')).toBeTruthy();
    expect(sidebar().getByRole('button', { name: '設定' })).toBeTruthy();
    // The new-chat page belongs to 對話; switching modes moves to the Workflow start page.
    expect(screen.getByRole('heading', { level: 1, name: '開始 Workflow' })).toBeTruthy();
  });
  it('lists one row per run with its state (blocked is 卡住, Q-12), folded by default', () => {
    open('/workflows/start');
    const runs = within(sidebar().getByRole('region', { name: '執行' }));
    const login = runs.getByRole('button', { name: /^登入功能.*等待核准/ });
    // Pending items are a dot with text for screen readers, never a count.
    expect(within(login).getByRole('img', { name: '有待處理項目' }).textContent).toBe('');
    expect(runs.getByRole('button', { name: /^文件 review/ }).querySelector('.v4-alert')).toBeNull();
    expect(runs.getByRole('button', { name: /^文件 review.*執行中/ })).toBeTruthy();
    const stuck = runs.getByRole('button', { name: /^匯出報表.*卡住/ });
    expect(stuck.querySelector('.v4-run-state')?.getAttribute('data-state')).toBe('blocked');
    expect(within(sidebar().getByRole('region', { name: '釘選' })).getByRole('button', { name: /^新人文件整理.*完成/ })).toBeTruthy();
    expect(runs.queryByRole('button', { name: /^實作：Session 儲存/ })).toBeNull();
    const run = runs.getByRole('button', { name: /^登入功能/ });
    run.focus();
    fireEvent.keyDown(run, { key: 'ArrowRight' });
    expect(runs.getByRole('button', { name: /^實作：Session 儲存/ })).toBeTruthy();
    expect(runs.getByRole('button', { name: 'Review：表單驗證' })).toBeTruthy();
  });
  it('switches to Workflow mode and marks the run when a node session is opened from search', () => {
    open('/new');
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'session 儲存' } });
    fireEvent.click(like(/^實作：Session 儲存登入功能/));
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: '' } });
    expect(mode(/^Workflow$/).getAttribute('aria-pressed')).toBe('true');
    const node = like(/^實作：Session 儲存/);
    expect(node.getAttribute('aria-current')).toBe('true');
    expect(node.closest('li.v4-run')?.querySelector('.v4-row-current')).toBeTruthy();
  });
  it('switches modes when a split view opens a session of the other mode', () => {
    open('/sessions/s-plan-notes');
    expect(mode(/^對話$/).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(sidebar().getByRole('searchbox'), { target: { value: 'review：表單' } });
    fireEvent.contextMenu(like(/^Review：表單驗證/));
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    expect(pane('規劃想法')).toBeTruthy();
    expect(pane('Review：表單驗證')).toBeTruthy();
    expect(mode(/^Workflow$/).getAttribute('aria-pressed')).toBe('true');
  });
  it('keeps one pinned list per mode', () => {
    open('/new');
    fireEvent.contextMenu(row('參考資料整理'));
    fireEvent.click(screen.getByRole('menuitem', { name: '釘選' }));
    fireEvent.click(mode(/^Workflow/));
    const pins = within(sidebar().getByRole('region', { name: '釘選' }));
    expect(pins.queryByRole('button', { name: '參考資料整理' })).toBeNull();
    fireEvent.contextMenu(pins.getByRole('button', { name: /^新人文件整理/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '取消釘選' }));
    expect(sidebar().queryByRole('region', { name: '釘選' })).toBeNull();
    fireEvent.click(mode(/^對話/));
    expect(within(sidebar().getByRole('region', { name: '釘選' })).getByRole('button', { name: '參考資料整理' })).toBeTruthy();
  });
  it('renames a run in place from its context menu (demo)', () => {
    open('/workflows/start');
    fireEvent.contextMenu(like(/^匯出報表/));
    fireEvent.click(screen.getByRole('menuitem', { name: '重新命名' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '執行名稱' });
    fireEvent.change(input, { target: { value: '月報匯出' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(like(/^月報匯出卡住/)).toBeTruthy();
  });
});

describe('T047 conversation', () => {
  it('keeps tool calls folded, the detail pane closed, and the sub-task list under the messages', () => {
    open('/sessions/s-wf-build-b');
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
  it('shows an escalation in the session that raised it (U2_PLAN §3-12); the demo sends nothing', () => {
    open('/sessions/s-wf-build-b');
    const card = within(screen.getByRole('article', { name: '要求執行 git push' }));
    expect(card.getByRole<HTMLButtonElement>('button', { name: '核准' }).matches(':disabled')).toBe(true);
    expect(screen.getByText(/示意資料，未送出任何核准。/)).toBeTruthy();
  });
  it('lists the run\'s other open escalations in the root session, with a way to the node', () => {
    open('/sessions/s-wf-root');
    expect(screen.queryByRole('article', { name: '要求執行 git push' })).toBeNull();
    const others = within(screen.getByRole('region', { name: '這次執行的其他待處理項目' }));
    fireEvent.click(others.getByRole('button', { name: '前往 實作：Session 儲存 處理「要求執行 git push」' }));
    expect(pane('實作：Session 儲存')).toBeTruthy();
    expect(screen.getByRole('article', { name: '要求執行 git push' })).toBeTruthy();
  });
  it('renames with Enter and cancels with Esc (demo: kept in this preview)', () => {
    open('/sessions/s-plan-notes');
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
    open('/sessions/s-wf-build-b');
    expect(screen.getByText(/Agent：.*· 鎖定/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Model：/ }));
    const otherTool = screen.getAllByRole<HTMLButtonElement>('menuitemradio').filter(item => item.title === 'workflow 的 node 不能換工具');
    expect(otherTool.length).toBeGreaterThan(0);
    expect(otherTool.every(item => item.disabled)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Workflow：登入功能/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '查看流程進度' }));
    expect(screen.queryByRole('region', { name: '對話：實作：Session 儲存' })).toBeNull();
    expect(window.location.hash).toBe('#/workflow-instances/inst-login');
    expect(screen.getByRole('region', { name: 'Workflow 執行進度' })).toBeTruthy();
  });
});

describe('T047 settings and workflow start', () => {
  it('saves the default work folder location and resets it to the default (Q-1)', async () => {
    open('/settings');
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: '預設工作資料夾位置' });
    expect(field.value).toBe(fixtureSnapshot.defaultWorkFolderRoot);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '還原預設' }).disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'D:\\agents' } });
    // The demo service is ready once its first read is done.
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '儲存' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await screen.findByText('已儲存。');
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '還原預設' }).disabled).toBe(false));
    expect(field.value).toBe('D:\\agents');
    fireEvent.click(screen.getByRole('button', { name: '還原預設' }));
    await waitFor(() => expect(field.value).toBe(fixtureSnapshot.defaultWorkFolderRoot));
  });
  it('switches the theme from settings', () => {
    open('/settings');
    fireEvent.click(screen.getByRole('radio', { name: '淺色' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
  it('has the backup, Runtime process and About sections of the old app menu (Q-13)', async () => {
    open('/settings');
    expect(screen.getByRole('heading', { name: 'Runtime 程序' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '備份與還原' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '關於' })).toBeTruthy();
    expect(screen.getByText('示意模式：未連接應用程式服務。')).toBeTruthy();
    await screen.findAllByRole('button', { name: /^還原 / });
  });
  it('splits work and project folders, and requires the project folder in worktree mode', () => {
    open('/workflows/start');
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: '工作資料夾' }).placeholder).toContain('自動建立');
    const project = screen.getByRole<HTMLInputElement>('combobox', { name: '專案資料夾' });
    expect(project.getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('示意模式：連接應用程式服務後才能開始。')).toBeTruthy();
  });
});

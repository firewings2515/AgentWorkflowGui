// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { DetailPanel } from './DetailPanel';

afterEach(cleanup);
describe('T011 folder scope', () => {
  it.each(['s-plan-notes', 's-wf-build-a', 's-wf-review-a'])('renders the effective scope of %s', id => {
    const session = fixtureSnapshot.sessions.find(item => item.id === id)!;
    render(<DetailPanel snapshot={fixtureSnapshot} session={session} viewId="scope-view" tab="info" onTab={() => { /* read-only */ }} onOpen={() => { /* read-only */ }} onNotice={() => { /* read-only */ }} />);
    expect(screen.getByText(session.folderScope.source === 'task-worktree' ? 'Task worktree' : 'Session 工作資料夾')).toBeTruthy();
    const root = screen.getByText('工作區根目錄').nextElementSibling;
    expect(root?.textContent).toBe(session.folderScope.workspaceRoot);
    const writable = screen.getByText('可寫入目錄').nextElementSibling;
    expect(writable?.textContent).toBe(session.folderScope.writableRoots.join('') || '無可寫入目錄');
    expect(screen.getByText('無額外可讀取目錄')).toBeTruthy();
    expect(screen.queryByText(/資料未提供；工作資料夾/)).toBeNull();
  });

  it('lists supplied readable roots without adding them to writable roots', () => {
    const source = fixtureSnapshot.sessions[0]!;
    const session = { ...source, folderScope: { ...source.folderScope, readableRoots: ['E:/reference'], writableRoots: [] } };
    render(<DetailPanel snapshot={fixtureSnapshot} session={session} viewId="scope-view" tab="info" onTab={() => { /* read-only */ }} onOpen={() => { /* read-only */ }} onNotice={() => { /* read-only */ }} />);
    expect(screen.getByText('E:/reference')).toBeTruthy();
    expect(screen.getByText('無可寫入目錄')).toBeTruthy();
    expect(screen.getByText('附件不會擴大寫入或執行權限。')).toBeTruthy();
  });
});

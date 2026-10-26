// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { DetailPanel } from './DetailPanel';
import { Snapshot } from '../../../contracts';

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

describe('T018 delivery and operation outcomes', () => {
  it.each([
    ['pending', 'cancelled', '等待中', '已取消'],
    ['sent', 'rejected', '已送達（不代表已讀）', '已拒絕'],
    ['unknown', 'failed', '送達結果未知', '失敗'],
  ] as const)('keeps %s delivery separate from %s outcome', (delivery, outcome, deliveryLabel, outcomeLabel) => {
    const source = fixtureSnapshot.peerMessages.find(message => message.delivery.state === (delivery === 'pending' ? 'sent' : delivery))!;
    const snapshot = Snapshot.parse({ ...fixtureSnapshot, peerMessages: [{ ...source,
      delivery: delivery === 'pending' ? { state: 'pending', attempts: [] } : source.delivery,
      outcome: { kind: outcome, detail: '操作結果與送達紀錄分開', at: source.createdAt },
    }] });
    const session = snapshot.sessions.find(item => item.id === source.toSessionId)!;
    render(<DetailPanel snapshot={snapshot} session={session} viewId="delivery-view" tab="messages" onTab={() => undefined} onOpen={() => undefined} onNotice={() => undefined} />);
    expect(screen.getByText(deliveryLabel)).toBeTruthy();
    expect(screen.getByText(outcomeLabel)).toBeTruthy();
    expect(screen.getByText(/操作結果：/).textContent).toContain(outcomeLabel);
    expect(document.querySelector(`[data-state="${delivery}"]`)?.textContent).toContain(deliveryLabel);
  });
});

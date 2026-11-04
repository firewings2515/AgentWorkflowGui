// @vitest-environment jsdom
// T042 C1 (V-18): HTML or script in anything the runtimes, the file system or the backend put in the Snapshot
// (conversation text, titles, file and attachment names, paths, escalation and runtime details) is shown as text
// and never becomes an element or runs. The source scan is in app/main/t042-window.test.ts; the live run checks
// the CSP in the real window as well.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../../contracts';
import { fixtureSnapshot } from '../../../contracts/fixtures/snapshot';
import { App } from './App';
import { fakeBridge } from './ipc-test-helpers';
import { rendererStore } from './renderer-store';

declare global {
  interface Window {
    __awgPwned?: number;
  }
}

const PAYLOAD = '<img src=x onerror="window.__awgPwned=1"><script>window.__awgPwned=2</script><a href="javascript:window.__awgPwned=3">x</a><iframe src="file:///C:/Windows/win.ini"></iframe>';

const poisoned = (): Snapshot => {
  const s = structuredClone(fixtureSnapshot);
  for (const session of s.sessions) session.title = `${session.title} ${PAYLOAD}`;
  for (const a of s.agents) a.name = `${a.name} ${PAYLOAD}`;
  for (const m of s.messages) {
    m.text = `${m.text} ${PAYLOAD}`;
    m.attachments = m.attachments.map((x) => ({ ...x, name: `${x.name}${PAYLOAD}`, path: `${x.path}${PAYLOAD}` }));
  }
  for (const a of s.artifacts) Object.assign(a, { name: `${a.name}${PAYLOAD}`, path: `${a.path}${PAYLOAD}` });
  for (const e of s.escalations) Object.assign(e, { title: `${e.title}${PAYLOAD}`, detail: `${e.detail ?? ''}${PAYLOAD}` });
  for (const r of s.runtimes) Object.assign(r, { detail: PAYLOAD });
  for (const p of s.projects) p.name = `${p.name}${PAYLOAD}`;
  return s;
};

let fake: ReturnType<typeof fakeBridge>;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn(); });
  fake = fakeBridge(poisoned());
  window.awg = fake.bridge;
  delete window.__awgPwned;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  rendererStore(fake.bridge).dispose();
  delete window.awg;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const expectInert = (container: HTMLElement) => {
  expect(container.querySelector('img[src="x"]')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(window.__awgPwned).toBeUndefined();
};

describe('T042 C1: untrusted text in the Snapshot', () => {
  // T051: every page of the v0.4 shell, including a workflow node with an escalation card and the run's root.
  it.each(['/#/new', '/#/sessions/s-plan-notes', '/#/sessions/s-wf-build-b', '/#/sessions/s-wf-root', '/#/agents', '/#/workflows/wf-default/edit',
    '/#/workflows/start', '/#/workflow-instances/inst-login', '/#/settings'])('stays text on %s', async (route) => {
    window.history.replaceState(null, '', route);
    const view = render(<App />);
    await screen.findAllByText(/<img src=x onerror=/);
    expectInert(view.container);
  });
  it('stays text in the detail pane, the sidebar search and the split view', async () => {
    window.history.replaceState(null, '', '/#/sessions/s-plan-notes');
    const view = render(<App />);
    await screen.findAllByText(/<img src=x onerror=/);
    for (const tab of ['成果／檔案', '任務流程', '跨 session 訊息', 'Session 資訊']) {
      if (!screen.queryByRole('tab', { name: tab })) fireEvent.click(screen.getByRole('button', { name: '開啟細節窗格' }));
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expectInert(view.container);
    }
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'img' } });
    expect(within(screen.getByRole('region', { name: '搜尋結果' })).getAllByText(/<img src=x onerror=/).length).toBeGreaterThan(0);
    fireEvent.contextMenu(within(screen.getByRole('region', { name: '搜尋結果' })).getAllByRole('button')[1]!);
    fireEvent.click(screen.getByRole('menuitem', { name: '在分割畫面開啟' }));
    expectInert(view.container);
  });
});

import { useEffect, useRef, useState } from 'react';
import type { AppInfo } from '../../preload/bridge-types';
import { Menu } from './ui';
import type { MenuAction } from './ui';
import type { Theme } from './theme';

type ActionId = 'create' | 'workflow' | 'tab' | 'quit' | 'workbench' | 'editor' | 'agents' | 'dark' | 'light' | 'reload' | 'about';
const ctrlActions: Partial<Record<string, ActionId>> = { KeyT: 'tab', Digit1: 'workbench', Digit2: 'editor', Digit3: 'agents' };
const keyCodes: Record<string, string> = { n: 'KeyN', t: 'KeyT', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', f5: 'F5' };

export function AppMenu({ theme, commandDisabled, themeDisabled, tabDisabled, reloadDisabled, onCreate, onWorkflow, onTab, onNavigate, onTheme, onReload }: {
  theme: Theme;
  commandDisabled: boolean; themeDisabled: boolean; tabDisabled: boolean; reloadDisabled: boolean;
  onCreate: () => void; onWorkflow: () => void; onTab: () => void; onNavigate: (page: 'workbench' | 'workflow' | 'agents') => void;
  onTheme: (theme: Theme) => void; onReload: () => void;
}) {
  const [about, setAbout] = useState(false);
  const actions: (MenuAction & { id: ActionId })[] = [
    { id: 'create', group: '檔案', label: '新增 session', hint: 'Ctrl+N', disabled: commandDisabled, onSelect: onCreate },
    { id: 'workflow', group: '檔案', label: '啟動 Workflow', hint: 'Ctrl+Shift+N', disabled: commandDisabled, onSelect: onWorkflow },
    { id: 'tab', group: '檔案', label: '新增工作區 tab', hint: 'Ctrl+T', disabled: tabDisabled, onSelect: onTab },
    { id: 'quit', group: '檔案', label: '結束', onSelect: () => window.close() },
    { id: 'workbench', group: '檢視', label: '工作台', hint: 'Ctrl+1', onSelect: () => onNavigate('workbench') },
    { id: 'editor', group: '檢視', label: 'Workflow 編輯器', hint: 'Ctrl+2', onSelect: () => onNavigate('workflow') },
    { id: 'agents', group: '檢視', label: 'Agent 管理', hint: 'Ctrl+3', onSelect: () => onNavigate('agents') },
    { id: 'dark', group: '檢視', label: '深色主題', checked: theme === 'dark', disabled: themeDisabled, onSelect: () => onTheme('dark') },
    { id: 'light', group: '檢視', label: '淺色主題', checked: theme === 'light', disabled: themeDisabled, onSelect: () => onTheme('light') },
    { id: 'reload', group: '檢視', label: '重新讀取資料', hint: 'F5', disabled: reloadDisabled, onSelect: onReload },
    { id: 'about', group: '說明', label: '關於', onSelect: () => setAbout(true) },
  ];
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey) return;
      const code = event.code || keyCodes[event.key.toLowerCase()];
      const id: ActionId | undefined = event.ctrlKey ? code === 'KeyN' ? (event.shiftKey ? 'workflow' : 'create')
        : !event.shiftKey && code ? ctrlActions[code] : undefined
        : !event.shiftKey && code === 'F5' ? 'reload' : undefined;
      if (!id) return;
      event.preventDefault();
      // Keep modal focus and do not discard an in-progress confirmation.
      if (event.repeat || document.querySelector('dialog[open]')) return;
      const action = actions.find(action => action.id === id);
      if (!action?.disabled) action?.onSelect();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  return <><Menu label="應用程式選單" className="app-menu" actions={actions}>☰</Menu>{about && <About onClose={() => setAbout(false)} />}</>;
}

function About({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<AppInfo>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement;
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    element?.querySelector('button')?.focus();
    if (window.awg) void window.awg.getAppInfo().then(value => { if (active) setInfo(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; element?.close?.(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="about-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') { event.preventDefault(); dialog.current?.querySelector('button')?.focus(); }
  }}>
    <h2 id="about-heading">關於</h2>
    {info ? <p>{info.name}<br />版本 {info.version}</p> : <p role="status">{failed ? '無法讀取應用程式資訊。' : window.awg ? '正在讀取應用程式資訊…' : '示意模式：未連接應用程式服務。'}</p>}
    <p>授權：Apache-2.0</p><button onClick={onClose}>關閉</button>
  </dialog>;
}

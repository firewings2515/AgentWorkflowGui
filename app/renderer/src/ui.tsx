import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CreateTasksToolResult, HandoffToolResult, LogicalSession, OperationOutcome, ReportToRootToolResult, SendMessageToolResult, Snapshot, WaitForFileToolResult } from '../../../contracts';

type ContractStatus = LogicalSession['activity'] | Snapshot['app']['status'] | Snapshot['turns'][number]['state'] |
  Snapshot['nativeTasks'][number]['state'] | Snapshot['items'][number]['state'] | Snapshot['permissionRequests'][number]['state'] |
  Snapshot['artifacts'][number]['access'] | Snapshot['instances'][number]['state'] | Snapshot['instances'][number]['tasks'][number]['status'] |
  Snapshot['transfers'][number]['state'] | Snapshot['handoffs'][number]['delivery']['state'] | Snapshot['escalations'][number]['state'] |
  OperationOutcome['kind'] | HandoffToolResult['status'] | CreateTasksToolResult['status'] | SendMessageToolResult['status'] |
  ReportToRootToolResult['status'] | WaitForFileToolResult['status'];

const labels = {
  idle: '閒置', running: '執行中', 'waiting-user': '待確認', 'waiting-lock': '等待檔案鎖',
  interrupted: '已中斷', error: '錯誤', reconciling: '核對中', closed: '已釋放 runtime',
  completed: '已完成', failed: '失敗', stopped: '已停止', pending: '等待中',
  available: '可存取', missing: '檔案遺失', 'out-of-scope': '範圍外', unreadable: '無法讀取',
  sent: '已送達（不代表已讀）', unknown: '送達結果未知', 'not-sent': '尚未送出',
  merged: '已合併', blocked: '受阻', cancelled: '已取消', rejected: '已拒絕', declined: '已拒絕',
  draft: '準備中', 'awaiting-confirmation': '等待確認', stale: '已過期', approved: '已核准',
  'awaiting-merge': '等待合併', merging: '合併中', proposed: '等待套用', applied: '已套用',
  held: '暫緩處理', answered: '已回覆', withdrawn: '已撤回', open: '待處理', resolved: '已解決',
  ready: '就緒', damaged: '資料損壞', accepted: '已接納', duplicate: '重複請求', escalated: '已提請處理',
  created: '已建立', reported: '已回報', free: '已釋放', 'not-locked': '未鎖定', timeout: '已逾時',
} satisfies Record<ContractStatus | 'not-sent', string>;
export function statusLabel(value: string): string {
  return Object.hasOwn(labels, value) ? labels[value as keyof typeof labels] : value;
}
export function Status({ value }: { value: string }) {
  return <span className="status" data-state={value}><span aria-hidden="true">●</span> {statusLabel(value)}</span>;
}
export const formatTime = (value: string) => new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
export function observedModelText(session: LogicalSession): string {
  const observed = session.observedModel;
  switch (observed.source) {
    case 'unknown': return '尚無模型回報';
    case 'configured': return `已設定 ${observed.model}`;
    case 'rerouted': return `改用通知：${observed.from} → ${observed.to}；${observed.reason}（非逐 turn 實際用量證據）`;
    case 'per-message': return session.requestedModel.runtime === 'codex' ? `已設定 ${observed.model}` : `訊息回報 ${observed.model}`;
  }
}
export function Empty({ children }: { children: ReactNode }) { return <p className="empty-note">{children}</p>; }

export interface MenuAction { label: string; hint?: string; onSelect: () => void }
export function Menu({ label, children, actions, shortcut = false, className = '' }: {
  label: string; children: ReactNode; actions: MenuAction[]; shortcut?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    if (!shortcut) return;
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'u' && root.current?.closest('[data-workspace]')?.contains(document.activeElement)) {
        event.preventDefault();
        actions[0]?.onSelect();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actions, shortcut]);
  return <div className={`menu-root ${className}`} ref={root} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{children}</button>
    {open && <div className="popup-menu" role="menu" aria-label={label} ref={menu} onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (current + 1) % buttons.length : event.key === 'ArrowUp' ? (current - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
    }}>{actions.map(action => <button type="button" key={action.label} role="menuitem" onClick={() => {
      setOpen(false); trigger.current?.focus(); action.onSelect();
    }}>{action.label}{action.hint && <kbd>{action.hint}</kbd>}</button>)}</div>}
  </div>;
}

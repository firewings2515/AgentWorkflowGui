import { useEffect, useState } from 'react';
import type { SessionId, Snapshot } from '../../../contracts';

export function LockWaits({ snapshot, sessionId, onOpen }: { snapshot: Snapshot; sessionId: SessionId; onOpen?: (id: SessionId) => void }) {
  const [now, setNow] = useState(Date.now);
  const locks = snapshot.locks.filter(lock => lock.waiters.some(w => w.sessionId === sessionId));
  const waiting = locks.length > 0;
  useEffect(() => { if (!waiting) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [waiting]);
  if (!waiting) return snapshot.sessions.find(s => s.id === sessionId)?.activity === 'waiting-lock' ? <p className="command-warning">等待檔案鎖，尚無持有者與等待時間資料。</p> : null;
  return <section className="lock-waits" aria-label="檔案鎖等待"><h4>等待檔案鎖</h4>{locks.map(lock => {
    const waiter = lock.waiters.find(w => w.sessionId === sessionId)!;
    const holder = snapshot.sessions.find(s => s.id === lock.holderSessionId);
    const seconds = Math.max(0, Math.floor((now - Date.parse(waiter.since)) / 1000));
    return <div key={lock.path}><code>{lock.path}</code><p>持有者：{holder?.title ?? lock.holderSessionId} · {lock.holderSessionId}
      {holder && onOpen && <button onClick={() => onOpen(holder.id)}>查看鎖持有者</button>}</p>
      <p>已等待 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒 · 開始於 <time dateTime={waiter.since}>{new Date(waiter.since).toLocaleString('zh-TW')}</time></p>
      <p>等待期限：{new Date(waiter.deadline).toLocaleString('zh-TW')}{now >= Date.parse(waiter.deadline) ? ' · 已到期限，等待服務回報' : ''}</p>
      {lock.waitingForBackground && <p>持有者仍有背景指令，鎖尚未釋放。</p>}
    </div>;
  })}</section>;
}

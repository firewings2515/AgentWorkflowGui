import { useEffect, useRef, useState } from 'react';
import type { FolderResult, FolderRequest, FolderTarget } from '../../../contracts';
import { requestFolder } from './shell-v4/folders';

/** Optional until preload/main implement the C-24 channel. */
export interface FolderBridge { request: (request: FolderRequest) => Promise<FolderResult> }

export function FolderButton({ target, onPick, disabled = false, label }: {
  target?: FolderTarget; onPick?: (path: string) => void; disabled?: boolean; label?: string;
}) {
  const bridge = window.awg?.folders;
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const busy = useRef(false);
  const generation = useRef<symbol | undefined>(undefined);
  const pick = useRef(onPick);
  useEffect(() => { pick.current = onPick; }, [onPick]);
  const identity = JSON.stringify(target ?? 'pick');
  useEffect(() => { generation.current = Symbol(identity); return () => { generation.current = undefined; }; }, [identity]);
  return <span className="folder-action">
    <button type="button" disabled={disabled || !bridge || pending} onClick={() => { void (async () => {
      if (!bridge || disabled || busy.current) return;
      busy.current = true; setPending(true); setFeedback('');
      const current = generation.current;
      try {
        const outcome = await requestFolder(target);
        if (current !== generation.current) return;
        if (outcome.kind === 'picked') pick.current?.(outcome.path);
        else setFeedback(outcome.kind === 'failed' ? outcome.message : outcome.kind === 'opened' ? '已請求在檔案總管開啟。' : '已取消選擇。');
      } finally { busy.current = false; setPending(false); }
    })(); }}>{pending ? '處理資料夾…' : label ?? (target ? '在檔案總管開啟' : '選擇資料夾')}</button>
    {!bridge && <small>資料夾服務尚未接入。</small>}
    {feedback && <small role="status">{feedback}</small>}
  </span>;
}

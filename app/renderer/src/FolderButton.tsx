import { useEffect, useRef, useState } from 'react';
import { FolderResult, RequestId } from '../../../contracts';
import type { FolderRequest, FolderTarget } from '../../../contracts';

/** Optional until preload/main implement the C-24 channel. */
export interface FolderBridge { request: (request: FolderRequest) => Promise<FolderResult> }

export function FolderButton({ target, onPick, disabled = false }: {
  target?: FolderTarget; onPick?: (path: string) => void; disabled?: boolean;
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
      const requestId = RequestId.parse(crypto.randomUUID());
      try {
        const result = FolderResult.parse(await bridge.request(target ? { type: 'folder.open', requestId, target } : { type: 'folder.pick', requestId }));
        if (current !== generation.current) return;
        if (result.requestId !== requestId) { setFeedback('資料夾回覆無法核對，請重新操作。'); return; }
        if (!result.ok) {
          setFeedback(({ not_found: '找不到資料夾。', invalid_request: '資料夾要求無效。', internal_error: '無法開啟資料夾視窗。' })[result.code]);
        } else if (!target && typeof result.path === 'string') { pick.current?.(result.path); }
        else setFeedback(target ? '已請求在檔案總管開啟。' : '已取消選擇。');
      } catch { if (current === generation.current) setFeedback('無法取得資料夾操作結果。'); }
      finally { busy.current = false; setPending(false); }
    })(); }}>{pending ? '處理資料夾…' : target ? '在檔案總管開啟' : '選擇資料夾'}</button>
    {!bridge && <small>資料夾服務尚未接入。</small>}
    {feedback && <small role="status">{feedback}</small>}
  </span>;
}

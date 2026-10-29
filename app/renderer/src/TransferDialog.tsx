import { useEffect, useRef, useState } from 'react';
import { RequestId, TransferId } from '../../../contracts';
import type { Command, CommandResult, ModelOption, SessionId, Snapshot, TransferProposal } from '../../../contracts';
import { blocksResubmit, commandFeedback } from './command-feedback';
import type { RendererState, RendererStore } from './renderer-store';
import { Status, statusLabel } from './ui';

export interface TransferPreview { sessionId: SessionId; model?: ModelOption; viewId: string }
const forSource = (command: Command, snapshot: Snapshot, sourceId: SessionId) => command.type === 'transfer.prepare'
  ? command.sourceSessionId === sourceId
  : (command.type === 'transfer.confirm' || command.type === 'transfer.cancel') && snapshot.transfers.some(p => p.id === command.transferId && p.sourceSessionId === sourceId);

function ProposalContent({ proposal, canConfirm, onConfirm }: { proposal: TransferProposal; canConfirm: boolean; onConfirm: () => void }) {
  const [reviewed, setReviewed] = useState(false);
  return <>
    <div className="transfer-content" role="region" aria-label="轉交內容預覽" tabIndex={0}>
      <h3>目標</h3><pre>{proposal.content.goal}</pre>
      <h3>交接說明</h3><p className="muted">{proposal.content.noteSource === 'agent' ? '來源 Agent 撰寫' : 'GUI 從紀錄整理'}</p><pre>{proposal.content.note || '未提供交接說明'}</pre>
      <h3>相關 commit 的 diff</h3><pre>{proposal.content.diff || '未提供 diff'}</pre>
      <h3>目前測試輸出</h3><pre>{proposal.content.testOutput || '未提供測試輸出'}</pre>
    </div>
    {proposal.state === 'awaiting-confirmation' && <>
      <label className="check-label"><input type="checkbox" checked={reviewed} disabled={!canConfirm} onChange={event => setReviewed(event.target.checked)} />我已審閱以上內容，同意轉交給指定工具與 Model。</label>
      <button className="primary" disabled={!canConfirm || !reviewed} onClick={onConfirm}>確認轉交</button>
    </>}
  </>;
}

export function TransferDialog({ snapshot, preview, store, ipcState, onClose, onOpen }: {
  snapshot: Snapshot; preview: TransferPreview; store: RendererStore | undefined; ipcState: RendererState | undefined;
  onClose: () => void; onOpen: (id: SessionId) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const source = snapshot.sessions.find(s => s.id === preview.sessionId);
  const proposals = snapshot.transfers.filter(p => p.sourceSessionId === preview.sessionId);
  const activities = Object.values(ipcState?.commands ?? {}).filter(a => forSource(a.command, snapshot, preview.sessionId));
  const outstanding = Object.values(ipcState?.blockedCommands ?? {}).filter(a => forSource(a.command, snapshot, preview.sessionId));
  const pendingPrepare = [...outstanding, ...activities].find(a => a.command.type === 'transfer.prepare' && (!a.result || a.result.ok || blocksResubmit(a.result)) && !proposals.some(p => a.command.type === 'transfer.prepare' && p.id === a.command.transferId));
  const [proposalId, setProposalId] = useState<TransferId | undefined>(() => pendingPrepare?.command.type === 'transfer.prepare' ? pendingPrepare.command.transferId : proposals.findLast(p => ['draft', 'awaiting-confirmation', 'stale'].includes(p.state))?.id ?? proposals.at(-1)?.id);
  const proposal = proposals.find(p => p.id === proposalId);
  const options = snapshot.modelOptions.filter(m => !m.hidden && m.runtime !== source?.requestedModel.runtime);
  const [modelKey, setModelKey] = useState(() => preview.model ? `${preview.model.runtime}:${preview.model.model}` : options[0] ? `${options[0].runtime}:${options[0].model}` : '');
  const [noteSource, setNoteSource] = useState<'gui-digest' | 'agent'>('gui-digest');
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<{ command: Command; result: CommandResult }>();
  const result = receipt ? ipcState?.commands[receipt.command.requestId]?.result ?? receipt.result : undefined;
  const model = options.find(m => `${m.runtime}:${m.model}` === modelKey);
  const uncertain = outstanding.length > 0 || proposals.some(p => p.delivery?.state === 'unknown' || p.provision?.state === 'unknown');
  const disabled = !store || ipcState?.connection !== 'ready' || pending || uncertain || !source || source.kind !== 'ordinary';
  const receipts = [...activities, ...(receipt ? [{ command: receipt.command, result: result ?? receipt.result }] : [])];
  const confirmAttempted = receipts.some(a => a.command.type === 'transfer.confirm' && a.command.transferId === proposal?.id && a.command.expectedRevision === proposal.revision && (a.result?.ok || (a.result && !a.result.ok && (blocksResubmit(a.result) || a.result.code === 'stale_revision'))));
  const cancelAccepted = receipts.some(a => a.command.type === 'transfer.cancel' && a.command.transferId === proposal?.id && a.result?.ok);
  const prepareAccepted = !!pendingPrepare || (receipt?.command.type === 'transfer.prepare' && result?.ok && !proposal);
  const hasActive = proposals.some(p => ['draft', 'awaiting-confirmation', 'stale'].includes(p.state) || (p.state === 'approved' && p.delivery?.state !== 'sent'));
  const canPrepare = !disabled && !!model && !hasActive && !prepareAccepted;
  const canCancel = !disabled && !cancelAccepted && !!proposal && proposal.delivery?.state !== 'sent' && !['cancelled', 'failed'].includes(proposal.state) && !store?.isBlocked('transfer.cancel', `transfer:${proposal.id}`);
  useEffect(() => {
    const element = dialog.current;
    if (element?.showModal) element.showModal(); else element?.setAttribute('open', '');
    return () => { if (element?.close) element.close(); };
  }, []);
  const send = (command: Command, onResult?: (result: CommandResult) => void) => {
    if (!store || pending) return;
    setPending(true);
    void store.send(command).then(result => { setReceipt({ command, result }); setPending(false); onResult?.(result); });
  };
  return <dialog className="transfer-dialog" ref={dialog} aria-labelledby="transfer-heading" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []);
      const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><span className="eyebrow">跨工具轉交</span><h2 id="transfer-heading">轉交到新的 session</h2><button autoFocus onClick={onClose}>返回工作台</button></header>
    <div className="transfer-body">
      <p>來源：{source?.title ?? preview.sessionId} · {source?.requestedModel.runtime ?? '工具未知'}<br /><code>{preview.sessionId}</code></p>
      <p className="muted">確認前不建立目標 session，也不傳送轉交內容。關閉視窗僅隱藏預覽；取消提案請使用下方按鈕。</p>
      {!store && <p className="command-warning">示意模式：連接應用程式服務後才能轉交。</p>}
      {source?.kind !== 'ordinary' && <p role="alert">此入口僅供一般 session 轉交。</p>}
      {proposals.length > 0 && <label>轉交提案<select value={proposalId ?? ''} onChange={event => { setProposalId(proposals.find(p => p.id === event.target.value)?.id); setReceipt(undefined); }}>
        {!proposal && <option value={proposalId ?? ''}>{proposalId ? '等待提案資料' : '新提案'}</option>}
        {proposals.map(p => <option key={p.id} value={p.id}>{p.id} · {statusLabel(p.state)} · v{p.revision}</option>)}
      </select></label>}
      {proposal && <>
        <p>提案狀態：<Status value={proposal.state} /> · 版本 {proposal.revision} · 來源版本 {proposal.sourceRevision}</p>
        <p className="transfer-route">目標：{proposal.target.runtime} · {proposal.target.model} · {proposal.target.effort ?? '未指定 effort'}</p>
        {proposal.state === 'stale' && <p role="alert" className="command-warning">此提案已過期，舊內容不可確認。請取消舊提案，再重新產生並審閱內容。</p>}
        {proposal.state === 'cancelled' && <p>此提案已取消；已記錄的建立與送達結果仍保留如下。</p>}
        {proposal.state === 'failed' && <p role="alert">目標建立失敗，工作保留在來源 session。{proposal.failure?.message}</p>}
        <ProposalContent key={`${proposal.id}:${proposal.revision}:${proposal.payloadHash}`} proposal={proposal} canConfirm={!disabled && !confirmAttempted && !cancelAccepted} onConfirm={() => {
          if (disabled || confirmAttempted || cancelAccepted || proposal.state !== 'awaiting-confirmation') return;
          send({ type: 'transfer.confirm', requestId: RequestId.parse(crypto.randomUUID()), transferId: proposal.id, expectedRevision: proposal.revision });
        }} />
        <dl className="transfer-facts"><dt>目標建立</dt><dd>{proposal.provision ? <span className="status" data-state={proposal.provision.state}>{proposal.provision.state === 'sent' ? '已確認建立' : proposal.provision.state === 'unknown' ? '建立結果未知，請先核對' : '等待建立'}</span> : '尚無建立紀錄'}</dd>
          <dt>內容送達</dt><dd>{proposal.delivery ? <Status value={proposal.delivery.state} /> : '尚無送達紀錄'}</dd>
          <dt>核准</dt><dd>{proposal.approvedRevision === undefined ? '尚未核准' : `已核准版本 ${proposal.approvedRevision}`}</dd></dl>
        {proposal.createdSessionId && <button disabled={!snapshot.sessions.some(s => s.id === proposal.createdSessionId)} onClick={() => { if (proposal.createdSessionId) onOpen(proposal.createdSessionId); }}>開啟接續 session</button>}
        {proposal.delivery?.state === 'sent' ? <p>已送達，無法取消；已建立的 session 與已送出的內容不會被收回。</p> : !['cancelled', 'failed'].includes(proposal.state) && <button disabled={!canCancel} onClick={() => {
          if (canCancel) send({ type: 'transfer.cancel', requestId: RequestId.parse(crypto.randomUUID()), transferId: proposal.id });
        }}>取消提案</button>}
      </>}
      {(!hasActive || !proposal) && <fieldset disabled={disabled || hasActive || !!prepareAccepted}>
        <legend>{proposal ? '建立新的轉交提案' : '換到另一個工具'}</legend>
        <label>目標 Model<select value={modelKey} onChange={event => setModelKey(event.target.value)}><option value="">選擇目標 Model</option>{options.map(m => <option key={`${m.runtime}:${m.model}`} value={`${m.runtime}:${m.model}`}>{m.displayName} · {m.runtime}</option>)}</select></label>
        <label>交接說明來源<select value={noteSource} onChange={event => setNoteSource(event.target.value === 'agent' ? 'agent' : 'gui-digest')}><option value="gui-digest">GUI 從紀錄整理</option><option value="agent">來源 Agent 撰寫（新增來源 turn）</option></select></label>
        <button className="primary" disabled={!canPrepare} onClick={() => {
          if (!canPrepare || !model) return;
          const previousId = proposalId;
          const id = TransferId.parse(crypto.randomUUID()); setProposalId(id);
          send({ type: 'transfer.prepare', requestId: RequestId.parse(crypto.randomUUID()), transferId: id, sourceSessionId: preview.sessionId, target: { runtime: model.runtime, model: model.model, ...(model.defaultEffort ? { effort: model.defaultEffort } : {}) }, noteSource }, result => {
            if (!result.ok && !blocksResubmit(result)) setProposalId(current => current === id ? previousId : current);
          });
        }}>產生轉交預覽</button>
      </fieldset>}
      {pending && <p role="status">正在處理轉交指令…</p>}
      {prepareAccepted && !proposal && !pending && <p role="status">等待本次提案資料，請重新讀取提案；不會重複建立。</p>}
      {confirmAttempted && proposal?.state === 'awaiting-confirmation' && <p className="command-warning">此版本已送出確認或回報版本過期，請重新讀取提案並核對新狀態。</p>}
      {result && <p role={result.ok ? 'status' : 'alert'}>{result.ok ? '指令已接受，請依最新提案狀態核對。' : `${commandFeedback(result)}（${result.code}）`}</p>}
      {uncertain && <p className="command-warning" role="status">轉交結果待核對，核對前暫停取消、再次確認與新建提案。這個提案可能已經核准，取消不會收回已建立的 session 或已送出的內容。請重新讀取資料；結果未知的送達可至來源 session 待處理項目核對。</p>}
      {store && <button disabled={ipcState?.connection === 'loading'} onClick={() => void store.reconnect()}>重新讀取提案</button>}
      {ipcState?.connection === 'error' && <p role="alert">資料同步失敗，請重新讀取提案。</p>}
    </div>
  </dialog>;
}

// Settings → Runtime (C-33, T045): what the GUI found of the user's own Claude Code and Codex, one card each, with
// "重新偵測". It shows only what the status holds: sign-in is a category, never an account or a key.
import { useState } from 'react';
import { RequestId } from '../../../contracts';
import type { Runtime, RuntimeAuth, RuntimeSource, RuntimeState, RuntimeStatus, Snapshot } from '../../../contracts';
import type { RendererState, RendererStore } from './renderer-store';
import './runtime-panel.css';

export const RUNTIME_NAMES: Record<Runtime, string> = { claude: 'Claude Code', codex: 'Codex' };
export const RUNTIME_ORDER: readonly Runtime[] = ['claude', 'codex'];

const stateLabels: Record<RuntimeState, string> = {
  available: '可用', 'not-installed': '未安裝', 'too-old': '版本太舊', 'signed-out': '未登入', failed: '讀不到版本',
};
const authLabels: Record<RuntimeAuth, string> = { subscription: '訂閱', 'api-key': 'API key', 'signed-out': '未登入', unknown: '不明' };
const sourceLabels: Record<RuntimeSource, string> = {
  env: '環境變數', path: 'PATH', 'known-location': '常見安裝位置', 'sdk-bundled': 'SDK 內建（僅開發版）',
};

const time = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-TW', { hour12: false });
};

function RuntimeCard({ runtime, status, detecting, canDetect, onDetect }: {
  runtime: Runtime; status: RuntimeStatus | undefined; detecting: boolean; canDetect: boolean; onDetect: () => void;
}) {
  const name = RUNTIME_NAMES[runtime];
  const headingId = `runtime-${runtime}-heading`;
  return <section className="runtime-card" aria-labelledby={headingId} data-state={status?.state ?? 'unknown'}>
    <div className="runtime-card-head">
      <h3 id={headingId}>{name}</h3>
      <span className="runtime-state" data-state={status?.state ?? 'unknown'}><span aria-hidden="true">●</span> {status ? stateLabels[status.state] : '尚未偵測'}</span>
    </div>
    {status ? <dl className="runtime-fields">
      <dt>版本</dt><dd><span>{status.version ?? '—'}</span> <span className="muted">（需要 {status.requiredVersion} 以上）</span></dd>
      <dt>路徑</dt><dd className="mono runtime-path">{status.executable ?? '—'}</dd>
      <dt>來源</dt><dd>{status.source ? sourceLabels[status.source] : '—'}</dd>
      <dt>登入</dt><dd>{authLabels[status.auth]}</dd>
      <dt>模型數</dt><dd>{status.modelCount}</dd>
      <dt>上次偵測</dt><dd>{time(status.checkedAt)}</dd>
    </dl> : <p className="muted">尚未偵測到結果。</p>}
    {status?.detail && status.state !== 'available' && <p className="runtime-detail" role="status">{status.detail}</p>}
    <button type="button" disabled={!canDetect || detecting} onClick={onDetect} aria-label={`重新偵測 ${name}`}>{detecting ? '偵測中…' : '重新偵測'}</button>
  </section>;
}

export function RuntimePanel({ snapshot, store, ipcState }: { snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined }) {
  const [detecting, setDetecting] = useState<Partial<Record<Runtime, boolean>>>({});
  const [failure, setFailure] = useState('');
  const canDetect = !!store && ipcState?.connection === 'ready' && snapshot.app.status !== 'damaged';
  const detect = (runtime: Runtime) => {
    if (!store || detecting[runtime]) return;
    setDetecting(previous => ({ ...previous, [runtime]: true }));
    setFailure('');
    void store.send({ type: 'runtime.detect', requestId: RequestId.parse(crypto.randomUUID()), runtime }).then(result => {
      if (!result.ok) setFailure(`重新偵測失敗（${result.code}）。`);
    }).finally(() => setDetecting(previous => ({ ...previous, [runtime]: false })));
  };
  return <section className="runtime-panel" aria-label="Runtime">
    <p className="muted">本程式使用你自己安裝並登入的 Claude Code 與 Codex，不內建、不安裝、不代為登入，也不讀取登入憑證。安裝、更新或登入後，請按「重新偵測」。</p>
    {!store && <p className="command-warning">示意模式：連接應用程式服務後才能重新偵測。</p>}
    <div className="runtime-cards">
      {RUNTIME_ORDER.map(runtime => <RuntimeCard key={runtime} runtime={runtime} status={snapshot.runtimes.find(item => item.runtime === runtime)}
        detecting={!!detecting[runtime]} canDetect={canDetect} onDetect={() => detect(runtime)} />)}
    </div>
    {failure && <p role="alert" className="command-warning">{failure}</p>}
  </section>;
}

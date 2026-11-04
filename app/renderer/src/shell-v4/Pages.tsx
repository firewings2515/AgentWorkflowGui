import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { RequestId } from '../../../../contracts';
import type { AgentDefinition, Snapshot } from '../../../../contracts';
import type { AppInfo } from '../../../preload/bridge-types';
import { blocksResubmit, commandFeedback } from '../command-feedback';
import { ConnectionStatus } from '../ConnectionStatus';
import { FolderButton } from '../FolderButton';
import { readOnlyProps } from '../read-only';
import type { RendererState, RendererStore } from '../renderer-store';
import { RuntimeNotice } from '../RuntimeNotice';
import { RuntimePanel } from '../RuntimePanel';
import { BackupSection, SupervisorSection } from '../StorageSettings';
import type { Theme } from '../theme';
import { Composer, modelKey } from './Composer';
import type { ComposerChoice } from './Composer';
import type { useCreateFlow } from './create-flow';
import { workFolderRoot } from './folders';

/** Claude's blank conversation: one prompt line and the input box. The session is created only on send (Q-3). */
export function NewChat({ snapshot, store, ipcState, agents, draft, onDraft, choice, onChoice, flow, recent, onPickFolder, onSend, onNotice }: {
  snapshot: Snapshot; store: RendererStore | undefined; ipcState: RendererState | undefined; agents: readonly AgentDefinition[];
  draft: string; onDraft: (text: string) => void; choice: ComposerChoice; onChoice: (choice: ComposerChoice) => void;
  flow: ReturnType<typeof useCreateFlow>; recent: readonly string[]; onPickFolder: () => void; onSend: () => void; onNotice: (text: string) => void;
}) {
  const readOnly = snapshot.app.status === 'read-only';
  const model = snapshot.modelOptions.find(item => !item.hidden && modelKey(item) === choice.modelKey);
  const agentMissing = !!choice.agentId && !agents.some(item => item.id === choice.agentId);
  const notReady = !!store && ipcState?.connection !== 'ready';
  const { attempt, result, unresolved } = flow;
  const failed = result && !result.ok && !blocksResubmit(result) && !flow.accepted ? result : undefined;
  return <section className="v4-new-chat" aria-labelledby="v4-new-heading" data-workspace="new">
    <div className="v4-column">
      <h1 id="v4-new-heading" tabIndex={-1}>今天想做什麼？</h1>
      <Composer draft={draft} onDraft={onDraft} choice={choice} onChoice={onChoice} agents={agents} models={snapshot.modelOptions} autoFocus
        folders={{ recent, onPick: onPickFolder }} readOnly={readOnly} placeholder="輸入訊息，送出後才建立對話…" onNotice={onNotice}
        inputDisabled={!!attempt && !result} choiceDisabled={flow.busy || notReady || !!flow.retryOf}
        sendDisabled={flow.busy || notReady || !model || agentMissing || snapshot.app.status !== 'ready'} onSend={onSend}>
        {!model && <p role="status">尚無可用 Model，請到設定 → Runtime 重新偵測。</p>}
        {agentMissing && <p role="status" className="command-warning">選擇的 Agent 已移除，請重新選擇。</p>}
        {notReady && <p role="status">資料尚未同步完成；完成後才能送出，草稿已保留。</p>}
        {attempt && !result && <p role="status">正在建立對話…</p>}
        {flow.accepted && <p role="status">建立指令已接受，等待最新 session 資料。<button type="button" disabled={ipcState?.connection === 'loading'} onClick={() => void flow.reconcile()}>重新讀取資料並開啟</button></p>}
        {failed && <p role="alert" className="field-error">沒有建立對話：{commandFeedback(failed)}（{failed.code}）草稿已保留，可以再送一次。</p>}
        {flow.uncertain && <div role="status" className="command-warning">
          <p>建立結果待核對：沒找到對話不代表建立失敗，請勿重複送出。草稿已保留。</p>
          {flow.found ? <button type="button" onClick={flow.openFound}>已找到建立的對話，開啟它</button>
            : <button type="button" disabled={ipcState?.connection === 'loading'} onClick={() => void flow.reconcile()}>重新讀取資料並核對</button>}
          {unresolved?.createCheck === 'missing' && <button type="button" disabled={ipcState?.connection !== 'ready'} onClick={flow.acknowledgeMissing}>我已確認沒有建立，可以重新送出</button>}
        </div>}
        {flow.retryOf && !flow.busy && <div role="status" className="v4-retry-note">
          <p>再送一次會沿用同一個對話（同一個 ID）和原本的資料夾、Agent、Model；原本的請求如果晚到，也只會有一個對話。</p>
          <button type="button" onClick={flow.abandon}>放棄這次建立，改用新的設定</button>
        </div>}
      </Composer>
      <RuntimeNotice runtimes={snapshot.runtimes} />
      <p className="v4-hint">沒選資料夾時，送出會在 <code>{workFolderRoot(snapshot)}</code> 建立新的資料夾。Agent 可以不選。</p>
    </div>
  </section>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="v4-field"><span className="v4-field-label">{label}</span>{children}{hint && <p className="v4-muted v4-field-hint">{hint}</p>}</div>;
}

/** The default work folder (Q-1, T048): `workFolderRoot`, or the default location when it is not set. */
function WorkFolderSetting({ snapshot, store, demo }: { snapshot: Snapshot; store: RendererStore; demo: boolean }) {
  const current = workFolderRoot(snapshot);
  const custom = snapshot.preferences.workFolderRoot !== undefined;
  const [root, setRoot] = useState(current);
  const [seen, setSeen] = useState(current);
  const [feedback, setFeedback] = useState('');
  if (seen !== current) { setSeen(current); setRoot(current); }
  const readOnly = snapshot.app.status === 'read-only';
  const disabled = readOnly || snapshot.app.status !== 'ready' || store.getSnapshot().connection !== 'ready' || store.isBlocked('preferences.set', 'preferences');
  // preferences.set replaces the whole object: build it from the latest Snapshot at the moment of sending.
  const save = (value: string | undefined) => {
    const latest = store.getSnapshot().snapshot?.preferences;
    if (!latest || disabled) return;
    const rest = { ...latest };
    delete rest.workFolderRoot;
    void store.send({ type: 'preferences.set', requestId: RequestId.parse(crypto.randomUUID()), preferences: value === undefined ? rest : { ...rest, workFolderRoot: value } })
      .then(result => setFeedback(result.ok ? '已儲存。' : commandFeedback(result)));
  };
  return <>
    <Field label="預設工作資料夾位置" hint={<>新對話沒選資料夾時，會在這裡建立「日期加序號」的資料夾，例如 <code>2026-11-04-001</code>。只有真的送出時才建立。預設是 <code>{snapshot.defaultWorkFolderRoot}</code>。</>}>
      <div className="v4-inline-field">
        <input aria-label="預設工作資料夾位置" value={root} onChange={event => setRoot(event.target.value)} />
        <FolderButton label="選擇…" disabled={disabled} onPick={setRoot} />
        <button type="button" {...readOnlyProps(readOnly)} disabled={disabled || !custom} onClick={() => save(undefined)}>還原預設</button>
      </div>
    </Field>
    <div className="v4-card-actions">
      {demo && <span className="v4-muted">示意模式：只改這次預覽的資料。</span>}
      {feedback && <span role="status">{feedback}</span>}
      <button type="button" className="primary" {...readOnlyProps(readOnly)} disabled={disabled || !root.trim() || root.trim() === current}
        onClick={() => save(root.trim() === snapshot.defaultWorkFolderRoot ? undefined : root.trim())}>儲存</button>
    </div>
  </>;
}

function About() {
  const [info, setInfo] = useState<AppInfo>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    if (window.awg) void window.awg.getAppInfo().then(value => { if (active) setInfo(value); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  return <section className="v4-card" aria-labelledby="settings-about-heading"><h2 id="settings-about-heading">關於</h2>
    {info ? <p>{info.name}<br />版本 {info.version}</p> : <p role="status">{failed ? '無法讀取應用程式資訊。' : window.awg ? '正在讀取應用程式資訊…' : '示意模式：未連接應用程式服務。'}</p>}
    <p>授權：Apache-2.0</p>
  </section>;
}

export function SettingsV4({ snapshot, store, serviceStore, ipcState, theme, themeDisabled, onTheme }: {
  snapshot: Snapshot; store: RendererStore | undefined; serviceStore: RendererStore; ipcState: RendererState | undefined;
  theme: Theme; themeDisabled: boolean; onTheme: (theme: Theme) => void;
}) {
  return <section className="v4-page" aria-labelledby="v4-settings-heading">
    <div className="v4-page-column">
      <h1 id="v4-settings-heading" tabIndex={-1}>設定</h1>
      <section className="v4-card" aria-label="一般">
        <h2>一般</h2>
        {serviceStore.savingPreferences() && <p role="status" className="v4-muted">正在儲存設定，完成後就能再改。</p>}
        <Field label="外觀"><div className="v4-segmented" role="radiogroup" aria-label="外觀">
          {(['dark', 'light'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={theme === value} disabled={themeDisabled} onClick={() => onTheme(value)}>{value === 'dark' ? '深色' : '淺色'}</button>)}
        </div></Field>
        <WorkFolderSetting snapshot={snapshot} store={serviceStore} demo={!store} />
      </section>
      <section className="v4-card v4-runtime" aria-labelledby="settings-runtime-heading"><h2 id="settings-runtime-heading">Runtime</h2>
        <RuntimePanel snapshot={snapshot} store={store} ipcState={ipcState} /></section>
      <SupervisorSection store={serviceStore} demo={!store} />
      <BackupSection store={serviceStore} demo={!store} />
      {store && ipcState && <section className="v4-card" aria-labelledby="settings-results-heading"><h2 id="settings-results-heading">連線與操作結果</h2>
        <ConnectionStatus store={store} state={ipcState} /></section>}
      <About />
    </div>
  </section>;
}

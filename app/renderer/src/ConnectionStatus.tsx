import type { RendererState, RendererStore } from './renderer-store';
import { commandTarget } from './renderer-store';
import { commandFeedback } from './command-feedback';

export function ConnectionStatus({ state, store }: { state: RendererState; store: RendererStore }) {
  const commands = Object.values(state.commands);
  const unresolved = Object.values(state.blockedCommands).filter(activity => activity.result);
  return <div className="connection-status">
    <span role="status">{state.connection === 'ready' ? 'IPC 已連線' : state.connection === 'loading' || state.connection === 'idle' ? '正在同步資料…' : state.snapshot ? '資料同步失敗，保留上次資料' : '資料同步失敗，尚未載入資料'}</span>
    <button disabled={state.connection === 'loading'} onClick={() => { void store.reconnect(); }}>重新讀取資料</button>
    {unresolved.length > 0 && <details><summary>待核對操作（{unresolved.length}）</summary>{unresolved.map(({ command }) => <div key={command.requestId}>
      <span>{command.type} · {commandTarget(command)}</span>
      <button onClick={() => store.acknowledge(command.type, commandTarget(command))}>已核對結果</button>
    </div>)}</details>}
    {commands.length > 0 && <details className="command-history"><summary>操作結果（{commands.length}）</summary><ol aria-label="操作結果">{commands.map(({ command, result, reviewed }, index) => <li key={command.requestId}>
      <strong>{command.type}</strong><span className="mono">{commandTarget(command)}</span>
      <p className={result && !result.ok ? result.code === 'unknown_outcome' ? 'command-warning' : 'field-error' : undefined}
        role={index === commands.length - 1 ? result && !result.ok && result.code !== 'unknown_outcome' ? 'alert' : 'status' : undefined}>
        {!result ? '處理中…' : result.ok ? '操作已接受' : commandFeedback(result, command.type)}{reviewed ? '（已核對結果）' : ''}
      </p>
      {result && !result.ok && <small>{result.code === 'unknown_outcome' ? '結果狀態' : '錯誤代碼'}：{result.code}{result.requestId === null ? ' · 服務無法解析 requestId' : ''}</small>}
    </li>)}</ol></details>}
  </div>;
}

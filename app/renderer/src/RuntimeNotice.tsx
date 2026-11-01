// Next to a Model dropdown (T045): why a runtime's models are not offered. A runtime that cannot be used lists no
// models, so without this the dropdown would just look short.
import type { RuntimeStatus } from '../../../contracts';
import { RUNTIME_NAMES, RUNTIME_ORDER } from './RuntimePanel';

export function RuntimeNotice({ runtimes }: { runtimes: readonly RuntimeStatus[] }) {
  const unavailable = RUNTIME_ORDER.flatMap(runtime => {
    const status = runtimes.find(item => item.runtime === runtime);
    return status && status.state !== 'available' ? [status] : [];
  });
  if (unavailable.length === 0) return null;
  return <ul className="runtime-notice" aria-label="無法使用的 Runtime">
    {unavailable.map(status => <li key={status.runtime} className="command-warning">
      {RUNTIME_NAMES[status.runtime]} 目前不可用，選單不列出它的模型。{status.detail ?? ''}（設定 → Runtime 可重新偵測）
    </li>)}
  </ul>;
}

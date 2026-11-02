import type { CommandResult, ErrorCode } from '../../../contracts';

type Failure = Extract<CommandResult, { ok: false }>;
const explanations: Record<ErrorCode, string> = {
  unsupported: '目前尚未支援此操作。',
  stale_revision: '版本已變更，請重新讀取並比對草稿。',
  permission_denied: '操作遭拒絕：沒有所需權限。',
  runtime_unavailable: 'Runtime 目前無法使用。',
  invalid_transition: '目前狀態不允許此操作。',
  unknown_outcome: '結果未知，請先核對目前狀態，勿重複送出。',
  storage_failed: '儲存失敗，草稿仍保留。',
  storage_read_only: '資料目前是唯讀，無法寫入；草稿仍保留。',
  not_found: '找不到指定目標，請重新讀取資料。',
  already_exists: '目標 ID 已存在，請重新讀取並核對。',
  invalid_request: '操作內容不符合契約，請檢查輸入。',
  usage_limit: '已達使用限制，操作遭拒絕。',
  internal_error: '服務發生錯誤，請重新讀取並核對狀態。',
};

export const blocksResubmit = (result: CommandResult) => !result.ok && (result.mayHaveSideEffects || result.code === 'unknown_outcome');
/** What a code means for one operation, where the general words would leave the user without a way on (T046). */
const byOperation: Partial<Record<string, Partial<Record<ErrorCode, string>>>> = {
  'agent.delete': { invalid_transition: 'Agent 仍被 Workflow 或 session 使用，無法刪除。' },
  'delivery.resolve': { runtime_unavailable: '重試已保存，但這個 session 現在接不回來，所以還沒有送出；下次啟動時會再試一次。要現在繼續，請另開一個新的 session。' },
  'session.send': { invalid_transition: '訊息沒有送出：這個 session 目前不能接收訊息（例如資料夾已不在，或 session 接不回來）。可以另開一個新的 session 繼續。' },
};

export function commandFeedback(result: Failure, operation?: string): string {
  const explanation = (operation === undefined ? undefined : byOperation[operation]?.[result.code]) ?? explanations[result.code];
  return explanation + (result.mayHaveSideEffects && result.code !== 'unknown_outcome' ? ' 可能已產生變更，請先核對；不可直接重試。' : '');
}

export const unknownResult = (requestId: Failure['requestId']): Failure => ({
  ok: false, requestId, code: 'unknown_outcome', message: '無法確認指令結果。', retryable: false, mayHaveSideEffects: true,
});

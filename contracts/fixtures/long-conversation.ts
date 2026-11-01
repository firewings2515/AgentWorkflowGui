// A long conversation for paging and performance work (C-32; T038, T040, T041): `turns` completed turns of
// one session, each with the user's message, an assistant reply and a command item, at one-minute steps. The
// same arguments always give the same records, so a baseline can be measured again.
import { HistoryPage } from '../ipc';

const minute = 60_000;
const start = Date.parse('2026-10-24T09:00:00+08:00');
const at = (n: number) => new Date(start + n * minute).toISOString();

export interface LongConversationOptions {
  sessionId?: string;
  turns: number;
  /** Characters of each assistant reply (default 400). */
  replyLength?: number;
}

/** The whole history as one page with nothing older (`olderCursor` null), oldest first. */
export const longConversation = ({ sessionId = 's-long', turns, replyLength = 400 }: LongConversationOptions): HistoryPage => {
  const page = { sessionId, turns: [] as unknown[], messages: [] as unknown[], items: [] as unknown[], nativeTasks: [], permissionRequests: [], artifacts: [], olderCursor: null };
  for (let i = 0; i < turns; i++) {
    const turnId = `${sessionId}-turn-${i}`;
    page.turns.push({ id: turnId, sessionId, state: 'completed', startedAt: at(i), endedAt: at(i + 0.9) });
    page.messages.push({ id: `${turnId}-u`, sessionId, turnId, role: 'user', origin: { kind: 'user' }, text: `第 ${i + 1} 個問題`, createdAt: at(i) });
    page.items.push({ id: `${turnId}-cmd`, sessionId, turnId, kind: 'command', command: 'npm test', cwd: 'E:/work/demo', state: 'completed', exitCode: 0, output: 'ok', startedAt: at(i + 0.2), endedAt: at(i + 0.3) });
    page.messages.push({ id: `${turnId}-a`, sessionId, turnId, role: 'assistant', origin: { kind: 'agent' }, text: `回覆 ${i + 1}：`.padEnd(replyLength, '字'), createdAt: at(i + 0.8) });
  }
  return HistoryPage.parse(page);
};

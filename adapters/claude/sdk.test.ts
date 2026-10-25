// The real SDK binding's raw transcript read (importSessionToStore + getSessionInfo), on JSONL files the
// test writes into a throwaway Claude config folder. No CLI is started and no model is called.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../contracts';
import { ClaudeAdapter } from './adapter';
import { claudeAgentSdk } from './sdk';

// The SDK finds transcripts under $CLAUDE_CONFIG_DIR/projects; set before the SDK is loaded.
const configDir = vi.hoisted(() => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const dir = `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/awg-t009-sdk-${process.pid}`;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return { dir, previous };
});

const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'awg-t009-cwd-')));
const project = join(configDir.dir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(project, { recursive: true });

afterAll(() => {
  rmSync(configDir.dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  if (configDir.previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir.previous;
});

const SID = '5f3c2a1e-8b7d-4c6e-9f10-112233445566';
const PAYLOAD = '6c8a00ac-6181-4e5f-8c01-0d915ed9844f';
const TEXT = 'Handoff: implement subtract().';
const line = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, sessionId: SID, cwd, timestamp: '2026-10-25T11:00:00.000Z', ...o });
const prompt = (uuid: string, parentUuid: string | null) => line({ type: 'user', uuid, parentUuid, message: { role: 'user', content: TEXT } });
const reply = (uuid: string, parentUuid: string) =>
  line({ type: 'assistant', uuid, parentUuid, message: { id: `msg_${uuid.slice(-4)}`, role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ACK' }] } });
const A1 = '11111111-0000-4000-8000-000000000001';
const A2 = '11111111-0000-4000-8000-000000000002';
const write = (text: string) => writeFileSync(join(project, `${SID}.jsonl`), text);
const adapter = () => new ClaudeAdapter({ sdk: claudeAgentSdk, onPermissionRequest: () => undefined });
const reconcile = () => adapter().reconcile({ nativeSessionRef: SID, cwd, clientMessageId: PAYLOAD as never, text: TEXT });

describe('readTranscript through importSessionToStore (review r2 P1-1)', () => {
  it('reads a whole file as complete, also without the final newline', async () => {
    write(`${prompt(PAYLOAD, null)}\n${reply(A1, PAYLOAD)}\n`);
    expect(await claudeAgentSdk.readTranscript(SID, { dir: cwd })).toMatchObject({ complete: true, lines: [{ uuid: PAYLOAD }, { uuid: A1 }] });
    expect(await reconcile()).toMatchObject({ state: 'sent' });
    write(`${prompt(PAYLOAD, null)}\n${reply(A1, PAYLOAD)}`);
    expect(await claudeAgentSdk.readTranscript(SID, { dir: cwd })).toMatchObject({ complete: true });
  });

  it('reports an unknown session as empty and complete', async () => {
    expect(await claudeAgentSdk.readTranscript('00000000-0000-4000-8000-0000000000aa', { dir: cwd })).toEqual({ lines: [], complete: true });
  });

  it('a truncated last line hides a duplicate: the read is incomplete and reconcile stays unknown', async () => {
    const duplicate = prompt(PAYLOAD, A1);
    write(`${prompt(PAYLOAD, null)}\n${reply(A1, PAYLOAD)}\n${duplicate}\n`);
    expect(await reconcile()).toMatchObject({ state: 'unknown', reason: 'duplicate' });
    // The CLI died while writing the second record: the SDK skips the line and returns the first only.
    write(`${prompt(PAYLOAD, null)}\n${reply(A1, PAYLOAD)}\n${duplicate.slice(0, 60)}`);
    const read = await claudeAgentSdk.readTranscript(SID, { dir: cwd });
    expect(read.lines.filter((l) => l.uuid === PAYLOAD)).toHaveLength(1);
    expect(read).toMatchObject({ complete: false });
    expect(await reconcile()).toMatchObject({ state: 'unknown', reason: 'read-failed' });
  });

  it('a damaged line in the middle makes the read incomplete too', async () => {
    write(`${prompt(PAYLOAD, null)}\n{"type":"user","uuid":"${PAYLOAD}",broken\n${reply(A2, PAYLOAD)}\n`);
    expect(await claudeAgentSdk.readTranscript(SID, { dir: cwd })).toMatchObject({ complete: false });
    expect(await reconcile()).toMatchObject({ state: 'unknown', reason: 'read-failed' });
    const history = await adapter().readHistory({ sessionId: SessionId.parse('session-a'), nativeSessionRef: SID, cwd });
    expect(history.complete).toBe(false);
  });
});

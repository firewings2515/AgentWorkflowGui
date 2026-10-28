// Real Claude and Codex sessions calling the GUI MCP server once each. Skipped unless AWG_MCP_LIVE is
// `claude`, `codex` or `both`, because it spends usage: one short turn per runtime on the cheapest model,
// in a fresh temp folder. Optional: AWG_CLAUDE_MODEL (default haiku), AWG_CODEX_MODEL (default
// gpt-6-luna), AWG_CODEX_COMMAND, AWG_MCP_LIVE_LOG=<file> for the findings (the `_meta` key names the
// clients send, never their values, and never a token).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AttemptId, ClientMessageId, type PermissionDecision, SessionId } from '../../contracts';
import type { PermissionHandle, RuntimeEvent } from '../../core/ports';
import { ClaudeAdapter } from '../claude/adapter';
import { claudeAgentSdk } from '../claude/sdk';
import { CodexAdapter, type CodexAdapterEvent } from '../codex/adapter';
import { GuiMcpServer } from './server';
import type { McpCallContext, McpToolHandlers } from './tools';

const which = process.env.AWG_MCP_LIVE ?? '';
const claudeLive = which === 'claude' || which === 'both';
const codexLive = which === 'codex' || which === 'both';
const logFile = process.env.AWG_MCP_LIVE_LOG;

const findings: Record<string, unknown> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what: string, predicate: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`live: timed out waiting for ${what}`);
    await sleep(200);
  }
};
/**
 * Whether the runtime wrote the token into its own stored session file (found by name under `root`).
 * Only a yes/no leaves this function.
 */
const tokenOnDisk = (root: string | null | undefined, nameIncludes: string, token: string): { found: boolean; containsToken?: boolean } => {
  if (!root || !existsSync(root)) return { found: false };
  const name = readdirSync(root, { recursive: true, encoding: 'utf8' }).find((f) => f.includes(nameIncludes) && f.endsWith('.jsonl'));
  return name === undefined ? { found: false } : { found: true, containsToken: readFileSync(join(root, name), 'utf8').includes(token) };
};
/** Runs every cleanup step even when an earlier one throws, then throws the first error. */
const cleanUp = async (...steps: (() => unknown)[]): Promise<void> => {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
};

const decide = (outcome: PermissionDecision['outcome']): PermissionDecision => ({ outcome, decidedBy: 'policy', at: new Date().toISOString() });

/** A server whose only working tool is report_to_root; it records who called and what `_meta` keys came. */
const startRecordingServer = async (label: string) => {
  const calls: { caller: string; content: string; sourceCallRefKind: string }[] = [];
  const meta: string[][] = [];
  const refuse = () => Promise.reject(new Error('not used in the live check'));
  const handlers: McpToolHandlers = {
    handoff: refuse,
    create_tasks: refuse,
    send_message: refuse,
    wait_for_file: refuse,
    report_to_root: (input, ctx: McpCallContext) => {
      calls.push({ caller: ctx.caller, content: input.content, sourceCallRefKind: ctx.sourceCallRef.startsWith('meta:') ? ctx.sourceCallRef.replace(/:[^:]*$/, '') : 'rpc' });
      return Promise.resolve({ status: 'reported' });
    },
  };
  const server = await GuiMcpServer.start({ handlers, onCallMeta: (info) => meta.push(info.metaKeys) });
  /** `extra` is read inside the cleanup, so a failure in it cannot keep the server open. */
  const close = (extra: () => Record<string, unknown>) =>
    cleanUp(
      () => (findings[label] = { ...extra(), calls, metaKeys: meta }),
      () => server.close(),
    );
  return { server, calls, close };
};

const prompt = (marker: string) =>
  `This is an automated check of a local tool server. Call the tool report_to_root from the MCP server "gui" ` +
  `exactly once with content "${marker}". Do not use any other tool except what is needed to load that tool. Then reply DONE.`;

afterAll(() => {
  if (logFile) writeFileSync(logFile, JSON.stringify(findings, null, 1));
});

describe.skipIf(!claudeLive)('GUI MCP server with a real Claude session (live)', () => {
  const cwd = claudeLive ? mkdtempSync(join(tmpdir(), 'awg-t016-claude-')) : '';
  afterAll(async () => {
    if (!cwd) return;
    const scratch = join(tmpdir(), 'claude');
    await cleanUp(
      () => rmSync(cwd, { recursive: true, force: true }),
      // The CLI keeps scratch files under %TEMP%\claude\<encoded cwd>; the transcript under ~/.claude stays.
      () => {
        if (existsSync(scratch)) for (const d of readdirSync(scratch)) if (d.endsWith(basename(cwd))) rmSync(join(scratch, d), { recursive: true, force: true });
      },
    );
  });

  it('a Claude session calls report_to_root and is identified by its token', { timeout: 240_000 }, async () => {
    const { server, calls, close } = await startRecordingServer('claude');
    const sessionId = SessionId.parse('t016-live-claude');
    const asked: string[] = [];
    // Only the GUI tool (and ToolSearch, which loads deferred MCP tools) may run; everything else is declined.
    let token = '';
    const onPermissionRequest = (h: PermissionHandle) => {
      asked.push(h.request.summary);
      const ok = /^(mcp__gui__report_to_root|ToolSearch)\b/.test(h.request.summary);
      h.answer(decide(ok ? 'approve' : 'decline'));
    };
    const adapter = new ClaudeAdapter({
      sdk: claudeAgentSdk,
      onPermissionRequest,
      mcpServers: ({ sessionId: id }) => {
        const mount = server.mount(id);
        token = mount.token;
        return { gui: { type: 'http', url: mount.url, headers: { Authorization: `Bearer ${mount.token}` } } };
      },
    });
    const events: RuntimeEvent[] = [];
    adapter.subscribe((e) => events.push(e));
    const ref = randomUUID();
    try {
      await adapter.start();
      await adapter.startSession({ sessionId, cwd, model: { runtime: 'claude', model: process.env.AWG_CLAUDE_MODEL ?? 'haiku' }, readOnly: true, preallocatedRef: ref });
      const marker = `AWG-T016-${randomUUID().slice(0, 8)}`;
      const clientMessageId = randomUUID();
      const sent = await adapter.dispatchOnce({
        nativeSessionRef: ref,
        attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${clientMessageId}`), clientMessageId: ClientMessageId.parse(clientMessageId), dispatchStartedAt: new Date().toISOString() },
        text: prompt(marker),
        entry: { kind: 'new-turn' },
        timeoutMs: 90_000,
      });
      expect(sent.state).toBe('sent');
      await waitFor('the turn to end', () => events.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running'), 180_000);
      expect(calls).toEqual([expect.objectContaining({ caller: sessionId, content: marker })]);
    } finally {
      await cleanUp(
        () => adapter.close(),
        () => close(() => ({ asked, transcript: tokenOnDisk(join(homedir(), '.claude', 'projects'), ref, token) })),
      );
    }
  });
});

describe.skipIf(!codexLive)('GUI MCP server with a real Codex thread (live)', () => {
  const cwd = codexLive ? mkdtempSync(join(tmpdir(), 'awg-t016-codex-')) : '';
  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('a Codex thread calls report_to_root and is identified by its token', { timeout: 240_000 }, async () => {
    const { server, calls, close } = await startRecordingServer('codex');
    const sessionId = SessionId.parse('t016-live-codex');
    const model = process.env.AWG_CODEX_MODEL ?? 'gpt-6-luna';
    const asked: string[] = [];
    // Codex asks before an MCP tool call (an elicitation from server "gui"); only that is approved.
    const onPermissionRequest = (h: PermissionHandle) => {
      asked.push(`${h.request.kind}:${h.request.elicitation?.serverName ?? ''}`);
      const ok = h.request.kind === 'mcpElicitation' && h.request.elicitation?.serverName === 'gui';
      h.answer(decide(ok ? 'approve' : 'decline'));
    };
    const adapter = new CodexAdapter({
      ...(process.env.AWG_CODEX_COMMAND && { spawnOptions: { command: process.env.AWG_CODEX_COMMAND } }),
      onPermissionRequest,
    });
    const events: CodexAdapterEvent[] = [];
    adapter.subscribe((e) => events.push(e));
    const mount = server.mount(sessionId);
    let threadId = '';
    try {
      await adapter.start();
      const thread = await adapter.startThread({
        sessionId,
        cwd,
        sandbox: 'workspace-write',
        model,
        config: { 'mcp_servers.gui.url': mount.url, 'mcp_servers.gui.http_headers': { Authorization: `Bearer ${mount.token}` } },
      });
      threadId = thread.threadId;
      const marker = `AWG-T016-${randomUUID().slice(0, 8)}`;
      const clientMessageId = randomUUID();
      const sent = await adapter.dispatchOnce({
        nativeSessionRef: thread.threadId,
        attempt: { state: 'unknown', attemptId: AttemptId.parse(`live-${clientMessageId}`), clientMessageId: ClientMessageId.parse(clientMessageId), dispatchStartedAt: new Date().toISOString() },
        text: prompt(marker),
        entry: { kind: 'new-turn', model: { runtime: 'codex', model, effort: 'low' } },
        timeoutMs: 60_000,
      });
      expect(sent.state).toBe('sent');
      await waitFor('the turn to end', () => events.some((e) => e.type === 'turn.updated' && e.turn.state !== 'running'), 180_000);
      expect(calls).toEqual([expect.objectContaining({ caller: sessionId, content: marker })]);
    } finally {
      const codexHome = adapter.serverInfo?.codexHome;
      await cleanUp(
        () => adapter.close(),
        () => close(() => ({ asked, rollout: threadId ? tokenOnDisk(codexHome && join(codexHome, 'sessions'), threadId, mount.token) : { found: false } })),
      );
    }
  });
});

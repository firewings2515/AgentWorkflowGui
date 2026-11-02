// Claude runtime adapter (T009): implements the runtime port with `@anthropic-ai/claude-agent-sdk`.
// Every live GUI session is one streaming-input query(), i.e. one `claude.exe` (SP-01, SP-05), bound to
// the GUI session it belongs to. SDK messages become contracts events; PreToolUse calls become
// permission requests answered by the layer above.
//
// Not here on purpose: retries of any kind (CR-2), the R-08 escalation decision (the layer above
// answers each request), supervisor idle shutdown, and Job Objects for orphaned commands (R-14).
import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ClientMessageId,
  type Message,
  MessageId,
  type MessageOrigin,
  type ModelOption,
  type ModelSelection,
  type NativeTask,
  NativeTaskId,
  type ObservedModel,
  PermissionDecision,
  PermissionRequest,
  PermissionRequestId,
  SessionId,
  type SessionItem,
  type Timestamp,
  type Turn,
  TurnId,
} from '../../contracts';
import type {
  DispatchRequest,
  DispatchResult,
  HistoryRequest,
  HistoryResult,
  McpMount,
  ModelChangeTiming,
  NativeSessionInfo,
  PermissionHandle,
  ReconcileMatch,
  ReconcileProvisionRequest,
  ReconcileProvisionResult,
  ReconcileRequest,
  ReconcileResult,
  ResumeSessionOptions,
  RuntimeAdapter,
  RuntimeAdapterHooks,
  RuntimeEvent,
  SessionSettings,
  StartSessionOptions,
} from '../../core/ports';
import { INTERRUPT_MARKER, isCompacted, mapTranscript, payloadRecords, rebuildNativeTasks, recordedCwd, turnOfMessage } from './history';
import { InputQueue } from './input-queue';
import {
  closeOpenItem,
  FILE_TOOLS,
  finishItem,
  isNonEmptyString,
  isObject,
  isoFromMs,
  type Json,
  num,
  opt,
  type Placement,
  placed,
  sameText,
  startItem,
  str,
  sumModelUsage,
  textOf,
  toEffort,
  toLimitWindows,
  toModelOption,
  toolResultsOf,
  toolResultText,
  toolUsesOf,
  toTokenCounts,
} from './mapping';
import { buildPermissionRequest, decisionToHookOutput, denyOutput, parsePreToolUse } from './permissions';
import { type ClaudeSdk, isWireUuid, type WireHookOutput, type WireMcpServer, type WireOrigin, type WireQuery, type WireQueryOptions, type WireSpawnedProcess, type WireSpawnOptions, type WireTranscript, type WireTranscriptEntry, type WireUserMessage } from './wire';

export interface ClaudeAdapterOptions extends RuntimeAdapterHooks {
  /** The SDK functions; `claudeAgentSdk` from ./sdk in production, a fake in tests. */
  sdk: ClaudeSdk;
  /**
   * The Claude Code executable to start (T045): the one found on this computer, handed to the SDK as
   * `pathToClaudeCodeExecutable`. The SDK's own copy when absent (tests, development).
   */
  executable?: string;
  /**
   * Origin stamped on a dispatched message (`SDKUserMessage.origin`). By default it follows
   * `DispatchRequest.origin`: the user's own input is `human`, peer and handoff payloads are `peer`
   * (R-03, SP-05), and anything else goes unattributed, which Claude treats as not human (fail closed).
   */
  dispatchOrigin?: (request: DispatchRequest) => WireOrigin | undefined;
  /**
   * Origin of a user message shown in events and history, for one this adapter did not dispatch itself
   * (a dispatched one keeps `DispatchRequest.origin`). Defaults to `user`.
   */
  userOrigin?: (info: { sessionId: SessionId; clientMessageId: string }) => MessageOrigin;
  /**
   * Starts a session's claude.exe; the GUI passes one that starts it inside the session's Job (T013,
   * R-14), so its commands cannot outlive the session or the GUI. The SDK's own spawn when absent.
   */
  spawnProcess?: (info: { sessionId: SessionId }) => WireQueryOptions['spawnClaudeCodeProcess'];
  /** Per-session MCP servers, e.g. the GUI MCP server with the session's own token (R-03). */
  mcpServers?: (info: { sessionId: SessionId; cwd: string }) => Record<string, WireMcpServer>;
  now?: () => Date;
  newId?: () => string;
  /** Command output is kept to this many trailing characters (default 64 KiB). */
  maxOutputChars?: number;
  /** Deadline for a dispatch before its outcome is reported unknown (default 60 s). */
  dispatchTimeoutMs?: number;
  /** Deadline for the CLI to come up on start / resume (default 60 s). */
  startTimeoutMs?: number;
  /**
   * PreToolUse hook timeout in seconds. Answers may be held for a long time (R-07 locks, R-05 user
   * approvals), so it defaults to 7 days instead of the CLI's short default. On timeout the CLI does not
   * run the tool and aborts the hook, which withdraws the request (live-checked, T009).
   */
  hookTimeoutSeconds?: number;
  /**
   * Fixed folder for the short-lived query that lists models when no session is open (default:
   * `awg-claude-probe` in the OS temp folder). Each probe makes a temp folder of its own in it for its
   * claude.exe and removes exactly that folder afterwards (T035).
   */
  probeCwd?: string;
  /** Replaces the cwd existence check (tests). */
  cwdExists?: (cwd: string) => boolean;
  /** Replaces the removal of a probe's temp folder (tests). */
  removeFolder?: (path: string) => Promise<void>;
  /**
   * Starts a probe's claude.exe (tests). Default: `spawnProcess` for `PROBE_SESSION_ID`, so it runs in a
   * Job like a session's; without one, a plain child process, as the SDK starts it.
   */
  spawnProbe?: (options: WireSpawnOptions) => WireSpawnedProcess;
  /** How long listModels waits for a probe's claude.exe to exit (default 5 s); its folder goes when it does. */
  probeExitTimeoutMs?: number;
  log?: (level: 'debug' | 'warn', message: string, detail?: unknown) => void;
}

interface TrackedItem {
  item: SessionItem;
  /** Main-loop items close with their turn; a sub-agent's items close with its task. */
  nativeTaskId?: NativeTaskId;
}

interface OpenMessage {
  id: string;
  placement: Placement;
  text: string;
  model?: string;
  createdAt: Timestamp;
}

interface PendingAck {
  text: string;
  resolve: (ack: { turnId: string | undefined; frame: string }) => void;
}

interface PermissionEntry {
  session: LiveSession;
  request: PermissionRequest;
  toolUseId: string;
  resolve: (output: WireHookOutput) => void;
  cleanup: () => void;
}

interface LiveSession {
  sessionId: SessionId;
  ref: string;
  cwd: string;
  query: WireQuery;
  input: InputQueue<WireUserMessage>;
  requestedModel: ModelSelection;
  observed: ObservedModel;
  turn?: { turn: Turn; interruptRequested: boolean } | undefined;
  /** Dispatched uuids not acknowledged yet, oldest first; a turn they start is named after them. */
  unacked: string[];
  usedTurnIds: Set<string>;
  acks: Map<string, PendingAck>;
  /** Open assistant message per context (`main` or a parent tool_use id). */
  openMessages: Map<string, OpenMessage>;
  /** API message id announced by `message_start`, per context, for text deltas. */
  streamIds: Map<string, string>;
  /** Usage of the API message in progress, per context; reported once when the message ends. */
  usage: Map<string, { id: string; usage: unknown; placement: Placement }>;
  items: Map<string, TrackedItem>;
  /** Tool calls the GUI denied; their error result is a decline, not a failure. */
  declined: Set<string>;
  tasks: Map<string, NativeTask>;
  taskByToolUse: Map<string, string>;
  /**
   * Background shell commands (`local_bash` tasks) by task id: the tool call that started each, and how
   * it ended when that came before the call's result (R-07: locks wait for them).
   */
  shellTasks: Map<string, { toolUseId?: string; ended?: 'completed' | 'failed' | 'interrupted' }>;
  /** Background commands whose tool call returned but whose task still runs, by tool_use id. */
  background: Map<string, SessionItem>;
  permissions: Set<PermissionEntry>;
  closing: boolean;
  ended: boolean;
  done: Promise<void>;
}

const MAIN = 'main';
const DEFAULT_MAX_OUTPUT = 64 * 1024;
/** The environment variable that carries a session's GUI MCP token into its own claude.exe only. */
export const GUI_TOKEN_ENV = 'AWG_GUI_MCP_TOKEN';
/** Claude Code keeps its temp files, a scratch folder per session among them, under `<this>\claude` (T035). */
export const CLI_TMPDIR_ENV = 'CLAUDE_CODE_TMPDIR';
/** How long listModels waits for a probe's claude.exe to exit before it ends that process. */
const PROBE_EXIT_MS = 5000;
/**
 * The Job a probe's claude.exe is started in through `spawnProcess`, like a session's (R-14); the Codex
 * probe's is `models-codex` (app/main backend).
 */
export const PROBE_SESSION_ID = SessionId.parse('models-claude');

/**
 * claude.exe for a probe, started as the SDK's own spawn starts it. The SDK reads only stdout of a custom
 * spawn, so stderr is read here (a full pipe would block claude.exe); the SDK's signal aborts only after
 * its stdin-EOF grace period, so killing on it is safe (as `claudeProcessSpawn` in adapters/process).
 */
const plainSpawn =
  (onStderr: (text: string) => void) =>
  (options: WireSpawnOptions): WireSpawnedProcess => {
    const child = spawnChild(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => onStderr(text));
    const { signal } = options;
    const onAbort = () => child.kill('SIGTERM');
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('exit', () => signal.removeEventListener('abort', onAbort));
    }
    return child;
  };

/**
 * A spawn function that knows the process it started (T035 r1 P1, r2 P1): `exited` resolves when that
 * process has exited, when its start failed, or once `closed()` says none will be started any more.
 * `kill()` ends that process only; `detach()` drops the listeners on one that will not exit.
 */
const watchedProcess = (spawn: (options: WireSpawnOptions) => WireSpawnedProcess) => {
  let child: WireSpawnedProcess | undefined;
  let done = false;
  const onExit = () => markExited();
  // A process that could not be started never exits; any other error leaves it to its exit.
  const onError = (error: NodeJS.ErrnoException) => {
    if (error.syscall?.startsWith('spawn')) markExited();
  };
  const detach = () => {
    child?.off('exit', onExit);
    child?.off('error', onError);
  };
  let markExited = () => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => {
      if (done) return;
      done = true;
      detach();
      resolve();
    };
  });
  return {
    spawn: (options: WireSpawnOptions): WireSpawnedProcess => {
      let started: WireSpawnedProcess;
      try {
        started = spawn(options);
      } catch (error) {
        markExited();
        throw error;
      }
      child = started;
      started.on('exit', onExit);
      started.on('error', onError);
      if (started.exitCode !== null || (started.signalCode ?? null) !== null) markExited();
      return started;
    },
    exited,
    /** The query is closed: no process will be started, so none started counts as exited. */
    closed: () => {
      if (child === undefined) markExited();
    },
    running: () => child !== undefined && !done,
    kill: (): boolean => {
      try {
        return child?.kill('SIGTERM') ?? false;
      } catch {
        return false;
      }
    },
    detach,
  };
};

type WatchedProcess = ReturnType<typeof watchedProcess>;

/** A model-listing probe whose temp folder goes once its claude.exe has exited (T035). */
interface Probe {
  /** Its own temp folder, when one could be made. */
  folder: string | undefined;
  cli: WatchedProcess;
  /** Settles after the process exited and its folder was removed (or the removal failed and was logged). */
  removed: Promise<void>;
  /** A close() has already waited for its removal (T043): later ones do not wait again, the removal goes on by itself. */
  closeWaited?: boolean;
}

/** Same folder, compared the way Windows does (case-insensitive, either separator, no trailing one). */
const sameFolder = (a: string, b: string): boolean => {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isThenable = (v: unknown): v is PromiseLike<unknown> => typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';

/** Resolves to `undefined` when `ms` passes first; never rejects for the timeout itself. */
const within = <T>(promise: Promise<T>, ms: number): Promise<{ value: T } | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * `SDKUserMessage.origin` for a payload (R-03, SP-05): only the user's own input is `human`; a message from
 * another session (a peer message, a handoff, a transfer) is `peer` and never counts as the user's approval;
 * anything else stays unattributed.
 */
const wireOrigin = (origin: MessageOrigin | undefined): WireOrigin | undefined => {
  switch (origin?.kind) {
    case 'user':
      return { kind: 'human' };
    case 'peer':
    case 'handoff':
    case 'transfer':
      return { kind: 'peer', from: origin.fromSessionId };
    default:
      return undefined;
  }
};

/** `hold` is set exactly while held, so it goes when the request is answered or withdrawn. */
const withoutHold = (request: PermissionRequest): PermissionRequest => {
  const copy = { ...request };
  delete copy.hold;
  return copy;
};

export class ClaudeAdapter implements RuntimeAdapter {
  readonly runtime = 'claude' as const;
  private started = false;
  private closing = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly dispatched = new Set<string>();
  /** Origin of each payload this adapter dispatched, by its uuid, for the user message it becomes. */
  private readonly origins = new Map<string, MessageOrigin>();
  /** Model-listing probes whose claude.exe has not exited yet (T035 r2 P1). */
  private readonly probes = new Set<Probe>();

  constructor(private readonly options: ClaudeAdapterOptions) {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** No shared process: each session starts its own CLI. */
  start(): Promise<void> {
    this.started = true;
    this.closing = false;
    return Promise.resolve();
  }

  /** R-14: every open session is interrupted before it is closed; a probe's claude.exe still running is ended. */
  async close(timeoutMs = 5000): Promise<{ forced: boolean }> {
    this.closing = true;
    const [results, probesLeft] = await Promise.all([Promise.all([...this.sessions.values()].map((s) => this.closeLive(s, timeoutMs))), this.closeProbes(timeoutMs)]);
    this.started = false;
    return { forced: probesLeft || results.some((r) => r.forced) };
  }

  /**
   * Ends the claude.exe of every probe still running, each by the process this adapter started (T035 r2
   * P1); its folder goes once it has exited. One that does not exit in time is let go: its listeners are
   * dropped, its folder is left, and that is logged. Returns whether any was let go.
   */
  private async closeProbes(timeoutMs: number): Promise<boolean> {
    // A probe an earlier close() already waited for (its folder removal was slow) is not waited for again: that
    // removal goes on by itself, and a second close() (shutdown after closeAll) would only add another timeout.
    const probes = [...this.probes].filter((p) => p.closeWaited !== true);
    for (const p of probes) p.closeWaited = true;
    for (const p of probes) if (p.cli.running() && !p.cli.kill()) this.log('warn', 'close: could not end a probe CLI', p.folder);
    await within(Promise.all(probes.map((p) => p.removed)), timeoutMs);
    const left = probes.filter((p) => p.cli.running());
    for (const p of left) {
      p.cli.detach();
      this.probes.delete(p);
      this.log('warn', 'close: a probe CLI did not exit; its temp folder is left', p.folder);
    }
    return left.length > 0;
  }

  /**
   * Releases one session's CLI (interrupt, then close; R-14), e.g. when the supervisor closes an idle
   * session (SP-05); resumeSession brings it back.
   */
  async closeSession(nativeSessionRef: string, timeoutMs = 5000): Promise<{ forced: boolean }> {
    const s = this.sessions.get(nativeSessionRef);
    return s ? this.closeLive(s, timeoutMs) : { forced: false };
  }

  /**
   * A pre-allocated session counts as created once its transcript exists under the cwd it was created in
   * (C-08). Read-only; not found is not proof that it was not created (CR-2).
   */
  async reconcileProvision(request: ReconcileProvisionRequest): Promise<ReconcileProvisionResult> {
    const ref = request.preallocatedRef;
    if (ref === undefined || !isWireUuid(ref)) return { state: 'unknown', reason: 'unsupported', detail: 'only a pre-allocated Claude session UUID can be looked up' };
    let lines: WireTranscriptEntry[];
    let complete: boolean;
    try {
      ({ lines, complete } = await this.options.sdk.readTranscript(ref, { dir: request.cwd }));
    } catch {
      // Fixed text: the SDK's error may quote paths or transcript content, and this result can end up in an escalation.
      return { state: 'unknown', reason: 'read-failed', detail: 'the stored transcript could not be read' };
    }
    // Nothing read from a transcript that was not read whole is not "none stored" (T046 r1 P1-1).
    if (lines.length === 0 && !complete) return { state: 'unknown', reason: 'read-failed', detail: 'the stored transcript could not be read whole' };
    if (lines.length === 0) return { state: 'unknown', reason: 'not-found', detail: 'no stored transcript for the pre-allocated session' };
    const recorded = recordedCwd(lines);
    if (recorded !== undefined && !sameFolder(recorded, request.cwd)) return { state: 'unknown', reason: 'read-failed', detail: 'the stored session ran in another folder' };
    return { state: 'sent', nativeSessionRef: ref };
  }

  async startSession(options: StartSessionOptions): Promise<NativeSessionInfo> {
    const ref = options.preallocatedRef ?? this.options.newId?.() ?? randomUUID();
    if (!isWireUuid(ref)) throw new Error(`startSession: Claude session IDs are UUIDs, got ${ref}`);
    return this.open(options, ref, { sessionId: ref }, { source: 'unknown' });
  }

  /**
   * Always in the original cwd (R-06). Core keeps the cwd from start (NativeSessionInfo) and passes it
   * here; the adapter checks it against the cwd the transcript itself recorded, because the SDK also
   * finds a session from another worktree of the same repository (SP-07). Read-only before the CLI starts.
   */
  async resumeSession(options: ResumeSessionOptions): Promise<NativeSessionInfo> {
    this.checkCwd(options.cwd, 'resumeSession');
    // A read that missed lines (a crash cut the last one) still shows where the session ran.
    let lines: WireTranscriptEntry[];
    try {
      ({ lines } = await this.options.sdk.readTranscript(options.nativeSessionRef, { dir: options.cwd }));
    } catch (error) {
      throw new Error(`resumeSession: could not read session ${options.nativeSessionRef} under ${options.cwd}: ${errorText(error)}`, { cause: error });
    }
    if (lines.length === 0) throw new Error(`resumeSession: no stored Claude session ${options.nativeSessionRef} under ${options.cwd}`);
    const recorded = recordedCwd(lines);
    if (recorded !== undefined && !sameFolder(recorded, options.cwd)) {
      throw new Error(`resumeSession: Claude session ${options.nativeSessionRef} ran in ${recorded}, not ${options.cwd}; resume it from its own folder`);
    }
    const lastModel = [...lines].reverse().find((e) => e.type === 'assistant' && e.isSidechain !== true && isObject(e.message) && isNonEmptyString(e.message.model) && e.message.model !== '<synthetic>');
    const observed: ObservedModel =
      lastModel && isObject(lastModel.message)
        ? { source: 'per-message', model: lastModel.message.model as string, observedAt: this.timeOf(lastModel.timestamp) }
        : { source: 'unknown' };
    return this.open(options, options.nativeSessionRef, { resume: options.nativeSessionRef }, observed);
  }

  /**
   * Hands the payload to the session once (CR2_DELIVERY_FIX §1 step 4) with the attempt's
   * clientMessageId as `SDKUserMessage.uuid`. `sent` needs an echo of that uuid on a reply frame
   * (`user_message_uuid(s)`); the queue push alone is not evidence. Never retried.
   */
  async dispatchOnce(req: DispatchRequest): Promise<DispatchResult> {
    const { attempt } = req;
    if (attempt.state !== 'unknown' || attempt.resolution?.decision === 'retry') {
      throw new Error('dispatchOnce: the attempt must be the live attempt committed as unknown');
    }
    const keys = [`attempt:${attempt.attemptId}`, `client:${attempt.clientMessageId}`];
    if (keys.some((k) => this.dispatched.has(k))) {
      return { state: 'unknown', reason: 'already-dispatched', written: false, detail: 'this attempt was already handed to the runtime by this adapter' };
    }
    const s = this.sessions.get(req.nativeSessionRef);
    if (!this.started || !s || s.closing || s.ended || s.input.isClosed) {
      return { state: 'unknown', reason: 'not-running', written: false, detail: `Claude session ${req.nativeSessionRef} is not open in this adapter` };
    }
    const refuse = (detail: string): DispatchResult => ({ state: 'unknown', reason: 'rejected', written: false, detail });
    if (req.entry.kind === 'new-turn') {
      if (s.turn) return refuse(`session is running turn ${s.turn.turn.id}; a new turn waits until it ends`);
      if (req.entry.model && req.entry.model.runtime !== 'claude') return refuse(`model ${req.entry.model.model} is not a Claude model`);
    } else {
      if (!s.turn) return refuse('no running turn to insert into');
      if (req.entry.expectedTurnRef !== undefined && req.entry.expectedTurnRef !== s.turn.turn.id) {
        return refuse(`expected turn ${req.entry.expectedTurnRef} but turn ${s.turn.turn.id} is running`);
      }
    }
    // Computed before the attempt is taken, so a throwing callback leaves nothing half done.
    const origin = this.options.dispatchOrigin ? this.options.dispatchOrigin(req) : wireOrigin(req.origin);
    for (const k of keys) this.dispatched.add(k);
    if (req.origin !== undefined) this.origins.set(attempt.clientMessageId, req.origin);

    if (req.entry.kind === 'new-turn' && req.entry.model) {
      try {
        await this.applyModel(s, req.entry.model);
      } catch (error) {
        return refuse(`model change before the turn failed: ${errorText(error)}`);
      }
    }
    const uuid: ClientMessageId = attempt.clientMessageId;
    // ClientMessageId is already a validated UUID; this only narrows the type for the SDK.
    if (!isWireUuid(uuid)) throw new Error(`dispatchOnce: clientMessageId ${uuid} is not a UUID`);
    const acked = new Promise<{ turnId: string | undefined; frame: string }>((resolve) => s.acks.set(uuid, { text: req.text, resolve }));
    const message: WireUserMessage = {
      type: 'user',
      uuid,
      session_id: s.ref,
      parent_tool_use_id: null,
      message: { role: 'user', content: req.text },
      ...opt('origin', origin),
    };
    s.unacked.push(uuid);
    if (!s.input.push(message)) {
      s.acks.delete(uuid);
      s.unacked = s.unacked.filter((u) => u !== uuid);
      return { state: 'unknown', reason: 'not-running', written: false, detail: 'the session input closed before the payload was queued' };
    }
    const timeoutMs = req.timeoutMs ?? this.options.dispatchTimeoutMs ?? 60_000;
    const outcome = await within(Promise.race([acked.then((ack) => ({ acked: true as const, ...ack })), s.done.then(() => ({ acked: false as const }))]), timeoutMs);
    if (!outcome) {
      return { state: 'unknown', reason: 'timeout', written: true, detail: `no reply frame echoed uuid ${uuid} within ${timeoutMs} ms` };
    }
    if (!outcome.value.acked) {
      s.acks.delete(uuid);
      return { state: 'unknown', reason: 'disconnected', written: true, detail: 'the Claude process ended before echoing the payload uuid' };
    }
    const { turnId, frame } = outcome.value;
    return {
      state: 'sent',
      nativeRef: { sessionRef: s.ref, ...opt('turnRef', turnId), itemRef: uuid },
      evidence: { kind: 'live-ack', at: this.now(), detail: `${frame} frame${turnId ? ` in turn ${turnId}` : ''} listed user_message_uuid ${uuid}` },
    };
  }

  /**
   * Read-only (CR2_DELIVERY_FIX §2, §4): reads the session's raw transcript lines and looks for records
   * of this uuid in this session with the same text. Raw lines, because getSessionMessages keeps one
   * entry per uuid and would hide a duplicate; and only a complete read counts, because the SDK skips a
   * line it cannot parse. The turn is the one readHistory shows. Never resumes or starts a turn.
   */
  async reconcile(req: ReconcileRequest): Promise<ReconcileResult> {
    const dir = { dir: req.cwd };
    let transcript: WireTranscript;
    try {
      transcript = await this.options.sdk.readTranscript(req.nativeSessionRef, dir);
    } catch (error) {
      return { state: 'unknown', reason: 'read-failed', matches: [], detail: errorText(error) };
    }
    const { lines } = transcript;
    const records = payloadRecords(lines, req.clientMessageId);
    // readHistory's own turn for the payload, when the chain view has it; else the same rules on raw lines.
    let historyTurn: string | undefined;
    if (records.length > 0) {
      try {
        const messages = await this.options.sdk.getSessionMessages(req.nativeSessionRef, { ...dir, includeSystemMessages: true });
        historyTurn = turnOfMessage(mapTranscript(messages, this.transcriptContext(SessionId.parse(req.nativeSessionRef), req.cwd)).entries, req.clientMessageId);
      } catch (error) {
        this.log('warn', 'could not read the chain view for a reconcile turn', error);
      }
    }
    const matches: ReconcileMatch[] = records.map((r) => ({
      turnRef: historyTurn ?? r.turnRef,
      itemRef: r.itemRef,
      contentMatches: r.sessionId === req.nativeSessionRef && sameText(r.content, req.text),
    }));
    if (!transcript.complete) {
      return { state: 'unknown', reason: 'read-failed', matches, detail: `the transcript could not be read whole: ${transcript.detail ?? 'unknown reason'}` };
    }
    if (matches.length === 0) {
      const compacted = isCompacted(lines) ? ' (the session was compacted)' : '';
      return { state: 'unknown', reason: 'not-found', matches, detail: `no stored record of uuid ${req.clientMessageId} among ${lines.length} transcript lines of ${req.nativeSessionRef}${compacted}` };
    }
    if (matches.length > 1) return { state: 'unknown', reason: 'duplicate', matches, detail: `${matches.length} stored prompts carry uuid ${req.clientMessageId}` };
    const [match] = matches as [ReconcileMatch];
    if (!match.contentMatches) return { state: 'unknown', reason: 'content-mismatch', matches, detail: 'the stored prompt with this uuid has another session or different content' };
    return {
      state: 'sent',
      nativeRef: { sessionRef: req.nativeSessionRef, turnRef: match.turnRef, itemRef: match.itemRef },
      evidence: { kind: 'reconciled', at: this.now(), detail: `stored prompt ${req.clientMessageId} in session ${req.nativeSessionRef} has the same text` },
    };
  }

  /** Stored history, oldest first (getSessionMessages / getSubagentMessages, CR-6). Read-only. */
  async readHistory(req: HistoryRequest): Promise<HistoryResult> {
    const { sdk } = this.options;
    const dir = { dir: req.cwd };
    const ctx = this.transcriptContext(req.sessionId, req.cwd);
    if (req.nativeTask) {
      const messages = await sdk.getSubagentMessages(req.nativeSessionRef, req.nativeTask.nativeRef, dir);
      const mapped = mapTranscript(messages, { ...ctx, nativeTaskId: req.nativeTask.nativeTaskId });
      return { entries: mapped.entries, nativeTasks: [], complete: mapped.complete };
    }
    const messages = await sdk.getSessionMessages(req.nativeSessionRef, { ...dir, includeSystemMessages: true });
    const mapped = mapTranscript(messages, ctx);
    let complete = mapped.complete;
    // The chain view drops the compaction boundary's subtype, so the raw lines are checked too; a raw read
    // that missed lines means the chain view may have missed them as well.
    try {
      const raw = await sdk.readTranscript(req.nativeSessionRef, dir);
      if (!raw.complete || isCompacted(raw.lines)) complete = false;
    } catch (error) {
      this.log('warn', 'could not read the raw transcript of a stored session', error);
      complete = false;
    }
    const agents: { agentId: string; parentToolUseId?: string }[] = [];
    try {
      for (const agentId of await sdk.listSubagents(req.nativeSessionRef, dir)) {
        // The sub-agent transcript names the Agent call that spawned it.
        const own = await sdk.getSubagentMessages(req.nativeSessionRef, agentId, dir);
        const parent = own.find((m) => isNonEmptyString(m.parent_tool_use_id))?.parent_tool_use_id ?? undefined;
        agents.push({ agentId, ...opt('parentToolUseId', parent) });
      }
    } catch (error) {
      this.log('warn', 'could not list the sub-agents of a stored session', error);
      complete = false;
    }
    const { tasks, unlinked } = rebuildNativeTasks(mapped, agents, req.sessionId);
    if (unlinked > 0) complete = false;
    return { entries: mapped.entries, nativeTasks: tasks, complete };
  }

  async interrupt(nativeSessionRef: string): Promise<void> {
    const s = this.live(nativeSessionRef, 'interrupt');
    if (s.turn) s.turn.interruptRequested = true;
    await s.query.interrupt();
  }

  /** R-12: takes effect from the next model call, also inside the running turn. */
  async setModel(nativeSessionRef: string, model: ModelSelection): Promise<ModelChangeTiming> {
    const s = this.live(nativeSessionRef, 'setModel');
    if (model.runtime !== 'claude') throw new Error(`setModel: ${model.model} is not a Claude model`);
    await this.applyModel(s, model);
    return 'next-model-call';
  }

  /** Stops one native sub-agent only (R-13: `stopTask`). */
  async stopNativeTask(nativeSessionRef: string, nativeTaskRef: string): Promise<void> {
    await this.live(nativeSessionRef, 'stopNativeTask').query.stopTask(nativeTaskRef);
  }

  /**
   * `supportedModels()` of an open session; with none open, a short-lived query that sends no prompt
   * (nothing reaches the model and no transcript is written).
   */
  async listModels(): Promise<ModelOption[]> {
    // A probe started after close() would outlive it (T035).
    if (this.closing) throw new Error('listModels: ClaudeAdapter is closing');
    const open = [...this.sessions.values()].find((s) => !s.closing && !s.ended);
    if (open) return (await open.query.supportedModels()).map(toModelOption);
    const input = new InputQueue<WireUserMessage>();
    // No prompt is sent, so no tool should run; if one did, it is denied.
    const denyAll = () => Promise.resolve(denyOutput('AgentWorkflowGui: model listing runs no tools'));
    // T035: the CLI leaves a scratch folder per session in its temp folder (`%TEMP%\claude\<cwd>\<id>\scratchpad`),
    // one more on every start. The probe runs in a fixed folder, and its claude.exe gets a temp folder of its
    // own made there, which is removed by its path once that process has exited; nothing else is touched.
    const cwd = this.options.probeCwd ?? join(tmpdir(), 'awg-claude-probe');
    let temp: string | undefined;
    let query: WireQuery | undefined;
    // The probe starts its claude.exe itself, so it sees the process exit (T035 r1 P1): the end of the
    // SDK's stream is not that, as the SDK stops waiting for the exit after a short grace. It starts it the
    // way sessions do (T035 r2 P1), in the GUI's Job for the probe, so the GUI's exit ends it too.
    const spawn = this.options.spawnProbe ?? this.options.spawnProcess?.({ sessionId: PROBE_SESSION_ID }) ?? plainSpawn((text) => this.log('debug', 'claude stderr', text));
    const cli = watchedProcess(spawn);
    let probe: Probe | undefined;
    try {
      try {
        mkdirSync(cwd, { recursive: true });
        temp = mkdtempSync(join(cwd, 'tmp-'));
      } catch (error) {
        this.log('warn', 'listModels: could not make the probe folder; the probe uses the OS temp folder', errorText(error));
      }
      probe = this.trackProbe(temp, cli);
      const options = this.queryOptions(temp === undefined ? tmpdir() : cwd, { readOnly: true }, {}, denyAll);
      const probeOptions = { ...options, ...(temp !== undefined && { env: { ...process.env, [CLI_TMPDIR_ENV]: temp } }), spawnClaudeCodeProcess: cli.spawn };
      query = this.options.sdk.query({ prompt: input, options: probeOptions });
      const timeoutMs = this.options.startTimeoutMs ?? 60_000;
      const models = await within(query.supportedModels(), timeoutMs);
      if (!models) throw new Error(`listModels: the Claude CLI did not answer within ${timeoutMs} ms`);
      return models.value.map(toModelOption);
    } finally {
      input.close();
      try {
        query?.close();
      } catch (error) {
        this.log('warn', 'query.close() threw', error);
      }
      cli.closed();
      if (probe !== undefined) await this.settleProbe(probe);
    }
  }

  /** Keeps a probe until its claude.exe has exited, then removes its own temp folder; a failed removal is only logged (T035). */
  private trackProbe(folder: string | undefined, cli: WatchedProcess): Probe {
    const remove = async () => {
      if (folder === undefined) return;
      try {
        await (this.options.removeFolder ?? ((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))(folder);
      } catch (error) {
        this.log('warn', 'listModels: could not remove the probe temp folder', { folder, error: errorText(error) });
      }
    };
    const probe: Probe = { folder, cli, removed: cli.exited.then(remove) };
    this.probes.add(probe);
    void probe.removed.then(() => this.probes.delete(probe));
    return probe;
  }

  /**
   * listModels waits for its probe's claude.exe to exit and its folder to go. One still running after the
   * wait is ended (that process only); its folder goes once it has exited, or close() lets it go.
   */
  private async settleProbe(probe: Probe): Promise<void> {
    if (await within(probe.removed, this.options.probeExitTimeoutMs ?? PROBE_EXIT_MS)) return;
    if (!probe.cli.running()) return;
    this.log('warn', 'listModels: the probe CLI has not exited; it is ended, and its temp folder removed once it exits', probe.folder);
    if (!probe.cli.kill()) this.log('warn', 'listModels: could not end the probe CLI', probe.folder);
  }

  // ---- sessions -----------------------------------------------------------------------------------

  private async open(settings: SessionSettings & { sessionId: SessionId; cwd: string }, ref: string, how: { sessionId: string } | { resume: string }, observed: ObservedModel): Promise<NativeSessionInfo> {
    if (!this.started || this.closing) throw new Error('ClaudeAdapter is not started');
    if (settings.model.runtime !== 'claude') throw new Error(`${settings.model.model} is not a Claude model`);
    this.checkCwd(settings.cwd, 'resume' in how ? 'resumeSession' : 'startSession');
    if (this.sessions.has(ref)) throw new Error(`Claude session ${ref} is already open`);

    const input = new InputQueue<WireUserMessage>();
    // The hook needs the session, which needs the query: bind it once both exist.
    const bound: { session?: LiveSession } = {};
    const hook = (raw: unknown, toolUseId: string | undefined, o: { signal: AbortSignal }) =>
      bound.session ? this.onPreToolUse(bound.session, raw, toolUseId, o.signal) : Promise.resolve(denyOutput('AgentWorkflowGui: session is not bound yet'));
    const query = this.options.sdk.query({ prompt: input, options: this.queryOptions(settings.cwd, settings, how, hook, settings.sessionId) });
    let markDone!: () => void;
    const s: LiveSession = {
      sessionId: settings.sessionId,
      ref,
      cwd: settings.cwd,
      query,
      input,
      requestedModel: settings.model,
      observed,
      unacked: [],
      usedTurnIds: new Set(),
      acks: new Map(),
      openMessages: new Map(),
      streamIds: new Map(),
      usage: new Map(),
      items: new Map(),
      shellTasks: new Map(),
      background: new Map(),
      declined: new Set(),
      tasks: new Map(),
      taskByToolUse: new Map(),
      permissions: new Set(),
      closing: false,
      ended: false,
      done: new Promise<void>((resolve) => (markDone = resolve)),
    };
    bound.session = s;
    this.sessions.set(ref, s);
    void this.consume(s).finally(markDone);

    const timeoutMs = this.options.startTimeoutMs ?? 60_000;
    let failure: string | undefined;
    try {
      const ready = await within(
        Promise.race([query.initializationResult().then(() => 'ready' as const), s.done.then(() => 'ended' as const)]),
        timeoutMs,
      );
      if (!ready) failure = `the Claude CLI did not come up within ${timeoutMs} ms`;
      else if (ready.value === 'ended') failure = 'the Claude CLI exited during startup';
    } catch (error) {
      failure = errorText(error);
    }
    if (failure !== undefined) {
      await this.closeLive(s, 2000);
      throw new Error(`${'resume' in how ? 'resumeSession' : 'startSession'}: Claude session ${ref} in ${settings.cwd} did not start: ${failure}`);
    }
    return { sessionId: settings.sessionId, nativeSessionRef: ref, cwd: settings.cwd, model: observed };
  }

  /** SP-04 isolation and R-08 permissions are fixed; only cwd, model, instructions and MCP vary. */
  private queryOptions(
    cwd: string,
    settings: Pick<SessionSettings, 'readOnly'> & Partial<Pick<SessionSettings, 'model' | 'instructions'>> & { mcp?: McpMount | undefined },
    how: { sessionId?: string; resume?: string },
    hook: (raw: unknown, toolUseId: string | undefined, o: { signal: AbortSignal }) => Promise<WireHookOutput>,
    sessionId?: SessionId,
  ): WireQueryOptions {
    const effort = toEffort(settings.model?.effort);
    const configured = sessionId === undefined ? undefined : this.options.mcpServers?.({ sessionId, cwd });
    // The GUI MCP server with this start's token (R-03) wins over a configured server of the same name.
    // The SDK hands mcpServers to claude.exe as a command-line argument, which any process of the user can
    // list (T021: another session's agent could read the token and call as this session). The header only
    // names a variable, which Claude Code expands from the environment of this session's claude.exe alone.
    const gui: Record<string, WireMcpServer> | undefined = settings.mcp && { gui: { type: 'http', url: settings.mcp.url, headers: { Authorization: `Bearer \${${GUI_TOKEN_ENV}}` } } };
    const mcpServers = configured || gui ? { ...configured, ...gui } : undefined;
    const spawn = sessionId === undefined ? undefined : this.options.spawnProcess?.({ sessionId });
    return {
      cwd,
      ...opt('sessionId', how.sessionId),
      ...opt('resume', how.resume),
      ...opt('model', settings.model?.model),
      ...opt('effort', effort),
      ...(settings.instructions !== undefined && { systemPrompt: { type: 'preset', preset: 'claude_code', append: settings.instructions } }),
      settingSources: [],
      settings: { disableClaudeAiConnectors: true },
      strictMcpConfig: true,
      ...opt('mcpServers', mcpServers),
      ...(settings.mcp && { env: { ...process.env, [GUI_TOKEN_ENV]: settings.mcp.token } }),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Read-only nodes (R-04): the edit tools are not offered at all. Shell writes still reach the hook.
      ...(settings.readOnly && { disallowedTools: [...FILE_TOOLS] }),
      hooks: { PreToolUse: [{ hooks: [hook], timeout: this.options.hookTimeoutSeconds ?? 7 * 24 * 3600 }] },
      includePartialMessages: true,
      persistSession: true,
      stderr: (data) => this.log('debug', 'claude stderr', data),
      ...opt('pathToClaudeCodeExecutable', this.options.executable),
      ...opt('spawnClaudeCodeProcess', spawn),
    };
  }

  private async applyModel(s: LiveSession, model: ModelSelection): Promise<void> {
    await s.query.setModel(model.model);
    const effort = toEffort(model.effort);
    if (effort) await s.query.applyFlagSettings({ effortLevel: effort });
    s.requestedModel = model;
  }

  private async closeLive(s: LiveSession, timeoutMs: number): Promise<{ forced: boolean }> {
    if (s.ended) {
      this.sessions.delete(s.ref);
      return { forced: false };
    }
    s.closing = true;
    let forced = false;
    // R-14: interrupt first; close() alone leaves claude.exe and its commands running (SP-08).
    try {
      if (!(await within(s.query.interrupt(), timeoutMs))) forced = true;
    } catch (error) {
      this.log('debug', 'interrupt before close failed', error);
    }
    s.input.close();
    try {
      s.query.close();
    } catch (error) {
      this.log('warn', 'query.close() threw', error);
    }
    if (!(await within(s.done, timeoutMs))) forced = true;
    this.sessions.delete(s.ref);
    return { forced };
  }

  private async consume(s: LiveSession): Promise<void> {
    let error: string | undefined;
    try {
      for await (const m of s.query) this.guard('SDK message', () => this.onMessage(s, m));
    } catch (e) {
      error = errorText(e);
    }
    this.guard('session end', () => this.onEnded(s, error));
  }

  private onEnded(s: LiveSession, error: string | undefined): void {
    s.ended = true;
    s.input.close();
    for (const entry of [...s.permissions]) this.withdraw(entry, 'the Claude session ended');
    const at = this.now();
    for (const key of [...s.openMessages.keys()]) this.flushMessage(s, key);
    for (const key of [...s.usage.keys()]) this.flushUsage(s, key);
    // Calls still open were killed with the process, whatever happens to the turn.
    for (const [id, tracked] of s.items) {
      const closed = closeOpenItem(tracked.item, 'interrupted', at);
      if (closed) this.emit({ type: 'item.updated', item: closed });
      s.items.delete(id);
    }
    if (s.turn) this.endTurn(s, s.closing || s.turn.interruptRequested ? 'interrupted' : 'failed', at, error ?? 'the Claude process ended during the turn');
    for (const task of s.tasks.values()) {
      if (task.state === 'running') this.emit({ type: 'nativeTask.updated', task: { ...task, state: 'stopped', endedAt: at } });
    }
    s.acks.clear();
    const expected = s.closing || this.closing;
    this.emit({ type: 'runtime.exited', runtime: 'claude', sessionIds: [s.sessionId], expected, code: null, signal: null, ...opt('error', error), at });
    this.emit({ type: 'session.activity', sessionId: s.sessionId, activity: expected && error === undefined ? 'closed' : 'error', at });
    if (!s.closing) this.sessions.delete(s.ref);
  }

  // ---- SDK messages -------------------------------------------------------------------------------

  private onMessage(s: LiveSession, m: unknown): void {
    if (!isObject(m)) return;
    const parent = isNonEmptyString(m.parent_tool_use_id) ? m.parent_tool_use_id : undefined;
    const at = this.now();
    switch (m.type) {
      case 'system':
        this.onSystem(s, m, parent, at);
        break;
      case 'stream_event':
        if (!parent) this.openTurn(s, at);
        this.onStreamEvent(s, m, parent);
        break;
      case 'assistant':
        if (!parent) this.openTurn(s, at);
        this.onAssistant(s, m, parent, at);
        break;
      case 'user':
        this.onUser(s, m, parent, at);
        break;
      case 'result':
        if (!parent) {
          this.openTurn(s, at);
          this.ack(s, m);
          this.onResult(s, m, at);
          return;
        }
        break;
      case 'rate_limit_event':
        this.emit({ type: 'usage.limits', ...toLimitWindows(m.rate_limit_info), at });
        break;
      default:
        break;
    }
    if (!parent) this.ack(s, m);
  }

  private onSystem(s: LiveSession, m: Json, parent: string | undefined, at: Timestamp): void {
    switch (m.subtype) {
      case 'init':
        // Recorded sessions emit init at the start of every turn, including one a background
        // sub-agent starts on its own (SP-03 N3, R-05).
        if (!parent) this.openTurn(s, at);
        return;
      case 'session_state_changed':
        if (m.state === 'running' && !parent) this.openTurn(s, at);
        return;
      case 'task_started':
        this.onTaskStarted(s, m, at);
        return;
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this.onTaskChanged(s, m, at);
        return;
      default:
        return;
    }
  }

  private onStreamEvent(s: LiveSession, m: Json, parent: string | undefined): void {
    const event = isObject(m.event) ? m.event : undefined;
    if (!event) return;
    const key = parent ?? MAIN;
    if (event.type === 'message_start' && isObject(event.message) && isNonEmptyString(event.message.id)) {
      s.streamIds.set(key, event.message.id);
      const p = this.placement(s, m, parent);
      if (p) this.trackUsage(s, key, event.message.id, event.message.usage, p);
      return;
    }
    // message_delta carries the message's final counts.
    if (event.type === 'message_delta' && isObject(event.usage)) {
      const tracked = s.usage.get(key);
      if (tracked) tracked.usage = event.usage;
      return;
    }
    if (event.type === 'message_stop') {
      s.streamIds.delete(key);
      this.flushMessage(s, key);
      this.flushUsage(s, key);
      return;
    }
    if (event.type !== 'content_block_delta' || !isObject(event.delta) || event.delta.type !== 'text_delta') return;
    const delta = str(event.delta.text);
    const messageId = s.streamIds.get(key);
    if (!delta || !messageId) return;
    const p = this.placement(s, m, parent);
    if (!p) return;
    this.emit({
      type: 'message.delta',
      sessionId: p.sessionId,
      ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
      ...opt('nativeTaskId', p.nativeTaskId),
      messageId: MessageId.parse(messageId),
      delta,
    });
  }

  private onAssistant(s: LiveSession, m: Json, parent: string | undefined, at: Timestamp): void {
    const message = isObject(m.message) ? m.message : undefined;
    if (!message) return;
    const p = this.placement(s, m, parent);
    if (!p) return;
    const key = parent ?? MAIN;
    const model = str(message.model);
    // R-12: the model that actually answered, per message; `<synthetic>` marks an error, not a model.
    if (!parent && isNonEmptyString(model) && model !== '<synthetic>' && !(s.observed.source === 'per-message' && s.observed.model === model)) {
      s.observed = { source: 'per-message', model, observedAt: at };
      this.emit({ type: 'model.observed', sessionId: s.sessionId, observed: s.observed, at });
    }
    const id = isNonEmptyString(message.id) ? message.id : str(m.uuid);
    if (id) this.trackUsage(s, key, id, message.usage, p);
    const text = textOf(message.content);
    if (id && text !== '') {
      const open = s.openMessages.get(key);
      if (open && open.id !== id) this.flushMessage(s, key);
      const current = s.openMessages.get(key);
      if (current) current.text += text;
      else s.openMessages.set(key, { id, placement: p, text, ...opt('model', model), createdAt: at });
    }
    for (const use of toolUsesOf(message.content)) {
      if (s.items.has(use.id)) continue;
      const item = startItem(p, use, s.cwd, at);
      if (!item) continue;
      s.items.set(use.id, { item, ...opt('nativeTaskId', p.nativeTaskId) });
      this.emit({ type: 'item.updated', item });
    }
  }

  private onUser(s: LiveSession, m: Json, parent: string | undefined, at: Timestamp): void {
    const message = isObject(m.message) ? m.message : undefined;
    if (!message) return;
    const results = toolResultsOf(message.content);
    if (results.length === 0) {
      // A sub-agent's prompt (from its parent agent); the session's own prompts are emitted on ack.
      if (!parent || !isNonEmptyString(m.uuid)) return;
      const p = this.placement(s, m, parent);
      if (!p) return;
      this.emit({ type: 'message.completed', message: { id: MessageId.parse(m.uuid), ...placed(p), role: 'user', origin: { kind: 'user' }, text: textOf(message.content), attachments: [], createdAt: at } });
      return;
    }
    const maxOutputChars = this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    for (const [i, result] of results.entries()) {
      const tracked = s.items.get(result.toolUseId);
      if (!tracked) continue;
      // The structured output belongs to the single result of a frame.
      const structured = results.length === 1 && i === 0 ? m.tool_use_result : undefined;
      const interrupted = s.turn?.interruptRequested === true || toolResultText(result.content).startsWith(INTERRUPT_MARKER);
      let item = finishItem(tracked.item, { ...result, ...opt('structured', structured) }, { endedAt: at, declined: s.declined.has(result.toolUseId), interrupted, maxOutputChars });
      s.items.delete(result.toolUseId);
      s.declined.delete(result.toolUseId);
      // A command sent to the background returns at once; it ends with its task, not with this result.
      const taskId = isObject(structured) ? str(structured.backgroundTaskId) : undefined;
      if (item.kind === 'command' && item.state === 'completed' && (isNonEmptyString(taskId) || item.background === true)) {
        const known = isNonEmptyString(taskId) ? taskId : [...s.shellTasks].find(([, t]) => t.toolUseId === result.toolUseId)?.[0];
        const shell = known === undefined ? undefined : s.shellTasks.get(known);
        if (shell?.ended !== undefined) item = { ...item, background: true, state: shell.ended };
        else {
          const running: SessionItem = { ...item, background: true, state: 'running' };
          delete running.endedAt;
          if (known !== undefined) s.shellTasks.set(known, { toolUseId: result.toolUseId });
          s.background.set(result.toolUseId, running);
          item = running;
        }
      }
      this.emit({ type: 'item.updated', item });
    }
  }

  private onResult(s: LiveSession, m: Json, at: Timestamp): void {
    const open = s.turn;
    if (!open) return;
    this.flushMessage(s, MAIN);
    this.flushUsage(s, MAIN);
    // `result.usage` covers the whole turn, so it is not `latest`; the session total comes from modelUsage.
    const total = sumModelUsage(m.modelUsage);
    if (total) {
      this.emit({
        type: 'usage.tokens',
        usage: { sessionId: s.sessionId, turnId: open.turn.id, cumulative: total.counts, ...opt('contextWindow', total.contextWindow), at },
      });
    }
    // A cancel answer (`continue: false`) stops the loop with a successful result and this reason.
    if (open.interruptRequested || m.terminal_reason === 'hook_stopped') return this.endTurn(s, 'interrupted', at);
    const ok = m.subtype === 'success' && m.is_error !== true;
    if (ok) return this.endTurn(s, 'completed', at);
    const errors = Array.isArray(m.errors) ? m.errors.filter(isNonEmptyString) : [];
    const detail = errors.join('; ') || str(m.result) || `turn ended with ${String(m.subtype)}`;
    this.endTurn(s, 'failed', at, detail);
  }

  /**
   * Acknowledges dispatched uuids listed on a main-loop frame (CR2_DELIVERY_FIX §4). The CLI stamps
   * `user_message_uuid(s)` on the frames of the turn that consumes a prompt: system/init and
   * system/status as the turn starts, then assistant / stream_event / result; a prompt folded into a
   * running turn first shows up on a system/status frame and the result (live-checked, T009).
   */
  private ack(s: LiveSession, m: Json): void {
    const uuids = new Set<string>(Array.isArray(m.user_message_uuids) ? m.user_message_uuids.filter(isNonEmptyString) : []);
    if (isNonEmptyString(m.user_message_uuid)) uuids.add(m.user_message_uuid);
    for (const uuid of uuids) {
      const pending = s.acks.get(uuid);
      if (!pending) continue;
      s.acks.delete(uuid);
      s.unacked = s.unacked.filter((u) => u !== uuid);
      const turnId = s.turn?.turn.id;
      this.emit({
        type: 'message.completed',
        message: {
          id: MessageId.parse(uuid),
          sessionId: s.sessionId,
          ...opt('turnId', turnId),
          role: 'user',
          origin: this.userOrigin(s.sessionId, uuid),
          text: pending.text,
          attachments: [],
          createdAt: this.now(),
        },
      });
      pending.resolve({ turnId, frame: [str(m.type), str(m.subtype)].filter(isNonEmptyString).join('/') || 'unknown' });
    }
  }

  // ---- turns --------------------------------------------------------------------------------------

  /**
   * A turn starts on the first main-loop frame while idle. It is named after the oldest dispatched
   * payload not acknowledged yet (the prompt the stored history names it after); a turn the session
   * starts on its own (background sub-agent done, R-05) gets a new id.
   */
  private openTurn(s: LiveSession, at: Timestamp): void {
    if (s.turn) return;
    const fromPayload = s.unacked.find((u) => !s.usedTurnIds.has(u));
    const id = fromPayload ?? this.options.newId?.() ?? randomUUID();
    s.usedTurnIds.add(id);
    const turn: Turn = { id: TurnId.parse(id), sessionId: s.sessionId, state: 'running', requestedModel: s.requestedModel, startedAt: at };
    s.turn = { turn, interruptRequested: false };
    this.emit({ type: 'turn.updated', turn });
    this.emit({ type: 'session.activity', sessionId: s.sessionId, activity: 'running', at });
  }

  private endTurn(s: LiveSession, state: Exclude<Turn['state'], 'running'>, at: Timestamp, failure?: string): void {
    const open = s.turn;
    if (!open) return;
    s.turn = undefined;
    // Main-loop calls without a result end with the turn; sub-agent calls end with their task.
    for (const [id, tracked] of s.items) {
      if (tracked.nativeTaskId !== undefined) continue;
      const closed = closeOpenItem(tracked.item, state === 'interrupted' ? 'interrupted' : 'failed', at);
      if (closed) this.emit({ type: 'item.updated', item: closed });
      s.items.delete(id);
    }
    const turn: Turn = { ...open.turn, state, ...(state === 'failed' && { failure: { message: failure ?? 'turn failed' } }), endedAt: at };
    this.emit({ type: 'turn.updated', turn });
    if (!s.ended) this.emit({ type: 'session.activity', sessionId: s.sessionId, activity: state === 'interrupted' ? 'interrupted' : 'idle', at });
  }

  /** Keeps the newest usage of the API message in progress; a new message reports the previous one. */
  private trackUsage(s: LiveSession, key: string, id: string, usage: unknown, placement: Placement): void {
    const tracked = s.usage.get(key);
    if (tracked && tracked.id !== id) this.flushUsage(s, key);
    const current = s.usage.get(key);
    if (current) {
      if (isObject(usage)) current.usage = usage;
    } else s.usage.set(key, { id, usage, placement });
  }

  /** `latest` is one model call's usage (contracts: Claude per-message usage), for the turn or the sub-agent. */
  private flushUsage(s: LiveSession, key: string): void {
    const tracked = s.usage.get(key);
    if (!tracked) return;
    s.usage.delete(key);
    const latest = toTokenCounts(tracked.usage);
    if (!latest) return;
    const p = tracked.placement;
    this.emit({
      type: 'usage.tokens',
      usage: {
        sessionId: p.sessionId,
        ...opt('turnId', p.turnId === undefined ? undefined : TurnId.parse(p.turnId)),
        ...opt('nativeTaskId', p.nativeTaskId),
        latest,
        at: this.now(),
      },
    });
  }

  private flushMessage(s: LiveSession, key: string): void {
    const open = s.openMessages.get(key);
    if (!open) return;
    s.openMessages.delete(key);
    const message: Message = {
      id: MessageId.parse(open.id),
      ...placed(open.placement),
      role: 'assistant',
      origin: { kind: 'agent' },
      text: open.text,
      attachments: [],
      ...opt('observedModel', isNonEmptyString(open.model) ? open.model : undefined),
      createdAt: open.createdAt,
    };
    this.emit({ type: 'message.completed', message });
  }

  // ---- native sub-agents (R-13) -------------------------------------------------------------------

  private onTaskStarted(s: LiveSession, m: Json, at: Timestamp): void {
    const taskId = str(m.task_id);
    if (isNonEmptyString(taskId) && m.task_type === 'local_bash') {
      const toolUseId = str(m.tool_use_id);
      s.shellTasks.set(taskId, { ...s.shellTasks.get(taskId), ...opt('toolUseId', isNonEmptyString(toolUseId) ? toolUseId : undefined) });
      return;
    }
    // Background shell commands are tasks too; only sub-agents are native tasks.
    if (!isNonEmptyString(taskId) || (m.task_type !== undefined && m.task_type !== 'local_agent')) return;
    const toolUseId = str(m.tool_use_id);
    if (isNonEmptyString(toolUseId)) s.taskByToolUse.set(toolUseId, taskId);
    const parentTask = str(m.parent_task_id);
    const task: NativeTask = {
      id: NativeTaskId.parse(taskId),
      sessionId: s.sessionId,
      runtime: 'claude',
      parentRef: isNonEmptyString(toolUseId) ? toolUseId : s.ref,
      nativeRef: taskId,
      ...opt('parentTaskId', isNonEmptyString(parentTask) ? NativeTaskId.parse(parentTask) : undefined),
      label: str(m.description) || taskId,
      ...opt('agentType', str(m.subagent_type)),
      state: 'running',
      background: m.is_backgrounded === true,
      startedAt: at,
    };
    s.tasks.set(taskId, task);
    this.emit({ type: 'nativeTask.updated', task });
  }

  private onTaskChanged(s: LiveSession, m: Json, at: Timestamp): void {
    const taskId = str(m.task_id);
    if (isNonEmptyString(taskId) && s.shellTasks.has(taskId)) {
      this.onShellTaskChanged(s, taskId, m, at);
      return;
    }
    const task = taskId === undefined ? undefined : s.tasks.get(taskId);
    if (!task || taskId === undefined) return;
    let next: NativeTask = task;
    if (m.subtype === 'task_progress') {
      const last = str(m.last_tool_name);
      const activity = [str(m.description), last && `last tool: ${last}`].filter(isNonEmptyString).join(' · ');
      next = { ...task, ...opt('lastActivity', activity || undefined), ...opt('summary', str(m.summary)) };
    } else if (m.subtype === 'task_updated' && isObject(m.patch)) {
      const ended = { completed: 'completed', failed: 'failed', killed: 'stopped' } as const;
      const status = str(m.patch.status);
      const endedState = status === 'completed' || status === 'failed' || status === 'killed' ? ended[status] : undefined;
      const endTime = num(m.patch.end_time);
      next = {
        ...task,
        ...(typeof m.patch.is_backgrounded === 'boolean' && { background: m.patch.is_backgrounded }),
        ...(endedState && task.state === 'running' && { state: endedState, endedAt: endTime === undefined ? at : isoFromMs(endTime) }),
      };
    } else if (m.subtype === 'task_notification') {
      const status = m.status === 'completed' || m.status === 'failed' || m.status === 'stopped' ? m.status : 'failed';
      next = { ...task, state: status, ...opt('summary', str(m.summary)), endedAt: task.endedAt ?? at };
      this.endTask(s, task, at);
    }
    s.tasks.set(taskId, next);
    if (next !== task) this.emit({ type: 'nativeTask.updated', task: next });
  }

  /** A background shell command's task ended: so does its command item (R-07: its session's locks may go). */
  private onShellTaskChanged(s: LiveSession, taskId: string, m: Json, at: Timestamp): void {
    const status = m.subtype === 'task_updated' && isObject(m.patch) ? str(m.patch.status) : m.subtype === 'task_notification' ? str(m.status) : undefined;
    const ended = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'interrupted' : undefined;
    if (ended === undefined) return;
    const shell = s.shellTasks.get(taskId)!;
    const toolUseId = shell.toolUseId ?? (isNonEmptyString(str(m.tool_use_id)) ? str(m.tool_use_id) : undefined);
    const running = toolUseId === undefined ? undefined : s.background.get(toolUseId);
    if (running === undefined || toolUseId === undefined) {
      // Ended before its tool call returned: the result ends the item with this state.
      s.shellTasks.set(taskId, { ...shell, ...opt('toolUseId', toolUseId), ended });
      return;
    }
    s.background.delete(toolUseId);
    s.shellTasks.delete(taskId);
    const endTime = isObject(m.patch) ? num(m.patch.end_time) : undefined;
    this.emit({ type: 'item.updated', item: { ...running, state: ended, endedAt: endTime === undefined ? at : isoFromMs(endTime) } as SessionItem });
  }

  /** A finished sub-agent's open message and calls end with it. */
  private endTask(s: LiveSession, task: NativeTask, at: Timestamp): void {
    for (const [key, open] of s.openMessages) if (open.placement.nativeTaskId === task.id) this.flushMessage(s, key);
    for (const [key, tracked] of s.usage) if (tracked.placement.nativeTaskId === task.id) this.flushUsage(s, key);
    for (const [id, tracked] of s.items) {
      if (tracked.nativeTaskId !== task.id) continue;
      const closed = closeOpenItem(tracked.item, 'interrupted', at);
      if (closed) this.emit({ type: 'item.updated', item: closed });
      s.items.delete(id);
    }
  }

  /** Main-loop frames belong to the turn; sub-agent frames to their task (agent_id, else the Agent call). */
  private placement(s: LiveSession, m: Json, parent: string | undefined): Placement | undefined {
    if (!parent) return { sessionId: s.sessionId, turnId: s.turn?.turn.id };
    const taskId = (isNonEmptyString(m.agent_id) ? m.agent_id : undefined) ?? s.taskByToolUse.get(parent);
    if (taskId === undefined) {
      this.log('warn', `sub-agent frame for unknown Agent call ${parent}; dropped`);
      return undefined;
    }
    return { sessionId: s.sessionId, nativeTaskId: NativeTaskId.parse(taskId) };
  }

  // ---- permission requests (R-07, R-08) -----------------------------------------------------------

  private onPreToolUse(s: LiveSession, raw: unknown, toolUseIdArg: string | undefined, signal: AbortSignal): Promise<WireHookOutput> {
    const call = parsePreToolUse(raw, toolUseIdArg);
    if (typeof call === 'string') {
      this.log('warn', `PreToolUse refused: ${call}`);
      return Promise.resolve(denyOutput(`AgentWorkflowGui could not read this tool call (${call})`));
    }
    if (signal.aborted || s.closing || s.ended) return Promise.resolve(denyOutput('AgentWorkflowGui: the session is closing'));
    let request: PermissionRequest;
    try {
      const placement: Placement =
        call.agentId !== undefined ? { sessionId: s.sessionId, nativeTaskId: NativeTaskId.parse(call.agentId) } : { sessionId: s.sessionId, turnId: s.turn?.turn.id };
      request = buildPermissionRequest(call, { id: PermissionRequestId.parse(this.options.newId?.() ?? randomUUID()), placement, createdAt: this.now() });
    } catch (error) {
      this.log('warn', 'PreToolUse could not be represented; denying', error);
      return Promise.resolve(denyOutput('AgentWorkflowGui could not represent this tool call'));
    }
    return new Promise<WireHookOutput>((resolve) => {
      const onAbort = () => this.withdraw(entry, 'the runtime withdrew the request');
      const entry: PermissionEntry = { session: s, request, toolUseId: call.toolUseId, resolve, cleanup: () => signal.removeEventListener('abort', onAbort) };
      s.permissions.add(entry);
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit({ type: 'permission.updated', request });
      const handle = this.handleFor(entry);
      try {
        const pending = this.options.onPermissionRequest(handle);
        if (isThenable(pending)) void Promise.resolve(pending).catch((error: unknown) => this.failClosed(entry, error));
      } catch (error) {
        this.failClosed(entry, error);
      }
    });
  }

  private handleFor(entry: PermissionEntry): PermissionHandle {
    const isOpen = () => entry.session.permissions.has(entry);
    return {
      get request() {
        return entry.request;
      },
      // Both validate the whole resulting request before anything is emitted or answered, so an invalid
      // answer (e.g. approve-for-session on an elicitation) throws and changes nothing.
      hold: (hold, extra) => {
        if (!isOpen()) return false;
        entry.request = PermissionRequest.parse({ ...entry.request, state: 'held', hold, ...opt('matchedRule', extra?.matchedRule) });
        this.emit({ type: 'permission.updated', request: entry.request });
        return true;
      },
      answer: (decision, extra) => {
        if (!isOpen()) return false;
        const parsed = PermissionDecision.parse(decision);
        const answered = PermissionRequest.parse({ ...withoutHold(entry.request), state: 'answered', decision: parsed, ...opt('matchedRule', extra?.matchedRule) });
        this.release(entry);
        if (parsed.outcome === 'decline' || parsed.outcome === 'cancel') entry.session.declined.add(entry.toolUseId);
        entry.request = answered;
        entry.resolve(decisionToHookOutput(parsed));
        this.emit({ type: 'permission.updated', request: entry.request });
        return true;
      },
    };
  }

  /** A broken handler must not leave the tool call waiting: decline whatever is still open. */
  private failClosed(entry: PermissionEntry, error: unknown): void {
    if (!entry.session.permissions.has(entry)) return;
    this.log('warn', 'permission handler failed; declining', error);
    try {
      this.handleFor(entry).answer({ outcome: 'decline', decidedBy: 'policy', reason: 'permission handler failed', at: this.now() });
    } catch {
      this.withdraw(entry, 'permission handler failed');
    }
  }

  /** The runtime no longer waits (turn interrupted, session gone): the call is denied and the request withdrawn. */
  private withdraw(entry: PermissionEntry, reason: string): void {
    if (!entry.session.permissions.has(entry)) return;
    this.release(entry);
    entry.session.declined.add(entry.toolUseId);
    entry.request = { ...withoutHold(entry.request), state: 'withdrawn' };
    entry.resolve(denyOutput(`AgentWorkflowGui: ${reason}`));
    this.emit({ type: 'permission.updated', request: entry.request });
  }

  private release(entry: PermissionEntry): void {
    entry.session.permissions.delete(entry);
    entry.cleanup();
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private live(nativeSessionRef: string, method: string): LiveSession {
    const s = this.sessions.get(nativeSessionRef);
    if (!s || s.ended || s.closing) throw new Error(`${method}: Claude session ${nativeSessionRef} is not open; start or resume it first`);
    return s;
  }

  /** R-06: Claude fails to start in a deleted cwd with a misleading "binary" error, so check first. */
  private checkCwd(cwd: string, method: string): void {
    const exists = this.options.cwdExists ?? existsSync;
    if (!exists(cwd)) throw new Error(`${method}: working folder ${cwd} does not exist; recreate the task worktree before using this session`);
  }

  private transcriptContext(sessionId: SessionId, cwd: string) {
    return {
      sessionId,
      cwd,
      userOrigin: (uuid: string) => this.userOrigin(sessionId, uuid),
      maxOutputChars: this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT,
      fallbackTime: this.now(),
    };
  }

  private userOrigin(sessionId: SessionId, clientMessageId: string): MessageOrigin {
    return this.origins.get(clientMessageId) ?? this.options.userOrigin?.({ sessionId, clientMessageId }) ?? { kind: 'user' };
  }

  private timeOf(iso: string | undefined): Timestamp {
    return isNonEmptyString(iso) && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : this.now();
  }

  private now(): Timestamp {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log('warn', `event listener threw on ${event.type}`, error);
      }
    }
  }

  /** A malformed message must not end the session's stream. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log('warn', `failed to handle ${what}`, error);
    }
  }

  private log(level: 'debug' | 'warn', message: string, detail?: unknown): void {
    this.options.log?.(level, message, detail);
  }
}


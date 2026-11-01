// Fault points for the crash tests (T039, V-15/V-16/V-28): a development run started with AWG_FAULT_POINT stops one
// named step of the runtimes of one session (or of one runtime) for good, right after logging one fixed line, so a
// live test can end the GUI at exactly that step (taskkill of the PID it started) instead of guessing with a sleep.
// The step is never carried out: the real adapter is not called. Nothing else changes, and a packaged app never reads
// these variables (index.ts).
//
//   AWG_FAULT_POINT    dispatch       before the adapter's dispatchOnce: the delivery's unknown is committed (CR2 §1
//                                     step 3), the runtime has not received it
//                      close-session  before the adapter's closeSession: the close has been decided (the idle
//                                     supervisor, a task's cleanup, the exit), the runtime is still running
//   AWG_FAULT_SESSION  the GUI session whose runtime stops there, or
//   AWG_FAULT_RUNTIME  claude | codex: every session of that runtime
//   AWG_FAULT_SKIP     optional: that many calls of each such adapter go through first (a Claude session must have
//                      had a turn before a restart can resume it, T046)
//
// The model probes (`models-*`) are never stopped.
import type { Runtime, SessionId } from '../../contracts';
import type { RuntimeAdapter } from '../../core/ports';

export type FaultPointName = 'dispatch' | 'close-session';

export interface FaultPoint {
  point: FaultPointName;
  /** Exactly one of the two. */
  sessionId?: string;
  runtime?: Runtime;
  /** Calls of the method that go through before it stops (default 0). */
  skip?: number;
}

const METHOD: Record<FaultPointName, 'dispatchOnce' | 'closeSession'> = { dispatch: 'dispatchOnce', 'close-session': 'closeSession' };

/** The fault point the environment asks for; undefined when none, or when it is not one this module knows. */
export const faultPointFrom = (env: Readonly<Record<string, string | undefined>>): FaultPoint | undefined => {
  const point = env['AWG_FAULT_POINT'];
  if (point !== 'dispatch' && point !== 'close-session') return undefined;
  const sessionId = env['AWG_FAULT_SESSION'];
  const runtime = env['AWG_FAULT_RUNTIME'];
  const skipText = env['AWG_FAULT_SKIP'];
  // Anything but a whole number of calls: no fault point at all, as for an unknown point.
  if (skipText !== undefined && skipText !== '' && !/^\d{1,3}$/.test(skipText)) return undefined;
  const skip = skipText === undefined || skipText === '' ? 0 : Number(skipText);
  const counted = skip > 0 ? { skip } : {};
  if (sessionId !== undefined && sessionId !== '' && (runtime === undefined || runtime === '')) return { point, sessionId, ...counted };
  if ((runtime === 'claude' || runtime === 'codex') && (sessionId === undefined || sessionId === '')) return { point, runtime, ...counted };
  return undefined;
};

/** Whether the adapter made for this session stops at the fault point. */
export const faultApplies = (fault: FaultPoint, runtime: Runtime, sessionId: SessionId): boolean =>
  !sessionId.startsWith('models-') && (fault.sessionId !== undefined ? fault.sessionId === sessionId : fault.runtime === runtime);

/** The text logged for one call that stopped: fixed words and IDs only, never a payload or a token. */
const reached = (fault: FaultPoint, sessionId: SessionId, args: unknown[]): string => {
  const first = args[0];
  const attemptId = (first as { attempt?: { attemptId?: unknown } } | undefined)?.attempt?.attemptId;
  const detail = fault.point === 'dispatch' ? `attempt=${typeof attemptId === 'string' ? attemptId : '?'}` : `ref=${typeof first === 'string' ? first : '?'}`;
  return `[fault] ${fault.point} reached session=${sessionId} ${detail}`;
};

/**
 * The adapter with the fault point's method replaced: after the first `skip` calls, which are the adapter's own, each
 * call logs and then never settles. Every other member is the adapter's own (bound to it), so the router sees one
 * adapter as before.
 */
export const withFaultPoint = (adapter: RuntimeAdapter, sessionId: SessionId, fault: FaultPoint, log: (message: string) => void): RuntimeAdapter => {
  const method = METHOD[fault.point];
  let passed = 0;
  return new Proxy(adapter, {
    get(target, key): unknown {
      if (key === method)
        return (...args: unknown[]): Promise<unknown> => {
          if (passed < (fault.skip ?? 0)) {
            passed += 1;
            return (target[method] as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          }
          log(reached(fault, sessionId, args));
          return new Promise<never>(() => undefined);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
};

// The idle supervisor's settings from the environment (T036): overriding the user's preferences (C-30,
// UiPreferences.supervisor) in development runs only — the live and crash tests; a packaged app never reads them.
//   AWG_IDLE_CLOSE_MS        how long a session goes unused before its runtime is closed (at least 1 s)
//   AWG_MAX_OPEN_RUNTIMES    how many runtimes may be open at once (0: no limit)
//   AWG_IDLE_TICK_MS         how often the supervisor looks (at least 1 s)
import type { BackendOptions } from './backend';

const whole = (raw: string | undefined, min: number): number | undefined => {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
};

export const supervisorSettings = (env: Record<string, string | undefined>): NonNullable<BackendOptions['supervisor']> => {
  const idleMs = whole(env['AWG_IDLE_CLOSE_MS'], 1000);
  const maxOpen = whole(env['AWG_MAX_OPEN_RUNTIMES'], 0);
  const tickMs = whole(env['AWG_IDLE_TICK_MS'], 1000);
  return {
    ...(idleMs !== undefined && { idleMs }),
    ...(maxOpen !== undefined && { maxOpen }),
    ...(tickMs !== undefined && { tickMs }),
  };
};

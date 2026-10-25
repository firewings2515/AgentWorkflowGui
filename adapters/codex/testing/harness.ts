// Test wiring: an adapter on a fake app-server, its events, and checks that every event satisfies the
// contracts schemas (the refinements are the point: e.g. endedAt exactly when an item is finished).
import { expect } from 'vitest';
import { AppEvent, SessionId } from '../../../contracts';
import type { PermissionHandle } from '../../../core/ports';
import { CodexAdapter, type CodexAdapterEvent, type CodexAdapterOptions } from '../adapter';
import { FakeAppServer, type ReplayRecord } from './fake-app-server';

export const SESSION = SessionId.parse('session-a');
export const NOW = new Date('2026-10-24T12:00:00.000Z');

export interface Harness {
  fake: FakeAppServer;
  adapter: CodexAdapter;
  events: CodexAdapterEvent[];
  permissions: PermissionHandle[];
  of<T extends CodexAdapterEvent['type']>(type: T): Extract<CodexAdapterEvent, { type: T }>[];
}

export const setup = (records: ReplayRecord[], options: Partial<CodexAdapterOptions> = {}): Harness => {
  const fake = new FakeAppServer(records);
  const events: CodexAdapterEvent[] = [];
  const permissions: PermissionHandle[] = [];
  let n = 0;
  const adapter = new CodexAdapter({
    spawn: () => fake,
    onPermissionRequest: (handle) => permissions.push(handle),
    now: () => NOW,
    newId: () => `perm-${++n}`,
    ...options,
  });
  adapter.subscribe((event) => events.push(event));
  return {
    fake,
    adapter,
    events,
    permissions,
    of: <T extends CodexAdapterEvent['type']>(type: T) => events.filter((e): e is Extract<CodexAdapterEvent, { type: T }> => e.type === type),
  };
};

/** Polls until `predicate` holds (the fake plays its script on the event loop). */
export const until = async (predicate: () => boolean, what = 'condition', timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Every event must parse with its contracts schema. */
export const expectValidEvents = (events: CodexAdapterEvent[]): void => {
  for (const event of events) {
    const result = AppEvent.safeParse(event);
    expect(result.success, `${event.type}: ${result.error?.message ?? ''}`).toBe(true);
  }
};

/** The params the adapter sent with the n-th request of `method`. */
export const sentParams = (fake: FakeAppServer, method: string, n = 0): Record<string, unknown> =>
  fake.received.filter((m) => m.method === method)[n]?.params as Record<string, unknown>;

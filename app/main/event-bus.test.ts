import { describe, expect, it, vi } from 'vitest';
import { CONTRACTS_VERSION, EventEnvelope, type AppEvent } from '../../contracts';
import { EventBus } from './event-bus';

const limits = (percentUsed: number): AppEvent => ({ type: 'usage.limits', claude5h: { percentUsed }, at: '2026-10-26T10:00:00+08:00' });

describe('EventBus', () => {
  it('numbers envelopes from the Snapshot seq upwards and stamps the contract version', () => {
    const bus = new EventBus({ seq: 42 });
    const seen: EventEnvelope[] = [];
    bus.subscribe((envelope) => seen.push(envelope));

    bus.publish(limits(10));
    bus.publish(limits(20));
    bus.publish(limits(30));

    expect(seen.map((e) => e.seq)).toEqual([43, 44, 45]);
    expect(bus.seq).toBe(45);
    for (const envelope of seen) {
      expect(envelope.schemaVersion).toBe(CONTRACTS_VERSION);
      expect(EventEnvelope.safeParse(envelope).success).toBe(true);
    }
  });

  it('starts at seq 0 by default', () => {
    expect(new EventBus().publish(limits(1))?.seq).toBe(1);
  });

  it('drops an invalid event without taking a seq, so the sequence has no gap', () => {
    const onRejected = vi.fn();
    const bus = new EventBus({ seq: 5, onRejected });
    const seen: number[] = [];
    bus.subscribe((envelope) => seen.push(envelope.seq));

    expect(bus.publish(limits(10))?.seq).toBe(6);
    expect(bus.publish(limits(250))).toBeNull(); // percentUsed is capped at 100
    expect(bus.publish({ type: 'no.such.event' } as unknown as AppEvent)).toBeNull();
    expect(bus.publish(limits(20))?.seq).toBe(7);

    expect(seen).toEqual([6, 7]);
    expect(onRejected).toHaveBeenCalledTimes(2);
  });

  it('keeps delivering to the other listeners when one throws', () => {
    const onListenerError = vi.fn();
    const bus = new EventBus({ onListenerError });
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((envelope) => seen.push(envelope.seq));

    expect(() => bus.publish(limits(10))).not.toThrow();
    expect(seen).toEqual([1]);
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after the subscription is cancelled', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const cancel = bus.subscribe(listener);

    bus.publish(limits(10));
    cancel();
    bus.publish(limits(20));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.seq).toBe(2);
  });
});

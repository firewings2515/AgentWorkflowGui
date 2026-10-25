// The streaming-input side of one Claude query(): messages pushed here are what the SDK reads and writes
// to the CLI. A push is only a local queue entry; it is never evidence of delivery (CR2_DELIVERY_FIX §1).

export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  /** False once closed: nothing is queued then. */
  push(item: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  /** Ends the stream; items not yet read are dropped. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.items.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

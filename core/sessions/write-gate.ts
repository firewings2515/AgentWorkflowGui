// After the session service shut down, nothing it holds may touch storage any more (T017 r2-P1-4): the main
// process closes the database next, and a continuation that arrives late (a start or a dispatch whose
// runtime answered after the exit deadline) must fail instead of writing. The service reaches the
// repositories and the delivery store only through this gate.

export class ServiceClosedError extends Error {
  override name = 'ServiceClosedError';
}

/**
 * A view of `target` whose every method (on it or on any object reachable from its properties) rejects
 * with ServiceClosedError once `closed()` is true. Methods run on the original object, so private class
 * fields keep working.
 */
export const gated = <T extends object>(target: T, closed: () => boolean): T => {
  const views = new WeakMap<object, object>();
  const wrap = <U extends object>(object: U): U => {
    const known = views.get(object);
    if (known !== undefined) return known as U;
    const view = new Proxy(object, {
      get(t, key) {
        const value: unknown = Reflect.get(t, key, t);
        if (typeof value === 'function') {
          return (...args: unknown[]): unknown => {
            if (closed()) return Promise.reject(new ServiceClosedError('the session service is closed; nothing is stored any more'));
            return Reflect.apply(value, t, args);
          };
        }
        return typeof value === 'object' && value !== null ? wrap(value) : value;
      },
    });
    views.set(object, view);
    return view;
  };
  return wrap(target);
};

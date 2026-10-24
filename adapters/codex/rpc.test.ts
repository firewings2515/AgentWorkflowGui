import { describe, expect, it } from 'vitest';
import { type ExitInfo, RpcClosedError, RpcConnection, type RpcHandlers, RpcTimeoutError } from './rpc';
import { FakeAppServer } from './testing/fake-app-server';

const connect = () => {
  // An empty script: this test writes the server side by hand.
  const fake = new FakeAppServer([]);
  const seen = { notifications: [] as string[], requests: [] as unknown[], noise: [] as string[], exits: [] as ExitInfo[] };
  const handlers: RpcHandlers = {
    onNotification: (method) => seen.notifications.push(method),
    onServerRequest: (id) => seen.requests.push(id),
    onExit: (exit) => seen.exits.push(exit),
    onProtocolNoise: (detail) => seen.noise.push(detail),
  };
  return { fake, conn: new RpcConnection(fake, handlers), seen };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('RpcConnection', () => {
  it('routes notifications and server requests (id 0 included) and ignores noise', async () => {
    const { fake, seen } = connect();
    fake.stdout.write('not json\n\n{"method":"turn/started","params":{}}\n{"id":0,"method":"item/commandExecution/requestApproval","params":{}}\n');
    fake.stdout.write('{"id":99,"result":{}}\n[1,2]\n');
    await tick();
    expect(seen.notifications).toEqual(['turn/started']);
    expect(seen.requests).toEqual([0]);
    expect(seen.noise).toEqual(['not JSON', 'response to unknown request', 'not an object']);
  });

  it('drops the late response of a timed-out request without reporting it as noise', async () => {
    const { fake, conn, seen } = connect();
    await expect(conn.request('thread/read', {}, { timeoutMs: 10 })).rejects.toBeInstanceOf(RpcTimeoutError);
    fake.stdout.write('{"id":1,"result":{}}\n');
    await tick();
    expect(seen.noise).toEqual([]);
  });

  it('rejects in-flight requests with written=true on exit, and later ones with written=false', async () => {
    const { fake, conn, seen } = connect();
    const inFlight = conn.request('turn/start', {});
    fake.crash(9);
    const error = (await inFlight.catch((e: unknown) => e)) as RpcClosedError;
    expect(error).toBeInstanceOf(RpcClosedError);
    expect(error.written).toBe(true);
    expect(seen.exits).toEqual([{ code: 9, signal: null }]);
    const after = (await conn.request('turn/start', {}).catch((e: unknown) => e)) as RpcClosedError;
    expect(after.written).toBe(false);
    expect(fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
  });
});

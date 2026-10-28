import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RequestIds, cancelledKeyOf, idKey, requestKeyOf, responseKeyOf } from './request-ids';

const request = (id: string | number, method = 'ping') => ({ jsonrpc: '2.0', id, method });
const response = (id: string | number) => ({ jsonrpc: '2.0', id, result: {} });
const cancel = (id: string | number) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });

describe('@modelcontextprotocol/sdk version', () => {
  it('is 1.32.2, the version the request ID lifecycle was checked against', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(
      pkg.version,
      'The SDK was upgraded: check again what request-ids.ts relies on (every answer through transport.send, ' +
        'cancels through onmessage, nothing sent after a cancel) and the cancel / same-ID tests in server.test.ts, ' +
        'then update this version.',
    ).toBe('1.32.2');
  });
});

describe('RequestIds', () => {
  it('reads request, response and cancel IDs, keeping 7 and "7" apart', () => {
    expect(requestKeyOf(request(7))).toBe('7');
    expect(requestKeyOf(request('7'))).toBe('"7"');
    expect(requestKeyOf({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(requestKeyOf(response(7))).toBeUndefined();
    expect(responseKeyOf(response(7))).toBe('7');
    expect(responseKeyOf({ jsonrpc: '2.0', id: 7, error: { code: 1, message: 'x' } })).toBe('7');
    expect(responseKeyOf(request(7))).toBeUndefined();
    expect(cancelledKeyOf(cancel(7))).toBe('7');
    expect(cancelledKeyOf(request(7, 'notifications/cancelled'))).toBeUndefined();
    expect(idKey(null)).toBeUndefined();
  });

  it('frees an ID that never reached the SDK when its HTTP response closes', () => {
    const ids = new RequestIds();
    const entry = ids.take('7');
    ids.closed('7', entry);
    expect(ids.has('7')).toBe(false);
  });

  it('keeps a dispatched ID after its HTTP response closes, until its answer is sent', () => {
    const ids = new RequestIds();
    const entry = ids.take('7');
    ids.received(request(7));
    ids.closed('7', entry);
    expect(ids.has('7')).toBe(true);
    const sending = ids.sending(response(7));
    expect(ids.has('7')).toBe(true);
    ids.sent(sending!);
    expect(ids.has('7')).toBe(false);
  });

  it('frees a dispatched ID when it is cancelled, whatever the method, with or without its HTTP response', () => {
    for (const method of ['ping', 'tools/list', 'tools/call', 'initialize']) {
      const ids = new RequestIds();
      ids.take('7');
      ids.received(request(7, method));
      ids.received(cancel(7));
      expect(ids.has('7')).toBe(false);
    }
  });

  it('lets a send already under way free a cancelled ID, not the cancel', () => {
    const ids = new RequestIds();
    ids.take('7');
    ids.received(request(7));
    const sending = ids.sending(response(7));
    ids.received(cancel(7));
    expect(ids.has('7')).toBe(true);
    ids.sent(sending!);
    expect(ids.has('7')).toBe(false);
  });

  it('never frees a later request with the same ID', () => {
    const ids = new RequestIds();
    const old = ids.take('7');
    ids.received(request(7));
    ids.sent(ids.sending(response(7))!);
    const next = ids.take('7');
    ids.closed('7', old);
    expect(ids.has('7')).toBe(true);
    ids.closed('7', next);
    expect(ids.has('7')).toBe(false);
  });

  it('ignores answers and cancels for IDs it does not hold', () => {
    const ids = new RequestIds();
    expect(ids.sending(response(9))).toBeUndefined();
    ids.received(cancel(9));
    ids.take('7');
    ids.received(cancel(7)); // not dispatched yet: only the HTTP close frees it
    expect(ids.has('7')).toBe(true);
  });
});

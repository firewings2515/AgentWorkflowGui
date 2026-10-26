// reconcileProvision (T012, C-08): a lost create is looked up read-only through the pre-allocated session's
// transcript; not found stays unknown (CR-2) and a failed read never echoes the SDK's error.
import { describe, expect, it } from 'vitest';
import { CWD, REF, setup } from './testing/harness';
import type { WireTranscriptEntry } from './wire';

const MARKER = 'SENSITIVE_INPUT_MARKER';
const entry = (cwd: string) => ({ type: 'user', uuid: '00000000-0000-4000-8000-0000000000a1', sessionId: REF, cwd, message: { role: 'user', content: 'hi' } }) as unknown as WireTranscriptEntry;

describe('reconcileProvision', () => {
  it('counts a pre-allocated session as created once its transcript exists in the original folder', async () => {
    const h = setup();
    h.sdk.store(CWD, REF, [entry(CWD)]);
    expect(await h.adapter.reconcileProvision({ cwd: CWD, preallocatedRef: REF })).toEqual({ state: 'sent', nativeSessionRef: REF });
    expect(h.sdk.queries).toHaveLength(0);
  });

  it('keeps a session it cannot find unknown, never not-created', async () => {
    const h = setup();
    expect(await h.adapter.reconcileProvision({ cwd: CWD, preallocatedRef: REF })).toMatchObject({ state: 'unknown', reason: 'not-found' });
  });

  it('does not trust a transcript that ran in another folder', async () => {
    const h = setup();
    h.sdk.store(CWD, REF, [entry('E:\\work\\other')]);
    expect(await h.adapter.reconcileProvision({ cwd: CWD, preallocatedRef: REF })).toMatchObject({ state: 'unknown', reason: 'read-failed' });
  });

  it('reports a failed read with fixed text, not the SDK error (review r1 P1-1)', async () => {
    const h = setup();
    h.sdk.readError = new Error(`cannot open C:\\Users\\someone\\.claude\\${MARKER}.jsonl`);
    const result = await h.adapter.reconcileProvision({ cwd: CWD, preallocatedRef: REF });
    expect(result).toMatchObject({ state: 'unknown', reason: 'read-failed' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it('cannot look up a session without a pre-allocated UUID', async () => {
    const h = setup();
    expect(await h.adapter.reconcileProvision({ cwd: CWD })).toMatchObject({ state: 'unknown', reason: 'unsupported' });
  });
});

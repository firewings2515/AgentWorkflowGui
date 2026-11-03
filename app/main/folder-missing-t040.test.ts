// T040 r1 P1-4: `folder-missing` (C-30) with the app's own path functions, never a stub: a closed session whose folder
// was deleted is refused as such, and a folder that cannot be looked at (access denied) is never reported gone. On the
// memory ports here; the same cases on SQLite are in t040-backend.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationId, type SessionId } from '../../contracts';
import { created, settle, world, type World } from '../../core/sessions/testing/harness';
import { folderState, resolveRealPath } from './real-path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awg-t040-folder-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const denied = () => {
  throw Object.assign(new Error('denied'), { code: 'EACCES' });
};

const call = (w: World, caller: SessionId, to: SessionId, operationId: string) =>
  w.service.sendMessage({ to, content: 'ping' }, { caller, operationId: OperationId.parse(operationId), sourceCallRef: `call-${operationId}` });

/** Sessions a (in the temp folder) and b (in its own folder below it), both closed by a restart. */
const closedPair = async () => {
  const folder = join(dir, 'b');
  mkdirSync(folder);
  const first = await world();
  first.realPath = (path) => resolveRealPath(path);
  first.folderState = (path) => folderState(path);
  const { sessionId: a } = await created(first, 'codex', 'session-a', { cwd: dir });
  const { sessionId: b } = await created(first, 'codex', 'session-b', { cwd: folder });
  const w = first.restart();
  await w.service.start();
  await settle();
  return { w, a, b, folder };
};

describe('folder-missing with the real path functions (C-30, T040 r1 P1-4) on memory', () => {
  it('the target folder deleted (ENOENT for its last part): folder-missing, nothing accepted, nothing resumed', async () => {
    const { w, a, b, folder } = await closedPair();
    // resolveRealPath alone cannot tell: it keeps the part that does not exist.
    rmSync(folder, { recursive: true });
    expect(resolveRealPath(folder)).not.toBeNull();
    expect(folderState(folder)).toBe('missing');
    expect(await call(w, a, b, 'op-gone')).toEqual({ status: 'rejected', rejection: { reason: 'folder-missing', detail: 'the target session is closed and its folder no longer exists' } });
    expect(await w.store.get(OperationId.parse('op-gone'))).toBeUndefined();
    expect(w.codex.get(b)).toBeUndefined();
  });

  it('the folder there: accepted, sent, and the target resumed once', async () => {
    const { w, a, b } = await closedPair();
    expect(await call(w, a, b, 'op-there')).toMatchObject({ status: 'accepted', delivery: 'sent' });
    expect(w.codex.get(b)?.calls.filter((c) => c === 'resumeSession')).toHaveLength(1);
  });

  it('the folder cannot be looked at (EACCES): never reported as gone', async () => {
    const { w, a, b } = await closedPair();
    // Both checks fail with access denied: resolveRealPath is null for it, folderState says unknown.
    w.realPath = (path) => resolveRealPath(path, denied);
    w.folderState = (path) => folderState(path, denied);
    expect(folderState(join(dir, 'b'), denied)).toBe('unknown');
    const result = await call(w, a, b, 'op-denied');
    expect(result).not.toMatchObject({ rejection: { reason: 'folder-missing' } });
  });

  it('a path that is a file, not a folder, is missing; one whose parent is gone too is missing', () => {
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'x');
    expect(folderState(file)).toBe('missing');
    expect(folderState(join(dir, 'no', 'such', 'folder'))).toBe('missing');
    expect(folderState(dir)).toBe('exists');
  });
});

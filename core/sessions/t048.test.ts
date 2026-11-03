// T048 on the memory ports and a memory file system (the same cases run on SQLite and real folders in
// app/main/t048-sqlite.test.ts), plus what only the memory run shows.
import { describe, expect, it } from 'vitest';
import { AgentId, SessionId } from '../../contracts';
import { MemoryDeliveryStore } from '../delivery/testing/memory-store';
import { agent, CWD, rid, settle, world } from './testing/harness';
import { MemoryRepositories } from './testing/memory-repositories';
import { MemoryWorkFolderFs } from './testing/memory-work-folders';
import { t048SessionCases } from './testing/t048-cases';
import { joinFolder, seqOf, workFolderName } from './work-folders';

t048SessionCases('memory', () => {
  const fs = new MemoryWorkFolderFs(['E:\\work']);
  const link = (path: string) => (path.toLowerCase().startsWith('e:\\work') ? `E:\\real${path.slice('E:\\work'.length)}` : null);
  return {
    repositories: new MemoryRepositories(),
    store: new MemoryDeliveryStore(),
    folders: {
      fs,
      location: 'E:\\work\\AgentWorkflowGui',
      elsewhere: 'E:\\work\\elsewhere',
      exists: (path) => fs.exists(path),
      putFile: (folder, name) => fs.putFile(joinFolder(folder, name)),
      makeForeign: (path) => fs.makeTree(path),
      realPath: link,
    },
  };
});

describe('T048 work folder names', () => {
  it('YYYY-MM-DD-NNN with at least three digits; only such names count', () => {
    expect(workFolderName('2026-11-04', 1)).toBe('2026-11-04-001');
    expect(workFolderName('2026-11-04', 999)).toBe('2026-11-04-999');
    expect(workFolderName('2026-11-04', 1000)).toBe('2026-11-04-1000');
    expect(seqOf('2026-11-04-001', '2026-11-04')).toBe(1);
    expect(seqOf('2026-11-04-12345', '2026-11-04')).toBe(12345);
    for (const name of ['2026-11-04-07', '2026-11-04-abc', '2026-11-04-001x', '2026-11-03-001', '2026-11-04-000', '2026-11-04--01']) expect(seqOf(name, '2026-11-04')).toBeUndefined();
    expect(joinFolder('E:\\a\\', 'b')).toBe('E:\\a\\b');
    expect(joinFolder('/tmp/a', 'b')).toBe('/tmp/a/b');
  });

  it('an Agent with empty instructions adds nothing either', async () => {
    const w = await world();
    await w.repositories.agents.save({ ...agent(), id: AgentId.parse('agent-empty'), instructions: '' }, null);
    expect(await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('s-1'), kind: 'ordinary', agentId: AgentId.parse('agent-empty'), model: { runtime: 'codex', model: 'gpt-6-luna' }, cwd: CWD })).toMatchObject({ ok: true });
    await settle();
    expect(w.codex.get('s-1')?.started[0]?.instructions).toBeUndefined();
  });

  it('without work folders (no default location given) a folder must be given, and nothing is made', async () => {
    const w = await world();
    expect(
      await w.run({ type: 'session.create', requestId: rid(), sessionId: SessionId.parse('s-1'), kind: 'ordinary', model: { runtime: 'codex', model: 'gpt-6-luna' } }),
    ).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await w.repositories.sessions.get(SessionId.parse('s-1'))).toBeUndefined();
  });
});

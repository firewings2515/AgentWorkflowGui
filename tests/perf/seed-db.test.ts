// Seeds the performance baseline's database (T040): an Agent and one closed ordinary session `s-perf` titled
// "perf-10k" with a 10,000-message conversation (5,000 turns). Used by tests/live/t040-perf-live.mjs before the app
// starts on the same (temporary) userData; skipped unless AWG_SEED_DB names a new database under the temp folder.
//
//   AWG_SEED_DB=<temp folder>\awg.sqlite AWG_SEED_TURNS=5000 npx vitest run tests/perf/seed-db.test.ts
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { SessionId } from '../../contracts';
import { longConversation } from '../../contracts/fixtures/long-conversation';
import { fixtureSnapshot } from '../../contracts/fixtures/snapshot';
import { createRepositories, openDatabase } from '../../adapters/storage';

const path = process.env['AWG_SEED_DB'];
const turns = Number(process.env['AWG_SEED_TURNS'] ?? 5000);
const sessionId = SessionId.parse('s-perf');
const now = '2026-11-03T10:00:00.000Z';

it.skipIf(path === undefined)('seeds the baseline database', async () => {
  if (path === undefined || !resolve(path).toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())) throw new Error('AWG_SEED_DB must be an awg.sqlite under the temp folder');
  if (existsSync(path)) throw new Error('the database exists already; seeding is for a new one only');
  const db = openDatabase(path);
  try {
    db.exec('PRAGMA synchronous = OFF');
    const repos = createRepositories(db);
    const agent = fixtureSnapshot.agents[0]!;
    await repos.agents.save({ ...agent, revision: 0 }, null);
    const template = fixtureSnapshot.sessions.find((s) => s.kind === 'ordinary')!;
    await repos.sessions.create({ ...template, id: sessionId, title: 'perf-10k', agent: { id: agent.id, revision: 0 }, revision: 0, activity: 'closed', createdAt: now, updatedAt: now });
    const history = longConversation({ sessionId, turns });
    for (const t of history.turns) await repos.conversations.upsertTurn(t);
    for (const m of history.messages) await repos.conversations.appendMessage(m);
    for (const i of history.items) await repos.conversations.upsertItem(i);
    console.log(JSON.stringify({ seeded: path, turns: history.turns.length, messages: history.messages.length, items: history.items.length }));
  } finally {
    db.close();
  }
}, 600_000);

// T040 r1 (follow-up of P1-5): a `report_to_root` whose delivery stayed unknown and that the user retried enters root
// the way the first try did — into root's running turn, else as a new turn — and is sent once. Any other peer message
// keeps its stored entry on a retry, as before. On the memory ports (core/workflow/t040-report.test.ts) and on SQLite
// (app/main/workflow-t040.test.ts).
import { describe, expect, it } from 'vitest';
import { OperationId, type WorkflowTemplate } from '../../../contracts';
import { dispatches, handoff, IMPL, ROOT, rid, sessionOf, settle, started, type World } from './harness';

const toImpl = { ruleId: 'to-impl', target: { kind: 'node' as const, nodeId: IMPL } };

/** Root runs a turn of its own; impl exists. */
const busyRoot = async (make: (workflow?: WorkflowTemplate) => Promise<World>) => {
  const w = await make();
  await started(w);
  await handoff(w, ROOT, toImpl);
  await settle();
  const impl = await sessionOf(w, IMPL);
  w.emitTurn(ROOT, 'turn-root-busy', 'running');
  await settle();
  return { w, impl, rootAdapter: w.codex.get(ROOT) ?? w.claude };
};

const retryUnknown = async (w: World) => {
  const [escalation] = (await w.repositories.escalations.list({ state: 'open' })).filter((e) => e.kind === 'delivery-unknown');
  if (escalation === undefined) throw new Error('no escalation');
  expect(await w.run({ type: 'delivery.resolve', requestId: rid(), escalationId: escalation.id, decision: 'retry', acceptDuplicateRisk: true })).toMatchObject({ ok: true });
  await settle();
};

/** The entries of every dispatch whose text holds `text`. */
const entriesOf = (w: World, text: string) => dispatches(w).filter((d) => d.text.includes(text)).map((d) => d.entry.kind);

export const t040ReportRetryCases = (backend: string, make: (workflow?: WorkflowTemplate) => Promise<World>) =>
  describe(`a retried report to root enters it as the first try did (T040 r1, ${backend})`, () => {
    it.each([
      ['still runs', 'insert'],
      ['has ended', 'new-turn'],
    ] as const)('root %s at the retry: the second try goes in as %s, once', async (rootState, expected) => {
      const { w, impl, rootAdapter } = await busyRoot(make);
      const content = `report while root ${rootState}`;
      // Lost on the way (CR-2): unknown, escalated to the user.
      rootAdapter.dispatchModes.push('lost');
      expect(await w.engine.reportToRoot({ content, needsUserConfirmation: false }, { caller: impl, sourceCallRef: `call-${expected}` })).toMatchObject({ status: 'reported' });
      await settle();
      expect(entriesOf(w, content)).toEqual(['insert']);
      const [message] = await w.repositories.peerMessages.list();
      expect(message?.delivery.state).toBe('unknown');
      if (rootState === 'has ended') {
        w.emitTurn(ROOT, 'turn-root-busy', 'completed');
        await settle();
      }
      await retryUnknown(w);
      expect(entriesOf(w, content)).toEqual(['insert', expected]);
      expect((await w.repositories.peerMessages.list()).map((m) => m.delivery.state)).toEqual(['sent']);
    });

    it('a send_message of a node to root is unchanged: its retry keeps the stored entry (a new turn)', async () => {
      const { w, impl, rootAdapter } = await busyRoot(make);
      rootAdapter.dispatchModes.push('lost');
      const sent = await w.service.sendMessage({ to: ROOT, content: 'a plain peer message' }, { caller: impl, operationId: OperationId.parse('op-peer-retry'), sourceCallRef: 'call-peer-retry' });
      expect(sent).toMatchObject({ status: 'accepted' });
      await settle();
      expect(entriesOf(w, 'a plain peer message')).toEqual(['insert']);
      await retryUnknown(w);
      expect(entriesOf(w, 'a plain peer message')).toEqual(['insert', 'new-turn']);
    });
  });

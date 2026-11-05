// Contract rule codes (C-04): every custom issue goes through the helpers of contracts/rules.ts, so it carries a code
// and a fixed message, and every listed code is used. Read with the TypeScript parser, so comments and strings in
// comments do not count.
//
// T061, kept literal on purpose:
// - Outside rules.ts the names of the raw ways in (`addIssue`, `.issues`, `.check`, `z.custom`, a `refine` without
//   `ruleIssue(...)`) do not appear at all.
// - A code is used statically when its string literal is an argument of `ruleIssue(...)`, `addRuleIssue(...)` or of
//   a wrapper named in RULE_WRAPPERS. Each wrapper has a run-time test below that feeds a smallest input and checks
//   the code that comes out is the code that went in, so a wrapper that drops its argument fails.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ContractRule, DeliveryRecord, Escalation, Handoff, issueRule, JoinRound, MergeAttempt, TaskPlan, TransferProposal } from '../contracts';
import { deliveryTargetIssues } from '../contracts/delivery';
import { fixtureSnapshotInput } from '../contracts/fixtures/snapshot';

const dir = join(import.meta.dirname, '..', 'contracts');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'rules.ts');

const RULE_HELPERS = new Set(['ruleIssue', 'addRuleIssue']);

/**
 * The wrappers around the helpers, keyed `file:top-level declaration:callee`. A code literal handed to one of these
 * counts as used. Each has a run-time test in WRAPPER_TESTS; the two lists must name the same wrappers.
 */
const RULE_WRAPPERS: ReadonlySet<string> = new Set([
  'delivery.ts:DeliveryRecord:fail',
  'delivery.ts:deliveryTargetIssues:issues.push',
  'transfer.ts:TransferProposal:fail',
  'workflow.ts:JoinRound:fail',
  'workflow.ts:MergeAttempt:fail',
  'workflow.ts:TaskPlan:fail',
  'workflow.ts:Handoff:fail',
  'workflow.ts:Escalation:fail',
]);

const stringArgs = (call: ts.CallExpression) => call.arguments.filter(ts.isStringLiteralLike).map((a) => a.text);

/** The name of the top-level declaration a node sits in. */
function topLevelName(node: ts.Node): string {
  let current: ts.Node = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent;
  if (ts.isVariableStatement(current)) return current.declarationList.declarations[0]?.name.getText() ?? '';
  if (ts.isFunctionDeclaration(current)) return current.name?.text ?? '';
  return '';
}

/**
 * `uses`: rule codes given to a rule helper, and `wrapped`: by wrapper key, the codes given to a listed wrapper.
 * `bypasses`: ways of raising an issue that carry no rule code.
 */
export function scanSource(file: string, text: string, wrappers: ReadonlySet<string> = RULE_WRAPPERS) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const uses: string[] = [];
  const wrapped = new Map<string, string[]>();
  const bypasses: string[] = [];
  const visit = (node: ts.Node) => {
    // Literal rules: outside rules.ts the names of the raw ways in are not used at all, however they are reached
    // (call, destructuring, alias, string key).
    if (ts.isIdentifier(node) && node.text === 'addIssue') bypasses.push(`${file}: addIssue outside rules.ts`);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'issues') bypasses.push(`${file}: .issues taken from a value`);
    if (ts.isBindingElement(node) && [node.name, node.propertyName].some((n) => n !== undefined && ts.isIdentifier(n) && n.text === 'issues')) bypasses.push(`${file}: issues taken by destructuring`);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && ['addIssue', 'issues'].includes(node.argumentExpression.text)) bypasses.push(`${file}: addIssue/issues by string key`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && RULE_HELPERS.has(callee.text)) uses.push(...stringArgs(node));
      const key = `${file}:${topLevelName(node)}:${callee.getText()}`;
      if (wrappers.has(key)) wrapped.set(key, [...(wrapped.get(key) ?? []), ...stringArgs(node)]);
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const target = callee.expression;
        if (name === 'refine') {
          // The options of a refinement are always `ruleIssue(...)`; `.refine(fn)` alone makes a code-less issue.
          const options = node.arguments[1];
          const ok = options !== undefined && ts.isCallExpression(options) && ts.isIdentifier(options.expression) && options.expression.text === 'ruleIssue';
          if (!ok) bypasses.push(`${file}: refine without ruleIssue(...) options`);
        }
        if (name === 'check') bypasses.push(`${file}: .check(...) adds issues without a code`);
        if (name === 'custom' && ts.isIdentifier(target) && target.text === 'z') bypasses.push(`${file}: z.custom(...) has no rule code`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { uses, wrapped, bypasses };
}

const scanned = files.map((file) => scanSource(file, readFileSync(join(dir, file), 'utf8')));
const wrappedCodes = (key: string) => scanned.flatMap((s) => s.wrapped.get(key) ?? []);

// --- run-time tests of the wrappers: a smallest input, the code that comes out must be the code that went in ---------

const at = '2026-10-24T10:00:00+08:00';
const first = <T>(xs: readonly T[]): T => {
  const x = xs[0];
  if (x === undefined) throw new Error('empty fixture list');
  return x;
};
/** The rule codes of every issue a parse of `input` raises; `null` marks an issue that carries none. */
const rulesOf = (schema: z.ZodType, input: unknown): (string | null)[] => {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issueRule(issue) ?? null);
};

const handoff = first(fixtureSnapshotInput.handoffs);
const transfer = first(fixtureSnapshotInput.transfers);
const escalation = first(fixtureSnapshotInput.escalations);

const WRAPPER_TESTS: Record<string, { rule: string; raised: () => (string | null)[] }> = {
  'delivery.ts:DeliveryRecord:fail': {
    rule: 'delivery.sent-needs-evidence',
    raised: () => rulesOf(DeliveryRecord, { state: 'sent', attempts: [] }),
  },
  'delivery.ts:deliveryTargetIssues:issues.push': {
    rule: 'target.binding-mismatch',
    raised: () =>
      deliveryTargetIssues(undefined, {
        sessionId: 's-1',
        nativeSessionRef: 'thread-a',
        provision: { operationId: 'op-t', bindingKey: 'k', state: 'sent', nativeSessionRef: 'thread-b', preallocated: false },
      } as never),
  },
  'transfer.ts:TransferProposal:fail': {
    rule: 'transfer.cancelled-at',
    raised: () => rulesOf(TransferProposal, { ...transfer, state: 'cancelled', cancelledAt: undefined }),
  },
  'workflow.ts:JoinRound:fail': {
    rule: 'round.settled-at',
    raised: () =>
      rulesOf(JoinRound, { taskId: 't', nodeId: 'n', round: 0, expectedUpstream: ['u'], arrived: [], state: 'waiting', openedAt: at, settledAt: at }),
  },
  'workflow.ts:MergeAttempt:fail': {
    rule: 'merge.ended-at',
    raised: () => rulesOf(MergeAttempt, { taskId: 't', attempt: 0, seq: 0, state: 'queued', enqueuedAt: at, endedAt: at }),
  },
  'workflow.ts:TaskPlan:fail': {
    rule: 'taskplan.confirming-needs-escalation',
    raised: () =>
      rulesOf(TaskPlan, {
        id: 'plan',
        fromSessionId: 's',
        sourceCallRef: 'call',
        ruleId: 'rule',
        items: [{ key: 'a', title: 'A' }],
        state: 'awaiting-confirmation',
        createdAt: at,
      }),
  },
  'workflow.ts:Handoff:fail': {
    rule: 'handoff.not-self',
    raised: () => rulesOf(Handoff, { ...handoff, toNodeId: handoff.fromNodeId }),
  },
  'workflow.ts:Escalation:fail': {
    rule: 'escalation.resolved-fields',
    raised: () => rulesOf(Escalation, { ...escalation, state: 'open', resolvedAt: at, resolvedBy: undefined }),
  },
};

describe('contract rule codes', () => {
  it('every custom issue goes through the rule helpers', () => {
    expect(scanned.flatMap((s) => s.bypasses)).toEqual([]);
  });

  it('every listed code is raised by some contract, through a helper or a listed wrapper', () => {
    const used = new Set([...scanned.flatMap((s) => s.uses), ...[...RULE_WRAPPERS].flatMap(wrappedCodes)]);
    expect(ContractRule.options.filter((rule) => !used.has(rule))).toEqual([]);
    expect([...used].filter((code) => !ContractRule.safeParse(code).success)).toEqual([]);
  });

  it('the wrapper list and the wrapper tests name the same wrappers, and each wrapper is still called with codes', () => {
    expect(Object.keys(WRAPPER_TESTS).sort()).toEqual([...RULE_WRAPPERS].sort());
    for (const key of RULE_WRAPPERS) expect(wrappedCodes(key).length, key).toBeGreaterThan(0);
  });

  for (const [key, { rule, raised }] of Object.entries(WRAPPER_TESTS)) {
    it(`wrapper ${key} hands its code to the issue: ${rule}`, () => {
      expect(wrappedCodes(key)).toContain(rule);
      expect(raised()).toEqual([rule]);
    });
  }
});

describe('deliveryTargetIssues, code by code', () => {
  const unknownAttempt = { attemptId: 'att-1', clientMessageId: '6f1c2a4e-8b3d-4c7a-9e21-000000000001', state: 'unknown', dispatchStartedAt: at };
  const unknownDelivery = { state: 'unknown', attempts: [unknownAttempt] } as never;
  const sentDelivery = { state: 'sent', attempts: [{ ...unknownAttempt, state: 'sent', nativeRef: { sessionRef: 'other' }, evidence: { kind: 'live-ack', at, detail: 'ack' } }] } as never;
  const provision = { operationId: 'op-t', bindingKey: 'k', state: 'unknown', preallocated: false } as never;

  it('a dispatched delivery needs a binding', () => {
    expect(deliveryTargetIssues(unknownDelivery, {})).toEqual(['target.dispatched-needs-binding']);
  });

  it('a dispatched delivery needs a created target', () => {
    expect(deliveryTargetIssues(unknownDelivery, { sessionId: 's-1', nativeSessionRef: 'thread-a', provision } as never)).toEqual(['target.provision-not-created']);
  });

  it('a sent attempt must name the target it is bound to', () => {
    expect(deliveryTargetIssues(sentDelivery, { sessionId: 's-1', nativeSessionRef: 'thread-a' } as never)).toEqual(['target.attempt-other-target']);
  });

  it('a consistent target raises nothing', () => {
    expect(deliveryTargetIssues(undefined, { sessionId: 's-1', nativeSessionRef: 'thread-a' } as never)).toEqual([]);
  });
});

describe('the rule scanner', () => {
  const bypassesOf = (code: string) => scanSource('x.ts', code).bypasses;

  it('accepts the helpers, and counts a wrapper only when it is listed', () => {
    const text = `export const A = z.object({}).refine((v) => v.ok, ruleIssue('a.one')).superRefine((v, ctx) => {
         const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
         fail('b.two');
         addRuleIssue(ctx, 'b.three', ['x']);
       });
       export const B = () => { const issues: ContractRule[] = []; issues.push('c.four'); return issues; };`;
    const listed = scanSource('ok.ts', text, new Set(['ok.ts:A:fail']));
    expect(listed.bypasses).toEqual([]);
    expect(listed.uses).toEqual(['a.one', 'b.three']);
    expect([...listed.wrapped]).toEqual([['ok.ts:A:fail', ['b.two']]]);
    const unlisted = scanSource('ok.ts', text, new Set());
    expect(unlisted.wrapped.size).toBe(0);
  });

  it('fails a refine with no options, with literal options or with another call', () => {
    expect(bypassesOf('s.refine((v) => v.ok);')).toHaveLength(1);
    expect(bypassesOf("s.refine((v) => v.ok, { message: 'no' });")).toHaveLength(1);
    expect(bypassesOf("s.refine((v) => v.ok, other('a.one'));")).toHaveLength(1);
  });

  it('fails the other ways of adding an issue', () => {
    expect(bypassesOf("s.superRefine((v, ctx) => { ctx.addIssue({ code: 'custom', message: 'm' }); });")).toHaveLength(1);
    expect(bypassesOf("s.superRefine((v, ctx) => { ctx['addIssue']({ code: 'custom', message: 'm' }); });")).toHaveLength(1);
    expect(bypassesOf("s.superRefine((v, ctx) => { const { addIssue } = ctx; addIssue({ code: 'custom', message: 'm' }); });").length).toBeGreaterThan(0);
    expect(bypassesOf("s.superRefine((v, ctx) => { const { addIssue: add } = ctx; add({ code: 'custom', message: 'm' }); });").length).toBeGreaterThan(0);
    expect(bypassesOf("s.superRefine((v, ctx) => { const { issues } = ctx; issues.push({ code: 'custom', message: 'm', input: v }); });").length).toBeGreaterThan(0);
    expect(bypassesOf("s.superRefine((v, ctx) => { const list = ctx.issues; list.push({ code: 'custom', message: 'm', input: v }); });")).toHaveLength(1);
    expect(bypassesOf('s.check((ctx) => { void ctx; });')).toHaveLength(1);
    expect(bypassesOf('const c = z.custom((v) => v !== undefined);')).toHaveLength(1);
  });

  it('does not count a code that is only a plain string or sits in a comment', () => {
    const scan = scanSource('plain.ts', "// ruleIssue('a.one')\nconst name = 'a.one';\nconst other = pick('a.one');\nconst fail = (n: string) => n;\nfail('a.one');");
    expect(scan.uses).toEqual([]);
    expect(scan.wrapped.size).toBe(0);
  });
});

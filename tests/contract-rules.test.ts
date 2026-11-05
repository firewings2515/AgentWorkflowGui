// Contract rule codes (C-04): every custom issue goes through the helpers of contracts/rules.ts, so it carries a code
// and a fixed message, and every listed code is used. Read with the TypeScript parser, so comments and strings in
// comments do not count. T061 made it strict: a `refine` without `ruleIssue(...)` (also with no options at all), the
// other ways to add an issue (`addIssue`, `.check`, `z.custom`, `ctx.issues`) and codes that only appear as plain
// strings are all caught, and the scanner is itself tested on small bad sources.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ContractRule } from '../contracts';

const dir = join(import.meta.dirname, '..', 'contracts');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'rules.ts');

const RULE_HELPERS = new Set(['ruleIssue', 'addRuleIssue']);

const isRuleType = (type: ts.TypeNode | undefined) => type !== undefined && ts.isTypeReferenceNode(type) && type.typeName.getText() === 'ContractRule';
const isRuleList = (type: ts.TypeNode | undefined) => type !== undefined && ts.isArrayTypeNode(type) && isRuleType(type.elementType);
const stringArgs = (call: ts.CallExpression) => call.arguments.filter(ts.isStringLiteralLike).map((a) => a.text);

/**
 * `uses`: rule codes handed to `ruleIssue` / `addRuleIssue`, to a local function whose first parameter is a
 * `ContractRule` (the `fail` wrappers of the superRefine bodies), or pushed onto a local `ContractRule[]`.
 * `bypasses`: ways of raising an issue that carry no rule code.
 */
export function scanSource(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const wrappers = new Set<string>();
  const lists = new Set<string>();
  const declare = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const init = node.initializer;
      if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && isRuleType(init.parameters[0]?.type)) wrappers.add(node.name.text);
      if (isRuleList(node.type)) lists.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && isRuleType(node.parameters[0]?.type)) wrappers.add(node.name.text);
    ts.forEachChild(node, declare);
  };
  declare(source);

  const uses: string[] = [];
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
      if (ts.isIdentifier(callee) && (RULE_HELPERS.has(callee.text) || wrappers.has(callee.text))) uses.push(...stringArgs(node));
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const target = callee.expression;
        if (name === 'push' && ts.isIdentifier(target) && lists.has(target.text)) uses.push(...stringArgs(node));
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
  return { uses, bypasses };
}

const scanned = files.map((file) => scanSource(file, readFileSync(join(dir, file), 'utf8')));

describe('contract rule codes', () => {
  it('every custom issue goes through the rule helpers', () => {
    expect(scanned.flatMap((s) => s.bypasses)).toEqual([]);
  });

  it('every listed code is raised by some contract, through a rule helper', () => {
    const used = new Set(scanned.flatMap((s) => s.uses));
    expect(ContractRule.options.filter((rule) => !used.has(rule))).toEqual([]);
    expect([...used].filter((code) => !ContractRule.safeParse(code).success)).toEqual([]);
  });
});

describe('the rule scanner', () => {
  const bypassesOf = (code: string) => scanSource('x.ts', code).bypasses;

  it('accepts the helpers and the typed wrappers around them', () => {
    const scan = scanSource(
      'ok.ts',
      `const a = z.object({}).refine((v) => v.ok, ruleIssue('a.one'));
       const b = z.object({}).superRefine((v, ctx) => {
         const fail = (rule: ContractRule) => addRuleIssue(ctx, rule);
         fail('b.two');
         addRuleIssue(ctx, 'b.three', ['x']);
       });
       const issues: ContractRule[] = [];
       issues.push('c.four');`,
    );
    expect(scan.bypasses).toEqual([]);
    expect(scan.uses).toEqual(['a.one', 'b.two', 'b.three', 'c.four']);
  });

  it('fails a refine with no options, with literal options or with another call', () => {
    expect(bypassesOf('s.refine((v) => v.ok);')).toHaveLength(1);
    expect(bypassesOf("s.refine((v) => v.ok, { message: 'no' });")).toHaveLength(1);
    expect(bypassesOf("s.refine((v) => v.ok, other('a.one'));")).toHaveLength(1);
  });

  it('fails the other ways of adding an issue', () => {
    expect(bypassesOf("s.superRefine((v, ctx) => { ctx.addIssue({ code: 'custom', message: 'm' }); });")).toHaveLength(1);
    expect(bypassesOf("s.superRefine((v, ctx) => { ctx.issues.push({ code: 'custom', message: 'm', input: v }); });")).toHaveLength(1);
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
  });
});

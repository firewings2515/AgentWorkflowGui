// Contract rule codes (C-04): every custom issue goes through the helpers of contracts/rules.ts, so it
// carries a code and a fixed message, and every listed code is used. Read with the TypeScript parser, so
// comments and strings in comments do not count.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ContractRule } from '../contracts';

const dir = join(import.meta.dirname, '..', 'contracts');
const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'rules.ts');

/** Walks a contract module and reports string literals and the calls that bypass the rule helpers. */
function scan(file: string) {
  const source = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const strings: string[] = [];
  const bypasses: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) strings.push(node.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      // A refinement must use ruleIssue(...) for its options, never a literal { message }.
      if ((name === 'refine' || name === 'superRefine') && node.arguments[1] !== undefined && !ts.isCallExpression(node.arguments[1])) {
        bypasses.push(`${file}: ${name} without ruleIssue`);
      }
      // Custom issues are added only through addRuleIssue(...).
      if (name === 'addIssue') bypasses.push(`${file}: addIssue outside rules.ts`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { strings, bypasses };
}

const scanned = files.map(scan);

describe('contract rule codes', () => {
  it('every custom issue goes through the rule helpers', () => {
    expect(scanned.flatMap((s) => s.bypasses)).toEqual([]);
  });

  it('every listed code is raised by some contract', () => {
    const used = new Set(scanned.flatMap((s) => s.strings));
    expect(ContractRule.options.filter((rule) => !used.has(rule))).toEqual([]);
  });
});

// Every exported schema in contracts/ also exports its inferred type under the same name (T005), so
// adapters never need to re-derive contract types with z.infer. Read with the TypeScript parser, so
// commented-out declarations do not count.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'contracts');
const isExported = (node: ts.Node) => ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function exportedNames(file: string) {
  const source = ts.createSourceFile(file, readFileSync(join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const types = new Set<string>();
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) values.push(d.name.text);
    } else if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      types.add(statement.name.text);
    }
  }
  return { values, types };
}

const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts');

describe('contracts type exports', () => {
  it('finds the contract modules', () => {
    expect(files).toContain('session.ts');
  });

  for (const file of files) {
    it(`${file} exports a type for every schema`, () => {
      const { values, types } = exportedNames(file);
      // Schemas are the exported values except plain constants (UPPER_CASE, e.g. CONTRACTS_VERSION) and helpers (lowercase).
      const schemas = values.filter((name) => /^[A-Z]/.test(name) && !/^[A-Z0-9_]+$/.test(name));
      expect(schemas.filter((name) => !types.has(name))).toEqual([]);
    });
  }
});

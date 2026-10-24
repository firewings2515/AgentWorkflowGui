// Every exported schema in contracts/ also exports its inferred type under the same name (T005), so
// adapters never need to re-derive contract types with z.infer.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '..', 'contracts');
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts')
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n') }));

describe('contracts type exports', () => {
  it('finds the contract modules', () => {
    expect(sources.map((s) => s.name)).toContain('session.ts');
  });

  for (const { name, text } of sources) {
    it(`${name} exports a type for every schema`, () => {
      const schemas = [...text.matchAll(/^export const ([A-Z][A-Za-z]*)[ =]/gm)].map((m) => m[1]).filter((c) => c !== 'CONTRACTS_VERSION');
      const missing = schemas.filter((c) => !text.includes(`\nexport type ${c} `));
      expect(missing).toEqual([]);
    });
  }
});

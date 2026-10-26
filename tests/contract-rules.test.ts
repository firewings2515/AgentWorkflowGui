// Every rule code of contracts/rules.ts is raised by some contract (C-04), so the list cannot keep codes
// that no schema uses.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContractRule } from '../contracts';

const dir = join(import.meta.dirname, '..', 'contracts');

describe('contract rule codes', () => {
  it('are each raised somewhere in the contracts', () => {
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'rules.ts')
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(ContractRule.options.filter((rule) => !sources.includes(`'${rule}'`))).toEqual([]);
  });
});

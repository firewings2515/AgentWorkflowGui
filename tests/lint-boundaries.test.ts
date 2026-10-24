import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { layerConfigs } from '../eslint.layers.mjs';

// Guards the dependency direction (eslint.layers.mjs) against regressions.
// Each fixture declares the path it pretends to live at and whether linting must fail. The fixtures
// are .txt so that lint, typecheck and the build never pick them up.
const root = join(__dirname, '..');
const fixtureDir = join(__dirname, 'lint-fixtures');

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [{ files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser } }, ...layerConfigs],
});

const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.txt'))
  .map((name) => {
    const source = readFileSync(join(fixtureDir, name), 'utf8');
    const virtualPath = /^\/\/ virtual-path: (.+)$/m.exec(source)?.[1]?.trim();
    const expectation = /^\/\/ expect: (error|ok)$/m.exec(source)?.[1];
    if (virtualPath === undefined || expectation === undefined) throw new Error(`${name}: missing header`);
    return { name, source, virtualPath, expectation };
  });

describe('layer dependency rules', () => {
  it('has fixtures for both outcomes', () => {
    expect(fixtures.some((f) => f.expectation === 'error')).toBe(true);
    expect(fixtures.some((f) => f.expectation === 'ok')).toBe(true);
  });

  it.each(fixtures)('$name ($expectation)', async ({ source, virtualPath, expectation }) => {
    const [result] = await eslint.lintText(source, { filePath: join(root, virtualPath) });
    const messages = result?.messages ?? [];
    expect(messages.filter((m) => m.fatal)).toEqual([]);
    const violations = messages.filter((m) => m.ruleId === 'layer/no-restricted-loads' || m.ruleId === 'no-restricted-globals');
    if (expectation === 'error') {
      expect(violations.length).toBeGreaterThan(0);
    } else {
      expect(violations).toEqual([]);
    }
  });
});

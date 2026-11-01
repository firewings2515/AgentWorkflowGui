// T045: the installer carries no Claude CLI (the user's own Claude Code is used) and names its company.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

describe('T045 packaging', () => {
  const builder = read('electron-builder.yml');
  const lines = builder.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));

  it("leaves the SDK's platform CLI packages out of the installer and does not unpack them", () => {
    expect(lines).toContain("  - '!node_modules/@anthropic-ai/claude-agent-sdk-*{,/**}'");
    expect(lines.join('\n')).not.toMatch(/asarUnpack:[\s\S]*claude-agent-sdk-/);
    expect(lines.filter((l) => /^\s+- node_modules\//.test(l))).toEqual(['  - node_modules/koffi/**', '  - node_modules/@koromix/**']);
  });

  it('names the author, which becomes the exe CompanyName', () => {
    const pkg = JSON.parse(read('package.json')) as { author?: string };
    expect(pkg.author).toBe('firewings2515');
  });

  it('no longer has the asar-to-unpacked path conversion of T044', () => {
    expect(() => readFileSync(join(root, 'app', 'main', 'packaged-paths.ts'))).toThrow();
  });
});

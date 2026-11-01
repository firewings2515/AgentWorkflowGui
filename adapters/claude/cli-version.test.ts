import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_MIN_VERSION } from './cli-version';

describe('T045 CLAUDE_CODE_MIN_VERSION', () => {
  it("is the pinned Agent SDK's claudeCodeVersion", () => {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    const sdkPackage = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { claudeCodeVersion?: string };
    expect(CLAUDE_CODE_MIN_VERSION).toBe(sdkPackage.claudeCodeVersion);
  });
});

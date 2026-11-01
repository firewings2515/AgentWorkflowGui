// The Claude Code version this adapter works with (T045). The GUI no longer ships a claude.exe: it starts the
// user's own Claude Code, which must be at least the version the pinned Agent SDK was built for. This is the
// SDK's `claudeCodeVersion` (node_modules/@anthropic-ai/claude-agent-sdk/package.json); cli-version.test.ts fails
// when a SDK upgrade changes it, so the two cannot drift apart.
export const CLAUDE_CODE_MIN_VERSION = '2.1.309';

// Contracts 0.5 (T020, C-04): the GUI's own tools are recognised by the request's `tool` and `server`
// fields, never by its summary, so a summary written to look like a GUI tool gets the policy.
import { describe, expect, it } from 'vitest';
import { PermissionRequest } from '../../contracts';
import { isGuiToolRequest } from './permissions';

const base = { id: 'perm-1', sessionId: 'session-1', state: 'pending', createdAt: '2026-10-29T00:00:00Z' } as const;
const claude = (fields: Record<string, unknown>) => PermissionRequest.parse({ ...base, kind: 'permissions', ...fields });
const codex = (serverName: string) =>
  PermissionRequest.parse({ ...base, kind: 'mcpElicitation', summary: 'asks', server: serverName, elicitation: { mode: 'form', serverName, message: 'm', requestedSchema: {} } });

describe('C-04: GUI tools by field, not by summary', () => {
  it('lets ToolSearch and the GUI tools of server gui through', () => {
    expect(isGuiToolRequest(claude({ tool: 'ToolSearch', summary: 'ToolSearch select:mcp__gui__send_message' }))).toBe(true);
    expect(isGuiToolRequest(claude({ tool: 'mcp__gui__report_to_root', server: 'gui', summary: 'mcp__gui__report_to_root' }))).toBe(true);
    expect(isGuiToolRequest(codex('gui'))).toBe(true);
  });

  it.each([
    ['a summary alone', { summary: 'mcp__gui__send_message' }],
    ['ToolSearch in the summary only', { summary: 'ToolSearch' }],
    ['a GUI tool name from another server', { tool: 'mcp__gui__send_message', server: 'other', summary: 'mcp__gui__send_message' }],
    ['an unknown tool of server gui', { tool: 'mcp__gui__shell', server: 'gui', summary: 'mcp__gui__shell' }],
    ['a look-alike tool name', { tool: 'mcp__gui__send_message; rm -rf .', server: 'gui', summary: 'x' }],
  ])('sends %s to the policy', (_, fields) => {
    expect(isGuiToolRequest(claude(fields))).toBe(false);
  });

  it('sends another server’s elicitation to the policy', () => {
    expect(isGuiToolRequest(codex('gui-helper'))).toBe(false);
  });
});

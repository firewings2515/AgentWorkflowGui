// Codex approval server requests <-> contracts PermissionRequest / PermissionDecision. Which answer to
// give is not decided here (the policy module owns the R-08 escalation list); this only translates.
import { ItemId, McpElicitation, PermissionRequest, type PermissionRequestId, type Timestamp, TurnId } from '../../contracts';
import type { PermissionDecision } from './contract-types';
import { opt, type Placement } from './mapping';
import { type JsonValue, PERMISSION_METHODS, type WirePermissionProfile } from './protocol';

export type PermissionKind = PermissionRequest['kind'];

export const permissionKindOf = (method: string): PermissionKind | undefined =>
  (Object.entries(PERMISSION_METHODS) as [PermissionKind, string][]).find(([, m]) => m === method)?.[0];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

export interface BuildContext {
  id: PermissionRequestId;
  placement: Placement;
  createdAt: Timestamp;
  /** Paths of the fileChange item announced by `item/started` before its approval request (R-07). */
  knownPaths?: string[] | undefined;
}

/** Builds the pending request, or returns an error message when the params cannot be represented. */
export const buildPermissionRequest = (kind: PermissionKind, params: unknown, ctx: BuildContext): PermissionRequest | string => {
  if (!isObject(params)) return 'params are not an object';
  const itemId = kind === 'mcpElicitation' ? undefined : str(params.itemId);
  const base = {
    id: ctx.id,
    sessionId: ctx.placement.sessionId,
    ...opt('turnId', ctx.placement.turnId === undefined ? undefined : TurnId.parse(ctx.placement.turnId)),
    ...opt('itemId', itemId === undefined ? undefined : ItemId.parse(itemId)),
    ...opt('nativeTaskId', ctx.placement.nativeTaskId),
    kind,
    state: 'pending' as const,
    createdAt: ctx.createdAt,
  };
  const reason = str(params.reason);
  let fields: Pick<PermissionRequest, 'summary' | 'paths'> & Partial<Pick<PermissionRequest, 'command' | 'cwd' | 'elicitation'>>;
  switch (kind) {
    case 'command': {
      const command = str(params.command);
      // `commandActions` is Codex's best-effort parse; its paths help the escalation list (SP-04 §2).
      const actionPaths = Array.isArray(params.commandActions)
        ? params.commandActions.flatMap((a) => (isObject(a) && str(a.path) ? [a.path as string] : []))
        : [];
      fields = {
        summary: reason ?? (command ? `Run command: ${command}` : 'Run a command'),
        ...opt('command', command),
        ...opt('cwd', str(params.cwd)),
        paths: [...new Set(actionPaths)],
      };
      break;
    }
    case 'fileChange': {
      const grantRoot = str(params.grantRoot);
      const paths = [...new Set([...(ctx.knownPaths ?? []), ...(grantRoot ? [grantRoot] : [])])];
      fields = {
        summary: reason ?? (grantRoot ? `Allow writes under ${grantRoot}` : `Apply a patch to ${paths.length || 'unknown'} file(s)`),
        paths,
      };
      break;
    }
    case 'permissions': {
      const perms = isObject(params.permissions) ? params.permissions : {};
      const fs = isObject(perms.fileSystem) ? perms.fileSystem : {};
      const network = isObject(perms.network) && perms.network.enabled === true;
      const read = strings(fs.read);
      const write = strings(fs.write);
      const parts = [network && 'network access', read.length > 0 && `read ${read.join(', ')}`, write.length > 0 && `write ${write.join(', ')}`].filter(Boolean);
      fields = {
        summary: reason ?? `Grant ${parts.length > 0 ? parts.join('; ') : 'additional permissions'}`,
        ...opt('cwd', str(params.cwd)),
        paths: [...new Set([...write, ...read])],
      };
      break;
    }
    case 'mcpElicitation': {
      const mode = params.mode === 'openai/form' || params.mode === 'openaiForm' ? 'form' : params.mode;
      const parsed = McpElicitation.safeParse(
        mode === 'url'
          ? { mode, serverName: params.serverName, message: params.message ?? '', url: params.url, elicitationId: params.elicitationId }
          : { mode, serverName: params.serverName, message: params.message ?? '', requestedSchema: params.requestedSchema ?? null },
      );
      if (!parsed.success) return `unsupported elicitation: ${parsed.error.message}`;
      fields = { summary: str(params.message) ?? `${parsed.data.serverName} asks for input`, paths: [], elicitation: parsed.data };
      break;
    }
  }
  const result = PermissionRequest.safeParse({ ...base, ...fields });
  return result.success ? result.data : result.error.message;
};

/**
 * The wire result for an answer. Elicitations carry the form content; permission grants are all or
 * nothing (`approve` for this turn, `approve-for-session` for the session).
 */
export const decisionToWire = (kind: PermissionKind, decision: PermissionDecision, params: unknown): JsonValue => {
  const { outcome } = decision;
  switch (kind) {
    case 'command':
    case 'fileChange':
      return { decision: outcome === 'approve' ? 'accept' : outcome === 'approve-for-session' ? 'acceptForSession' : outcome };
    case 'permissions': {
      if (outcome === 'decline' || outcome === 'cancel') return { permissions: {}, scope: 'turn' };
      const requested = (isObject(params) && isObject(params.permissions) ? params.permissions : {}) as Partial<WirePermissionProfile>;
      const granted: Record<string, JsonValue> = {};
      if (requested.network) granted.network = requested.network;
      if (requested.fileSystem) granted.fileSystem = requested.fileSystem as JsonValue;
      return { permissions: granted, scope: outcome === 'approve-for-session' ? 'session' : 'turn' };
    }
    case 'mcpElicitation': {
      const accepted = outcome === 'approve' || outcome === 'approve-for-session';
      return { action: accepted ? 'accept' : outcome, content: accepted ? ((decision.content ?? null)) : null, _meta: null };
    }
  }
};

/** Fail-closed answer for requests that cannot reach the GUI (unknown thread, unparseable params). */
export const refusalToWire = (kind: PermissionKind): JsonValue =>
  kind === 'mcpElicitation'
    ? { action: 'decline', content: null, _meta: null }
    : kind === 'permissions'
      ? { permissions: {}, scope: 'turn' }
      : { decision: 'decline' };

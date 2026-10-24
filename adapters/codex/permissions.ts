// Codex approval server requests <-> contracts PermissionRequest / PermissionDecision. Which answer to
// give is not decided here (the policy module owns the R-08 escalation list); this only translates.
import { ItemId, McpElicitation, PermissionRequest, type PermissionRequestId, type Timestamp, TurnId } from '../../contracts';
import type { PermissionDecision } from './contract-types';
import { opt, type Placement } from './mapping';
import { type JsonValue, PERMISSION_METHODS } from './protocol';

export type PermissionKind = PermissionRequest['kind'];

export const permissionKindOf = (method: string): PermissionKind | undefined =>
  (Object.entries(PERMISSION_METHODS) as [PermissionKind, string][]).find(([, m]) => m === method)?.[0];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export interface BuildContext {
  id: PermissionRequestId;
  placement: Placement;
  createdAt: Timestamp;
  /** Paths of the fileChange item announced by `item/started` before its approval request (R-07). */
  knownPaths?: string[] | undefined;
}

/** What a `permissions` request asks for, in terms the upper layer sees, plus the exact grant to send back. */
interface ParsedProfile {
  network: boolean;
  read: string[];
  write: string[];
  deny: string[];
  grant: { [key: string]: JsonValue };
}

const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const pathList = (v: unknown): string[] | undefined =>
  v === null || v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '') ? (v as string[]) : undefined;

/**
 * Accepts only what `PermissionRequest.paths` can show: network on/off and plain file paths (legacy
 * `read` / `write` lists and `entries` of type `path`). Globs, special scopes (root, tmpdir, project
 * roots, ...) and unknown fields cannot be shown to the user, so the request is refused (fail closed).
 * The grant is rebuilt from the parsed values, never echoed from the raw params.
 */
export const parsePermissionProfile = (v: unknown): ParsedProfile | string => {
  if (!isObject(v) || !onlyKeys(v, ['network', 'fileSystem'])) return 'permissions has unknown fields';
  const out: ParsedProfile = { network: false, read: [], write: [], deny: [], grant: {} };
  if (v.network !== null && v.network !== undefined) {
    if (!isObject(v.network) || !onlyKeys(v.network, ['enabled'])) return 'network permission has unknown fields';
    if (v.network.enabled === true) {
      out.network = true;
      out.grant.network = { enabled: true };
    } else if (v.network.enabled !== false && v.network.enabled !== null) return 'network.enabled is not a boolean';
  }
  const fs = v.fileSystem;
  if (fs === null || fs === undefined) return out;
  if (!isObject(fs) || !onlyKeys(fs, ['read', 'write', 'entries', 'globScanMaxDepth'])) return 'fileSystem permission has unknown fields';
  const read = pathList(fs.read);
  const write = pathList(fs.write);
  if (!read || !write) return 'fileSystem.read / write are not path lists';
  out.read.push(...read);
  out.write.push(...write);
  const entries: JsonValue[] = [];
  if (fs.entries !== null && fs.entries !== undefined) {
    if (!Array.isArray(fs.entries)) return 'fileSystem.entries is not a list';
    for (const e of fs.entries) {
      if (!isObject(e) || !onlyKeys(e, ['path', 'access']) || !isObject(e.path)) return 'fileSystem entry is malformed';
      if (e.path.type !== 'path' || !onlyKeys(e.path, ['type', 'path']) || !str(e.path.path)) {
        return `fileSystem entry of type ${String(e.path.type)} cannot be represented`;
      }
      const path = e.path.path as string;
      if (e.access === 'read') out.read.push(path);
      else if (e.access === 'write') out.write.push(path);
      else if (e.access === 'deny') out.deny.push(path);
      else return 'fileSystem entry has an unknown access mode';
      entries.push({ path: { type: 'path', path }, access: e.access });
    }
  }
  const fileSystem: { [key: string]: JsonValue } = { read: read.length > 0 ? read : null, write: write.length > 0 ? write : null };
  if (entries.length > 0) fileSystem.entries = entries;
  if (out.read.length + out.write.length + out.deny.length > 0) out.grant.fileSystem = fileSystem;
  return out;
};

export interface BuiltRequest {
  request: PermissionRequest;
  /** For `permissions` requests: exactly what an approval grants. */
  grant?: JsonValue;
}

/**
 * Builds the pending request, or returns an error message when the params cannot be represented.
 * Never throws: anything unexpected becomes an error message, so the caller can refuse the request.
 */
export const buildPermissionRequest = (kind: PermissionKind, params: unknown, ctx: BuildContext): BuiltRequest | string => {
  try {
    return build(kind, params, ctx);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const build = (kind: PermissionKind, params: unknown, ctx: BuildContext): BuiltRequest | string => {
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
  let grant: JsonValue | undefined;
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
      const profile = parsePermissionProfile(params.permissions);
      if (typeof profile === 'string') return profile;
      grant = profile.grant;
      const { network, read, write, deny } = profile;
      const parts = [
        network && 'network access',
        write.length > 0 && `write ${write.join(', ')}`,
        read.length > 0 && `read ${read.join(', ')}`,
        deny.length > 0 && `deny ${deny.join(', ')}`,
      ].filter(Boolean);
      // The summary always states the full scope; the agent's reason is only added to it.
      const scope = `Grant ${parts.length > 0 ? parts.join('; ') : 'no additional permissions'}`;
      fields = {
        summary: reason ? `${scope} (${reason})` : scope,
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
  if (!result.success) return result.error.message;
  return grant === undefined ? { request: result.data } : { request: result.data, grant };
};

/**
 * The wire result for an answer. Elicitations carry the form content; permission grants are all or
 * nothing (`approve` for this turn, `approve-for-session` for the session) and grant only `grant`, the
 * scope the upper layer was shown.
 */
export const decisionToWire = (kind: PermissionKind, decision: PermissionDecision, grant?: JsonValue): JsonValue => {
  const { outcome } = decision;
  switch (kind) {
    case 'command':
    case 'fileChange':
      return { decision: outcome === 'approve' ? 'accept' : outcome === 'approve-for-session' ? 'acceptForSession' : outcome };
    case 'permissions':
      if (outcome === 'decline' || outcome === 'cancel' || grant === undefined) return { permissions: {}, scope: 'turn' };
      return { permissions: grant, scope: outcome === 'approve-for-session' ? 'session' : 'turn' };
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

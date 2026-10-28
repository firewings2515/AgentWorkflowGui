// One bearer token per GUI session (R-03, SP-05): the token alone says who is calling. Tokens are kept only
// as SHA-256 digests, so the table never holds a token that could leak into a dump, and every check
// compares two 32-byte digests with `timingSafeEqual`.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionId } from '../../contracts';

/** Longer than any token we issue; anything longer is refused before hashing. */
const MAX_TOKEN_LENGTH = 256;

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/**
 * Who a token belongs to. `generation` is unique per issued token, so anything bound to a token (an MCP
 * session) can tell that token from the same session's later one.
 */
export interface TokenGrant {
  sessionId: SessionId;
  generation: number;
}

export class SessionTokens {
  readonly #byDigest = new Map<string, TokenGrant & { digest: Buffer }>();
  readonly #bySession = new Map<SessionId, string>();
  #generation = 0;

  /** A fresh token for `sessionId`; the session's earlier token stops working. */
  issue(sessionId: SessionId): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString('base64url');
    const digest = digestOf(token);
    const key = digest.toString('hex');
    this.#byDigest.set(key, { sessionId, generation: ++this.#generation, digest });
    this.#bySession.set(sessionId, key);
    return token;
  }

  /** Returns false when the session had no token. */
  revoke(sessionId: SessionId): boolean {
    const key = this.#bySession.get(sessionId);
    if (key === undefined) return false;
    this.#bySession.delete(sessionId);
    this.#byDigest.delete(key);
    return true;
  }

  /** The grant of a presented token; undefined for a missing, unknown or revoked token. */
  resolve(token: string | undefined): TokenGrant | undefined {
    if (!token || token.length > MAX_TOKEN_LENGTH) return undefined;
    const digest = digestOf(token);
    const entry = this.#byDigest.get(digest.toString('hex'));
    return entry && timingSafeEqual(entry.digest, digest) ? { sessionId: entry.sessionId, generation: entry.generation } : undefined;
  }

  /** Whether `grant` is still the session's current token. */
  isCurrent(grant: TokenGrant): boolean {
    const key = this.#bySession.get(grant.sessionId);
    return key !== undefined && this.#byDigest.get(key)?.generation === grant.generation;
  }

  clear(): void {
    this.#byDigest.clear();
    this.#bySession.clear();
  }
}

/** The token of an `Authorization: Bearer <token>` header, or undefined. */
export const bearerToken = (header: string | undefined): string | undefined => {
  const match = header === undefined ? null : /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match?.[1];
};

// Reading and writing contract-shaped records as JSON text (T015). Records are validated with their
// contracts schema on the way in and on the way out. A failure names the table and the rules that failed
// but never a value: stored data may hold conversation text, paths and secrets (contracts 0.4 rule).
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { issueRule } from '../../contracts';

/** A stored record cannot be read: damaged text, or a shape the contracts no longer accept. */
export class StoredDataError extends Error {
  constructor(
    readonly table: string,
    readonly problems: readonly string[],
  ) {
    super(`stored ${table} record is damaged (${problems.join(', ') || 'unreadable'})`);
    this.name = 'StoredDataError';
  }
}

/** A record handed to a repository does not satisfy its contract. */
export class InvalidRecordError extends Error {
  constructor(
    readonly table: string,
    readonly problems: readonly string[],
  ) {
    super(`${table} record does not satisfy its contract (${problems.join(', ') || 'invalid'})`);
    this.name = 'InvalidRecordError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

/** `path:code` or `path:rule` per issue; path segments that may come from data (keys) become `*`. */
const describe = (error: z.ZodError): string[] =>
  error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.map((p) => (typeof p === 'number' ? '[]' : SAFE_SEGMENT.test(String(p)) ? String(p) : '*')).join('.');
    return `${path === '' ? '$' : path}:${issueRule(issue) ?? issue.code}`;
  });

/** Parses a record about to be stored; the parsed form (defaults applied) is what gets stored. */
export const checkRecord = <S extends z.ZodType>(schema: S, table: string, record: unknown): z.output<S> => {
  const result = schema.safeParse(record);
  if (!result.success) throw new InvalidRecordError(table, describe(result.error));
  return result.data;
};

/** Parses stored text; `JSON.parse` messages quote the text, so they are replaced. */
export const readRecord = <S extends z.ZodType>(schema: S, table: string, text: string): z.output<S> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StoredDataError(table, ['$:json']);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new StoredDataError(table, describe(result.error));
  return result.data;
};

/** The ms since epoch of a contract timestamp, for ordering across UTC offsets. */
export const epochMs = (timestamp: string): number => Date.parse(timestamp);

/** What the repositories share: the connection and where large text goes. */
export interface StorageContext {
  readonly db: DatabaseSync;
  /** Text longer than this many UTF-8 bytes is kept in `blob` instead of in the record's row. */
  readonly blobThresholdBytes: number;
}

/** IMPLEMENTATION_DRAFT §5: large content is stored apart so lists and snapshots stay small. */
export const DEFAULT_BLOB_THRESHOLD_BYTES = 64 * 1024;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Splits `fields` of `record` that exceed the threshold out of it. Returns the record without them and
 * the text taken out; `blobs` is empty when nothing was large.
 */
export const splitBlobs = (ctx: StorageContext, record: object, fields: readonly string[]): { body: string; blobs: Record<string, string> } => {
  const rest: Record<string, unknown> = { ...record };
  const blobs: Record<string, string> = {};
  for (const field of fields) {
    const value = rest[field];
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > ctx.blobThresholdBytes) {
      blobs[field] = value;
      delete rest[field];
    }
  }
  return { body: JSON.stringify(rest), blobs };
};

/** Replaces the blobs of one owner (a record's ID within its kind). */
export const writeBlobs = (ctx: StorageContext, kind: string, ownerId: string, blobs: Record<string, string>): void => {
  ctx.db.prepare('DELETE FROM blob WHERE kind = ? AND owner_id = ?').run(kind, ownerId);
  const insert = ctx.db.prepare('INSERT INTO blob (kind, owner_id, field, size_bytes, sha256, content) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [field, content] of Object.entries(blobs)) insert.run(kind, ownerId, field, Buffer.byteLength(content, 'utf8'), sha256(content), content);
};

/** Puts the stored blobs of a record back into its body text, checking each against its hash. */
export const joinBlobs = (ctx: StorageContext, table: string, kind: string, ownerId: string, body: string): string => {
  const rows = ctx.db.prepare('SELECT field, size_bytes, sha256, content FROM blob WHERE kind = ? AND owner_id = ?').all(kind, ownerId) as unknown as {
    field: string;
    size_bytes: number;
    sha256: string;
    content: string;
  }[];
  if (rows.length === 0) throw new StoredDataError(table, ['blob:missing']);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new StoredDataError(table, ['$:json']);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StoredDataError(table, ['$:json']);
  const record = value as Record<string, unknown>;
  for (const row of rows) {
    if (Buffer.byteLength(row.content, 'utf8') !== row.size_bytes || sha256(row.content) !== row.sha256) throw new StoredDataError(table, ['blob:hash']);
    record[row.field] = row.content;
  }
  return JSON.stringify(record);
};

/** The bodies are synchronous (one transaction each); a throw becomes a rejection. */
export const run = <T>(body: () => T): Promise<T> => new Promise((resolve) => resolve(body()));

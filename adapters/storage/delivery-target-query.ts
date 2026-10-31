// This expression is part of migration v7: keep it stable. A nonempty text sessionId on an object is
// the only evidence that permits skipping another session's row. Everything else maps to SQL NULL,
// including valid unbound targets and damaged JSON, and must be loaded and validated by the caller.
export const TARGET_SESSION_V7 = `CASE WHEN json_valid(target) THEN
  CASE WHEN json_type(target) = 'object' AND json_type(target, '$.sessionId') = 'text'
    AND json_extract(target, '$.sessionId') <> '' THEN json_extract(target, '$.sessionId') END
  END`;

// Both disjoint branches seek delivery_by_target: SQLite indexes NULL keys too. UNION ALL avoids an
// OR predicate becoming a table scan, and rowid preserves acceptance order for equal epoch times.
export const DELIVERY_BY_TARGET_SQL = `
  SELECT rowid AS target_order, * FROM delivery WHERE ${TARGET_SESSION_V7} = ?
  UNION ALL
  SELECT rowid AS target_order, * FROM delivery WHERE ${TARGET_SESSION_V7} IS NULL
  ORDER BY accepted_ms, target_order`;

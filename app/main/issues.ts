/** The part of a zod error that `describeIssues` reads. */
export interface IssueSource {
  readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[];
}

/**
 * Field paths and issue codes only, never zod's messages: a message can quote the input (for example a
 * refinement naming the node ID it did not find), and neither the renderer nor the log may see input values.
 * The contracts hold no records, so every path segment is a fixed field name or an array index.
 */
export function describeIssues(error: IssueSource, limit = 5): string {
  const shown = error.issues.slice(0, limit).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
  const more = error.issues.length - shown.length;
  return `${shown.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}`;
}

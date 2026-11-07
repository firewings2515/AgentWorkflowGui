// T065: when a payload inserted into a running turn is reconciled. Every number of that rule is here.
//
// A runtime takes an inserted payload into its turn only at the turn's next step (after the tool calls running then
// return) and stores it in its transcript then, so a dispatch whose ack did not come within the adapter's deadline
// (Claude 60 s, Codex 30 s: `dispatchTimeoutMs` of each adapter) is not reconciled at once. It is reconciled once the
// turn it went into has ended (or the runtime has exited): read-only, at each of the delays below counted from that
// end, and only the last miss is escalated to the user. A turn that runs on for longer than the limit is reconciled
// (and escalated) anyway, so the user sees it; a later end of the turn looks again, and finding it sent closes that
// escalation. Nothing is ever sent again on this path (CR-2).

/** After the turn ended: the read-only reconciles, in ms from that end; the last one that misses escalates. */
export const LATE_RECONCILE_DELAYS_MS: readonly number[] = [0, 2_000, 5_000, 10_000];

/** From the dispatch: a turn still running this long is reconciled and escalated without waiting for its end. */
export const LATE_RECONCILE_LIMIT_MS = 10 * 60_000;

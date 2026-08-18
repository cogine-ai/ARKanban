/**
 * Timestamp handling shared by the projectors.
 *
 * Every projection reads times from the Gateway, and each one had grown its own
 * copy of these two functions — which is how one of them ended up without the
 * bound, and a single bad reading could freeze a session's usage for good.
 */

/** Anything older is a unit mismatch — seconds read as milliseconds — not a date. */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);

export function asTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Bounds a Gateway timestamp by the moment it was observed.
 *
 * Two shapes do real damage. A future date — clock skew, or a field in the wrong
 * unit — sits ahead of every later comparison: a session whose activity is dated
 * ahead of now is permanently newer than its own stored verdict, so the
 * recomputation loop rescores it every pass and never reaches the backlog, and a
 * usage reading dated ahead of now is never superseded by a real one. A date from
 * before this project existed is a wrong unit rather than a time, and drives
 * retention to delete what it has only just stored.
 */
export function boundedTimestamp(value: unknown, observedAt: number): number | undefined {
  const parsed = asTimestamp(value);
  if (parsed === undefined || parsed < EARLIEST_PLAUSIBLE_MS) return undefined;
  return Math.min(parsed, observedAt);
}

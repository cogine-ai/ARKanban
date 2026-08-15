/**
 * Opaque keyset cursors for session pagination.
 *
 * Offset pagination is not usable here: sessions are reordered by every
 * `sessions.list` reconcile, so page 2 of an offset scan would skip or repeat
 * rows that moved across the boundary. A keyset cursor addresses a position by
 * value instead, which stays correct under concurrent writes.
 *
 * The cursor carries the sort it was issued for. Feeding a `lastActivity` cursor
 * into a `duration` scan would compare unrelated magnitudes and silently emit a
 * nonsense page, so decoding rejects the mismatch instead.
 */

export const SESSION_SORTS = ["lastActivity", "duration"] as const;

export type SessionSort = (typeof SESSION_SORTS)[number];

/**
 * Sorts the API accepts but cannot serve yet, mapped to the phase that collects
 * their backing data. Rejecting them by name beats silently falling back to a
 * different order, which would look like a working sort returning wrong results.
 */
export const DEFERRED_SESSION_SORTS: Record<string, string> = {
  cost: "S6 (sessions.usage collection)",
  grade: "S7 (derived session signals)",
};

export type KeysetCursor = {
  sort: SessionSort;
  /** Primary sort value of the last row on the previous page. */
  value: number;
  /** Final tiebreaker, guaranteeing a total order over equal sort values. */
  sessionKey: string;
};

export function isSessionSort(value: string): value is SessionSort {
  return (SESSION_SORTS as readonly string[]).includes(value);
}

export function encodeCursor(cursor: KeysetCursor): string {
  const payload = JSON.stringify([cursor.sort, cursor.value, cursor.sessionKey]);
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Returns undefined for anything malformed, tampered with, or issued for a
 * different sort. Callers must treat that as a client error rather than
 * restarting from the first page, since a silent restart during an infinite
 * scroll would duplicate rows the user already saw.
 */
export function decodeCursor(raw: string, expectedSort: SessionSort): KeysetCursor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [sort, value, sessionKey] = parsed as [unknown, unknown, unknown];
  if (typeof sort !== "string" || !isSessionSort(sort) || sort !== expectedSort) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return undefined;
  return { sort, value, sessionKey };
}

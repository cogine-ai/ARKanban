/**
 * Tracks how well a projector's field expectations match what a Gateway actually
 * returns.
 *
 * The field names in the session and agent projectors were derived from the
 * OpenClaw protocol documentation rather than from observed responses. A wrong
 * guess fails silently — map `archived` when the server sends `archivedAt` and
 * every session simply looks un-archived forever. This inventory turns that
 * silent failure into a visible report.
 */

export type FieldInventoryReport = {
  source: string;
  rowsObserved: number;
  /** Response keys a projector alias matched. */
  consumed: string[];
  /**
   * Response keys the projector has no alias for anywhere. Keys registered as a
   * lower-priority alternate are excluded even when a higher-priority alias won,
   * since those are already understood and would otherwise read as unrecognised.
   */
  unknown: string[];
  /**
   * Logical fields whose entire alias list failed to match any row, reported as
   * `field: alias|alias`. Tracking the concept rather than the alias keeps the
   * report honest: matching `key` should not make its alternate `sessionKey`
   * look absent.
   */
  missing: string[];
};

export class FieldInventory {
  private readonly consumed = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly aliasesOf = new Map<string, readonly string[]>();
  private readonly matchedFields = new Set<string>();
  private rows = 0;

  constructor(private readonly source: string) {}

  /** Records the keys a single raw row carried. */
  observeRow(row: Record<string, unknown>): void {
    this.rows += 1;
    for (const key of Object.keys(row)) this.seen.add(key);
  }

  /** Records a lookup for one logical field and which alias, if any, satisfied it. */
  observeLookup(field: string, aliases: readonly string[], matched: string | undefined): void {
    this.aliasesOf.set(field, aliases);
    if (matched !== undefined) {
      this.consumed.add(matched);
      this.matchedFields.add(field);
    }
  }

  report(): FieldInventoryReport {
    const known = new Set([...this.aliasesOf.values()].flat());
    const unknown = [...this.seen].filter((key) => !this.consumed.has(key) && !known.has(key)).sort();
    const missing = [...this.aliasesOf.entries()]
      .filter(([field]) => !this.matchedFields.has(field))
      .map(([field, aliases]) => `${field}: ${aliases.join("|")}`)
      .sort();
    return { source: this.source, rowsObserved: this.rows, consumed: [...this.consumed].sort(), unknown, missing };
  }

  reset(): void {
    this.consumed.clear();
    this.seen.clear();
    this.aliasesOf.clear();
    this.matchedFields.clear();
    this.rows = 0;
  }
}

/**
 * Reads the first alias present on the row, recording the attempt so unmatched
 * expectations surface in the report.
 */
export function pick(
  row: Record<string, unknown>,
  field: string,
  aliases: readonly string[],
  inventory?: FieldInventory,
): unknown {
  let matched: string | undefined;
  let value: unknown;
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== null) {
      matched = alias;
      value = row[alias];
      break;
    }
  }
  inventory?.observeLookup(field, aliases, matched);
  return value;
}

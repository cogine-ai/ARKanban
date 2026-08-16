import type { SessionSignalsBrief } from "../../../src/contracts";

/**
 * The derived grade, or an explicit statement that there is none.
 *
 * `unscored` renders as a visible marker rather than an empty cell: a blank
 * would read as "fine", and the whole point of the unscored bucket is that the
 * evidence did not support a verdict either way.
 */
export function GradeChip({ signals }: { signals?: SessionSignalsBrief }) {
  if (!signals) {
    return <span className="grade-chip" data-grade="unscored" title="Not scored yet">—</span>;
  }

  const detail = [
    signals.score === undefined ? "no score" : `score ${signals.score}`,
    `outcome ${signals.outcome}`,
    `${signals.confidence} confidence`,
  ].join(" · ");

  return (
    <span className="grade-chip" data-grade={signals.grade} data-confidence={signals.confidence} title={detail}>
      {signals.grade === "unscored" ? "—" : signals.grade}
    </span>
  );
}

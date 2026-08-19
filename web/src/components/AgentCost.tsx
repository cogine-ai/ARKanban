import type { AgentOverview, AgentRollupWindow, SessionUsageCoverage } from "../../../src/contracts";
import { calendarDay, formatCost, formatTokens } from "../lib/format";

export const ROLLUP_WINDOWS: AgentRollupWindow[] = ["24h", "7d"];

/**
 * Why there is no cost to show. Each state is a different instruction to the
 * reader, so none of them may render as `$0`.
 */
const COST_UNAVAILABLE: Partial<Record<SessionUsageCoverage, string>> = {
  not_observed: "Usage not collected yet",
  // The Gateway answered and had nothing to report, which is not the same as a
  // free agent and must never render as one.
  unreported: "Gateway reports no usage for these sessions",
  unavailable: "Gateway does not report usage",
  unauthorized: "Token lacks usage scope",
  error: "Usage read failed",
};

/**
 * What a Gateway-priced window covers, in the words the Gateway used.
 *
 * The Gateway prices calendar days: there is no rolling-window form to ask for,
 * so the amount under `24h` is one day's spend. Labelling it `24h` anyway would
 * put a figure under a heading it does not answer, so a single-day span is
 * labelled by its date — `today` when it is today — and a longer one keeps the
 * window key with the exact span in reach.
 */
function pricedLabel(window: AgentRollupWindow, span: { from: string; to: string } | undefined, today: string): string {
  if (!span || span.from !== span.to) return window;
  return span.from === today ? "today" : span.from.slice(5);
}

/**
 * Says which span the heading is naming, in both directions.
 *
 * The two figures under one heading do not cover the same span: the tokens are
 * this machine's rolling window, and the amount — when the Gateway priced it —
 * is calendar days. Without this the heading reads `today` on the cards the
 * Gateway priced and `24h` on the ones it did not, and nothing on screen says
 * why two cards side by side are labelled differently.
 */
function spanTitle(window: AgentRollupWindow, span: { from: string; to: string } | undefined): string {
  if (!span) {
    return `The last ${window} of recorded activity. No Gateway-priced span for this agent, so there is no calendar day to name.`;
  }
  return span.from === span.to
    ? `Gateway priced ${span.from} (a calendar day, not a rolling window); token counts beside it are the last ${window}`
    : `Gateway priced ${span.from} through ${span.to} (calendar days, not a rolling window); token counts beside it are the last ${window}`;
}

export function AgentCost({ cost }: { cost: AgentOverview["cost"] }) {
  const blocked = COST_UNAVAILABLE[cost.coverage];
  const measured = ROLLUP_WINDOWS.some((window) => cost.windows[window].sessionCount > 0);
  const today = calendarDay();

  return (
    <div className="agent-section agent-cost" data-coverage={cost.coverage}>
      <span className="eyebrow">
        COST
        {cost.coverage === "snapshot" ? (
          <span className="cost-note" title="More sessions were due than one round could read; some figures are from an earlier reading">
            {" "}snapshot
          </span>
        ) : null}
      </span>
      {blocked && !measured ? (
        <span className="cost-empty muted">{blocked}</span>
      ) : (
        <div className="cost-windows">
          {ROLLUP_WINDOWS.map((window) => {
            const totals = cost.windows[window];
            const tokens = totals.inputTokens + totals.outputTokens;
            const span = cost.source[window] === "gateway" ? cost.priced?.[window] : undefined;
            return (
              <span key={window} className="cost-window" data-window={window}>
                <small title={spanTitle(window, span)}>{pricedLabel(window, span, today)}</small>
                <b title={totals.hasCost ? undefined : `At least this much; no price for ${totals.unpricedModels.join(", ") || "some models"}`}>
                  {formatCost(totals.costMicroUsd)}
                  {/* `+` reads as "at least". With no amount at all there is
                      nothing for it to qualify, and "—+" reads as neither. */}
                  {totals.hasCost || totals.costMicroUsd === undefined ? "" : "+"}
                </b>
                <small title={`${tokens.toLocaleString()} tokens across ${totals.sessionCount} sessions in the last ${window}`}>
                  {formatTokens(tokens)} tok
                </small>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

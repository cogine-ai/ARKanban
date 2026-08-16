import type { AgentOverview, AgentRollupWindow, SessionUsageCoverage } from "../../../src/contracts";
import { formatCost, formatTokens } from "../lib/format";

export const ROLLUP_WINDOWS: AgentRollupWindow[] = ["24h", "7d"];

/**
 * Why there is no cost to show. Each state is a different instruction to the
 * reader, so none of them may render as `$0`.
 */
const COST_UNAVAILABLE: Partial<Record<SessionUsageCoverage, string>> = {
  not_observed: "Usage not collected yet",
  unavailable: "Gateway does not report usage",
  unauthorized: "Token lacks usage scope",
  error: "Usage read failed",
};

export function AgentCost({ cost }: { cost: AgentOverview["cost"] }) {
  const blocked = COST_UNAVAILABLE[cost.coverage];
  const measured = ROLLUP_WINDOWS.some((window) => cost.windows[window].sessionCount > 0);

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
            return (
              <span key={window} className="cost-window" data-window={window}>
                <small>{window}</small>
                <b title={totals.hasCost ? undefined : `At least this much; no price for ${totals.unpricedModels.join(", ") || "some models"}`}>
                  {formatCost(totals.costMicroUsd)}
                  {totals.hasCost ? "" : "+"}
                </b>
                <small title={`${tokens.toLocaleString()} tokens across ${totals.sessionCount} sessions`}>
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

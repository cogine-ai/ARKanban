import { useMemo, useState } from "react";
import type {
  ActivitySnapshot,
  AgentOverview,
  AgentRollupWindow,
  SessionUsageCoverage,
  UpcomingSchedule,
} from "../../../src/contracts";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { AGENT_COLORS } from "../lib/board";
import {
  formatCost,
  formatDuration,
  formatPercent,
  formatRelative,
  formatScheduleRelative,
  formatTokens,
  hash,
  shortAgent,
} from "../lib/format";
import { Link } from "../router";
import { useAgents } from "../state/use-agents";
import { useCollector } from "../state/collector-context";

const ROLLUP_WINDOWS: AgentRollupWindow[] = ["24h", "7d"];

/** Live counters the roster endpoint does not carry, read off the activity snapshot. */
type LiveCounts = { running: number; attention: number; schedules: UpcomingSchedule[] };

function liveCountsByAgent(snapshot: ActivitySnapshot | undefined): Map<string, LiveCounts> {
  const byAgent = new Map<string, LiveCounts>();
  const of = (agentId: string): LiveCounts => {
    const existing = byAgent.get(agentId) ?? { running: 0, attention: 0, schedules: [] };
    byAgent.set(agentId, existing);
    return existing;
  };
  for (const item of snapshot?.items ?? []) {
    if (item.state === "terminal") continue;
    const counts = of(item.agentId);
    if (item.state === "active") counts.running += 1;
    if (item.attention !== "none") counts.attention += 1;
  }
  for (const schedule of snapshot?.schedule.items ?? []) of(schedule.agentId).schedules.push(schedule);
  return byAgent;
}

/**
 * Why a card has no cost to show. Each state is a different instruction to the
 * reader, so none of them may render as `$0`.
 */
const COST_UNAVAILABLE: Partial<Record<SessionUsageCoverage, string>> = {
  not_observed: "Usage not collected yet",
  unavailable: "Gateway does not report usage",
  unauthorized: "Token lacks usage scope",
  error: "Usage read failed",
};

function AgentCost({ cost }: { cost: AgentOverview["cost"] }) {
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

function AgentCard({ agent, live }: { agent: AgentOverview; live: LiveCounts }) {
  const now = useScheduleNow();
  const nextRun = live.schedules.reduce<number | undefined>(
    (earliest, schedule) => (earliest === undefined || schedule.nextRunAt < earliest ? schedule.nextRunAt : earliest),
    undefined,
  );
  const descriptors = [agent.model, agent.runtime].filter(Boolean).join(" · ");

  return (
    <article className="agent-card" data-agent-id={agent.id} data-kind={agent.kind}>
      <header className="agent-card-head">
        <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agent.id) % AGENT_COLORS.length] }}>
          {shortAgent(agent.id)}
        </span>
        <span className="agent-identity">
          <b>{agent.displayName}</b>
          <small>{descriptors || "runtime not reported"}</small>
        </span>
        <span className="agent-badges">
          {agent.kind === "system" ? <span className="agent-badge system">SYSTEM</span> : null}
          {agent.origin === "observed" ? (
            <span className="agent-badge inferred" title="Inferred from observed activity; not in the Gateway roster">
              INFERRED
            </span>
          ) : null}
        </span>
      </header>

      <div className="agent-section agent-now">
        <span className="eyebrow">NOW</span>
        <div className="agent-inline-metrics">
          <span><b>{agent.activeSessionCount}</b> active sessions</span>
          <span><b>{live.running}</b> running</span>
          {live.attention > 0 ? <span className="wait"><b>{live.attention}</b> need attention</span> : null}
        </div>
      </div>

      <div className="agent-section">
        <span className="eyebrow">RECENT</span>
        <table className="agent-rollup">
          <thead>
            <tr><th scope="col"><span className="sr-only">Window</span></th><th scope="col">Done</th><th scope="col">Success</th><th scope="col">Avg</th></tr>
          </thead>
          <tbody>
            {ROLLUP_WINDOWS.map((window) => {
              const rollup = agent.recent[window];
              return (
                <tr key={window} data-window={window}>
                  <th scope="row">{window}</th>
                  <td>{rollup.completed}</td>
                  <td>{formatPercent(rollup.successRate)}</td>
                  <td title={rollup.durationSampleCount > 0 ? `${rollup.durationSampleCount} timed runs` : "No run reported both a start and an end"}>
                    {formatDuration(rollup.avgDurationMs)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="agent-section agent-next">
        <span className="eyebrow">NEXT HOUR</span>
        <span>
          {live.schedules.length === 0
            ? "Nothing scheduled"
            : `${live.schedules.length} scheduled · first ${formatScheduleRelative(nextRun!, now)}`}
        </span>
      </div>

      <AgentCost cost={agent.cost} />

      <footer className="agent-card-foot">
        <span className="agent-seen">{agent.lastSessionActivityAt ? `Active ${formatRelative(agent.lastSessionActivityAt)}` : "No session observed"}</span>
        {agent.sessionCount > 0 ? (
          <Link className="agent-sessions-link" to={`/sessions?agentId=${encodeURIComponent(agent.id)}`}>
            {agent.sessionCount} sessions
          </Link>
        ) : null}
      </footer>
    </article>
  );
}

export function AgentsView() {
  const { snapshot } = useCollector();
  const { agents, error } = useAgents();
  const [showSystem, setShowSystem] = useState(false);

  const live = useMemo(() => liveCountsByAgent(snapshot), [snapshot]);

  // Busiest first, then most recently seen. Matches how the live board orders
  // its lanes, so the same agent tends to sit near the top on both pages.
  const sorted = useMemo(() => {
    const counts = (agent: AgentOverview) => agent.activeSessionCount + (live.get(agent.id)?.running ?? 0);
    return [...(agents ?? [])].sort((left, right) => (
      counts(right) - counts(left)
      || (right.lastSessionActivityAt ?? right.lastActivityAt ?? 0) - (left.lastSessionActivityAt ?? left.lastActivityAt ?? 0)
      || left.id.localeCompare(right.id)
    ));
  }, [agents, live]);

  const primary = sorted.filter((agent) => agent.kind !== "system");
  const system = sorted.filter((agent) => agent.kind === "system");
  const emptyCounts: LiveCounts = { running: 0, attention: 0, schedules: [] };

  return (
    <section className="surface view-surface">
      <div className="view-heading">
        <div><span className="eyebrow">AGENT ROSTER</span><h1>Agents</h1></div>
        <span className="count-chip">{primary.length} agents{system.length > 0 ? ` · ${system.length} system` : ""}</span>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      {agents && primary.length === 0 && system.length === 0 ? (
        <div className="simple-empty">No agent has been observed yet. The roster is built from the Gateway, not from configuration.</div>
      ) : null}

      <div className="agent-grid">
        {primary.map((agent) => <AgentCard key={agent.id} agent={agent} live={live.get(agent.id) ?? emptyCounts} />)}
      </div>

      {system.length > 0 ? (
        <div className="agent-system-group">
          {/* Collapsed by default, matching how the OpenClaw client treats the
              system roster: present, but not what an operator came to look at. */}
          <button className="agent-system-toggle" onClick={() => setShowSystem((current) => !current)} aria-expanded={showSystem}>
            <span aria-hidden="true">{showSystem ? "▾" : "▸"}</span> System agents ({system.length})
          </button>
          {showSystem ? (
            <div className="agent-grid">
              {system.map((agent) => <AgentCard key={agent.id} agent={agent} live={live.get(agent.id) ?? emptyCounts} />)}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

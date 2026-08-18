import { useMemo } from "react";
import type { ActivitySnapshot, AgentOverview, UpcomingSchedule } from "../../../src/contracts";
import { AgentCost, ROLLUP_WINDOWS } from "../components/AgentCost";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { AGENT_COLORS } from "../lib/board";
import {
  formatDuration,
  formatPercent,
  formatRelative,
  formatScheduleRelative,
  hash,
  shortAgent,
} from "../lib/format";
import { Link } from "../router";
import { useAgents } from "../state/use-agents";
import { useCollector } from "../state/collector-context";

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
        <Link className="agent-card-open" to={`/agents/${encodeURIComponent(agent.id)}`}>
          <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agent.id) % AGENT_COLORS.length] }}>
            {shortAgent(agent.id)}
          </span>
          <span className="agent-identity">
            <b>{agent.displayName}</b>
            <small>{descriptors || "runtime not reported"}</small>
          </span>
        </Link>
        <span className="agent-badges">
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

  const emptyCounts: LiveCounts = { running: 0, attention: 0, schedules: [] };

  return (
    <section className="surface view-surface">
      <div className="view-heading">
        <div><span className="eyebrow">AGENT ROSTER</span><h1>Agents</h1></div>
        <span className="count-chip">{sorted.length} agents</span>
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      {agents && sorted.length === 0 ? (
        <div className="simple-empty">No agent has been observed yet. The roster is built from the Gateway, not from configuration.</div>
      ) : null}

      {/* One list, because the roster carries nothing that separates a built-in
          agent from a configured one: `agents.list` publishes no kind at all on
          2026.7.1-2, so every agent projects as `unknown`. A collapsed "System
          agents" section was therefore a section that could never appear, and
          inferring membership from something else — say, only ever triggered by
          cron — would be a distinction this collector invented rather than read. */}
      <div className="agent-grid">
        {sorted.map((agent) => <AgentCard key={agent.id} agent={agent} live={live.get(agent.id) ?? emptyCounts} />)}
      </div>
    </section>
  );
}

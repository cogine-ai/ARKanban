import { useId, useMemo, useState } from "react";
import type { AgentOverview, UpcomingSchedule, UpcomingScheduleSnapshot } from "../../../src/contracts";
import { AgentCost } from "../components/AgentCost";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { AGENT_COLORS } from "../lib/board";
import {
  agentIdentity, countsForAgent, liveCountsByAgent, matchesAgentFilter, matchesAgentSearch, schedulesForAgent, sortAgents,
  type AgentFilter, type AgentLiveCounts,
} from "../lib/agents-model";
import {
  formatDuration, formatExact, formatPercent, formatRelative, formatScheduleRelative, hash, scheduleLabel, shortAgent,
} from "../lib/format";
import { Link } from "../router";
import { useAgents } from "../state/use-agents";
import { useCollector } from "../state/collector-context";
import "./agents.css";

function Signal({ counts }: { counts: AgentLiveCounts | undefined }) {
  const state = !counts ? "unknown" : counts.attention > 0 ? "attention" : counts.running > 0 ? "running" : "idle";
  return (
    <div className="roster-signal" data-state={state}>
      <span className="roster-state"><i aria-hidden="true">{state === "attention" ? "!" : state === "running" ? "▶" : ""}</i>
        {!counts ? "—" : counts.attention > 0 ? `${counts.attention} need attention` : counts.running > 0 ? `${counts.running} running` : "Idle"}
      </span>
      {counts && counts.attention > 0 && counts.running > 0 ? <small>{counts.running} running</small> : null}
    </div>
  );
}

function Rollup({ agent, window }: { agent: AgentOverview; window: "24h" | "7d" }) {
  const rollup = agent.recent[window];
  return (
    <div className="roster-rollup" data-window={window} aria-label={`Last ${window}`}>
      <span><small>Done</small><b>{rollup.completed.toLocaleString()}</b></span>
      <span><small>Success</small><b>{formatPercent(rollup.successRate)}</b>
        {rollup.successRate !== undefined ? <i className="roster-success-track" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, rollup.successRate * 100))}%` }} /></i> : null}
      </span>
      <span title={rollup.durationSampleCount > 0 ? `${rollup.durationSampleCount} timed runs` : "Duration not reported"}>
        <small>Avg</small><b>{formatDuration(rollup.avgDurationMs)}</b>
      </span>
    </div>
  );
}

function AgentCard({ agent, counts, schedules, schedule, multiHost, now }: {
  agent: AgentOverview; counts: AgentLiveCounts | undefined; schedules: UpcomingSchedule[] | undefined; schedule: UpcomingScheduleSnapshot | undefined; multiHost: boolean; now: number;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const nextRun = schedules?.reduce<UpcomingSchedule | undefined>(
    (earliest, next) => (!earliest || next.nextRunAt < earliest.nextRunAt ? next : earliest), undefined,
  );
  const descriptors = [agent.model, agent.runtime].filter(Boolean).join(" · ");
  const scheduleKnown = schedules !== undefined;
  return (
    <article className="agent-card roster-row" data-agent-id={agent.id} data-host-id={agent.hostId} data-kind={agent.kind}>
      <div className="roster-row-main">
        <Link className="agent-card-open roster-identity" to={`/agents/${encodeURIComponent(agent.id)}`}>
          <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agentIdentity(agent.hostId, agent.id)) % AGENT_COLORS.length] }}>{shortAgent(agent.displayName || agent.id)}</span>
          <span className="agent-identity"><b>{agent.displayName}</b>
            {descriptors || multiHost ? <small>{multiHost ? agent.hostId : descriptors}</small> : null}
          </span>
        </Link>
        <Signal counts={counts} />
        <div className="roster-primary-rollup"><span className="roster-mobile-window">Last 24h</span><Rollup agent={agent} window="24h" /></div>
        <div className="roster-next" title={`Next 1h · ${nextRun ? `${nextRun.title} · ${formatExact(nextRun.nextRunAt)}` : scheduleKnown ? scheduleLabel(schedule) : "Forecast unavailable"}`}>
          <svg aria-hidden="true" viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M6 2v4M14 2v4M3 8h14M7 12h2" /></svg>
          <span><small>Next 1h</small><b>{nextRun ? formatScheduleRelative(nextRun.nextRunAt, now) : scheduleKnown ? "—" : "Unavailable"}</b></span>
        </div>
        <Link className="agent-sessions-link roster-sessions" to={`/sessions?agentId=${encodeURIComponent(agent.id)}`}>
          <b>{agent.sessionCount.toLocaleString()}</b><span>sessions <span aria-hidden="true">↗</span></span>
        </Link>
        <button className="roster-more" type="button" aria-label={`${open ? "Hide" : "More"} details for ${agent.displayName} on ${agent.hostId}`} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 8 4 4 4-4" /></svg>
        </button>
      </div>
      {open ? <div className="roster-details" id={detailsId}>
        <div className="roster-detail-rollup"><h2>Last 7d</h2><Rollup agent={agent} window="7d" /></div>
        <div className="roster-detail-usage"><AgentCost cost={agent.cost} /></div>
        <dl className="roster-facts">
          <div><dt>Machine</dt><dd>{agent.hostId}</dd></div>
          <div><dt>Agent ID</dt><dd><code>{agent.id}</code></dd></div>
          <div><dt>Source</dt><dd>{agent.origin === "roster" ? "Gateway roster" : "Observed activity"}{agent.kind === "unknown" ? "" : ` · ${agent.kind}`}</dd></div>
          {multiHost && descriptors ? <div><dt>Runtime</dt><dd>{descriptors}</dd></div> : null}
          <div><dt>Active sessions</dt><dd>{agent.activeSessionCount}</dd></div>
          <div><dt>Last activity</dt><dd>{agent.lastSessionActivityAt ? formatRelative(agent.lastSessionActivityAt) : "Not observed"}</dd></div>
        </dl>
      </div> : null}
    </article>
  );
}

const FILTERS: Array<{ value: AgentFilter; label: string }> = [
  { value: "all", label: "All" }, { value: "running", label: "Running" }, { value: "attention", label: "Attention" }, { value: "idle", label: "Idle" },
];

export function AgentsView() {
  const { snapshot, status, live } = useCollector();
  const { agents, error, reload } = useAgents();
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [query, setQuery] = useState("");
  const now = useScheduleNow();
  const counts = useMemo(() => liveCountsByAgent(snapshot), [snapshot]);
  const of = (agent: AgentOverview) => countsForAgent(agent, counts, snapshot, status);
  const sorted = useMemo(() => sortAgents(agents ?? [], counts), [agents, counts]);
  const shown = sorted.filter((agent) => matchesAgentFilter(filter, of(agent)) && matchesAgentSearch(agent, query));
  const multiHost = new Set(sorted.map((agent) => agent.hostId)).size > 1;
  const missingCollectors = (status?.hosts ?? []).filter((host) => !host.reachable).length;
  const sourceIncomplete = !status || status.syncState !== "live" || !status.gateway.connected || status.sources.some((source) => source.state !== "live") || status.syncReasons.includes("live_with_unavailable_source") || (status.hosts ?? []).some((host) => !host.reachable || host.syncState !== "live" || host.gatewayConnected !== true);
  const sourceState = live.state !== "open" ? "Updates paused" : missingCollectors > 0 ? `${missingCollectors} collector${missingCollectors === 1 ? "" : "s"} unavailable` : sourceIncomplete ? "Snapshot" : undefined;
  const filtered = filter !== "all" || query.trim().length > 0;
  return (
    <section className="surface view-surface agents-view">
      <header className="roster-heading"><div><h1>Agents</h1>{sourceState ? <Link className="roster-source-state" to="/connections">{sourceState}<span aria-hidden="true"> ↗</span></Link> : null}</div>
        {agents ? <span className="roster-count">{filtered ? `${shown.length} / ${agents.length}` : agents.length}</span> : null}
      </header>
      <div className="roster-toolbar">
        <div className="roster-filters" role="group" aria-label="Agent activity">
          {FILTERS.map(({ value, label }) => <button type="button" key={value} data-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}<span>{agents ? sorted.filter((agent) => matchesAgentFilter(value, of(agent))).length : "—"}</span>
          </button>)}
        </div>
        <label className="roster-search"><svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an agent" aria-label="Find an agent" />
        </label>
      </div>
      {error ? <div className="roster-error" role="alert"><span>{error}</span><button type="button" onClick={() => void reload()}>Retry</button></div> : null}
      {!agents && !error ? <div className="roster-empty" role="status"><span className="roster-empty-symbol" aria-hidden="true">···</span><h2>Loading agents</h2></div> : null}
      {agents?.length === 0 ? <div className="roster-empty"><span className="roster-empty-symbol" aria-hidden="true">◌</span><h2>{sourceIncomplete ? "No agents available" : "No agents yet"}</h2><Link to="/connections">Check connections <span aria-hidden="true">↗</span></Link></div> : null}
      {agents && agents.length > 0 && shown.length === 0 ? <div className="roster-empty"><span className="roster-empty-symbol" aria-hidden="true">⌕</span><h2>No matching agents</h2><button type="button" onClick={() => { setFilter("all"); setQuery(""); }}>Clear filters</button></div> : null}
      {shown.length > 0 ? <div className="agent-grid roster-list">
        <div className="roster-columns" aria-hidden="true"><span>Agent</span><span>Now</span><span>Last 24h</span><span>Next 1h</span><span>Sessions</span><span /></div>
        {shown.map((agent) => <AgentCard key={agentIdentity(agent.hostId, agent.id)} agent={agent} counts={of(agent)} schedules={schedulesForAgent(agent, snapshot, status)} schedule={snapshot?.schedule} multiHost={multiHost} now={now} />)}
      </div> : null}
    </section>
  );
}

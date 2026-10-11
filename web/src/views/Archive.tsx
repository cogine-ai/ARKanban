import { useMemo, useState } from "react";
import type { ActivityItem, ActivityOutcome, AgentSummary, CollectorStatus } from "../../../src/contracts";
import {
  ARCHIVE_PAGE_SIZE, ARCHIVE_RESULTS, archiveAgentChoices, archiveAgentName, archiveAgentKey,
  archiveExactTime, archiveHostLabels, archiveRelativeTime, archiveResult, archiveTimestamp,
  filterArchive, groupArchiveByDay, type ArchiveFilters,
} from "../lib/archive-model";
import "./archive.css";

function ArchiveSymbol({ outcome }: { outcome?: ActivityOutcome }) {
  if (!outcome) return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6" /></svg>;
  return <span className="archive-result-symbol" data-result={outcome} aria-hidden="true">{archiveResult(outcome).symbol}</span>;
}

export type ArchiveViewProps = {
  items?: ActivityItem[];
  agents?: AgentSummary[];
  status?: CollectorStatus;
  selectedId?: string;
  error?: string;
  onRetry?: () => void;
  onSelect: (id: string) => void;
};

export function ArchiveView({ items, agents, status, selectedId, error, onRetry, onSelect }: ArchiveViewProps) {
  const [filters, setFilters] = useState<ArchiveFilters>({ query: "", outcome: "all", agent: "" });
  const [limit, setLimit] = useState(ARCHIVE_PAGE_SIZE);
  const hostLabels = useMemo(() => archiveHostLabels(status), [status]);
  const retained = useMemo(() => filterArchive(items ?? [], { query: "", outcome: "all", agent: "" }, agents, hostLabels), [items, agents, hostLabels]);
  const matches = useMemo(() => filterArchive(retained, filters, agents, hostLabels), [retained, filters, agents, hostLabels]);
  const choices = useMemo(() => archiveAgentChoices(retained, agents, hostLabels), [retained, agents, hostLabels]);
  const agentLabels = useMemo(() => new Map(choices.map((choice) => [choice.value, choice.agentLabel])), [choices]);
  const groups = groupArchiveByDay(matches.slice(0, limit));
  const filtered = Boolean(filters.query.trim() || filters.agent || filters.outcome !== "all");
  const multiHost = new Set(retained.map((item) => item.hostId)).size > 1;
  const change = (patch: Partial<ArchiveFilters>) => { setFilters((current) => ({ ...current, ...patch })); setLimit(ARCHIVE_PAGE_SIZE); };
  const reset = () => { setFilters({ query: "", outcome: "all", agent: "" }); setLimit(ARCHIVE_PAGE_SIZE); };

  return <section className="surface view-surface archive-view">
    <header className="archive-view-heading"><div><h1>Archive</h1><span>Recent activity</span></div>{items ? <span className="archive-retained-count"><b>{retained.length}</b> recent</span> : null}</header>
    <div className="archive-filters">
      <label className="archive-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 4.5 4.5" /></svg><span className="sr-only">Find recent activity</span><input type="search" placeholder="Find activity" value={filters.query} onChange={(event) => change({ query: event.target.value })} /></label>
      <label className="archive-control"><span>Result</span><select aria-label="Result" value={filters.outcome} data-filtered={filters.outcome !== "all" ? "true" : "false"} onChange={(event) => change({ outcome: event.target.value as ArchiveFilters["outcome"] })}><option value="all">All results</option>{ARCHIVE_RESULTS.map((outcome) => <option value={outcome} key={outcome}>{archiveResult(outcome).label}</option>)}</select></label>
      <label className="archive-control"><span>Agent</span><select aria-label="Agent" value={filters.agent} data-filtered={filters.agent ? "true" : "false"} onChange={(event) => change({ agent: event.target.value })}><option value="">All agents</option>{filters.agent && !choices.some((choice) => choice.value === filters.agent) ? <option value={filters.agent}>Selected agent</option> : null}{choices.map((choice) => <option value={choice.value} key={choice.value}>{choice.label}</option>)}</select></label>
    </div>
    <div className="archive-result-toolbar">{items ? <span>{filtered ? `${matches.length} match${matches.length === 1 ? "" : "es"} in recent history` : "Newest first"}</span> : <span>Newest first</span>}{filtered ? <button type="button" className="archive-clear" onClick={reset}><span aria-hidden="true">×</span> Clear filters</button> : null}</div>
    {error ? <div className="archive-error" role="alert"><span aria-hidden="true">!</span><strong>{items ? "History update unavailable" : "History unavailable"}</strong>{onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}</div> : null}
    {!items && !error ? <div className="archive-empty" role="status"><ArchiveSymbol /><strong>Loading history…</strong></div> : null}
    {items && !error && matches.length === 0 ? <div className="archive-empty"><ArchiveSymbol /><strong>{filtered ? "No matching activity" : "No recent activity"}</strong>{filtered ? <button type="button" onClick={reset}>Clear filters</button> : null}</div> : null}
    {groups.length > 0 ? <div className="archive-timeline archive-table" aria-label="Recent activity history">{groups.map((group) => <section className="archive-day" key={group.key} aria-label={group.label}><h2><span>{group.label}</span><span>{group.items.length} shown</span></h2><div className="archive-day-records">{group.items.map((item) => {
      const result = archiveResult(item.outcome);
      const timestamp = archiveTimestamp(item);
      const timeKind = item.endedAt !== undefined ? "Ended" : "Updated";
      const agentName = agentLabels.get(archiveAgentKey(item.hostId, item.agentId)) ?? archiveAgentName(item, agents);
      return <button type="button" className="archive-row" key={JSON.stringify([item.hostId, item.id])} data-activity-id={item.id} data-host-id={item.hostId} data-agent-key={archiveAgentKey(item.hostId, item.agentId)} aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
        <ArchiveSymbol outcome={item.outcome} />
        <span className="archive-record-copy"><strong>{item.title}</strong><span><span className="archive-agent-name">{agentName}</span><span className="archive-record-kind">{item.kind === "task" ? "Task" : "Attempt"}</span>{multiHost ? <span className="archive-record-host">{hostLabels.get(item.hostId) || item.hostId}</span> : null}</span></span>
        <span className="archive-row-result" data-result={item.outcome}>{result.label}</span>
        <time className="archive-record-time" dateTime={new Date(timestamp).toISOString()} title={`${timeKind} · ${archiveExactTime(timestamp)}`}><span>{timeKind}</span>{archiveRelativeTime(timestamp)}</time>
        <span className="archive-row-chevron" aria-hidden="true">›</span>
      </button>;
    })}</div></section>)}</div> : null}
    {matches.length > 0 ? <footer className="archive-paging"><span>{Math.min(limit, matches.length)} of {matches.length} {filtered ? "matches" : "recent"}</span>{matches.length > limit ? <button type="button" className="archive-load-more" onClick={() => setLimit((current) => current + ARCHIVE_PAGE_SIZE)}>Load more <span aria-hidden="true">↓</span></button> : null}</footer> : null}
  </section>;
}

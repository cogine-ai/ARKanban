import { useMemo } from "react";
import type { ActivityItem, SettledGroupSummary, SettledRange, UpcomingSchedule } from "../../../src/contracts";
import { FlowBoard } from "../components/FlowBoard";
import { RangeSelector } from "../components/RangeSelector";
import { StatusPills } from "../components/StatusPills";
import type { KindFilter } from "../lib/board";
import { statusLabel } from "../lib/format";
import { useCollector } from "../state/collector-context";

/**
 * Kind and query are owned by the app shell rather than by this view: the live
 * board unmounts when another view is shown, and operators expect their search
 * text to still be there when they come back.
 */
export function LiveFlowView({
  kind,
  query,
  hostFilter,
  onKindChange,
  onQueryChange,
  onHostFilterChange,
  onRangeChange,
  selectedId,
  selectedSeriesKey,
  onSelectActivity,
  onSelectSeries,
  onSelectOverflow,
  onOpenIncomingOverflow,
}: {
  kind: KindFilter;
  query: string;
  hostFilter: string;
  onKindChange: (kind: KindFilter) => void;
  onQueryChange: (query: string) => void;
  onHostFilterChange: (hostId: string) => void;
  onRangeChange: (range: SettledRange) => void;
  selectedId?: string;
  selectedSeriesKey?: string;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
  onOpenIncomingOverflow: (agentId: string, queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
}) {
  const { status, snapshot, settled, error, range, refresh } = useCollector();

  const hostOptions = useMemo(() => {
    if (status?.hosts && status.hosts.length > 0) {
      return status.hosts.map((host) => ({ id: host.id, label: host.label }));
    }
    if (status?.host) return [{ id: status.host.id, label: status.host.label }];
    const ids = new Set((snapshot?.items ?? []).map((item) => item.hostId).filter(Boolean));
    return [...ids].sort().map((id) => ({ id, label: id }));
  }, [status, snapshot]);

  const visibleOperationalItems = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return (snapshot?.items ?? []).filter((item) => {
      if (hostFilter !== "all" && item.hostId !== hostFilter) return false;
      if (item.state === "terminal" || item.stage === "settled") return false;
      if (kind !== "all" && item.kind !== kind) return false;
      return !lowered || `${item.title} ${item.agentId} ${item.hostId} ${item.lastToolName ?? ""}`.toLowerCase().includes(lowered);
    });
  }, [snapshot, kind, query, hostFilter]);

  const visibleSchedules = useMemo(() => {
    if (kind !== "all") return [];
    const lowered = query.trim().toLowerCase();
    return (snapshot?.schedule.items ?? []).filter((schedule) => (
      (hostFilter === "all" || schedule.hostId === hostFilter) &&
      (!lowered || `${schedule.title} ${schedule.agentId} ${schedule.hostId}`.toLowerCase().includes(lowered))
    ));
  }, [snapshot, kind, query, hostFilter]);

  const visibleSettled = useMemo(() => {
    if (!settled || hostFilter === "all") return settled;
    const groupsByAgent: typeof settled.groupsByAgent = {};
    const outcomeCounts = { ...settled.outcomeCounts };
    for (const key of Object.keys(outcomeCounts) as Array<keyof typeof outcomeCounts>) outcomeCounts[key] = 0;
    let totalSeries = 0;
    let totalRuns = 0;
    for (const [agentId, groups] of Object.entries(settled.groupsByAgent)) {
      const filtered = groups.filter((group) => group.hostId === hostFilter);
      if (filtered.length === 0) continue;
      groupsByAgent[agentId] = filtered;
      totalSeries += filtered.length;
      for (const group of filtered) {
        totalRuns += group.runCount;
        outcomeCounts.succeeded += group.succeededCount;
        outcomeCounts.failed += group.failedCount;
        outcomeCounts.timed_out += group.timedOutCount;
        outcomeCounts.cancelled += group.cancelledCount;
        outcomeCounts.blocked += group.blockedCount;
        outcomeCounts.unknown += group.unknownCount;
      }
    }
    return { ...settled, groupsByAgent, totalSeries, totalRuns, outcomeCounts };
  }, [settled, hostFilter]);

  const active = visibleOperationalItems.length;
  const waiting = visibleOperationalItems.filter((item) => item.stage === "waiting" || item.stage === "unresolved").length;
  const scheduled = visibleSchedules.length;
  const agentCount = new Set([
    ...visibleOperationalItems.map((item) => item.agentId),
    ...visibleSchedules.map((item) => item.agentId),
    ...Object.keys(visibleSettled?.groupsByAgent ?? {}),
  ]).size;

  return (
    <>
      <section className="summary-bar">
        <div className="summary-copy">
          <span className="eyebrow">LIVE ACTIVITY</span>
          <h1>{status?.syncState === "live" ? (active > 0 ? "Activity is flowing" : "Collector is watching") : statusLabel(status)}</h1>
          <div className="metrics">
            <span><b>{active}</b> operational</span>
            <span><b>{scheduled}</b> scheduled next 1h</span>
            <span className="wait"><b>{waiting}</b> waiting / unresolved</span>
            <span><b>{visibleSettled?.totalSeries ?? "—"}</b> settled series</span>
            <span><b>{visibleSettled?.totalRuns ?? "—"}</b> runs · {range}</span>
            <span><b>{agentCount}</b> agents</span>
            {hostOptions.length > 1 ? <span><b>{hostOptions.length}</b> hosts</span> : null}
          </div>
        </div>
        <div className="summary-actions">
          <StatusPills status={status} snapshot={snapshot} settled={visibleSettled} />
          <div className="filters">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search activity, schedule or series" aria-label="Search board" /></label>
            {hostOptions.length > 0 ? (
              <label className="host-filter">
                <span className="sr-only">Host</span>
                <select value={hostFilter} onChange={(event) => onHostFilterChange(event.target.value)} aria-label="Filter by host">
                  <option value="all">All hosts</option>
                  {hostOptions.map((host) => (
                    <option key={host.id} value={host.id}>{host.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="segmented" aria-label="Activity kind"><button aria-pressed={kind === "all"} onClick={() => onKindChange("all")}>All</button><button aria-pressed={kind === "task"} onClick={() => onKindChange("task")}>Tasks</button><button aria-pressed={kind === "attempt"} onClick={() => onKindChange("attempt")}>Attempts</button></div>
            <RangeSelector value={range} onChange={onRangeChange} />
            <button className="refresh-button" onClick={() => void refresh()} aria-label="Refresh snapshots">↻</button>
          </div>
        </div>
      </section>
      <main className="board-shell">
        {error ? <div className="connection-banner"><span />{error}<button onClick={() => void refresh()}>Retry now</button></div> : null}
        <section className="flow-board surface" aria-label="Adaptive activity flowboard">
          <FlowBoard
            key={range}
            items={visibleOperationalItems}
            schedules={visibleSchedules}
            scheduleState={snapshot?.schedule}
            settled={visibleSettled}
            range={range}
            kind={kind}
            query={query}
            selectedId={selectedId}
            selectedSeriesKey={selectedSeriesKey}
            onSelectActivity={onSelectActivity}
            onSelectSeries={onSelectSeries}
            onSelectOverflow={onSelectOverflow}
            onOpenIncomingOverflow={onOpenIncomingOverflow}
          />
        </section>
      </main>
    </>
  );
}

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
  onKindChange,
  onQueryChange,
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
  onKindChange: (kind: KindFilter) => void;
  onQueryChange: (query: string) => void;
  onRangeChange: (range: SettledRange) => void;
  selectedId?: string;
  selectedSeriesKey?: string;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
  onOpenIncomingOverflow: (agentId: string, queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
}) {
  const { status, snapshot, settled, error, range, refresh } = useCollector();

  const visibleOperationalItems = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return (snapshot?.items ?? []).filter((item) => {
      if (item.state === "terminal" || item.stage === "settled") return false;
      if (kind !== "all" && item.kind !== kind) return false;
      return !lowered || `${item.title} ${item.agentId} ${item.lastToolName ?? ""}`.toLowerCase().includes(lowered);
    });
  }, [snapshot, kind, query]);

  const visibleSchedules = useMemo(() => {
    if (kind !== "all") return [];
    const lowered = query.trim().toLowerCase();
    return (snapshot?.schedule.items ?? []).filter((schedule) => (
      !lowered || `${schedule.title} ${schedule.agentId}`.toLowerCase().includes(lowered)
    ));
  }, [snapshot, kind, query]);

  const active = snapshot?.items.filter((item) => item.catalog === "operational").length ?? 0;
  const waiting = snapshot?.items.filter((item) => item.stage === "waiting" || item.stage === "unresolved").length ?? 0;
  const scheduled = snapshot?.schedule.items.length ?? 0;
  const agentCount = new Set([
    ...(snapshot?.items.filter((item) => item.state !== "terminal").map((item) => item.agentId) ?? []),
    ...(snapshot?.schedule.items.map((item) => item.agentId) ?? []),
    ...Object.keys(settled?.groupsByAgent ?? {}),
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
            <span><b>{settled?.totalSeries ?? "—"}</b> settled series</span>
            <span><b>{settled?.totalRuns ?? "—"}</b> runs · {range}</span>
            <span><b>{agentCount}</b> agents</span>
          </div>
        </div>
        <div className="summary-actions">
          <StatusPills status={status} snapshot={snapshot} settled={settled} />
          <div className="filters">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search activity, schedule or series" aria-label="Search board" /></label>
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
            settled={settled}
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

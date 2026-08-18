import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  ActivityOutcome,
  SettledGroupSummary,
  SettledRange,
  SettledSeriesRuns,
  UpcomingSchedule,
} from "../../../src/contracts";
import { collectorApi } from "../api";
import { formatHourMinute, formatRelative, formatScheduleRelative } from "../lib/format";
import { useMeasuredHeight } from "../state/use-measured-height";
import { DialogFrame } from "./DialogFrame";
import { Timestamp } from "./Timestamp";

export function SeriesRunDialog({
  group,
  range,
  onClose,
  onOpenActivity,
}: {
  group: SettledGroupSummary;
  range: SettledRange;
  onClose: () => void;
  onOpenActivity: (id: string) => void;
}) {
  const [detail, setDetail] = useState<SettledSeriesRuns>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<ActivityOutcome | "all">("all");
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    setFilter("all");
    setScrollTop(0);
    void collectorApi.settledSeriesRuns(group.seriesKey, range, group.rangeEnd)
      .then((value) => { if (live) setDetail(value); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [group.seriesKey, group.rangeEnd, range]);

  const runs = detail?.runs ?? [];
  const filteredRuns = filter === "all" ? runs : runs.filter((run) => run.outcome === filter);
  const outcomes = useMemo(() => ["all", ...new Set(runs.map((run) => run.outcome))] as Array<ActivityOutcome | "all">, [runs]);
  const rowHeight = 48;
  // The list asks for exactly the room its rows need; how much of that it may
  // have on this screen is `.series-run-viewport`'s decision, and the windowing
  // maths then works from what it actually got.
  const contentHeight = filteredRuns.length * rowHeight;
  const viewportHeight = useMeasuredHeight(viewportRef, contentHeight, detail !== undefined);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 4);
  const end = Math.min(filteredRuns.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 4);
  const visibleRuns = filteredRuns.slice(start, end);

  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [filter]);

  return (
    <DialogFrame title={group.title} eyebrow="SERIES RUNS" onClose={onClose}>
      <div className="series-dialog-summary">
        <div><span>Agent</span><b>{group.agentId}</b></div>
        <div><span>Range</span><b>{range}</b></div>
        <div><span>Runs</span><b>{group.runCount}</b></div>
        <div><span>Latest</span><b className={`tier-${group.priorityTier}`}>{group.latestOutcome.replaceAll("_", " ")}</b></div>
      </div>
      <div className="series-confidence-note">Grouped by exact displayed title · Task and Attempt records remain separate</div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="series-dialog-toolbar">
        <ToggleGroup.Root
          type="single"
          value={filter}
          onValueChange={(next) => { if (next) setFilter(next as ActivityOutcome | "all"); }}
          className="flex flex-wrap gap-1"
          aria-label="Run outcome"
        >
          {outcomes.map((outcome) => (
            <ToggleGroup.Item
              key={outcome}
              value={outcome}
              className="rounded-lg border border-black/[0.06] bg-neutral-50 px-2.5 py-1.5 text-[9px] font-semibold capitalize text-neutral-500 data-[state=on]:border-neutral-300 data-[state=on]:bg-neutral-900 data-[state=on]:text-white"
            >
              {outcome.replaceAll("_", " ")}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <span>{filteredRuns.length} runs</span>
      </div>
      {!detail && !error ? <div className="dialog-loading">Loading complete range…</div> : null}
      {detail ? (
        <div
          ref={viewportRef}
          className="series-run-viewport"
          style={{ height: contentHeight }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: filteredRuns.length * rowHeight, position: "relative" }}>
            {visibleRuns.map((run, index) => (
              <button
                key={run.id}
                className="series-run-row"
                style={{ height: rowHeight, top: (start + index) * rowHeight }}
                onClick={() => onOpenActivity(run.id)}
              >
                <span><i className={`archive-state outcome-${run.outcome}`} />{run.title}</span>
                <b>{run.outcome.replaceAll("_", " ")}</b>
                <Timestamp value={run.terminalAt} />
              </button>
            ))}
          </div>
          {filteredRuns.length === 0 ? <div className="dialog-loading">No runs match this outcome.</div> : null}
        </div>
      ) : null}
    </DialogFrame>
  );
}

export function OverflowDialog({
  agentId,
  groups,
  range,
  onClose,
  onOpenSeries,
}: {
  agentId: string;
  groups: SettledGroupSummary[];
  range: SettledRange;
  onClose: () => void;
  onOpenSeries: (seriesKey: string) => void;
}) {
  const runCount = groups.reduce((total, group) => total + group.runCount, 0);
  return (
    <DialogFrame title={agentId} eyebrow={`OVERFLOW · ${groups.length} SERIES · ${runCount} RUNS · ${range}`} onClose={onClose} widthClass="max-w-[640px]">
      <div className="overflow-list">
        {groups.map((group) => (
          <button key={group.seriesKey} onClick={() => onOpenSeries(group.seriesKey)}>
            <span className={`overflow-tier tier-${group.priorityTier}`}>{group.priorityTier}</span>
            <span><b>{group.title}</b><small>{group.kind} · latest {group.latestOutcome.replaceAll("_", " ")}</small></span>
            <span><b>{group.runCount}</b><small>runs</small></span>
          </button>
        ))}
      </div>
    </DialogFrame>
  );
}

export function IncomingOverflowDialog({
  agentId,
  queued,
  schedules,
  onClose,
  onOpenActivity,
}: {
  agentId: string;
  queued: ActivityItem[];
  schedules: UpcomingSchedule[];
  onClose: () => void;
  onOpenActivity: (id: string) => void;
}) {
  return (
    <DialogFrame
      title={agentId}
      eyebrow={`INCOMING OVERFLOW · ${queued.length} QUEUED · ${schedules.length} SCHEDULED`}
      onClose={onClose}
      widthClass="max-w-[640px]"
    >
      <div className="overflow-list incoming-overflow-list">
        {queued.map((item) => (
          <button key={item.id} data-activity-id={item.id} onClick={() => onOpenActivity(item.id)}>
            <span className="overflow-tier">Q</span>
            <span><b>{item.title}</b><small>Queued task · {formatRelative(item.createdAt ?? item.updatedAt)}</small></span>
            <span><b>Queued</b><small>task</small></span>
          </button>
        ))}
        {schedules.map((schedule) => (
          <article key={schedule.id} data-schedule-id={schedule.id}>
            <span className="overflow-tier schedule-tier">◷</span>
            <span><b>{schedule.title}</b><small>Scheduled · {formatScheduleRelative(schedule.nextRunAt, Date.now())}</small></span>
            <span><b>{formatHourMinute(schedule.nextRunAt)}</b><small>{schedule.timezone ?? schedule.scheduleKind}</small></span>
          </article>
        ))}
      </div>
    </DialogFrame>
  );
}

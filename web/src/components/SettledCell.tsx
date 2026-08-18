import { AnimatePresence, motion } from "motion/react";
import type { SettledGroupSummary, SettledPriorityTier, SettledRange } from "../../../src/contracts";
import { useCellLayout } from "../hooks/use-cell-layout";
import { PRIORITY_ORDER, SERIES_TONE } from "../lib/board";
import { formatDateTime, formatExact, formatRelative } from "../lib/format";
import { applyCellQuota, type CellLayout } from "../settled-layout";

function SeriesGroupCard({
  group,
  range,
  layout,
  selected,
  matching,
  onOpen,
}: {
  group: SettledGroupSummary;
  range: SettledRange;
  layout: CellLayout;
  selected: boolean;
  matching: boolean;
  onOpen: () => void;
}) {
  const exceptions = group.failedCount + group.timedOutCount;
  return (
    <motion.button
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={`series-group-card relative min-w-0 overflow-hidden rounded-xl border px-2 py-1.5 text-left shadow-sm transition-colors ${SERIES_TONE[group.priorityTier]} ${selected ? "ring-2 ring-blue-500 ring-offset-1" : ""}`}
      data-series-key={group.seriesKey}
      data-priority={group.priorityTier}
      data-cell-layout={layout.mode}
      onClick={onOpen}
      aria-pressed={selected}
      title={`${group.title} · ${group.runCount} runs · latest ${group.latestOutcome}`}
    >
      <span className="series-title block truncate text-[10px] font-semibold leading-tight">{group.title}</span>
      {layout.mode !== "compact" ? <span className="series-subline block truncate text-[8px] font-medium opacity-65">{group.runCount} runs · {range}</span> : null}
      {layout.mode !== "compact" ? <span className="series-latest block truncate text-[8px] opacity-75">Latest: {group.latestOutcome.replaceAll("_", " ")} · {formatRelative(group.latestEndedAt)}</span> : null}
      <span className="series-counts block truncate text-[8px] font-semibold tabular-nums">
        ✓{group.succeededCount} &nbsp;!{exceptions} &nbsp;?{group.unknownCount}
        {group.cancelledCount > 0 ? ` · cancelled ${group.cancelledCount}` : ""}
        {group.blockedCount > 0 ? ` · blocked ${group.blockedCount}` : ""}
      </span>
      {matching ? <span className="series-match">{group.runCount} matching runs</span> : null}
      {layout.mode === "wide" ? <span className="series-confidence" title={formatExact(group.latestEndedAt)}>Same displayed title · {formatDateTime(group.latestEndedAt)}</span> : null}
    </motion.button>
  );
}

function OverflowCard({
  groups,
  range,
  layout,
  onOpen,
}: {
  groups: SettledGroupSummary[];
  range: SettledRange;
  layout: CellLayout;
  onOpen: () => void;
}) {
  const runCount = groups.reduce((total, group) => total + group.runCount, 0);
  const succeeded = groups.reduce((total, group) => total + group.succeededCount, 0);
  const exceptions = groups.reduce((total, group) => total + group.failedCount + group.timedOutCount, 0);
  const unknown = groups.reduce((total, group) => total + group.unknownCount, 0);
  const highestTier = groups.reduce<SettledPriorityTier>(
    (current, group) => PRIORITY_ORDER[group.priorityTier] < PRIORITY_ORDER[current] ? group.priorityTier : current,
    "P3",
  );
  const exceptional = highestTier === "P0" || highestTier === "P1";
  return (
    <motion.button
      key="overflow"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={`series-group-card overflow-card min-w-0 rounded-xl border px-2 py-1.5 text-left shadow-sm ${exceptional ? "border-red-300 bg-red-50 text-red-950" : "border-neutral-300 bg-neutral-100 text-neutral-900"}`}
      data-overflow-series={groups.length}
      data-priority={highestTier}
      data-cell-layout={layout.mode}
      onClick={onOpen}
      title={`${groups.length} hidden series · ${runCount} runs`}
    >
      <span className="block text-[13px] font-bold leading-tight">+{groups.length} series</span>
      <span className="block truncate text-[8px] font-medium opacity-70">{runCount} runs · {range}</span>
      <span className="block truncate text-[8px] font-semibold tabular-nums">✓{succeeded} &nbsp;!{exceptions} &nbsp;?{unknown}</span>
      {layout.mode === "wide" ? <span className="series-confidence">Highest priority {highestTier}</span> : null}
    </motion.button>
  );
}

export function SettledCell({
  groups,
  range,
  selectedSeriesKey,
  matching,
  onOpenSeries,
  onOpenOverflow,
}: {
  groups: SettledGroupSummary[];
  range: SettledRange;
  selectedSeriesKey?: string;
  matching: boolean;
  onOpenSeries: (seriesKey: string) => void;
  onOpenOverflow: (groups: SettledGroupSummary[]) => void;
}) {
  const { cellRef, layout } = useCellLayout();
  const quota = applyCellQuota(groups, layout.capacity);
  const visibleGroups = quota.visible;
  const hiddenGroups = quota.hidden;
  const hasOverflow = hiddenGroups.length > 0;
  return (
    <div
      ref={cellRef}
      className="stage-cell stage-settled"
      data-cell-layout={layout.mode}
      data-cell-capacity={layout.capacity}
      data-visible-cards={visibleGroups.length + (hasOverflow ? 1 : 0)}
    >
      <AnimatePresence initial={false}>
        {visibleGroups.map((group) => (
          <SeriesGroupCard
            key={`${group.seriesKey}:${group.priorityTier}:${group.latestOutcome}`}
            group={group}
            range={range}
            layout={layout}
            selected={group.seriesKey === selectedSeriesKey}
            matching={matching}
            onOpen={() => onOpenSeries(group.seriesKey)}
          />
        ))}
        {hasOverflow ? <OverflowCard key="overflow" groups={hiddenGroups} range={range} layout={layout} onOpen={() => onOpenOverflow(hiddenGroups)} /> : null}
      </AnimatePresence>
    </div>
  );
}

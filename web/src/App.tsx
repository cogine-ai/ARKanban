import * as Dialog from "@radix-ui/react-dialog";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ActivityDetail,
  ActivityItem,
  ActivityOutcome,
  ActivitySnapshot,
  ActivityStage,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledGroupSummary,
  SettledPriorityTier,
  SettledRange,
  SettledSeriesRuns,
  SourceCoverage,
} from "../../src/contracts";
import { collectorApi } from "./api";
import { applyCellQuota, initialCellLayout, nextCellLayout, type CellLayout } from "./settled-layout";

type View = "live" | "relations" | "archive" | "connections";
type KindFilter = "all" | "task" | "attempt";

const OPERATIONAL_STAGES: Array<{ key: Exclude<ActivityStage, "settled" | "unresolved">; label: string; hint: string; arrow: string }> = [
  { key: "incoming", label: "INCOMING", hint: "queued ledger work", arrow: "→" },
  { key: "in_flight", label: "IN FLIGHT", hint: "observed execution", arrow: "→" },
  { key: "waiting", label: "WAITING", hint: "operator attention", arrow: "↔" },
];

const SETTLED_RANGES: SettledRange[] = ["24h", "7d", "30d"];
const RANGE_STORAGE_KEY = "ar-kanban.settled-range";
const AGENT_COLORS = ["#39766e", "#bd6842", "#53679c", "#aa8738", "#8c657f", "#758653", "#517f87", "#815d45"];
const PRIORITY_ORDER: Record<SettledPriorityTier, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const SERIES_TONE: Record<SettledPriorityTier, string> = {
  P0: "border-red-300/80 bg-red-50/95 text-red-950",
  P1: "border-slate-300/90 bg-slate-50/95 text-slate-900",
  P2: "border-amber-300/80 bg-amber-50/95 text-amber-950",
  P3: "border-emerald-200/90 bg-emerald-50/80 text-emerald-950",
};

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0;
  return result;
}

function shortAgent(value: string): string {
  return value
    .split(/[-_\s]+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function isSettledRange(value: string | null): value is SettledRange {
  return value === "24h" || value === "7d" || value === "30d";
}

function initialSettledRange(): SettledRange {
  try {
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return isSettledRange(stored) ? stored : "7d";
  } catch {
    return "7d";
  }
}

function formatTime(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

function formatDateTime(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatRelative(value?: number): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function outcomeLabel(item: ActivityItem): string {
  if (item.state !== "terminal") return item.phase.replaceAll("_", " ");
  return item.outcome === "unknown" ? "ended · outcome unknown" : item.outcome.replaceAll("_", " ");
}

function coverageTone(source: SourceCoverage): "good" | "warn" | "bad" | "quiet" {
  if (source.state === "live") return "good";
  if (source.state === "reconciling" || source.state === "connecting") return "warn";
  if (source.state === "unavailable") return "quiet";
  return "bad";
}

function statusLabel(status: CollectorStatus | undefined): string {
  if (!status) return "Starting";
  if (status.syncState === "live") return "Live";
  if (status.syncState === "reconciling") return "Reconciling";
  if (status.syncState === "unauthorized") return "Unauthorized";
  if (status.syncState === "incompatible") return "Incompatible";
  if (status.syncState === "offline") return "Offline";
  if (status.syncState === "error") return "Error";
  return "Starting";
}

function useCollector(range: SettledRange) {
  const [status, setStatus] = useState<CollectorStatus>();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [settled, setSettled] = useState<SettledGroupSnapshot>();
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSnapshot, nextSettled] = await Promise.all([
        collectorApi.status(),
        collectorApi.snapshot(),
        collectorApi.settledGroups(range),
      ]);
      setStatus(nextStatus);
      setSnapshot(nextSnapshot);
      setSettled(nextSettled);
      setError(undefined);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, [range]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 90);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/v1/events");
    events.addEventListener("status", (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent<string>).data) as CollectorStatus);
      } catch {
        scheduleRefresh();
      }
    });
    events.addEventListener("invalidate", scheduleRefresh);
    events.onerror = () => setError("Live updates disconnected; retrying automatically");
    return () => {
      events.close();
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  return { status, snapshot, settled: settled?.range === range ? settled : undefined, error, refresh };
}

function StatusPills({
  status,
  snapshot,
  settled,
}: {
  status?: CollectorStatus;
  snapshot?: ActivitySnapshot;
  settled?: SettledGroupSnapshot;
}) {
  const tasks = status?.sources.find((item) => item.source === "tasks");
  const sessions = status?.sources.find((item) => item.source === "sessions");
  const events = status?.sources.find((item) => item.source === "events");
  const allLive = status?.sources.every((item) => item.state === "live");
  return (
    <div className="truth-pills" aria-label="Collector truth status">
      <span className={`truth-pill ${status?.gateway.connected ? "good" : "bad"}`}>
        <i /> Transport {status?.gateway.connected ? "connected" : "offline"}
      </span>
      <span className={`truth-pill ${status?.syncState === "live" ? "good" : status?.syncState === "reconciling" ? "warn" : "bad"}`}>
        <i /> Snapshot {status?.syncState === "live" ? "fresh" : statusLabel(status).toLowerCase()}
      </span>
      <span className={`truth-pill ${allLive ? "good" : "warn"}`} title={[tasks, sessions, events].filter(Boolean).map((item) => `${item!.source}: ${item!.state}`).join(" · ")}>
        <i /> Coverage {allLive ? "complete" : "partial"}
      </span>
      {settled && !settled.complete ? <span className="truth-pill warn"><i /> Settled partial coverage</span> : null}
      {snapshot && snapshot.summary.unresolved > 0 ? <span className="truth-pill warn"><i /> {snapshot.summary.unresolved} unresolved</span> : null}
    </div>
  );
}

function RangeSelector({ value, onChange }: { value: SettledRange; onChange: (value: SettledRange) => void }) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => { if (isSettledRange(next)) onChange(next); }}
      className="flex h-[34px] items-center gap-0.5 rounded-[11px] bg-black/[0.07] p-[3px]"
      aria-label="Settled time range"
    >
      {SETTLED_RANGES.map((range) => (
        <ToggleGroup.Item
          key={range}
          value={range}
          className="h-7 rounded-lg px-2.5 text-[10px] font-semibold text-neutral-500 transition-colors hover:text-neutral-900 data-[state=on]:bg-white data-[state=on]:text-neutral-950 data-[state=on]:shadow-sm"
        >
          {range}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

function ActivityCard({ item, selected, onSelect }: { item: ActivityItem; selected: boolean; onSelect: () => void }) {
  const classes = ["activity-card", item.stage, item.state, `outcome-${item.outcome}`, item.attention !== "none" ? `attention-${item.attention}` : "", selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} data-activity-id={item.id} onClick={onSelect} aria-pressed={selected} title={`${item.title} · ${outcomeLabel(item)}`}>
      <span className="status-dot" />
      <span className="activity-title">{item.title}</span>
      <span className="activity-meta">{item.kind === "task" ? "TASK" : "ATTEMPT"} · {outcomeLabel(item)}</span>
      {item.lastToolName ? <span className="activity-tool">{item.lastToolName}</span> : null}
    </button>
  );
}

function useSettledCellLayout() {
  const cellRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [layout, setLayout] = useState<CellLayout>({ mode: "standard", capacity: 4 });

  useEffect(() => {
    const element = cellRef.current;
    if (!element) return;
    setLayout(initialCellLayout(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (!width) return;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setLayout((current) => nextCellLayout(width, current)), 300);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);
  return { cellRef, layout };
}

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
      {layout.mode === "wide" ? <span className="series-confidence">Same displayed title · {formatDateTime(group.latestEndedAt)}</span> : null}
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

function SettledCell({
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
  const { cellRef, layout } = useSettledCellLayout();
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

type AgentBoardRow = {
  agentId: string;
  items: ActivityItem[];
  groups: SettledGroupSummary[];
};

function FlowBoard({
  items,
  settled,
  range,
  kind,
  query,
  selectedId,
  selectedSeriesKey,
  onSelectActivity,
  onSelectSeries,
  onSelectOverflow,
}: {
  items: ActivityItem[];
  settled?: SettledGroupSnapshot;
  range: SettledRange;
  kind: KindFilter;
  query: string;
  selectedId?: string;
  selectedSeriesKey?: string;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
}) {
  const lowered = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const byAgent = new Map<string, AgentBoardRow>();
    for (const item of items) {
      const row = byAgent.get(item.agentId) ?? { agentId: item.agentId, items: [], groups: [] };
      row.items.push(item);
      byAgent.set(item.agentId, row);
    }
    for (const [agentId, candidates] of Object.entries(settled?.groupsByAgent ?? {})) {
      const groups = candidates.filter((group) => {
        if (kind !== "all" && group.kind !== kind) return false;
        return !lowered || `${group.title} ${group.agentId}`.toLowerCase().includes(lowered);
      });
      if (groups.length === 0) continue;
      const row = byAgent.get(agentId) ?? { agentId, items: [], groups: [] };
      row.groups = groups;
      byAgent.set(agentId, row);
    }
    return [...byAgent.values()].sort((left, right) => {
      const leftAttention = left.items.filter((item) => item.attention !== "none").length;
      const rightAttention = right.items.filter((item) => item.attention !== "none").length;
      return rightAttention - leftAttention
        || right.items.length + right.groups.length - (left.items.length + left.groups.length)
        || left.agentId.localeCompare(right.agentId);
    });
  }, [items, settled, kind, lowered]);

  const seriesCount = rows.reduce((total, row) => total + row.groups.length, 0);
  const settledRunCount = rows.reduce((total, row) => total + row.groups.reduce((subtotal, group) => subtotal + group.runCount, 0), 0);
  const densitySignal = items.length + seriesCount;
  const density = densitySignal <= 12 ? "focus" : densitySignal <= 70 ? "board" : densitySignal <= 260 ? "dense" : "radar";

  if (rows.length === 0) {
    return (
      <div className="board-empty">
        <div className="empty-orbit"><span /></div>
        <strong>{settled ? "No activity matches this view" : "Loading observed activity"}</strong>
        <p>The board is built from Gateway task and session observations. No demo records are mixed into this view.</p>
      </div>
    );
  }

  return (
    <div className={`flow-table density-${density}`}>
      <div className="flow-head agent-head">AGENT FLOW</div>
      {OPERATIONAL_STAGES.map((stage) => (
        <div className="flow-head" key={stage.key}>
          <span>{stage.label}</span><b>{stage.arrow}</b><small>{stage.hint}</small>
        </div>
      ))}
      <div className="flow-head settled-head">
        <span>SETTLED · {settled?.totalSeries ?? "—"} series · {settled?.totalRuns ?? "—"} runs · {range}</span>
        <b>→</b>
        <small>{settled?.complete === false ? "partial coverage" : "grouped terminal work"}</small>
      </div>
      {rows.map(({ agentId, items: agentItems, groups }) => {
        const activeCount = agentItems.filter((item) => item.state === "active").length;
        const groupRunCount = groups.reduce((total, group) => total + group.runCount, 0);
        return (
          <div className="lane-row" key={agentId}>
            <div className="agent-cell">
              <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agentId) % AGENT_COLORS.length] }}>{shortAgent(agentId)}</span>
              <span className="agent-copy">
                <b>{agentId}</b>
                <small>{activeCount} active · {groups.length} series / {groupRunCount} runs</small>
              </span>
              <span className="agent-count">{agentItems.length + groups.length}</span>
            </div>
            {OPERATIONAL_STAGES.map((stage) => {
              const stageItems = agentItems.filter((item) => item.stage === stage.key || (stage.key === "waiting" && item.stage === "unresolved"));
              return (
                <div className={`stage-cell stage-${stage.key}`} key={stage.key}>
                  {stageItems.map((item) => <ActivityCard key={item.id} item={item} selected={item.id === selectedId} onSelect={() => onSelectActivity(item.id)} />)}
                </div>
              );
            })}
            <SettledCell
              groups={groups}
              range={range}
              selectedSeriesKey={selectedSeriesKey}
              matching={Boolean(lowered)}
              onOpenSeries={onSelectSeries}
              onOpenOverflow={(hiddenGroups) => onSelectOverflow(agentId, hiddenGroups)}
            />
          </div>
        );
      })}
      <aside className="fleet-map" aria-label="Fleet stage distribution">
        <h4>FLEET<br />MAP</h4>
        <div className="fleet-map-rows">
          {rows.map(({ agentId, items: agentItems, groups }) => {
            const total = Math.max(1, agentItems.length + groups.length);
            return (
              <div className="fleet-map-row" key={agentId} title={agentId}>
                <span style={{ flex: agentItems.filter((item) => item.stage === "incoming").length / total }} />
                <span style={{ flex: agentItems.filter((item) => item.stage === "in_flight").length / total }} />
                <span style={{ flex: agentItems.filter((item) => item.stage === "waiting" || item.stage === "unresolved").length / total }} />
                <span style={{ flex: groups.length / total }} />
              </div>
            );
          })}
        </div>
      </aside>
      <div className="flow-footer">
        <span className="mini-live" /> Auto density · {density}
        <span>{items.length} operational · {seriesCount} settled series / {settledRunCount} runs · {range}</span>
        <span className="flow-footer-push">Full-range server aggregation</span>
      </div>
    </div>
  );
}

function DialogFrame({
  title,
  eyebrow,
  onClose,
  children,
  widthClass = "max-w-[720px]",
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div className="dialog-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.section
            className={`series-dialog fixed left-1/2 top-1/2 z-[130] w-[calc(100vw-32px)] ${widthClass} -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] border border-black/10 bg-white/95 shadow-2xl outline-none backdrop-blur-2xl`}
            initial={{ opacity: 0, scale: 0.985, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <header className="dialog-head">
              <div>
                <span className="eyebrow">{eyebrow}</span>
                <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
              </div>
              <Dialog.Close asChild><button className="icon-button" aria-label="Close">×</button></Dialog.Close>
            </header>
            {children}
          </motion.section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SeriesRunDialog({
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
  const viewportHeight = Math.min(360, Math.max(120, filteredRuns.length * rowHeight));
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
          style={{ height: viewportHeight }}
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
                <time>{formatDateTime(run.terminalAt)}</time>
              </button>
            ))}
          </div>
          {filteredRuns.length === 0 ? <div className="dialog-loading">No runs match this outcome.</div> : null}
        </div>
      ) : null}
    </DialogFrame>
  );
}

function OverflowDialog({
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

function Inspector({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    void collectorApi.detail(id).then((value) => { if (live) setDetail(value); }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [id]);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div className="inspector-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.aside className="inspector" aria-label="Activity inspector" initial={{ opacity: 0, x: 28, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ duration: 0.22, ease: "easeOut" }}>
            <div className="inspector-head">
              <div><span className="eyebrow">ACTIVITY INSPECTOR</span><Dialog.Title asChild><h2>{detail?.item.title ?? "Loading activity…"}</h2></Dialog.Title></div>
              <Dialog.Close asChild><button className="icon-button" aria-label="Close inspector">×</button></Dialog.Close>
            </div>
            {error ? <div className="inline-error">{error}</div> : null}
            {detail ? (
              <>
                <section className="inspector-now">
                  <div className={`large-state ${detail.item.attention !== "none" ? "attention" : ""}`}><span />{detail.item.stage.replaceAll("_", " ")}</div>
                  <p>{detail.item.progressSummary ?? (detail.item.lastToolName ? `Using ${detail.item.lastToolName}` : outcomeLabel(detail.item))}</p>
                  <div className="now-grid"><span>State<b>{detail.item.state}</b></span><span>Phase<b>{detail.item.phase}</b></span><span>Outcome<b>{detail.item.outcome}</b></span></div>
                </section>
                <InspectorSection title="OBSERVATION EVIDENCE">
                  <div className="evidence-list">
                    {detail.item.evidence.map((evidence) => <div key={evidence.source}><span className={`evidence-dot ${evidence.health}`} /><b>{evidence.source}</b><span>{evidence.health.replaceAll("_", " ")}</span><time>{formatRelative(evidence.observedAt)}</time></div>)}
                  </div>
                </InspectorSection>
                <InspectorSection title="IDENTITY">
                  <dl className="identity-grid">
                    <div><dt>Activity</dt><dd>{detail.item.id}</dd></div>
                    <div><dt>Kind</dt><dd>{detail.item.kind}</dd></div>
                    {Object.entries(detail.identity).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                  </dl>
                </InspectorSection>
                <InspectorSection title="TIMELINE">
                  <div className="timeline">
                    {detail.timeline.length === 0 ? <p className="muted">No state transition has been retained yet.</p> : detail.timeline.map((entry) => <div className="timeline-entry" key={entry.id}><span /><div><b>{entry.kind}</b><small>{entry.toolName ?? entry.status ?? entry.phase ?? entry.source}</small></div><time>{formatTime(entry.occurredAt)}</time></div>)}
                  </div>
                </InspectorSection>
                <InspectorSection title="RELATIONSHIPS">
                  {detail.relations.length === 0 ? <p className="muted">No exact or correlation-only relation observed.</p> : detail.relations.map((relation) => <div className="relation-line" key={`${relation.type}:${relation.from}:${relation.to}`}><span>{relation.label}</span><b>{relation.certainty.replaceAll("_", " ")}</b></div>)}
                </InspectorSection>
              </>
            ) : null}
          </motion.aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

function RelationsView({ snapshot, onSelect }: { snapshot?: ActivitySnapshot; onSelect: (id: string) => void }) {
  const itemsById = new Map(snapshot?.items.map((item) => [item.id, item]) ?? []);
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">OBSERVED LINKS</span><h1>Relations</h1></div><span className="count-chip">{snapshot?.relations.length ?? 0} links</span></div>
      <div className="relation-cards">
        {snapshot?.relations.map((relation) => {
          const from = itemsById.get(relation.from);
          const to = itemsById.get(relation.to);
          return <button key={`${relation.type}:${relation.from}:${relation.to}`} onClick={() => onSelect(to?.id ?? relation.to)}><span className="relation-kind">{relation.type.replaceAll("_", " ")}</span><b>{from?.title ?? relation.from}</b><i>→</i><b>{to?.title ?? relation.to}</b><small>{relation.certainty.replaceAll("_", " ")}</small></button>;
        })}
        {snapshot?.relations.length === 0 ? <div className="simple-empty">Relations appear when Task and Attempt records share a run reference or parent identity.</div> : null}
      </div>
    </section>
  );
}

function ArchiveView({ items, onSelect }: { items: ActivityItem[]; onSelect: (id: string) => void }) {
  const terminal = items.filter((item) => item.state === "terminal").sort((left, right) => (right.endedAt ?? right.updatedAt) - (left.endedAt ?? left.updatedAt));
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">RECENT TERMINAL HISTORY</span><h1>Archive</h1></div><span className="count-chip">{terminal.length} retained</span></div>
      <div className="archive-table">
        <div className="archive-head"><span>Activity</span><span>Agent</span><span>Kind</span><span>Outcome</span><span>Terminal time</span></div>
        {terminal.map((item) => <button key={item.id} onClick={() => onSelect(item.id)}><span><i className={`archive-state outcome-${item.outcome}`} />{item.title}</span><span>{item.agentId}</span><span>{item.kind}</span><span>{item.outcome}</span><span>{formatRelative(item.endedAt ?? item.updatedAt)}</span></button>)}
        {terminal.length === 0 ? <div className="simple-empty">No terminal activity has been observed yet.</div> : null}
      </div>
    </section>
  );
}

function ConnectionsView({ status }: { status?: CollectorStatus }) {
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">READ-ONLY INPUTS</span><h1>Connections</h1></div><span className={`count-chip ${status?.gateway.connected ? "connected" : ""}`}>{status?.gateway.connected ? "Connected" : "Offline"}</span></div>
      <div className="gateway-panel">
        <div className="gateway-main"><span className={`gateway-orb ${status?.gateway.connected ? "live" : ""}`} /><div><small>OPENCLAW GATEWAY</small><h2>{status?.gateway.name ?? "Gateway"}</h2><p>{status?.gateway.endpoint ?? "Endpoint unavailable"}</p></div><dl><div><dt>Version</dt><dd>{status?.gateway.serverVersion ?? "—"}</dd></div><div><dt>Protocol</dt><dd>{status?.gateway.protocolVersion ?? "—"}</dd></div><div><dt>Scope</dt><dd>{status?.gateway.grantedScopes.join(", ") || "—"}</dd></div></dl></div>
        <div className="coverage-grid">
          {status?.sources.map((item) => <article key={item.source}><span className={`coverage-icon ${coverageTone(item)}`}><i /></span><div><small>{item.source.toUpperCase()}</small><h3>{item.state}</h3><p>{item.code ?? (item.lastSnapshotAt ? `Snapshot ${formatRelative(item.lastSnapshotAt)}` : item.lastEventAt ? `Event ${formatRelative(item.lastEventAt)}` : "Awaiting first observation")}</p></div></article>)}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const [range, setRange] = useState<SettledRange>(initialSettledRange);
  const { status, snapshot, settled, error, refresh } = useCollector(range);
  const [view, setView] = useState<View>("live");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSeriesKey, setSelectedSeriesKey] = useState<string>();
  const [overflow, setOverflow] = useState<{ agentId: string; groups: SettledGroupSummary[] }>();

  useEffect(() => {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, range);
    } catch {
      // Local preference persistence is best effort.
    }
  }, [range]);

  const visibleOperationalItems = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return (snapshot?.items ?? []).filter((item) => {
      if (item.state === "terminal" || item.stage === "settled") return false;
      if (kind !== "all" && item.kind !== kind) return false;
      return !lowered || `${item.title} ${item.agentId} ${item.lastToolName ?? ""}`.toLowerCase().includes(lowered);
    });
  }, [snapshot, kind, query]);

  const selectedGroup = useMemo(
    () => Object.values(settled?.groupsByAgent ?? {}).flat().find((group) => group.seriesKey === selectedSeriesKey),
    [settled, selectedSeriesKey],
  );
  const active = snapshot?.items.filter((item) => item.catalog === "operational").length ?? 0;
  const waiting = snapshot?.items.filter((item) => item.stage === "waiting" || item.stage === "unresolved").length ?? 0;
  const agentCount = new Set([
    ...(snapshot?.items.filter((item) => item.state !== "terminal").map((item) => item.agentId) ?? []),
    ...Object.keys(settled?.groupsByAgent ?? {}),
  ]).size;

  const changeRange = (next: SettledRange) => {
    setRange(next);
    setSelectedSeriesKey(undefined);
    setOverflow(undefined);
  };
  const openItem = (id: string) => {
    setSelectedSeriesKey(undefined);
    setOverflow(undefined);
    setSelectedId(id);
  };
  const openSeries = (seriesKey: string) => {
    setSelectedId(undefined);
    setOverflow(undefined);
    setSelectedSeriesKey(seriesKey);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("live")}><span className="mark">AR</span><span>AR Kanban</span></button>
        <nav aria-label="Primary">
          {(["live", "relations", "archive", "connections"] as View[]).map((item) => <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>{({ live: "Live flow", relations: "Relations", archive: "Archive", connections: "Connections" } as const)[item]}</button>)}
        </nav>
        <button className={`gateway-button ${status?.gateway.connected ? "live" : ""}`} onClick={() => setView("connections")}><span />{status?.gateway.name ?? "Gateway"}<small>{statusLabel(status)}</small></button>
      </header>

      {view === "live" ? (
        <>
          <section className="summary-bar">
            <div className="summary-copy">
              <span className="eyebrow">LIVE ACTIVITY</span>
              <h1>{status?.syncState === "live" ? (active > 0 ? "Activity is flowing" : "Collector is watching") : statusLabel(status)}</h1>
              <div className="metrics">
                <span><b>{active}</b> operational</span>
                <span className="wait"><b>{waiting}</b> waiting / unresolved</span>
                <span><b>{settled?.totalSeries ?? "—"}</b> settled series</span>
                <span><b>{settled?.totalRuns ?? "—"}</b> runs · {range}</span>
                <span><b>{agentCount}</b> agents</span>
              </div>
            </div>
            <div className="summary-actions">
              <StatusPills status={status} snapshot={snapshot} settled={settled} />
              <div className="filters">
                <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity or series" aria-label="Search activity" /></label>
                <div className="segmented" aria-label="Activity kind"><button aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button><button aria-pressed={kind === "task"} onClick={() => setKind("task")}>Tasks</button><button aria-pressed={kind === "attempt"} onClick={() => setKind("attempt")}>Attempts</button></div>
                <RangeSelector value={range} onChange={changeRange} />
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
                settled={settled}
                range={range}
                kind={kind}
                query={query}
                selectedId={selectedId}
                selectedSeriesKey={selectedSeriesKey}
                onSelectActivity={openItem}
                onSelectSeries={openSeries}
                onSelectOverflow={(agentId, groups) => setOverflow({ agentId, groups })}
              />
            </section>
          </main>
        </>
      ) : (
        <main className="content-shell">
          {view === "relations" ? <RelationsView snapshot={snapshot} onSelect={openItem} /> : null}
          {view === "archive" ? <ArchiveView items={snapshot?.items ?? []} onSelect={openItem} /> : null}
          {view === "connections" ? <ConnectionsView status={status} /> : null}
        </main>
      )}

      {overflow ? (
        <OverflowDialog
          agentId={overflow.agentId}
          groups={overflow.groups}
          range={range}
          onClose={() => setOverflow(undefined)}
          onOpenSeries={openSeries}
        />
      ) : null}
      {selectedGroup ? (
        <SeriesRunDialog
          group={selectedGroup}
          range={range}
          onClose={() => setSelectedSeriesKey(undefined)}
          onOpenActivity={openItem}
        />
      ) : null}
      {selectedId ? <Inspector id={selectedId} onClose={() => setSelectedId(undefined)} /> : null}
    </div>
  );
}

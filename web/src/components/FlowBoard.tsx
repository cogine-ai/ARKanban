import * as Dialog from "@radix-ui/react-dialog";
import { useId, useMemo, useState } from "react";
import type { ActivityItem, CollectorStatus, SettledGroupSnapshot, SettledGroupSummary, SettledRange, UpcomingSchedule, UpcomingScheduleSnapshot } from "../../../src/contracts";
import { AGENT_COLORS, type KindFilter } from "../lib/board";
import { activityIdentity, buildFlowBoardModel, currentPreview, displayedAgent, isAwaitingApproval, isUnconfirmed, pageOf } from "../lib/flow-board-model";
import { formatExact, formatHourMinute, formatScheduleRelative, hash, localZoneLabel, scheduleLabel, shortAgent } from "../lib/format";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { DialogFrame } from "./DialogFrame";
import { RangeSelector } from "./RangeSelector";
import { SettledCell } from "./SettledCell";
import "./flow-board.css";

type Collection = { type: "running" | "queued"; laneKey: string } | { type: "attention" | "unconfirmed" | "schedules" };
type FlowBoardProps = {
  items: ActivityItem[];
  schedules: UpcomingSchedule[];
  scheduleState?: UpcomingScheduleSnapshot;
  settled?: SettledGroupSnapshot;
  range: SettledRange;
  kind: KindFilter;
  query: string;
  selectedId?: string;
  selectedSeriesKey?: string;
  status?: CollectorStatus;
  loading?: boolean;
  paused?: boolean;
  onRangeChange?: (range: SettledRange) => void;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
  /** Existing callers stay compatible; queue and forecast overflow now have separate lists. */
  onOpenIncomingOverflow: (agentId: string, queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
};

function activityLabel(item: ActivityItem): string {
  if (isUnconfirmed(item)) {
    if (item.freshness === "stale" || item.attention === "stale") return "Stale observation";
    if (item.attention === "partial") return "Incomplete observation";
    return "State unknown";
  }
  if (isAwaitingApproval(item)) return item.phase === "waiting_approval" ? "Waiting approval" : "Waiting";
  if (item.state === "queued") return "In queue";
  if (item.phase === "tool" && item.lastToolName) return item.lastToolName;
  if (item.phase === "planning") return "Planning";
  if (item.phase === "model") return "Model response";
  if (item.phase === "starting") return "Starting";
  return "In progress";
}

function CurrentCard({ item, selected, live, identity, onSelect }: {
  item: ActivityItem; selected: boolean; live: boolean; identity?: string; onSelect: () => void;
}) {
  const unconfirmed = isUnconfirmed(item);
  const waiting = isAwaitingApproval(item);
  const tone = unconfirmed ? "unconfirmed" : waiting ? "approval" : item.state === "queued" ? "queued" : "running";
  return (
    <button className={`lfb-card lfb-card-${tone}`} onClick={onSelect} aria-pressed={selected}
      data-activity-id={item.id} data-host-id={item.hostId} data-kind={item.kind} data-observed-state={item.state} title={item.title}>
      <span className={`lfb-state lfb-state-${tone}`} aria-hidden="true" data-live={live && tone === "running"}>
        {unconfirmed ? "?" : waiting ? "Ⅱ" : item.state === "queued" ? "◷" : ""}
      </span>
      <span className="lfb-card-copy">
        <strong>{item.title}</strong>
        <span className="lfb-card-meta"><span className={`lfb-kind lfb-kind-${item.kind}`}>{item.kind === "task" ? "Task" : "Attempt"}</span>{identity ? <span>{identity}</span> : null}</span>
        <span className="lfb-card-state">{!live && !unconfirmed && item.state === "active" ? "Last observed · " : ""}{activityLabel(item)}</span>
      </span>
    </button>
  );
}

function ScheduleEntry({ schedule, hostLabel, now }: { schedule: UpcomingSchedule; hostLabel: string; now: number }) {
  return (
    <li className="lfb-schedule-entry" data-schedule-id={schedule.id}>
      <span className="lfb-schedule-clock" aria-hidden="true">◷</span>
      <div>
        <time dateTime={new Date(schedule.nextRunAt).toISOString()} title={formatExact(schedule.nextRunAt)}>{formatHourMinute(schedule.nextRunAt)}</time>
        <strong>{schedule.title}</strong>
        <span>{displayedAgent(schedule.hostId, schedule.agentId)} · {hostLabel}</span>
        <small>{formatScheduleRelative(schedule.nextRunAt, now)} · Scheduled</small>
      </div>
    </li>
  );
}

export function FlowBoard({
  items, schedules, scheduleState, settled, range, kind, query, selectedId, selectedSeriesKey,
  status, loading = false, paused = false, onRangeChange, onSelectActivity, onSelectSeries, onSelectOverflow,
}: FlowBoardProps) {
  const model = useMemo(() => buildFlowBoardModel(items, schedules, settled, kind, query), [items, schedules, settled, kind, query]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [collection, setCollection] = useState<Collection>();
  const [collectionPage, setCollectionPage] = useState(0);
  const [lanePage, setLanePage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const historyId = useId();
  const now = useScheduleNow();
  const hostLabels = useMemo(() => new Map([
    ...(status?.host ? [[status.host.id, status.host.label] as const] : []),
    ...(status?.hosts ?? []).map((host) => [host.id, host.label] as const),
  ]), [status]);
  const hostLabel = (hostId: string) => hostLabels.get(hostId) ?? hostId;
  const itemLive = (item: ActivityItem) => {
    if (paused || item.freshness !== "live") return false;
    const host = status?.hosts?.find((entry) => entry.id === item.hostId);
    return host ? host.reachable && host.syncState === "live" : !status || status.syncState === "live";
  };
  const selectActivity = (id: string) => { setCollection(undefined); onSelectActivity(id); };
  const openCollection = (next: Collection) => { setCollectionPage(0); setCollection(next); };
  const lanePageData = pageOf(model.lanes, lanePage, 8);
  const historyPageData = pageOf(model.history, historyPage, 8);
  const currentCount = model.lanes.reduce((count, lane) => count + lane.running.length + lane.queued.length, 0);
  const activeLane = collection && "laneKey" in collection ? model.lanes.find((lane) => lane.key === collection.laneKey) : undefined;
  const collectionActivities = collection?.type === "attention" ? model.attention
    : collection?.type === "unconfirmed" ? model.unconfirmed
    : collection?.type === "running" ? activeLane?.running ?? []
    : collection?.type === "queued" ? activeLane?.queued ?? [] : [];
  const activityPageData = pageOf(collectionActivities, collectionPage);
  const schedulePageData = pageOf(model.schedules, collectionPage);
  const collectionTitle = collection?.type === "schedules" ? "Next hour"
    : collection?.type === "attention" ? "Needs attention"
    : collection?.type === "unconfirmed" ? "Unconfirmed state"
    : activeLane ? `${displayedAgent(activeLane.hostId, activeLane.agentId)} · ${hostLabel(activeLane.hostId)}` : "Current activity";
  const collectionCount = collection?.type === "schedules" ? model.schedules.length : collectionActivities.length;
  const hasData = model.operationalCount + model.schedules.length + model.seriesCount > 0;

  return (
    <div className={`live-flow-board${model.attention.length ? " lfb-has-attention" : ""}${model.unconfirmed.length ? " lfb-has-unconfirmed" : ""}`} data-current-records={model.operationalCount}>
      {model.attention.length > 0 ? (
        <section className="lfb-attention" aria-label="Needs attention">
          <header className="lfb-section-heading">
            <h2><span className="lfb-heading-symbol lfb-heading-warning" aria-hidden="true">!</span>Needs attention <span>{model.attention.length}</span></h2>
            <button className="lfb-text-button" onClick={() => openCollection({ type: "attention" })}>View all <span aria-hidden="true">↗</span></button>
          </header>
          <div className="lfb-attention-cards">
            {currentPreview(model.attention, 3, selectedId).visible.map((item) => <CurrentCard key={activityIdentity(item)} item={item} selected={item.id === selectedId} live={itemLive(item)} identity={`${displayedAgent(item.hostId, item.agentId)} · ${hostLabel(item.hostId)}`} onSelect={() => selectActivity(item.id)} />)}
          </div>
        </section>
      ) : null}

      <div className={`lfb-workspace${kind !== "all" ? " lfb-without-schedules" : ""}`}>
        <section className="lfb-current" aria-label="Current activity by Agent">
          <div className="lfb-lane-head" aria-hidden="true"><span>Agent</span><span>In progress</span><span>Queued</span></div>
          <div className="lfb-lanes">
            {lanePageData.entries.map((lane) => {
              const running = currentPreview(lane.running, 2, selectedId);
              const queued = currentPreview(lane.queued, 1, selectedId);
              const agentLabel = displayedAgent(lane.hostId, lane.agentId);
              return (
                <section className="lfb-lane" key={lane.key} aria-label={`${agentLabel} · ${hostLabel(lane.hostId)}`}>
                  <div className="lfb-agent">
                    <span className="lfb-avatar" style={{ background: AGENT_COLORS[hash(lane.key) % AGENT_COLORS.length] }} aria-hidden="true">{shortAgent(agentLabel)}</span>
                    <span><strong>{agentLabel}</strong><small>{hostLabel(lane.hostId)}</small><small>{lane.running.length + lane.queued.length} records</small></span>
                  </div>
                  <div className="lfb-current-cell lfb-running-cell" aria-label={`${lane.running.length} in progress`}>
                    {running.visible.map((item) => <CurrentCard key={activityIdentity(item)} item={item} selected={item.id === selectedId} live={itemLive(item)} onSelect={() => selectActivity(item.id)} />)}
                    {running.hiddenCount > 0 ? <button className="lfb-more" onClick={() => openCollection({ type: "running", laneKey: lane.key })} aria-label={`View all ${lane.running.length} in-progress records for ${agentLabel} on ${hostLabel(lane.hostId)}`}>+{running.hiddenCount}</button> : null}
                    {lane.running.length === 0 ? <span className="lfb-cell-empty" aria-hidden="true">—</span> : null}
                  </div>
                  <div className="lfb-current-cell lfb-queued-cell" aria-label={`${lane.queued.length} queued`}>
                    {queued.visible.map((item) => <CurrentCard key={activityIdentity(item)} item={item} selected={item.id === selectedId} live={itemLive(item)} onSelect={() => selectActivity(item.id)} />)}
                    {queued.hiddenCount > 0 ? <button className="lfb-more" onClick={() => openCollection({ type: "queued", laneKey: lane.key })} aria-label={`View all ${lane.queued.length} queued records for ${agentLabel} on ${hostLabel(lane.hostId)}`}>+{queued.hiddenCount}</button> : null}
                    {lane.queued.length === 0 ? <span className="lfb-cell-empty" aria-hidden="true">—</span> : null}
                  </div>
                </section>
              );
            })}
            {model.lanes.length === 0 ? (
              <div className={`lfb-current-empty${loading ? " lfb-loading" : ""}`} role="status">
                <span className="lfb-empty-symbol" aria-hidden="true">{loading ? "◌" : "—"}</span>
                <strong>{loading ? "Loading activity" : query.trim() || kind !== "all" ? "No matching current records" : model.unconfirmed.length > 0 ? "Current state unconfirmed" : "No current activity"}</strong>
              </div>
            ) : null}
          </div>
          {lanePageData.pageCount > 1 ? <Pagination page={lanePageData.page} pageCount={lanePageData.pageCount} onChange={setLanePage} label="Agent lanes" /> : null}
        </section>

        {kind === "all" ? (
          <aside className={`lfb-schedules${scheduleOpen ? " lfb-schedules-expanded" : ""}`} aria-label="Scheduled forecast for the next hour">
            <header className="lfb-section-heading"><h2><span aria-hidden="true">◷</span>Next hour <span>{scheduleState ? model.schedules.length : "—"}</span></h2><button className="lfb-schedule-toggle" aria-expanded={scheduleOpen} onClick={() => setScheduleOpen((open) => !open)} aria-label={scheduleOpen ? "Collapse schedule forecast" : "Expand schedule forecast"}>{scheduleOpen ? "⌃" : "⌄"}</button></header>
            <div className="lfb-schedule-body">
              <span className="lfb-schedule-health">{scheduleLabel(scheduleState)}</span>
              <ol className="lfb-schedule-list">
                {model.schedules.slice(0, 4).map((schedule) => <ScheduleEntry key={JSON.stringify([schedule.hostId, schedule.id])} schedule={schedule} hostLabel={hostLabel(schedule.hostId)} now={now} />)}
              </ol>
              {model.schedules.length > 4 ? <button className="lfb-text-button lfb-schedule-more" onClick={() => openCollection({ type: "schedules" })}>View all {model.schedules.length} schedules <span aria-hidden="true">↗</span></button> : null}
              {model.schedules.length === 0 ? <div className="lfb-schedule-empty">{scheduleState?.state === "live" ? query.trim() ? "No matching schedules" : "No schedules in this hour" : "No forecast available"}</div> : null}
              <small className="lfb-zone">{localZoneLabel()}</small>
            </div>
          </aside>
        ) : null}
      </div>

      {model.unconfirmed.length > 0 ? <button className="lfb-unconfirmed-row" onClick={() => openCollection({ type: "unconfirmed" })}><span className="lfb-heading-symbol" aria-hidden="true">?</span><strong>Unconfirmed state</strong><span>{model.unconfirmed.length}</span><span className="lfb-chevron" aria-hidden="true">›</span></button> : null}

      <section className="lfb-history" aria-label="Finished activity">
        <div className="lfb-history-heading">
          <button className="lfb-history-toggle" onClick={() => setHistoryOpen((open) => !open)} aria-expanded={historyOpen} aria-controls={historyId}><span className={`lfb-fold${historyOpen ? " lfb-fold-open" : ""}`} aria-hidden="true">›</span><strong>Finished</strong><span>{settled ? `${model.runCount} runs · ${model.seriesCount} series` : "History loading"}</span></button>
          {onRangeChange ? <RangeSelector value={range} onChange={onRangeChange} /> : <span className="lfb-history-range">{range}</span>}
          <div className="lfb-outcomes" aria-label="Finished outcome counts">
            <OutcomeCount symbol="✓" label="Succeeded" count={settled ? model.outcomes.succeeded : undefined} tone="success" />
            <OutcomeCount symbol="!" label="Failed" count={settled ? model.outcomes.failed : undefined} tone="error" />
            <OutcomeCount symbol="◷" label="Timed out" count={settled ? model.outcomes.timedOut : undefined} tone="error" />
            <OutcomeCount symbol="■" label="Blocked" count={settled ? model.outcomes.blocked : undefined} />
            <OutcomeCount symbol="⊘" label="Cancelled" count={settled ? model.outcomes.cancelled : undefined} />
            <OutcomeCount symbol="?" label="Unknown" count={settled ? model.outcomes.unknown : undefined} />
          </div>
          {settled?.complete === false ? <span className="lfb-partial">Partial coverage</span> : null}
        </div>
        {historyOpen ? <div id={historyId} className="lfb-history-body">
          {historyPageData.entries.map((lane) => <div className="lfb-history-lane" key={lane.key}><div className="lfb-history-agent"><strong>{displayedAgent(lane.hostId, lane.agentId)}</strong><span>{hostLabel(lane.hostId)}</span></div><SettledCell groups={lane.groups} range={range} selectedSeriesKey={selectedSeriesKey} matching={Boolean(query.trim())} onOpenSeries={onSelectSeries} onOpenOverflow={(groups) => onSelectOverflow(`${displayedAgent(lane.hostId, lane.agentId)} · ${hostLabel(lane.hostId)}`, groups)} /></div>)}
          {model.history.length === 0 ? <div className="lfb-history-empty">{settled ? query.trim() || kind !== "all" ? "No matching finished records" : "No finished records in this range" : "Loading finished records"}</div> : null}
          {historyPageData.pageCount > 1 ? <Pagination page={historyPageData.page} pageCount={historyPageData.pageCount} onChange={setHistoryPage} label="History Agents" /> : null}
        </div> : <div id={historyId} hidden />}
      </section>
      {hasData ? <div className="lfb-record-count">{currentCount} current · {model.unconfirmed.length} unconfirmed · {model.schedules.length} scheduled</div> : null}

      {collection ? <DialogFrame title={collectionTitle} eyebrow={`${collectionCount} ${collection.type === "schedules" ? "SCHEDULES" : "RECORDS"}${collection.type === "running" ? " · IN PROGRESS" : collection.type === "queued" ? " · QUEUED" : ""}`} onClose={() => setCollection(undefined)} widthClass="max-w-[780px]">
        <Dialog.Description className="sr-only">Observed records in this view. Select a record to view its details.</Dialog.Description>
        <div className="live-flow-board lfb-collection">
          {collection.type === "schedules" ? <ol className="lfb-schedule-list">{schedulePageData.entries.map((schedule) => <ScheduleEntry key={JSON.stringify([schedule.hostId, schedule.id])} schedule={schedule} hostLabel={hostLabel(schedule.hostId)} now={now} />)}</ol>
            : <div className="lfb-collection-list">{activityPageData.entries.map((item) => <CurrentCard key={activityIdentity(item)} item={item} selected={item.id === selectedId} live={itemLive(item)} identity={`${displayedAgent(item.hostId, item.agentId)} · ${hostLabel(item.hostId)}`} onSelect={() => selectActivity(item.id)} />)}</div>}
          {collectionCount === 0 ? <div className="lfb-history-empty">No records remain in this view</div> : null}
          <Pagination page={collection.type === "schedules" ? schedulePageData.page : activityPageData.page} pageCount={collection.type === "schedules" ? schedulePageData.pageCount : activityPageData.pageCount} onChange={setCollectionPage} label="Records" />
        </div>
      </DialogFrame> : null}
    </div>
  );
}

function OutcomeCount({ symbol, label, count, tone = "neutral" }: { symbol: string; label: string; count?: number; tone?: string }) {
  return <span className={`lfb-outcome lfb-outcome-${count === undefined ? "neutral" : tone}`} aria-label={`${label}: ${count ?? "Not observed"}`}><b aria-hidden="true">{symbol}</b><span>{label} <strong>{count ?? "—"}</strong></span></span>;
}

function Pagination({ page, pageCount, onChange, label }: { page: number; pageCount: number; onChange: (page: number) => void; label: string }) {
  return <nav className="lfb-pagination" aria-label={`${label} pagination`}><button disabled={page === 0} onClick={() => onChange(page - 1)} aria-label={`Previous ${label.toLowerCase()} page`}>‹</button><span>{page + 1} / {pageCount}</span><button disabled={page + 1 >= pageCount} onClick={() => onChange(page + 1)} aria-label={`Next ${label.toLowerCase()} page`}>›</button></nav>;
}

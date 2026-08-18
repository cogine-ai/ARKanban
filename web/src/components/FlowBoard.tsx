import { useMemo } from "react";
import type {
  ActivityItem,
  SettledGroupSnapshot,
  SettledGroupSummary,
  SettledRange,
  UpcomingSchedule,
  UpcomingScheduleSnapshot,
} from "../../../src/contracts";
import { AGENT_COLORS, OPERATIONAL_STAGES, type AgentBoardRow, type KindFilter } from "../lib/board";
import { hash, incomingHeaderHint, shortAgent } from "../lib/format";
import { ActivityCard } from "./cards";
import { IncomingCell } from "./IncomingCell";
import { SettledCell } from "./SettledCell";

export function FlowBoard({
  items,
  schedules,
  scheduleState,
  settled,
  range,
  kind,
  query,
  selectedId,
  selectedSeriesKey,
  onSelectActivity,
  onSelectSeries,
  onSelectOverflow,
  onOpenIncomingOverflow,
}: {
  items: ActivityItem[];
  schedules: UpcomingSchedule[];
  scheduleState?: UpcomingScheduleSnapshot;
  settled?: SettledGroupSnapshot;
  range: SettledRange;
  kind: KindFilter;
  query: string;
  selectedId?: string;
  selectedSeriesKey?: string;
  onSelectActivity: (id: string) => void;
  onSelectSeries: (seriesKey: string) => void;
  onSelectOverflow: (agentId: string, groups: SettledGroupSummary[]) => void;
  onOpenIncomingOverflow: (agentId: string, queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
}) {
  const lowered = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const byAgent = new Map<string, AgentBoardRow>();
    for (const item of items) {
      const row = byAgent.get(item.agentId) ?? { agentId: item.agentId, items: [], schedules: [], groups: [] };
      row.items.push(item);
      byAgent.set(item.agentId, row);
    }
    for (const schedule of schedules) {
      const row = byAgent.get(schedule.agentId) ?? { agentId: schedule.agentId, items: [], schedules: [], groups: [] };
      row.schedules.push(schedule);
      byAgent.set(schedule.agentId, row);
    }
    for (const [agentId, candidates] of Object.entries(settled?.groupsByAgent ?? {})) {
      const groups = candidates.filter((group) => {
        if (kind !== "all" && group.kind !== kind) return false;
        return !lowered || `${group.title} ${group.agentId}`.toLowerCase().includes(lowered);
      });
      if (groups.length === 0) continue;
      const row = byAgent.get(agentId) ?? { agentId, items: [], schedules: [], groups: [] };
      row.groups = groups;
      byAgent.set(agentId, row);
    }
    return [...byAgent.values()].sort((left, right) => {
      const leftAttention = left.items.filter((item) => item.attention !== "none").length;
      const rightAttention = right.items.filter((item) => item.attention !== "none").length;
      return rightAttention - leftAttention
        || right.items.length + right.schedules.length + right.groups.length - (left.items.length + left.schedules.length + left.groups.length)
        || left.agentId.localeCompare(right.agentId);
    });
  }, [items, schedules, settled, kind, lowered]);

  const seriesCount = rows.reduce((total, row) => total + row.groups.length, 0);
  const settledRunCount = rows.reduce((total, row) => total + row.groups.reduce((subtotal, group) => subtotal + group.runCount, 0), 0);
  const queuedCount = items.filter((item) => item.stage === "incoming").length;
  const densitySignal = items.length + schedules.length + seriesCount;
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
          <span>{stage.label}</span><b>{stage.arrow}</b><small>{stage.key === "incoming" ? incomingHeaderHint(scheduleState, queuedCount, schedules.length) : stage.hint}</small>
        </div>
      ))}
      <div className="flow-head settled-head">
        <span>SETTLED · {settled?.totalSeries ?? "—"} series · {settled?.totalRuns ?? "—"} runs · {range}</span>
        <b>→</b>
        <small>{settled?.complete === false ? "partial coverage" : "grouped terminal work"}</small>
      </div>
      {rows.map(({ agentId, items: agentItems, schedules: agentSchedules, groups }) => {
        const activeCount = agentItems.filter((item) => item.state === "active").length;
        const groupRunCount = groups.reduce((total, group) => total + group.runCount, 0);
        return (
          <div className="lane-row" key={agentId}>
            <div className="agent-cell">
              <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agentId) % AGENT_COLORS.length] }}>{shortAgent(agentId)}</span>
              <span className="agent-copy">
                <b>{agentId}</b>
                <small>{activeCount} active · {agentSchedules.length} scheduled · {groups.length} series / {groupRunCount} runs</small>
              </span>
              <span className="agent-count">{agentItems.length + agentSchedules.length + groups.length}</span>
            </div>
            {OPERATIONAL_STAGES.map((stage) => {
              const stageItems = agentItems.filter((item) => item.stage === stage.key || (stage.key === "waiting" && item.stage === "unresolved"));
              if (stage.key === "incoming") {
                return (
                  <IncomingCell
                    key={stage.key}
                    queued={stageItems}
                    schedules={agentSchedules}
                    selectedId={selectedId}
                    onSelectActivity={onSelectActivity}
                    onOpenOverflow={(queued, hiddenSchedules) => onOpenIncomingOverflow(agentId, queued, hiddenSchedules)}
                  />
                );
              }
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
          {rows.map(({ agentId, items: agentItems, schedules: agentSchedules, groups }) => {
            const total = Math.max(1, agentItems.length + agentSchedules.length + groups.length);
            return (
              <div className="fleet-map-row" key={agentId} title={agentId}>
                <span style={{ flex: (agentItems.filter((item) => item.stage === "incoming").length + agentSchedules.length) / total }} />
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
        <span>{items.length} operational · {schedules.length} scheduled next 1h · {seriesCount} settled series / {settledRunCount} runs · {range}</span>
        <span className="flow-footer-push">Full-range server aggregation</span>
      </div>
    </div>
  );
}

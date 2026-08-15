import { useMemo, useState } from "react";
import type { ActivityItem, SettledGroupSummary, SettledRange, UpcomingSchedule } from "../../src/contracts";
import { IncomingOverflowDialog, OverflowDialog, SeriesRunDialog } from "./components/dialogs";
import { Inspector } from "./components/Inspector";
import type { KindFilter } from "./lib/board";
import { statusLabel } from "./lib/format";
import { useCollector } from "./state/collector-context";
import { ArchiveView } from "./views/Archive";
import { ConnectionsView } from "./views/Connections";
import { LiveFlowView } from "./views/LiveFlow";
import { RelationsView } from "./views/Relations";

type View = "live" | "relations" | "archive" | "connections";

const VIEW_LABELS: Record<View, string> = {
  live: "Live flow",
  relations: "Relations",
  archive: "Archive",
  connections: "Connections",
};

export function App() {
  const { status, snapshot, settled, range, setRange } = useCollector();
  const [view, setView] = useState<View>("live");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedSeriesKey, setSelectedSeriesKey] = useState<string>();
  const [overflow, setOverflow] = useState<{ agentId: string; groups: SettledGroupSummary[] }>();
  const [incomingOverflow, setIncomingOverflow] = useState<{ agentId: string; queued: ActivityItem[]; schedules: UpcomingSchedule[] }>();

  const selectedGroup = useMemo(
    () => Object.values(settled?.groupsByAgent ?? {}).flat().find((group) => group.seriesKey === selectedSeriesKey),
    [settled, selectedSeriesKey],
  );

  const changeRange = (next: SettledRange) => {
    setRange(next);
    setSelectedSeriesKey(undefined);
    setOverflow(undefined);
    setIncomingOverflow(undefined);
  };
  const openItem = (id: string) => {
    setSelectedSeriesKey(undefined);
    setOverflow(undefined);
    setIncomingOverflow(undefined);
    setSelectedId(id);
  };
  const openSeries = (seriesKey: string) => {
    setSelectedId(undefined);
    setOverflow(undefined);
    setIncomingOverflow(undefined);
    setSelectedSeriesKey(seriesKey);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("live")}><span className="mark">AR</span><span>AR Kanban</span></button>
        <nav aria-label="Primary">
          {(Object.keys(VIEW_LABELS) as View[]).map((item) => <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>{VIEW_LABELS[item]}</button>)}
        </nav>
        <button className={`gateway-button ${status?.gateway.connected ? "live" : ""}`} onClick={() => setView("connections")}><span />{status?.gateway.name ?? "Gateway"}<small>{statusLabel(status)}</small></button>
      </header>

      {view === "live" ? (
        <LiveFlowView
          kind={kind}
          query={query}
          onKindChange={setKind}
          onQueryChange={setQuery}
          onRangeChange={changeRange}
          selectedId={selectedId}
          selectedSeriesKey={selectedSeriesKey}
          onSelectActivity={openItem}
          onSelectSeries={openSeries}
          onSelectOverflow={(agentId, groups) => setOverflow({ agentId, groups })}
          onOpenIncomingOverflow={(agentId, queued, schedules) => setIncomingOverflow({ agentId, queued, schedules })}
        />
      ) : (
        <main className="content-shell">
          {view === "relations" ? <RelationsView snapshot={snapshot} onSelect={openItem} /> : null}
          {view === "archive" ? <ArchiveView items={snapshot?.items ?? []} onSelect={openItem} /> : null}
          {view === "connections" ? <ConnectionsView status={status} /> : null}
        </main>
      )}

      {incomingOverflow ? (
        <IncomingOverflowDialog
          agentId={incomingOverflow.agentId}
          queued={incomingOverflow.queued}
          schedules={incomingOverflow.schedules}
          onClose={() => setIncomingOverflow(undefined)}
          onOpenActivity={openItem}
        />
      ) : null}
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

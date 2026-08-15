import { useMemo, useState } from "react";
import type { ActivityItem, SettledGroupSummary, SettledRange, UpcomingSchedule } from "../../src/contracts";
import { IncomingOverflowDialog, OverflowDialog, SeriesRunDialog } from "./components/dialogs";
import { Inspector } from "./components/Inspector";
import type { KindFilter } from "./lib/board";
import { statusLabel } from "./lib/format";
import { Link, matchPath, useLocation, useNavigate } from "./router";
import { useCollector } from "./state/collector-context";
import { AgentsView } from "./views/Agents";
import { ArchiveView } from "./views/Archive";
import { ConnectionsView } from "./views/Connections";
import { LiveFlowView } from "./views/LiveFlow";
import { RelationsView } from "./views/Relations";

const NAV_ITEMS = [
  { path: "/", key: "live", label: "Live flow" },
  { path: "/agents", key: "agents", label: "Agents" },
  { path: "/relations", key: "relations", label: "Relations" },
  { path: "/archive", key: "archive", label: "Archive" },
  { path: "/connections", key: "connections", label: "Connections" },
] as const;

export function App() {
  const { status, snapshot, settled, range, setRange } = useCollector();
  const { pathname } = useLocation();
  const navigateTo = useNavigate();
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

  const isLive = matchPath("/", pathname) !== undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/"><span className="mark">AR</span><span>AR Kanban</span></Link>
        <nav aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.key}
              to={item.path}
              data-nav={item.key}
              className={matchPath(item.path, pathname) ? "active" : ""}
              aria-current={matchPath(item.path, pathname) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button className={`gateway-button ${status?.gateway.connected ? "live" : ""}`} onClick={() => navigateTo("/connections")}><span />{status?.gateway.name ?? "Gateway"}<small>{statusLabel(status)}</small></button>
      </header>

      {isLive ? (
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
          {matchPath("/agents", pathname) ? <AgentsView /> : null}
          {matchPath("/relations", pathname) ? <RelationsView snapshot={snapshot} onSelect={openItem} /> : null}
          {matchPath("/archive", pathname) ? <ArchiveView items={snapshot?.items ?? []} onSelect={openItem} /> : null}
          {matchPath("/connections", pathname) ? <ConnectionsView status={status} /> : null}
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

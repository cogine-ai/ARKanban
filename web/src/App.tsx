import { useMemo, useState } from "react";
import type { ActivityItem, SettledGroupSummary, SettledRange, UpcomingSchedule } from "../../src/contracts";
import { IncomingOverflowDialog, OverflowDialog, SeriesRunDialog } from "./components/dialogs";
import { Inspector } from "./components/Inspector";
import type { KindFilter } from "./lib/board";
import { formatRelative, statusLabel } from "./lib/format";
import { Link, matchPath, useLocation, useNavigate } from "./router";
import { useCollector } from "./state/collector-context";
import { AgentDetailView } from "./views/AgentDetail";
import { AgentsView } from "./views/Agents";
import { ArchiveView } from "./views/Archive";
import { ConnectionsView } from "./views/Connections";
import { LiveFlowView } from "./views/LiveFlow";
import { RelationsView } from "./views/Relations";
import { SessionDetailView } from "./views/SessionDetail";
import { SessionsView } from "./views/Sessions";

const NAV_ITEMS = [
  { path: "/", key: "live", label: "Live flow" },
  { path: "/agents", key: "agents", label: "Agents" },
  { path: "/sessions", key: "sessions", label: "Sessions" },
  { path: "/relations", key: "relations", label: "Relations" },
  { path: "/archive", key: "archive", label: "Archive" },
  { path: "/connections", key: "connections", label: "Connections" },
] as const;

/**
 * A nav entry stays lit on its own subtree, so the Sessions tab does not go dark
 * when a session detail is open. `/` is excluded because it prefixes everything.
 */
function isNavActive(navPath: string, pathname: string): boolean {
  if (matchPath(navPath, pathname)) return true;
  return navPath !== "/" && pathname.startsWith(`${navPath}/`);
}

/**
 * The state of this page's own updates, which is not the same fact as whether the
 * collector can reach its Gateway. A frozen page is worth saying out loud: every
 * number on it was true when the stream broke and has not been checked since.
 */
function LiveStreamNotice() {
  const { live, retryLive } = useCollector();
  if (live.state === "open" || live.state === "connecting") return null;

  return (
    <div className="live-notice" data-state={live.state} role="status">
      {live.state === "stopped" ? (
        <>
          <span>
            Live updates have stopped{live.lostAt ? ` — last update ${formatRelative(live.lostAt)}` : ""}. Nothing on
            this page is refreshing.
          </span>
          <button type="button" onClick={retryLive}>
            Reconnect
          </button>
        </>
      ) : (
        // No countdown: `EventSource` sets its own delay, and naming a time this
        // code does not control would be inventing a schedule.
        <span>
          Reconnecting to live updates (attempt {live.attempts})
          {live.lostAt ? ` — last update ${formatRelative(live.lostAt)}` : ""}.
        </span>
      )}
    </div>
  );
}

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
  const agentDetail = matchPath("/agents/:agentId", pathname);
  const sessionDetail = matchPath("/sessions/:sessionKey", pathname);

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
              className={isNavActive(item.path, pathname) ? "active" : ""}
              aria-current={isNavActive(item.path, pathname) ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button className={`gateway-button ${status?.gateway.connected ? "live" : ""}`} onClick={() => navigateTo("/connections")}><span />{status?.gateway.name ?? "Gateway"}<small>{statusLabel(status)}</small></button>
      </header>

      <LiveStreamNotice />

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
          {agentDetail ? <AgentDetailView agentId={agentDetail.agentId!} /> : null}
          {matchPath("/sessions", pathname) ? <SessionsView /> : null}
          {sessionDetail ? <SessionDetailView sessionKey={sessionDetail.sessionKey!} /> : null}
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

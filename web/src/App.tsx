import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityDetail,
  ActivityItem,
  ActivitySnapshot,
  ActivityStage,
  CollectorStatus,
  SourceCoverage,
} from "../../src/contracts";
import { collectorApi } from "./api";

type View = "live" | "relations" | "archive" | "connections";
type KindFilter = "all" | "task" | "attempt";

const STAGES: Array<{ key: ActivityStage; label: string; hint: string; arrow: string }> = [
  { key: "incoming", label: "INCOMING", hint: "queued ledger work", arrow: "→" },
  { key: "in_flight", label: "IN FLIGHT", hint: "observed execution", arrow: "→" },
  { key: "waiting", label: "WAITING", hint: "operator attention", arrow: "↔" },
  { key: "settled", label: "SETTLED", hint: "recent terminal work", arrow: "→" },
];

const AGENT_COLORS = ["#39766e", "#bd6842", "#53679c", "#aa8738", "#8c657f", "#758653", "#517f87", "#815d45"];

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

function formatTime(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

function formatRelative(value?: number): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function outcomeLabel(item: ActivityItem): string {
  if (item.state !== "terminal") return item.phase.replaceAll("_", " ");
  return item.outcome === "unknown" ? "ended · outcome unknown" : item.outcome.replaceAll("_", " ");
}

function stageCount(snapshot: ActivitySnapshot | undefined, stage: ActivityStage): number {
  if (!snapshot) return 0;
  if (stage === "in_flight") return snapshot.summary.inFlight;
  return snapshot.summary[stage];
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

function useCollector() {
  const [status, setStatus] = useState<CollectorStatus>();
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>();
  const [error, setError] = useState<string>();
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSnapshot] = await Promise.all([collectorApi.status(), collectorApi.snapshot()]);
      setStatus(nextStatus);
      setSnapshot(nextSnapshot);
      setError(undefined);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

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

  return { status, snapshot, error, refresh };
}

function StatusPills({ status, snapshot }: { status?: CollectorStatus; snapshot?: ActivitySnapshot }) {
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
      {snapshot && snapshot.summary.unresolved > 0 ? <span className="truth-pill warn"><i /> {snapshot.summary.unresolved} unresolved</span> : null}
    </div>
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

function FlowBoard({ items, selectedId, onSelect }: { items: ActivityItem[]; selectedId?: string; onSelect: (id: string) => void }) {
  const byAgent = useMemo(() => {
    const result = new Map<string, ActivityItem[]>();
    for (const item of items) {
      const rows = result.get(item.agentId) ?? [];
      rows.push(item);
      result.set(item.agentId, rows);
    }
    return [...result.entries()].sort(([, a], [, b]) => {
      const attentionA = a.filter((item) => item.attention !== "none").length;
      const attentionB = b.filter((item) => item.attention !== "none").length;
      return attentionB - attentionA || b.length - a.length;
    });
  }, [items]);
  const density = items.length <= 12 ? "focus" : items.length <= 70 ? "board" : items.length <= 260 ? "dense" : "radar";
  const operationalCount = items.filter((item) => item.catalog === "operational").length;
  const terminalCount = items.length - operationalCount;

  if (items.length === 0) {
    return (
      <div className="board-empty">
        <div className="empty-orbit"><span /></div>
        <strong>Waiting for observed activity</strong>
        <p>The board will fill from Gateway task and session snapshots. No demo records are mixed into this view.</p>
      </div>
    );
  }

  return (
    <div className={`flow-table density-${density}`}>
      <div className="flow-head agent-head">AGENT FLOW</div>
      {STAGES.map((stage) => (
        <div className="flow-head" key={stage.key}>
          <span>{stage.label}</span><b>{stage.arrow}</b><small>{stage.hint}</small>
        </div>
      ))}
      {byAgent.map(([agentId, agentItems]) => (
        <div className="lane-row" key={agentId}>
          <div className="agent-cell">
            <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agentId) % AGENT_COLORS.length] }}>{shortAgent(agentId)}</span>
            <span className="agent-copy"><b>{agentId}</b><small>{agentItems.filter((item) => item.state === "active").length} active · {agentItems.length} visible</small></span>
            <span className="agent-count">{agentItems.length}</span>
          </div>
          {STAGES.map((stage) => {
            const stageItems = agentItems.filter((item) => item.stage === stage.key || (stage.key === "waiting" && item.stage === "unresolved"));
            return (
              <div className={`stage-cell stage-${stage.key}`} key={stage.key}>
                {stageItems.map((item) => <ActivityCard key={item.id} item={item} selected={item.id === selectedId} onSelect={() => onSelect(item.id)} />)}
              </div>
            );
          })}
        </div>
      ))}
      <aside className="fleet-map" aria-label="Fleet stage distribution">
        <h4>FLEET<br />MAP</h4>
        <div className="fleet-map-rows">
          {byAgent.map(([agentId, agentItems]) => {
            const total = Math.max(1, agentItems.length);
            return <div className="fleet-map-row" key={agentId} title={agentId}><span style={{ flex: agentItems.filter((item) => item.stage === "incoming").length / total }} /><span style={{ flex: agentItems.filter((item) => item.stage === "in_flight").length / total }} /><span style={{ flex: agentItems.filter((item) => item.stage === "waiting" || item.stage === "unresolved").length / total }} /><span style={{ flex: agentItems.filter((item) => item.stage === "settled").length / total }} /></div>;
          })}
        </div>
      </aside>
      <div className="flow-footer">
        <span className="mini-live" /> Auto density · {density}
        <span>{operationalCount} operational · {terminalCount} recent terminal · tasks and attempts remain separate</span>
        <span className="flow-footer-push">Snapshot + low-latency events</span>
      </div>
    </div>
  );
}

function Inspector({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    void collectorApi.detail(id).then((value) => live && setDetail(value)).catch((cause) => live && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { live = false; };
  }, [id]);

  return (
    <aside className="inspector" aria-label="Activity inspector">
      <div className="inspector-head">
        <div><span className="eyebrow">ACTIVITY INSPECTOR</span><h2>{detail?.item.title ?? "Loading activity…"}</h2></div>
        <button className="icon-button" onClick={onClose} aria-label="Close inspector">×</button>
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
    </aside>
  );
}

function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
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
  const terminal = items.filter((item) => item.state === "terminal").sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">RECENT TERMINAL HISTORY</span><h1>Archive</h1></div><span className="count-chip">{terminal.length} retained</span></div>
      <div className="archive-table">
        <div className="archive-head"><span>Activity</span><span>Agent</span><span>Kind</span><span>Outcome</span><span>Last observed</span></div>
        {terminal.map((item) => <button key={item.id} onClick={() => onSelect(item.id)}><span><i className={`archive-state outcome-${item.outcome}`} />{item.title}</span><span>{item.agentId}</span><span>{item.kind}</span><span>{item.outcome}</span><span>{formatRelative(item.lastObservedAt)}</span></button>)}
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
  const { status, snapshot, error, refresh } = useCollector();
  const [view, setView] = useState<View>("live");
  const [kind, setKind] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();

  const visibleItems = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return (snapshot?.items ?? []).filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (view === "live" && item.catalog !== "operational" && item.state !== "terminal") return false;
      return !lowered || `${item.title} ${item.agentId} ${item.lastToolName ?? ""}`.toLowerCase().includes(lowered);
    });
  }, [snapshot, kind, query, view]);
  const active = snapshot?.items.filter((item) => item.catalog === "operational").length ?? 0;
  const waiting = snapshot?.items.filter((item) => item.stage === "waiting").length ?? 0;
  const terminal = snapshot?.items.filter((item) => item.state === "terminal").length ?? 0;

  const openItem = (id: string) => setSelectedId(id);
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("live")}><span className="mark">C</span><span>OpenClaw Collector</span></button>
        <nav aria-label="Primary">
          {(["live", "relations", "archive", "connections"] as View[]).map((item) => <button className={view === item ? "active" : ""} key={item} onClick={() => setView(item)}>{({ live: "Live flow", relations: "Relations", archive: "Archive", connections: "Connections" } as const)[item]}</button>)}
        </nav>
        <button className={`gateway-button ${status?.gateway.connected ? "live" : ""}`} onClick={() => setView("connections")}><span />{status?.gateway.name ?? "Gateway"}<small>{statusLabel(status)}</small></button>
      </header>

      {view === "live" ? (
        <>
          <section className="summary-bar">
            <div className="summary-copy"><span className="eyebrow">LIVE ACTIVITY</span><h1>{status?.syncState === "live" ? (active > 0 ? "Activity is flowing" : "Collector is watching") : statusLabel(status)}</h1><div className="metrics"><span><b>{active}</b> active</span><span className="wait"><b>{waiting}</b> waiting</span><span><b>{terminal}</b> recent terminal</span><span><b>{snapshot?.lanes.length ?? 0}</b> agents</span></div></div>
            <div className="summary-actions"><StatusPills status={status} snapshot={snapshot} /><div className="filters"><label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search activity" aria-label="Search activity" /></label><div className="segmented" aria-label="Activity kind"><button aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button><button aria-pressed={kind === "task"} onClick={() => setKind("task")}>Tasks</button><button aria-pressed={kind === "attempt"} onClick={() => setKind("attempt")}>Attempts</button></div><button className="refresh-button" onClick={() => void refresh()} aria-label="Refresh snapshots">↻</button></div></div>
          </section>
          <main className="board-shell">
            {error ? <div className="connection-banner"><span />{error}<button onClick={() => void refresh()}>Retry now</button></div> : null}
            <section className="flow-board surface" aria-label="Adaptive activity flowboard">
              <FlowBoard items={visibleItems} selectedId={selectedId} onSelect={openItem} />
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
      {selectedId ? <><button className="inspector-scrim" onClick={() => setSelectedId(undefined)} aria-label="Close activity inspector" /><Inspector id={selectedId} onClose={() => setSelectedId(undefined)} /></> : null}
    </div>
  );
}

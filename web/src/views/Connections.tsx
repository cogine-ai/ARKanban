import type { CollectorStatus } from "../../../src/contracts";
import { coverageTone, formatRelative } from "../lib/format";

export function ConnectionsView({ status }: { status?: CollectorStatus }) {
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

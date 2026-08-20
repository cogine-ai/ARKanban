import type { CollectorStatus } from "../../../src/contracts";
import type { TranscriptArchiveStatus } from "../api";
import { coverageTone, formatBytes, formatRelative } from "../lib/format";
import { useTranscriptStatus } from "../state/use-transcript-status";

/**
 * Standing disclosure required by the local_archive invariants: storing whole
 * conversations must be stated plainly and continuously, not buried in a
 * settings page the operator has to go looking for.
 */
const CAPACITY_LABEL = {
  ok: "Within limit",
  paused: "Evicting oldest",
  full: "Full — new messages not stored",
} as const;

function ArchivePanel({ status }: { status?: TranscriptArchiveStatus }) {
  if (!status) return null;
  const capacity = status.sync?.capacity ?? "ok";

  return (
    <div className="archive-panel" data-enabled={status.enabled}>
      <div className="archive-headline">
        <span className={`coverage-icon ${status.enabled ? "live" : "muted"}`}><i /></span>
        <div>
          <small>LOCAL TRANSCRIPT ARCHIVE</small>
          <h3>
            {status.enabled
              ? "Full conversation text is stored on this machine"
              : "Transcript sync is off; previously stored text is kept"}
          </h3>
          <p>
            {status.messageCount.toLocaleString()} messages · {formatBytes(status.contentBytes)} · kept{" "}
            {status.retentionDays} days or until {formatBytes(status.maxBytes)}
          </p>
        </div>
      </div>
      <dl>
        <div>
          <dt>Last round</dt>
          <dd>{status.sync ? `${status.sync.sessions} sessions · ${status.sync.inserted} new` : "Not run yet"}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd>{CAPACITY_LABEL[capacity]}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{status.sync?.errorCode ?? status.sync?.skipped ?? "Healthy"}</dd>
        </div>
        <div>
          <dt>File access</dt>
          <dd>{status.filePermissionsEnforced ? "This user only" : "Readable by other users"}</dd>
        </div>
      </dl>
      {capacity === "full" ? (
        <p className="archive-warning">
          The archive has reached {formatBytes(status.maxBytes)} and everything it holds is too recent to evict, so new
          messages are not being stored. Raise the size limit or run the erase command below.
        </p>
      ) : null}
      {status.filePermissionsEnforced ? null : (
        <p className="archive-warning">
          This filesystem would not restrict the database to your account, so other users on this machine can read the
          stored conversations. Move the data directory to a volume that supports file permissions.
        </p>
      )}
      <p className="archive-erase">
        Erase everything with <code>openclaw-collector purge-transcripts --yes</code>
      </p>
    </div>
  );
}

function HostPanel({ status }: { status: CollectorStatus }) {
  const hosts = status.hosts ?? [
    {
      id: status.host.id,
      label: status.host.label,
      reachable: true,
      syncState: status.syncState,
      gatewayConnected: status.gateway.connected,
    },
  ];

  return (
    <div className="host-grid" aria-label="Hosts">
      {hosts.map((host) => (
        <article key={host.id} className="host-card" data-host-id={host.id} data-reachable={host.reachable}>
          <span className={`coverage-icon ${host.reachable ? "live" : "muted"}`}><i /></span>
          <div>
            <small>HOST</small>
            <h3>{host.label}</h3>
            <p>
              {host.id} · {host.reachable ? host.syncState : host.code ?? "unreachable"}
              {host.gatewayConnected === undefined ? "" : host.gatewayConnected ? " · gateway up" : " · gateway down"}
              {host.lastSeenAt ? ` · seen ${formatRelative(host.lastSeenAt)}` : ""}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}

export function ConnectionsView({ status }: { status?: CollectorStatus }) {
  const { status: archive } = useTranscriptStatus();

  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">READ-ONLY INPUTS</span><h1>Connections</h1></div><span className={`count-chip ${status?.gateway.connected ? "connected" : ""}`}>{status?.gateway.connected ? "Connected" : "Offline"}</span></div>
      {status ? <HostPanel status={status} /> : null}
      <div className="gateway-panel">
        <div className="gateway-main"><span className={`gateway-orb ${status?.gateway.connected ? "live" : ""}`} /><div><small>OPENCLAW GATEWAY</small><h2>{status?.gateway.name ?? "Gateway"}</h2><p>{status?.gateway.endpoint ?? "Endpoint unavailable"}</p></div><dl><div><dt>Version</dt><dd>{status?.gateway.serverVersion ?? "—"}</dd></div><div><dt>Protocol</dt><dd>{status?.gateway.protocolVersion ?? "—"}</dd></div><div><dt>Scope</dt><dd>{status?.gateway.grantedScopes.join(", ") || "—"}</dd></div><div><dt>Host</dt><dd>{status?.host.id ?? "—"}</dd></div></dl></div>
        <div className="coverage-grid">
          {status?.sources.map((item) => <article key={item.source}><span className={`coverage-icon ${coverageTone(item)}`}><i /></span><div><small>{item.source.toUpperCase()}</small><h3>{item.state}</h3><p>{item.code ?? (item.lastSnapshotAt ? `Snapshot ${formatRelative(item.lastSnapshotAt)}` : item.lastEventAt ? `Event ${formatRelative(item.lastEventAt)}` : "Awaiting first observation")}</p></div></article>)}
        </div>
      </div>
      <ArchivePanel status={archive} />
    </section>
  );
}

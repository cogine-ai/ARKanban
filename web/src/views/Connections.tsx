import type { ReactNode } from "react";
import type { CollectorStatus, HostCoverage, SourceCoverage } from "../../../src/contracts";
import type { TranscriptArchiveStatus } from "../api";
import {
  archiveDisclosure, archiveSignal, browserSignal, collectorSignal, gatewaySignal,
  hostGatewaySignal, latestSourceObservation, sourceSignal, type ConnectionSignal,
} from "../lib/connections-model";
import { formatBytes } from "../lib/format";
import { Link } from "../router";
import { useCollector } from "../state/collector-context";
import { useTranscriptStatus } from "../state/use-transcript-status";
import "./connections.css";

function ConnectionIcon({ kind }: { kind: "gateway" | "collector" | "browser" | "archive" | "settings" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "gateway" ? <><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4M9 12h6" /></> : null}
    {kind === "collector" ? <><rect x="3" y="3" width="18" height="8" rx="2" /><rect x="3" y="13" width="18" height="8" rx="2" /><path d="M7 7h.01M7 17h.01M15 7h3M15 17h3" /></> : null}
    {kind === "browser" ? <><rect x="2.5" y="3" width="19" height="18" rx="2.5" /><path d="M3 8h18M6 5.5h.01M9 5.5h.01M7 14l3 3 7-7" /></> : null}
    {kind === "archive" ? <><path d="M4 8v12h16V8M3 4h18v4H3zM9 12h6" /></> : null}
    {kind === "settings" ? <><path d="m10 2-1 3-3 1-3-1-1 3 2 2v4l-2 2 1 3 3-1 3 1 1 3h4l1-3 3-1 3 1 1-3-2-2v-4l2-2-1-3-3 1-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></> : null}
  </svg>;
}

function Signal({ signal, prefix }: { signal: ConnectionSignal; prefix?: string }) {
  return <span className="connection-signal" data-tone={signal.tone}><i aria-hidden="true" />{prefix}{signal.label}</span>;
}

function FlowStep({ kind, label, title, signal, children }: {
  kind: "gateway" | "collector" | "browser"; label: string; title: string; signal: ConnectionSignal; children?: ReactNode;
}) {
  return <article className="connection-step" data-step={kind} data-tone={signal.tone}>
    <span className="connection-step-icon"><ConnectionIcon kind={kind} /></span>
    <div className="connection-step-copy"><span className="connection-step-label">{label}</span><h2 title={title}>{title}</h2><Signal signal={signal} /></div>
    {children}
  </article>;
}

function FlowArrow({ flowing }: { flowing: boolean }) {
  return <span className="connection-arrow" data-flowing={flowing} aria-hidden="true"><svg viewBox="0 0 40 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 10h36M29 3l8 7-8 7" /></svg></span>;
}

function observationLabel(time?: number): string {
  if (time === undefined) return "Not observed";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function exactTime(time: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(time);
}

function SourceStrip({ sources, paused }: { sources: SourceCoverage[]; paused: boolean }) {
  return <div className="connection-sources" aria-label="Source coverage">
    {(["tasks", "sessions", "events"] as const).map((name) => {
      const source = sources.find((item) => item.source === name);
      const time = latestSourceObservation(source);
      return <article key={name} data-source={name}>
        <strong>{name === "tasks" ? "Tasks" : name === "sessions" ? "Sessions" : "Events"}</strong>
        <Signal signal={sourceSignal(source)} />
        <span className="connection-observation" title={time === undefined ? undefined : exactTime(time)}>{paused ? "Last seen · " : ""}{observationLabel(time)}</span>
      </article>;
    })}
  </div>;
}

function HostBranch({ host }: { host: HostCoverage }) {
  return <article className="connection-host" data-host-id={host.id} data-reachable={host.reachable}>
    <span className="connection-host-icon"><ConnectionIcon kind="collector" /></span>
    <div><h3 title={host.label}>{host.label}</h3><div className="connection-host-signals">
      <Signal signal={{ label: host.reachable ? "Node online" : "Node offline", tone: host.reachable ? "good" : "bad" }} />
      <Signal signal={hostGatewaySignal(host)} prefix="Gateway · " />
      {host.reachable && host.syncState !== "live" ? <Signal signal={collectorSignal(host.syncState)} prefix="Sync · " /> : null}
    </div></div>
  </article>;
}

function ArchivePanel({ status, error, reload }: { status?: TranscriptArchiveStatus; error?: string; reload: () => Promise<void> }) {
  return <section className="connection-archive" aria-labelledby="connection-archive-title" aria-busy={!status && !error}>
    <div className="connection-archive-heading">
      <span className="connection-archive-icon"><ConnectionIcon kind="archive" /></span>
      <div><h2 id="connection-archive-title">Conversation archive</h2><p className="connection-archive-disclosure">{status ? archiveDisclosure(status) : error ? "Status unavailable" : "Loading…"}</p></div>
      {status ? <Signal signal={error ? { label: "Last known", tone: "warn" } : archiveSignal(status)} /> : null}
      <Link to="/settings?section=archive" className="connection-settings" aria-label="Archive settings" title="Archive settings"><ConnectionIcon kind="settings" /></Link>
    </div>
    {error ? <div className="connection-error" role="alert"><span>Archive status unavailable</span><button type="button" onClick={() => void reload()}>Retry</button></div> : null}
    {status ? <>
      <div className="connection-archive-summary"><span><b>{status.messageCount.toLocaleString()}</b> messages</span><span><b>{formatBytes(status.contentBytes)}</b> text</span><span>Kept <b>{status.retentionDays} days</b></span><span>Limit <b>{formatBytes(status.maxBytes)}</b></span></div>
      {!status.filePermissionsEnforced ? <p className="connection-privacy-warning" role="alert"><span aria-hidden="true">!</span>Stored text is readable by other users on this machine</p> : null}
      <details className="connection-details connection-archive-details"><summary>Archive details</summary><dl>
        <div><dt>Last sync</dt><dd>{status.sync ? `${status.sync.sessions} sessions · ${status.sync.inserted} new messages` : "Not run yet"}</dd></div>
        <div><dt>File access</dt><dd>{status.filePermissionsEnforced ? "This user only" : "Other users can read"}</dd></div>
        {status.sync?.errorCode ? <div><dt>Sync error</dt><dd><code>{status.sync.errorCode}</code></dd></div> : null}
        {status.sync?.skipped ? <div><dt>Sync reason</dt><dd><code>{status.sync.skipped}</code></dd></div> : null}
        <div><dt>Erase saved text</dt><dd><code>openclaw-collector purge-transcripts --yes</code></dd></div>
      </dl></details>
    </> : null}
  </section>;
}

function LocalArchiveSection() {
  const { status, error, reload } = useTranscriptStatus();
  return <ArchivePanel status={status} error={error} reload={reload} />;
}

function ConnectionDetails({ status, hub }: { status: CollectorStatus; hub: boolean }) {
  return <details className="connection-details connection-diagnostics"><summary>Connection details</summary>
    <dl><div><dt>Machine</dt><dd><code>{status.host.id}</code></dd></div><div><dt>Role</dt><dd>{hub ? "Hub" : "Collector"}</dd></div><div><dt>Version</dt><dd>{status.process.version}</dd></div><div><dt>Sync</dt><dd>{status.syncState}</dd></div>
      {!hub ? <><div><dt>Gateway endpoint</dt><dd><code>{status.gateway.endpoint}</code></dd></div><div><dt>Gateway version</dt><dd>{status.gateway.serverVersion ?? "Not reported"}</dd></div><div><dt>Protocol</dt><dd>{status.gateway.protocolVersion ?? "Not reported"}</dd></div><div><dt>Scopes</dt><dd>{status.gateway.grantedScopes.join(", ") || "None reported"}</dd></div></> : null}
      {status.syncReasons.length ? <div><dt>Sync reasons</dt><dd>{status.syncReasons.join(", ")}</dd></div> : null}
    </dl>
    {hub && status.hosts?.length ? <div className="connection-node-diagnostics">{status.hosts.map((host) => <dl key={host.id}><div><dt>{host.label}</dt><dd><code>{host.id}</code></dd></div><div><dt>Sync</dt><dd>{host.syncState}</dd></div><div><dt>Last seen</dt><dd title={host.lastSeenAt === undefined ? undefined : exactTime(host.lastSeenAt)}>{observationLabel(host.lastSeenAt)}</dd></div>{host.code ? <div><dt>Reason</dt><dd><code>{host.code}</code></dd></div> : null}</dl>)}</div> : null}
    {!hub ? <div className="connection-source-diagnostics">{status.sources.map((source) => source.code ? <p key={source.source}><strong>{source.source}</strong> <code>{source.code}</code></p> : null)}</div> : null}
  </details>;
}

export function ConnectionsView({ status }: { status?: CollectorStatus }) {
  const { live, retryLive, error, refresh } = useCollector();
  const hub = status?.host.role === "hub";
  const pageSignal = browserSignal(live);
  const hosts = status?.hosts ?? [];
  const connectedHosts = hosts.filter((host) => host.reachable).length;
  const hubSignal: ConnectionSignal = hosts.length
    ? { label: `${connectedHosts} / ${hosts.length} nodes online`, tone: connectedHosts === hosts.length && status?.syncState === "live" ? "good" : connectedHosts ? "warn" : "bad" }
    : { label: "No nodes", tone: "quiet" };

  return <section className="surface view-surface connections-view" aria-busy={!status && !error}>
    <div className="view-heading"><h1>Connections</h1><div className="connection-heading-actions"><Signal signal={pageSignal} /><Link to="/settings" className="connection-settings" aria-label="Connection settings" title="Connection settings"><ConnectionIcon kind="settings" /></Link></div></div>
    {status ? <>
      <div className={`connection-flow${hub ? " connection-flow-hub" : ""}`} aria-label={hub ? "Nodes to Hub to Browser" : "Gateway to Collector to Browser"} data-page-live={live.state === "open"}>
        {hub ? <div className="connection-branches" aria-label="Collector nodes">{hosts.length ? hosts.map((host) => <HostBranch key={host.id} host={host} />) : <div className="connection-no-nodes"><ConnectionIcon kind="collector" /><span>No connected nodes</span><Link to="/settings">Connect a node</Link></div>}</div> : <FlowStep kind="gateway" label="Gateway" title={status.gateway.name} signal={gatewaySignal(status.gateway.connected)} />}
        <FlowArrow flowing={live.state === "open" && (hub ? connectedHosts > 0 : status.gateway.connected)} />
        <FlowStep kind="collector" label={hub ? "Hub" : "Collector"} title={status.host.label} signal={hub ? hubSignal : collectorSignal(status.syncState)} />
        <FlowArrow flowing={live.state === "open"} />
        <FlowStep kind="browser" label="Browser" title="This page" signal={pageSignal}>{live.state === "stopped" ? <button className="connection-retry" type="button" onClick={retryLive}>Reconnect</button> : null}</FlowStep>
      </div>
      {!hub ? <SourceStrip sources={status.sources} paused={live.state !== "open"} /> : null}
      {hub ? <div className="connection-hub-archive"><ConnectionIcon kind="archive" /><span>Conversation archives stay on nodes</span></div> : <LocalArchiveSection />}
      <ConnectionDetails status={status} hub={hub} />
    </> : error ? <div className="connection-error" role="alert"><span>Connection status unavailable</span><button type="button" onClick={() => void refresh()}>Retry</button></div> : <div className="connection-loading" role="status"><ConnectionIcon kind="collector" /><span>Loading connections…</span></div>}
  </section>;
}

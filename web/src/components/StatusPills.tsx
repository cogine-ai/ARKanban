import type { ActivitySnapshot, CollectorStatus, SettledGroupSnapshot } from "../../../src/contracts";
import { scheduleLabel, scheduleTone, statusLabel } from "../lib/format";

export function StatusPills({
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
      <span className={`truth-pill ${scheduleTone(snapshot?.schedule)}`}>
        <i /> {scheduleLabel(snapshot?.schedule)}
      </span>
      {settled && !settled.complete ? <span className="truth-pill warn"><i /> Settled partial coverage</span> : null}
      {snapshot && snapshot.summary.unresolved > 0 ? <span className="truth-pill warn"><i /> {snapshot.summary.unresolved} unresolved</span> : null}
    </div>
  );
}

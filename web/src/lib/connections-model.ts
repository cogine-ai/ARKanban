import type { CollectorStatus, HostCoverage, SourceCoverage } from "../../../src/contracts";
import type { TranscriptArchiveStatus } from "../api";
import type { LiveStreamState } from "../state/collector-context";
import { archiveSearchState } from "./message-search-model";

export type ConnectionSignal = { label: string; tone: "good" | "warn" | "bad" | "quiet" };

export function gatewaySignal(connected?: boolean): ConnectionSignal {
  if (connected === undefined) return { label: "Unknown", tone: "quiet" };
  return connected ? { label: "Connected", tone: "good" } : { label: "Offline", tone: "bad" };
}

export function collectorSignal(state: CollectorStatus["syncState"]): ConnectionSignal {
  switch (state) {
    case "live": return { label: "Live", tone: "good" };
    case "starting": return { label: "Starting", tone: "warn" };
    case "reconciling": return { label: "Syncing", tone: "warn" };
    case "offline": return { label: "Source offline", tone: "bad" };
    case "unauthorized": return { label: "Access denied", tone: "bad" };
    case "incompatible": return { label: "Incompatible", tone: "bad" };
    case "error": return { label: "Error", tone: "bad" };
  }
}

export function browserSignal(live: LiveStreamState): ConnectionSignal {
  switch (live.state) {
    case "open": return { label: "Updates live", tone: "good" };
    case "connecting": return { label: "Connecting", tone: "warn" };
    case "reconnecting": return { label: "Reconnecting", tone: "warn" };
    case "stopped": return { label: "Updates paused", tone: "bad" };
  }
}

export function hostGatewaySignal(host: HostCoverage): ConnectionSignal {
  // A disconnected node can still carry a last-known Gateway flag. It is not a
  // current observation and must not colour a dead branch green.
  return host.reachable ? gatewaySignal(host.gatewayConnected) : { label: "Not current", tone: "quiet" };
}

export function sourceSignal(source?: SourceCoverage): ConnectionSignal {
  if (!source) return { label: "Not reported", tone: "quiet" };
  switch (source.state) {
    case "live": return { label: "Live", tone: "good" };
    case "connecting": return { label: "Connecting", tone: "warn" };
    case "reconciling": return { label: "Syncing", tone: "warn" };
    case "offline": return { label: "Offline", tone: "bad" };
    case "unavailable": return { label: "Unavailable", tone: "quiet" };
    case "error": return { label: "Error", tone: "bad" };
  }
}

/** A last observation can be at epoch zero, and either channel can be newer. */
export function latestSourceObservation(source?: SourceCoverage): number | undefined {
  const times = [source?.lastSnapshotAt, source?.lastEventAt].filter((time): time is number => time !== undefined);
  return times.length ? Math.max(...times) : undefined;
}

export function archiveDisclosure(archive: TranscriptArchiveStatus): string {
  if (archive.enabled) return "Full text · saved locally";
  return archive.messageCount > 0 ? "Sync off · saved text kept" : "Archive off";
}

export function archiveSignal(archive: TranscriptArchiveStatus): ConnectionSignal {
  const state = archiveSearchState(archive);
  if (state.tone === "warn") return { label: state.label, tone: "warn" };
  if (!archive.enabled) return { label: archive.messageCount > 0 ? "Sync off" : "Off", tone: "quiet" };
  if (!archive.sync) return { label: "Not run yet", tone: "quiet" };
  return { label: "Sync ready", tone: "good" };
}

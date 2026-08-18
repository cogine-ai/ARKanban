import type {
  ActivityItem,
  CollectorStatus,
  SourceCoverage,
  UpcomingScheduleSnapshot,
} from "../../../src/contracts";

export function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0;
  return result;
}

export function shortAgent(value: string): string {
  return value
    .split(/[-_\s]+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function formatTime(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value);
}

export function formatDateTime(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/**
 * A timestamp nobody has to interpret: full date, seconds, and the zone it is in.
 *
 * The compact forms above drop the zone to stay readable in a list, which is fine
 * while every row is read in one place and wrong as soon as an archive is read
 * from another — "11:54" alone does not say whose 11:54 it was. This is the form
 * to reach for wherever the exact instant is the point, such as a tooltip on a
 * transcript line.
 */
export function formatExact(value?: number): string {
  if (!value) return "Not observed";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

/** Names the zone the clock times on screen are in, so it can be said once. */
export function localZoneLabel(): string {
  const resolved = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).resolvedOptions();
  const abbreviation = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(Date.now())
    .find((part) => part.type === "timeZoneName")?.value;
  return abbreviation && abbreviation !== resolved.timeZone
    ? `${resolved.timeZone} (${abbreviation})`
    : resolved.timeZone;
}

export function formatHourMinute(value: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(value);
}

export function formatRelative(value?: number): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatScheduleRelative(nextRunAt: number, now: number): string {
  const delta = nextRunAt - now;
  if (delta <= 0) return "Due now";
  const minutes = Math.ceil(delta / 60_000);
  return minutes <= 1 ? "in <1m" : `in ${minutes}m`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}

/**
 * Renders integer micro-USD as money.
 *
 * Sub-cent amounts keep more decimals rather than rounding to $0.00, since a
 * cheap run and a free one are different facts and the card is where the
 * difference is read.
 */
export function formatCost(microUsd?: number): string {
  if (microUsd === undefined) return "—";
  const usd = microUsd / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString()}`;
}

/** Compact token counts; the exact figure belongs in a tooltip, not the card. */
export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** Renders an em dash for "not measured", which is not the same as 0%. */
export function formatPercent(value?: number): string {
  if (value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Renders an em dash for "not measured", which is not the same as an instant run. */
export function formatDuration(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function scheduleTone(schedule: UpcomingScheduleSnapshot | undefined): "good" | "warn" | "bad" | "quiet" {
  if (!schedule) return "warn";
  if (schedule.state === "live") return schedule.schedulerEnabled ? "good" : "quiet";
  if (schedule.state === "partial") return "warn";
  if (schedule.state === "unavailable") return "quiet";
  return "bad";
}

export function scheduleLabel(schedule: UpcomingScheduleSnapshot | undefined): string {
  if (!schedule) return "Schedule loading";
  if (schedule.state === "unavailable") return "Schedule unavailable";
  if (schedule.state === "offline") return "Schedule offline";
  if (schedule.state === "error") return "Schedule error";
  if (!schedule.schedulerEnabled) return "Cron disabled";
  return schedule.state === "partial" ? "Schedule partial" : "Schedule live";
}

export function incomingHeaderHint(
  schedule: UpcomingScheduleSnapshot | undefined,
  queued: number,
  scheduled: number,
): string {
  if (!schedule) return `${queued} queued · schedule loading`;
  if (schedule.state === "unavailable") return `${queued} queued · schedule unavailable`;
  if (schedule.state === "offline" || schedule.state === "error") return `${queued} queued · schedule ${schedule.state}`;
  if (!schedule.schedulerEnabled) return `${queued} queued · Cron disabled`;
  return `${queued} queued · ${scheduled} scheduled next 1h${schedule.state === "partial" ? " · partial" : ""}`;
}

export function outcomeLabel(item: ActivityItem): string {
  if (item.state !== "terminal") return item.phase.replaceAll("_", " ");
  return item.outcome === "unknown" ? "ended · outcome unknown" : item.outcome.replaceAll("_", " ");
}

export function coverageTone(source: SourceCoverage): "good" | "warn" | "bad" | "quiet" {
  if (source.state === "live") return "good";
  if (source.state === "reconciling" || source.state === "connecting") return "warn";
  if (source.state === "unavailable") return "quiet";
  return "bad";
}

export function statusLabel(status: CollectorStatus | undefined): string {
  if (!status) return "Starting";
  if (status.syncState === "live") return "Live";
  if (status.syncState === "reconciling") return "Reconciling";
  if (status.syncState === "unauthorized") return "Unauthorized";
  if (status.syncState === "incompatible") return "Incompatible";
  if (status.syncState === "offline") return "Offline";
  if (status.syncState === "error") return "Error";
  return "Starting";
}

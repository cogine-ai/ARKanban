import type { MessageSearchHit } from "../../../src/contracts";
import type { MessageSearchFilters, TranscriptArchiveStatus } from "../api";

export function messageSearchIssue(filters: MessageSearchFilters): "empty" | "scope" | "range" | undefined {
  if (!filters.q.trim()) return "empty";
  if ([filters.from, filters.to].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    || (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)) return "range";
  if ([...filters.q.trim()].length < 3 && !filters.agentId?.trim() && !filters.sessionKey?.trim() && filters.from === undefined) return "scope";
  return undefined;
}

/** Groups cover the returned hits, never the entire matching archive. */
export function groupMessageHits(hits: MessageSearchHit[]) {
  const groups = new Map<string, { key: string; label: string; agentId: string; hits: MessageSearchHit[] }>();
  for (const hit of hits) {
    const key = hit.message.sessionKey;
    let group = groups.get(key);
    if (!group) { group = { key, label: hit.sessionLabel, agentId: hit.agentId, hits: [] }; groups.set(key, group); }
    group.hits.push(hit);
  }
  return [...groups.values()];
}

export function archiveSearchState(archive: TranscriptArchiveStatus): { label: string; tone: "neutral" | "warn"; empty: string } {
  if (!archive.enabled) return { label: archive.messageCount > 0 ? "Sync off · saved messages searchable" : "Archive off", tone: "neutral", empty: "No saved messages" };
  if (archive.sync?.capacity === "full") return { label: "New messages paused", tone: "warn", empty: "Archive at capacity" };
  if (archive.sync?.capacity === "paused") return { label: "Backfill paused", tone: "warn", empty: "Waiting for archive" };
  if (archive.sync?.skipped === "unavailable") return { label: "Archive unavailable", tone: "warn", empty: "Messages unavailable from source" };
  if (archive.sync?.skipped === "not_connected") return { label: "Source offline", tone: "warn", empty: "Waiting for source" };
  if (archive.sync?.skipped === "primary_sync_failed") return { label: "Sync paused", tone: "warn", empty: "Waiting for source sync" };
  if (archive.sync?.errorCode) return { label: "Last sync failed", tone: "warn", empty: "Waiting for archive" };
  return { label: "Local archive", tone: "neutral", empty: "Waiting for archive" };
}

export function messageSnippet(content: string, query: string, radius = 100): string {
  const at = content.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - radius);
  const end = Math.min(content.length, (at < 0 ? 0 : at) + Math.max(query.length, 1) + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

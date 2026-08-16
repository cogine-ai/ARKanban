import type {
  ActivityDetail,
  ActivityItem,
  ActivitySnapshot,
  AgentOverview,
  ArchivedMessage,
  CollectorStatus,
  SessionRecord,
  SessionSignalGrade,
  SessionSignals,
  SessionSummary,
  SessionUsage,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
  TranscriptSyncState,
} from "../../src/contracts";
import type { SessionSort } from "../../src/storage/keyset-cursor";

/** Counts and settings for the local transcript archive; never message text. */
export type TranscriptArchiveStatus = {
  enabled: boolean;
  retentionDays: number;
  maxBytes: number;
  messageCount: number;
  contentBytes: number;
  sync: { sessions: number; inserted: number; capacity: "ok" | "paused"; errorCode?: string; skipped?: string } | null;
};

export type SessionListFilters = {
  agentId?: string;
  state?: "active" | "terminal" | "archived";
  grade?: SessionSignalGrade;
  sort?: SessionSort;
};

/** A session archive plus everything the detail page shows beside it. */
export type SessionDetail = SessionRecord & {
  usage?: SessionUsage;
  signals?: SessionSignals;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

function sessionQuery(filters: SessionListFilters, cursor: string | undefined, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.agentId) params.set("agentId", filters.agentId);
  if (filters.state) params.set("state", filters.state);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.sort) params.set("sort", filters.sort);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export const collectorApi = {
  status: () => getJson<CollectorStatus>("/api/v1/meta"),
  snapshot: () => getJson<ActivitySnapshot>("/api/v1/snapshot"),
  settledGroups: (range: SettledRange) => getJson<SettledGroupSnapshot>(`/api/v1/settled-groups?range=${range}`),
  settledSeriesRuns: (seriesKey: string, range: SettledRange, rangeEnd: number) => getJson<SettledSeriesRuns>(
    `/api/v1/settled-groups/${encodeURIComponent(seriesKey)}/runs?range=${range}&rangeEnd=${rangeEnd}`,
  ),
  detail: (id: string) => getJson<ActivityDetail>(`/api/v1/activities/${encodeURIComponent(id)}`),
  agents: () => getJson<{ agents: AgentOverview[] }>("/api/v1/agents"),
  transcriptStatus: () => getJson<TranscriptArchiveStatus>("/api/v1/transcripts/status"),
  sessions: (filters: SessionListFilters, cursor?: string, limit = 50) =>
    getJson<{ items: SessionSummary[]; nextCursor?: string }>(
      `/api/v1/sessions?${sessionQuery(filters, cursor, limit)}`,
    ),
  session: (sessionKey: string) => getJson<SessionDetail>(`/api/v1/sessions/${encodeURIComponent(sessionKey)}`),
  sessionActivities: (sessionKey: string) =>
    getJson<{ activities: ActivityItem[] }>(`/api/v1/sessions/${encodeURIComponent(sessionKey)}/activities`),
  sessionMessages: (sessionKey: string, afterSeq?: number) =>
    getJson<{ messages: ArchivedMessage[]; sync: TranscriptSyncState }>(
      `/api/v1/sessions/${encodeURIComponent(sessionKey)}/messages${afterSeq === undefined ? "" : `?afterSeq=${afterSeq}`}`,
    ),
};

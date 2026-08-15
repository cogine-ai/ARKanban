import type {
  ActivityDetail,
  ActivitySnapshot,
  AgentOverview,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
} from "../../src/contracts";

/** Counts and settings for the local transcript archive; never message text. */
export type TranscriptArchiveStatus = {
  enabled: boolean;
  retentionDays: number;
  maxBytes: number;
  messageCount: number;
  contentBytes: number;
  sync: { sessions: number; inserted: number; capacity: "ok" | "paused"; errorCode?: string; skipped?: string } | null;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
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
};

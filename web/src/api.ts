import type {
  ActivityDetail,
  ActivitySnapshot,
  CollectorStatus,
  SettledGroupSnapshot,
  SettledRange,
  SettledSeriesRuns,
} from "../../src/contracts";

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
};

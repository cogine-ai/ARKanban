import type { ActivityDetail, ActivitySnapshot, CollectorStatus } from "../../src/contracts";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const collectorApi = {
  status: () => getJson<CollectorStatus>("/api/v1/meta"),
  snapshot: () => getJson<ActivitySnapshot>("/api/v1/snapshot"),
  detail: (id: string) => getJson<ActivityDetail>(`/api/v1/activities/${encodeURIComponent(id)}`),
};

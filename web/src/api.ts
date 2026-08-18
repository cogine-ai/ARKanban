import type {
  ActivityDetail,
  ActivityItem,
  ActivitySnapshot,
  AgentOverview,
  ArchivedMessage,
  CollectorStatus,
  MessageSearchResult,
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
  filePermissionsEnforced: boolean;
  messageCount: number;
  contentBytes: number;
  sync: {
    sessions: number;
    inserted: number;
    capacity: "ok" | "paused" | "full";
    errorCode?: string;
    skipped?: string;
  } | null;
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

/** One agent plus its most recent sessions; the full list lives on `/sessions`. */
export type AgentDetail = {
  agent: AgentOverview;
  sessions: { items: SessionSummary[]; nextCursor?: string };
};

export type MessageSearchFilters = {
  q: string;
  agentId?: string;
  sessionKey?: string;
  from?: number;
  to?: number;
};

/**
 * Reads the error the server actually sent.
 *
 * The API answers a rejected request with a machine code and often a `hint`
 * naming the way out — `query_too_short` says to narrow by agent or time. Only
 * showing "400 Bad Request" would throw that away and leave the reader guessing
 * at a limit the server was willing to state.
 */
async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; hint?: string; supported?: string[] };
    const code = body.error?.replaceAll("_", " ");
    const detail = body.hint ?? (body.supported ? `supported: ${body.supported.join(", ")}` : undefined);
    if (code) return detail ? `${code} — ${detail}` : code;
  } catch {
    // Not a JSON body; the status line is all there is.
  }
  return `${response.status} ${response.statusText}`;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as T;
}

/** True for the rejection a cancelled request produces, which is not an error to show. */
export function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
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

/**
 * How many transcript messages one page request asks for.
 *
 * Stated by the caller rather than left to the server's default, because the
 * "Load N more" button names this number: reading it off an unstated default made
 * the label a guess that would quietly go wrong if the default ever moved.
 */
export const TRANSCRIPT_PAGE_SIZE = 200;

export const collectorApi = {
  status: () => getJson<CollectorStatus>("/api/v1/meta"),
  snapshot: () => getJson<ActivitySnapshot>("/api/v1/snapshot"),
  settledGroups: (range: SettledRange) => getJson<SettledGroupSnapshot>(`/api/v1/settled-groups?range=${range}`),
  settledSeriesRuns: (seriesKey: string, range: SettledRange, rangeEnd: number) => getJson<SettledSeriesRuns>(
    `/api/v1/settled-groups/${encodeURIComponent(seriesKey)}/runs?range=${range}&rangeEnd=${rangeEnd}`,
  ),
  detail: (id: string) => getJson<ActivityDetail>(`/api/v1/activities/${encodeURIComponent(id)}`),
  agents: () => getJson<{ agents: AgentOverview[] }>("/api/v1/agents"),
  agent: (agentId: string) => getJson<AgentDetail>(`/api/v1/agents/${encodeURIComponent(agentId)}`),
  /**
   * Takes a signal because a search is the one read a reader outruns: a trigram
   * query over the archive costs real work, and every keystroke that leaves one
   * running is work spent on an answer nobody will see.
   */
  searchMessages: (filters: MessageSearchFilters, options: { limit?: number; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams({ q: filters.q, limit: String(options.limit ?? 50) });
    if (filters.agentId) params.set("agentId", filters.agentId);
    if (filters.sessionKey) params.set("sessionKey", filters.sessionKey);
    if (filters.from !== undefined) params.set("from", String(filters.from));
    if (filters.to !== undefined) params.set("to", String(filters.to));
    return getJson<MessageSearchResult>(`/api/v1/search/messages?${params.toString()}`, options.signal);
  },
  transcriptStatus: () => getJson<TranscriptArchiveStatus>("/api/v1/transcripts/status"),
  sessions: (filters: SessionListFilters, cursor?: string, limit = 50) =>
    getJson<{ items: SessionSummary[]; nextCursor?: string }>(
      `/api/v1/sessions?${sessionQuery(filters, cursor, limit)}`,
    ),
  session: (sessionKey: string) => getJson<SessionDetail>(`/api/v1/sessions/${encodeURIComponent(sessionKey)}`),
  sessionActivities: (sessionKey: string) =>
    getJson<{ activities: ActivityItem[] }>(`/api/v1/sessions/${encodeURIComponent(sessionKey)}/activities`),
  sessionMessages: (sessionKey: string, afterSeq?: number) => {
    const params = new URLSearchParams({ limit: String(TRANSCRIPT_PAGE_SIZE) });
    if (afterSeq !== undefined) params.set("afterSeq", String(afterSeq));
    return getJson<{ messages: ArchivedMessage[]; sync: TranscriptSyncState }>(
      `/api/v1/sessions/${encodeURIComponent(sessionKey)}/messages?${params.toString()}`,
    );
  },
};

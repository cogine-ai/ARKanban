import type { SessionSignalGrade } from "../../../src/contracts";
import type { SessionSort } from "../../../src/storage/keyset-cursor";
import type { MessageSearchFilters, SessionListFilters } from "../api";

export type SessionsMode = "sessions" | "messages";
export const SESSION_STATES = ["active", "terminal", "archived"] as const;
export const SESSION_GRADES: SessionSignalGrade[] = ["A", "B", "C", "D", "F", "unscored"];
export const SESSION_SORTS: Array<{ value: SessionSort; label: string }> = [
  { value: "lastActivity", label: "Last activity" },
  { value: "grade", label: "Worst grade" },
  { value: "cost", label: "Cost" },
  { value: "duration", label: "Duration" },
];
export const SESSION_FILTER_KEYS = ["agentId", "state", "grade", "sort"] as const;
export const MESSAGE_FILTER_KEYS = ["q", "messageAgentId", "sessionKey", "from", "to"] as const;

// The same fixed row height is used at every breakpoint. Small screens move
// metadata onto a second line rather than changing the virtual window's units.
export const SESSION_ROW_HEIGHT = 72;
export const SESSION_OVERSCAN = 8;
export const SESSION_VIRTUALIZE_ABOVE = 100;

export function readSessionsMode(params: URLSearchParams): SessionsMode {
  const explicit = params.get("mode");
  if (explicit === "sessions" || explicit === "messages") return explicit;
  return params.has("q") ? "messages" : "sessions";
}

export function sessionFilterSignature(params: URLSearchParams): string {
  const filtered = new URLSearchParams();
  for (const key of SESSION_FILTER_KEYS) {
    const value = params.get(key);
    if (value) filtered.set(key, value);
  }
  return filtered.toString();
}

export function readSessionFilters(params: URLSearchParams): SessionListFilters {
  const state = params.get("state");
  const grade = params.get("grade");
  const sort = params.get("sort");
  return {
    ...(params.get("agentId") ? { agentId: params.get("agentId")! } : {}),
    ...(state && (SESSION_STATES as readonly string[]).includes(state) ? { state: state as SessionListFilters["state"] } : {}),
    ...(grade && SESSION_GRADES.includes(grade as SessionSignalGrade) ? { grade: grade as SessionSignalGrade } : {}),
    ...(sort && SESSION_SORTS.some((entry) => entry.value === sort) ? { sort: sort as SessionSort } : {}),
  };
}

export function readMessageFilters(params: URLSearchParams): MessageSearchFilters {
  // Old shared-filter links used agentId for both lists. In explicit modes the
  // controls have separate scopes, so an inactive session filter cannot narrow
  // the archive behind the reader's back.
  const agentId = (params.get("messageAgentId") ?? (!params.has("mode") ? params.get("agentId") : null))?.trim();
  const sessionKey = params.get("sessionKey")?.trim();
  const from = params.get("from");
  const to = params.get("to");
  return {
    q: params.get("q")?.trim() ?? "",
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(from !== null ? { from: from.trim() ? Number(from) : NaN } : {}),
    ...(to !== null ? { to: to.trim() ? Number(to) : NaN } : {}),
  };
}

export type MessageValidation = "empty" | "range-required" | "invalid-range";
export function validateMessageFilters(filters: MessageSearchFilters): MessageValidation | undefined {
  const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if ((filters.from !== undefined && !validTimestamp(filters.from)) ||
      (filters.to !== undefined && !validTimestamp(filters.to)) ||
      (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)) return "invalid-range";
  const query = filters.q.trim();
  if (!query) return "empty";
  if ([...query].length < 3 && !filters.agentId?.trim() && !filters.sessionKey?.trim() && filters.from === undefined) return "range-required";
  return undefined;
}

export function setSessionsMode(params: URLSearchParams, mode: SessionsMode): URLSearchParams {
  const next = new URLSearchParams(params);
  if (!params.has("mode") && params.has("q") && params.get("agentId") && !params.has("messageAgentId")) {
    next.set("messageAgentId", params.get("agentId")!);
  }
  next.set("mode", mode);
  return next;
}

export function localDateInput(timestamp?: number): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function sessionWindow(total: number, scrollTop: number, viewportHeight: number): { first: number; count: number; virtualized: boolean } {
  const virtualized = total > SESSION_VIRTUALIZE_ABOVE;
  return {
    first: virtualized ? Math.max(0, Math.floor(scrollTop / SESSION_ROW_HEIGHT) - SESSION_OVERSCAN) : 0,
    count: virtualized ? Math.ceil(viewportHeight / SESSION_ROW_HEIGHT) + SESSION_OVERSCAN * 2 : total,
    virtualized,
  };
}

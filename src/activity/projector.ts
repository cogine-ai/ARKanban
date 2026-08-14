import { createHash, randomUUID } from "node:crypto";
import type {
  ActivityAttention,
  ActivityItem,
  ActivityOutcome,
  ActivityPhase,
  ActivityStage,
  ActivityState,
  EvidenceState,
} from "../contracts.js";

export type RawTaskSummary = Record<string, unknown>;
export type RawSessionRow = Record<string, unknown>;

export type ActivityWrite = ActivityItem & {
  sourceKey: string;
  taskId?: string;
  runRef?: string;
  sessionKey?: string;
  parentTaskId?: string;
  observation?: {
    source: "task" | "session" | "events" | "collector";
    kind: string;
    phase?: ActivityPhase;
    status?: string;
    toolName?: string;
    occurredAt: number;
  };
};

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function stageFor(state: ActivityState, phase: ActivityPhase, attention: ActivityAttention): ActivityStage {
  if (state === "terminal") return "settled";
  if (state === "queued") return "incoming";
  if (state === "active" && (phase === "waiting_approval" || attention === "waiting")) return "waiting";
  if (state === "active") return "in_flight";
  return "unresolved";
}

export function stableTaskActivityId(taskId: string): string {
  return `task:ta_${createHash("sha256").update(taskId).digest("base64url").slice(0, 18)}`;
}

export function newAttemptActivityId(): string {
  return `attempt:ri_${randomUUID().replaceAll("-", "")}`;
}

function taskLifecycle(status: string, terminalOutcome?: string): {
  state: ActivityState;
  outcome: ActivityOutcome;
  attention: ActivityAttention;
} {
  switch (status) {
    case "queued":
      return { state: "queued", outcome: "none", attention: "none" };
    case "running":
      return { state: "active", outcome: "none", attention: "none" };
    case "completed":
      return terminalOutcome === "blocked"
        ? { state: "terminal", outcome: "blocked", attention: "blocked" }
        : { state: "terminal", outcome: "succeeded", attention: "none" };
    case "failed":
      return { state: "terminal", outcome: "failed", attention: "error" };
    case "cancelled":
      return { state: "terminal", outcome: "cancelled", attention: "none" };
    case "timed_out":
      return { state: "terminal", outcome: "timed_out", attention: "error" };
    default:
      return { state: "unknown", outcome: "unknown", attention: "partial" };
  }
}

export function taskToActivity(task: RawTaskSummary, now = Date.now()): ActivityWrite | null {
  const taskId = stringOrUndefined(task.taskId) ?? stringOrUndefined(task.id);
  if (!taskId) return null;
  const status = stringOrUndefined(task.status) ?? "unknown";
  const terminalOutcome = stringOrUndefined(task.terminalOutcome);
  const lifecycle = taskLifecycle(status, terminalOutcome);
  const createdAt = numberOrUndefined(task.createdAt);
  const startedAt = numberOrUndefined(task.startedAt);
  const endedAt = numberOrUndefined(task.endedAt);
  const updatedAt = numberOrUndefined(task.updatedAt) ?? endedAt ?? startedAt ?? createdAt ?? now;
  const agentId = stringOrUndefined(task.agentId) ?? "Unattributed";
  const title = stringOrUndefined(task.title) ?? `${stringOrUndefined(task.runtime) ?? "OpenClaw"} task`;
  const phase: ActivityPhase = lifecycle.state === "active" && stringOrUndefined(task.lastToolName) ? "tool" : "none";
  const evidence: EvidenceState[] = [{ source: "task", health: "snapshot", observedAt: now }];

  return {
    id: stableTaskActivityId(taskId),
    kind: "task",
    origin: "task_ledger",
    catalog: lifecycle.state === "terminal" ? "terminal_history" : "operational",
    sourceKey: `task:${taskId}`,
    taskId,
    ...(stringOrUndefined(task.runId) ? { runRef: stringOrUndefined(task.runId) } : {}),
    ...(stringOrUndefined(task.sessionKey) ? { sessionKey: stringOrUndefined(task.sessionKey) } : {}),
    ...(stringOrUndefined(task.parentTaskId) ? { parentTaskId: stringOrUndefined(task.parentTaskId) } : {}),
    ...(stringOrUndefined(task.flowId) ? { flowId: stringOrUndefined(task.flowId) } : {}),
    agentId,
    ...(stringOrUndefined(task.runtime) ? { runtime: stringOrUndefined(task.runtime) } : {}),
    state: lifecycle.state,
    outcome: lifecycle.outcome,
    phase,
    attention: lifecycle.attention,
    stage: stageFor(lifecycle.state, phase, lifecycle.attention),
    freshness: "live",
    title,
    ...(stringOrUndefined(task.progressSummary) ? { progressSummary: stringOrUndefined(task.progressSummary) } : {}),
    ...(stringOrUndefined(task.lastToolName) ? { lastToolName: stringOrUndefined(task.lastToolName) } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    updatedAt,
    lastObservedAt: now,
    evidence,
    observation: {
      source: "task",
      kind: "task_snapshot",
      status,
      ...(stringOrUndefined(task.lastToolName) ? { toolName: stringOrUndefined(task.lastToolName) } : {}),
      occurredAt: updatedAt,
    },
  };
}

export function sessionAgentId(session: RawSessionRow): string {
  return stringOrUndefined(session.agentId) ?? "Unattributed";
}

export function sessionKey(session: RawSessionRow): string | undefined {
  return stringOrUndefined(session.key) ?? stringOrUndefined(session.sessionKey);
}

export function sessionTitle(session: RawSessionRow): string {
  return stringOrUndefined(session.label) ?? stringOrUndefined(session.displayName) ?? "Interactive run";
}

export function sessionRunRefs(session: RawSessionRow): string[] {
  return Array.isArray(session.activeRunIds)
    ? session.activeRunIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

export function sessionIsActive(session: RawSessionRow): boolean {
  return session.hasActiveRun === true;
}

export function attemptPatch(params: {
  id: string;
  sourceKey: string;
  origin: "online" | "session_segment";
  agentId: string;
  title: string;
  now: number;
  runRef?: string;
  sessionKey?: string;
  state: ActivityState;
  outcome?: ActivityOutcome;
  phase?: ActivityPhase;
  attention?: ActivityAttention;
  lastToolName?: string;
  startedAt?: number;
  endedAt?: number;
  source: "session" | "events";
  eventKind: string;
  status?: string;
}): ActivityWrite {
  const outcome = params.outcome ?? (params.state === "terminal" ? "unknown" : "none");
  const phase = params.phase ?? (params.state === "active" ? "unknown" : "none");
  const attention = params.attention ?? "none";
  return {
    id: params.id,
    kind: "attempt",
    origin: params.origin,
    catalog: params.state === "terminal" ? "terminal_history" : "operational",
    sourceKey: params.sourceKey,
    ...(params.runRef ? { runRef: params.runRef } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    agentId: params.agentId,
    state: params.state,
    outcome,
    phase,
    attention,
    stage: stageFor(params.state, phase, attention),
    freshness: "live",
    title: params.title,
    ...(params.lastToolName ? { lastToolName: params.lastToolName } : {}),
    ...(params.startedAt !== undefined ? { startedAt: params.startedAt } : {}),
    ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
    updatedAt: params.now,
    lastObservedAt: params.now,
    evidence: [{ source: params.source, health: params.source === "events" ? "live" : "snapshot", observedAt: params.now }],
    observation: {
      source: params.source,
      kind: params.eventKind,
      phase,
      ...(params.status ? { status: params.status } : {}),
      ...(params.lastToolName ? { toolName: params.lastToolName } : {}),
      occurredAt: params.now,
    },
  };
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return stringOrUndefined(record[key]);
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return numberOrUndefined(record[key]);
}

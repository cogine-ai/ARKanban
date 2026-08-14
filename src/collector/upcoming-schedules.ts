import type { UpcomingSchedule } from "../contracts.js";

export const UPCOMING_WINDOW_MINUTES = 60;
export const DUE_GRACE_MINUTES = 3;

const UPCOMING_WINDOW_MS = UPCOMING_WINDOW_MINUTES * 60_000;
const DUE_GRACE_MS = DUE_GRACE_MINUTES * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function selectUpcomingSchedules(
  jobs: Array<Record<string, unknown>>,
  options: { now: number; defaultAgentId?: string },
): { items: UpcomingSchedule[]; omittedAgentCount: number } {
  const items: UpcomingSchedule[] = [];
  let omittedAgentCount = 0;

  for (const job of jobs) {
    if (job.enabled !== true) continue;
    const jobId = stringValue(job.id);
    if (!jobId) continue;
    const state = record(job.state);
    const nextRunAt = numberValue(state.nextRunAtMs) ?? numberValue(job.nextRunAtMs);
    if (nextRunAt === undefined || nextRunAt < options.now - DUE_GRACE_MS || nextRunAt > options.now + UPCOMING_WINDOW_MS) continue;

    const agentId = stringValue(job.agentId) ?? stringValue(options.defaultAgentId);
    if (!agentId) {
      omittedAgentCount += 1;
      continue;
    }

    const schedule = record(job.schedule);
    const timezone = stringValue(schedule.tz);
    items.push({
      id: `cron:${jobId}`,
      jobId,
      agentId,
      title: stringValue(job.name) ?? "Scheduled job",
      nextRunAt,
      scheduleKind: stringValue(schedule.kind) ?? "unknown",
      ...(timezone ? { timezone } : {}),
    });
  }

  items.sort((left, right) => left.nextRunAt - right.nextRunAt || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { items, omittedAgentCount };
}

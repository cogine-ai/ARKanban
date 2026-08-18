import { motion } from "motion/react";
import type { ActivityItem, UpcomingSchedule } from "../../../src/contracts";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { formatHourMinute, formatScheduleRelative, outcomeLabel } from "../lib/format";

export function ActivityCard({
  item,
  selected,
  onSelect,
}: {
  item: ActivityItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const classes = [
    "activity-card",
    item.stage,
    item.state,
    `outcome-${item.outcome}`,
    item.attention !== "none" ? `attention-${item.attention}` : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} data-activity-id={item.id} onClick={onSelect} aria-pressed={selected} title={`${item.title} · ${outcomeLabel(item)}`}>
      <span className="status-dot" />
      <span className="activity-title">{item.title}</span>
      <span className="activity-meta">{item.kind === "task" ? "TASK" : "ATTEMPT"} · {outcomeLabel(item)}</span>
      {item.lastToolName ? <span className="activity-tool">{item.lastToolName}</span> : null}
    </button>
  );
}

export function ScheduleCard({ schedule }: { schedule: UpcomingSchedule }) {
  const now = useScheduleNow();
  return (
    <motion.article
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="activity-card schedule-card incoming border-blue-200/70 bg-blue-50/45 text-slate-900"
      data-schedule-id={schedule.id}
      data-next-run-at={schedule.nextRunAt}
      title={`${schedule.title} · ${formatHourMinute(schedule.nextRunAt)} · ${formatScheduleRelative(schedule.nextRunAt, now)}`}
    >
      <span className="status-dot schedule-clock" aria-hidden="true">◷</span>
      <span className="activity-title">{schedule.title}</span>
      <span className="activity-meta">CRON · {formatHourMinute(schedule.nextRunAt)} · {formatScheduleRelative(schedule.nextRunAt, now)}</span>
    </motion.article>
  );
}

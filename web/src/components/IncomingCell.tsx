import { AnimatePresence, motion } from "motion/react";
import type { ActivityItem, UpcomingSchedule } from "../../../src/contracts";
import { useCellLayout } from "../hooks/use-cell-layout";
import { applyIncomingQuota, sortQueuedActivities } from "../incoming-layout";
import { ActivityCard, ScheduleCard } from "./cards";

function IncomingOverflowCard({
  hiddenQueued,
  hiddenSchedules,
  onOpen,
}: {
  hiddenQueued: number;
  hiddenSchedules: number;
  onOpen: () => void;
}) {
  const title = [hiddenQueued > 0 ? `+${hiddenQueued} queued` : "", hiddenSchedules > 0 ? `+${hiddenSchedules} scheduled` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <motion.button
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className="activity-card incoming-overflow-card incoming border-slate-300 bg-slate-100 text-slate-800"
      data-incoming-overflow
      data-hidden-queued={hiddenQueued}
      data-hidden-schedules={hiddenSchedules}
      title={title}
      onClick={onOpen}
    >
      <span className="status-dot" />
      <span className="activity-title">{title}</span>
      <span className="activity-meta">Incoming cell capacity reached</span>
    </motion.button>
  );
}

export function IncomingCell({
  queued,
  schedules,
  selectedId,
  onSelectActivity,
  onOpenOverflow,
}: {
  queued: ActivityItem[];
  schedules: UpcomingSchedule[];
  selectedId?: string;
  onSelectActivity: (id: string) => void;
  onOpenOverflow: (queued: ActivityItem[], schedules: UpcomingSchedule[]) => void;
}) {
  const { cellRef, layout } = useCellLayout();
  const orderedQueued = sortQueuedActivities(queued);
  const orderedSchedules = [...schedules].sort((left, right) => left.nextRunAt - right.nextRunAt || left.title.localeCompare(right.title));
  const quota = applyIncomingQuota(orderedQueued, orderedSchedules, layout.capacity);
  const hiddenCount = quota.hiddenQueued.length + quota.hiddenSchedules.length;
  return (
    <div
      ref={cellRef}
      className="stage-cell stage-incoming"
      data-cell-layout={layout.mode}
      data-cell-capacity={layout.capacity}
      data-visible-cards={quota.visibleQueued.length + quota.visibleSchedules.length + (hiddenCount > 0 ? 1 : 0)}
    >
      <AnimatePresence initial={false}>
        {quota.visibleQueued.map((item) => (
          <ActivityCard key={item.id} item={item} selected={item.id === selectedId} onSelect={() => onSelectActivity(item.id)} />
        ))}
        {quota.visibleSchedules.map((schedule) => <ScheduleCard key={schedule.id} schedule={schedule} />)}
        {hiddenCount > 0 ? (
          <IncomingOverflowCard
            key="incoming-overflow"
            hiddenQueued={quota.hiddenQueued.length}
            hiddenSchedules={quota.hiddenSchedules.length}
            onOpen={() => onOpenOverflow(quota.hiddenQueued, quota.hiddenSchedules)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export type IncomingQuota<TQueued, TScheduled> = {
  visibleQueued: TQueued[];
  visibleSchedules: TScheduled[];
  hiddenQueued: TQueued[];
  hiddenSchedules: TScheduled[];
};

export function applyIncomingQuota<TQueued, TScheduled>(
  queued: TQueued[],
  schedules: TScheduled[],
  capacity: number,
): IncomingQuota<TQueued, TScheduled> {
  if (queued.length + schedules.length <= capacity) {
    return {
      visibleQueued: queued,
      visibleSchedules: schedules,
      hiddenQueued: [],
      hiddenSchedules: [],
    };
  }

  const visibleSlots = Math.max(0, capacity - 1);
  const visibleQueued = queued.slice(0, visibleSlots);
  const remainingSlots = visibleSlots - visibleQueued.length;
  const visibleSchedules = schedules.slice(0, remainingSlots);
  return {
    visibleQueued,
    visibleSchedules,
    hiddenQueued: queued.slice(visibleQueued.length),
    hiddenSchedules: schedules.slice(visibleSchedules.length),
  };
}

export function sortQueuedActivities<T extends { id: string; createdAt?: number; updatedAt: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const time = (left.createdAt ?? left.updatedAt) - (right.createdAt ?? right.updatedAt);
    return time || left.id.localeCompare(right.id);
  });
}

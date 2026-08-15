import { useEffect, useState } from "react";

/** Ticks every 30s so "in Nm" countdowns stay honest without a per-card timer. */
export function useScheduleNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

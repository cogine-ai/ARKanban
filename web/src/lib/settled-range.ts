import type { SettledRange } from "../../../src/contracts";

export const SETTLED_RANGES: SettledRange[] = ["24h", "7d", "30d"];
export const RANGE_STORAGE_KEY = "ar-kanban.settled-range";

export function isSettledRange(value: string | null): value is SettledRange {
  return value === "24h" || value === "7d" || value === "30d";
}

export function initialSettledRange(): SettledRange {
  try {
    const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
    return isSettledRange(stored) ? stored : "7d";
  } catch {
    return "7d";
  }
}

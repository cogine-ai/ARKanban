export type CellLayout = { mode: "compact" | "standard" | "wide"; capacity: 3 | 4 | 8 };

export function initialCellLayout(width: number): CellLayout {
  if (width >= 738) return { mode: "wide", capacity: 8 };
  if (width >= 334) return { mode: "standard", capacity: 4 };
  return { mode: "compact", capacity: 3 };
}

export function nextCellLayout(width: number, current: CellLayout): CellLayout {
  if (current.mode === "compact") {
    if (width >= 738 * 1.12) return { mode: "wide", capacity: 8 };
    return width >= 334 * 1.12 ? { mode: "standard", capacity: 4 } : current;
  }
  if (current.mode === "standard") {
    if (width < 334) return { mode: "compact", capacity: 3 };
    if (width >= 738 * 1.12) return { mode: "wide", capacity: 8 };
    return current;
  }
  if (width < 334) return { mode: "compact", capacity: 3 };
  return width < 738 ? { mode: "standard", capacity: 4 } : current;
}

export function applyCellQuota<T>(items: T[], capacity: CellLayout["capacity"]): { visible: T[]; hidden: T[] } {
  if (items.length <= capacity) return { visible: items, hidden: [] };
  return {
    visible: items.slice(0, capacity - 1),
    hidden: items.slice(capacity - 1),
  };
}

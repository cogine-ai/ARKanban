import { describe, expect, it } from "vitest";
import { applyCellQuota, initialCellLayout, nextCellLayout } from "./settled-layout";

describe("settled cell layout", () => {
  it("uses the card-size-derived compact, standard, and wide capacities", () => {
    expect(initialCellLayout(333)).toEqual({ mode: "compact", capacity: 3 });
    expect(initialCellLayout(334)).toEqual({ mode: "standard", capacity: 4 });
    expect(initialCellLayout(737)).toEqual({ mode: "standard", capacity: 4 });
    expect(initialCellLayout(738)).toEqual({ mode: "wide", capacity: 8 });
  });

  it("applies upgrade hysteresis and handles direct cross-mode resize jumps", () => {
    expect(nextCellLayout(350, { mode: "compact", capacity: 3 })).toEqual({ mode: "compact", capacity: 3 });
    expect(nextCellLayout(380, { mode: "compact", capacity: 3 })).toEqual({ mode: "standard", capacity: 4 });
    expect(nextCellLayout(900, { mode: "compact", capacity: 3 })).toEqual({ mode: "wide", capacity: 8 });
    expect(nextCellLayout(200, { mode: "wide", capacity: 8 })).toEqual({ mode: "compact", capacity: 3 });
  });

  it("reserves one capacity slot for overflow only when the cell is over quota", () => {
    expect(applyCellQuota([1, 2, 3, 4], 4)).toEqual({ visible: [1, 2, 3, 4], hidden: [] });
    expect(applyCellQuota([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual({ visible: [1, 2, 3], hidden: [4, 5, 6, 7, 8, 9] });
  });
});

import { describe, expect, it } from "vitest";
import { formatDateTime, formatExact, localZoneLabel } from "./lib/format";

const INSTANT = Date.UTC(2026, 7, 18, 3, 54, 12);

/** The zone abbreviation this machine would show, whatever zone it is set to. */
function zoneAbbreviation(): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(INSTANT)
    .find((entry) => entry.type === "timeZoneName");
  return part!.value;
}

describe("absolute timestamps", () => {
  it("names the zone, so a clock time can be placed", () => {
    expect(formatExact(INSTANT)).toContain(zoneAbbreviation());
  });

  it("keeps the compact form free of the zone it repeats on every row", () => {
    expect(formatDateTime(INSTANT)).not.toContain(zoneAbbreviation());
  });

  it("distinguishes a missing timestamp from the epoch", () => {
    expect(formatExact(undefined)).toBe("Not observed");
    expect(formatExact(0)).toBe("Not observed");
  });

  it("labels the zone the page is being read in", () => {
    const label = localZoneLabel();
    expect(label.length).toBeGreaterThan(0);
    expect(label).toContain(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

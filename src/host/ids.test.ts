import { describe, expect, it } from "vitest";
import { isValidHostId, qualifyId, splitQualifiedId } from "./ids.js";

describe("host ids", () => {
  it("accepts stable host id shapes", () => {
    expect(isValidHostId("local")).toBe(true);
    expect(isValidHostId("mac-studio-1")).toBe(true);
    expect(isValidHostId("a")).toBe(true);
    expect(isValidHostId("-bad")).toBe(false);
    expect(isValidHostId("bad id")).toBe(false);
  });

  it("qualifies and splits without double-wrapping", () => {
    expect(qualifyId("host-a", "task:ta_1")).toBe("host-a::task:ta_1");
    expect(qualifyId("host-a", "host-a::task:ta_1")).toBe("host-a::task:ta_1");
    expect(splitQualifiedId("host-a::task:ta_1")).toEqual({ hostId: "host-a", localId: "task:ta_1" });
    expect(splitQualifiedId("task:ta_1")).toBeUndefined();
  });
});

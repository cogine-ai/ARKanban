import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, isSessionSort } from "./keyset-cursor.js";

describe("keyset cursor", () => {
  it("round-trips a cursor", () => {
    const cursor = { sort: "lastActivity", value: 1_700_000_000_000, sessionKey: "agent:a:1" } as const;
    expect(decodeCursor(encodeCursor(cursor), "lastActivity")).toEqual(cursor);
  });

  it("rejects a cursor issued for a different sort", () => {
    const encoded = encodeCursor({ sort: "lastActivity", value: 10, sessionKey: "agent:a:1" });
    expect(decodeCursor(encoded, "duration")).toBeUndefined();
  });

  it("rejects malformed base64", () => {
    expect(decodeCursor("not-a-cursor", "lastActivity")).toBeUndefined();
  });

  it("rejects a payload with the wrong shape", () => {
    const encoded = Buffer.from(JSON.stringify(["lastActivity", 10]), "utf8").toString("base64url");
    expect(decodeCursor(encoded, "lastActivity")).toBeUndefined();
  });

  it("rejects a non-numeric sort value", () => {
    const encoded = Buffer.from(JSON.stringify(["lastActivity", "10", "agent:a:1"]), "utf8").toString("base64url");
    expect(decodeCursor(encoded, "lastActivity")).toBeUndefined();
  });

  it("rejects an empty session key, which would break the tiebreaker", () => {
    const encoded = Buffer.from(JSON.stringify(["lastActivity", 10, ""]), "utf8").toString("base64url");
    expect(decodeCursor(encoded, "lastActivity")).toBeUndefined();
  });

  it("does not leak the sort key as a readable query parameter", () => {
    const encoded = encodeCursor({ sort: "lastActivity", value: 10, sessionKey: "agent:a:1" });
    expect(encoded).not.toContain("lastActivity");
  });

  it("recognises only collected sorts", () => {
    expect(isSessionSort("lastActivity")).toBe(true);
    expect(isSessionSort("cost")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { readMessageFilters, readSessionFilters, readSessionsMode, SESSION_ROW_HEIGHT, sessionFilterSignature, sessionWindow, setSessionsMode, validateMessageFilters } from "./session-filters";

describe("session and message scopes", () => {
  it("keeps legacy search links useful while explicit modes have independent agents", () => {
    const legacy = new URLSearchParams("q=release&agentId=writer&state=active&grade=F");
    expect(readSessionsMode(legacy)).toBe("messages");
    expect(readMessageFilters(legacy)).toEqual({ q: "release", agentId: "writer" });
    const sessions = setSessionsMode(legacy, "sessions");
    expect(readSessionsMode(sessions)).toBe("sessions");
    expect(readSessionFilters(sessions)).toEqual({ agentId: "writer", state: "active", grade: "F" });
    expect(readMessageFilters(sessions)).toEqual({ q: "release", agentId: "writer" });
    sessions.set("agentId", "ops");
    const messages = setSessionsMode(sessions, "messages");
    expect(readMessageFilters(messages)).toEqual({ q: "release", agentId: "writer" });
    expect(readSessionFilters(messages).agentId).toBe("ops");
  });

  it("does not send list filters as message filters or search filters as list filters", () => {
    const params = new URLSearchParams("mode=messages&q=release&messageAgentId=ops&agentId=writer&state=archived&sort=cost&sessionKey=thread&from=0&to=100");
    expect(readMessageFilters(params)).toEqual({ q: "release", agentId: "ops", sessionKey: "thread", from: 0, to: 100 });
    expect(readSessionFilters(params)).toEqual({ agentId: "writer", state: "archived", sort: "cost" });
    expect(sessionFilterSignature(params)).toBe("agentId=writer&state=archived&sort=cost");
  });

  it("ignores unsupported session filters and retains unknown exact agent IDs", () => {
    expect(readSessionFilters(new URLSearchParams("agentId=unlisted&state=success&grade=Z&sort=score"))).toEqual({ agentId: "unlisted" });
  });
});

describe("message query admission", () => {
  it("counts Unicode code points instead of surrogate halves", () => {
    expect(validateMessageFilters({ q: "😀😀" })).toBe("range-required");
    expect(validateMessageFilters({ q: "😀😀😀" })).toBeUndefined();
    expect(validateMessageFilters({ q: "中文" })).toBe("range-required");
    expect(validateMessageFilters({ q: "   " })).toBe("empty");
  });

  it("requires Agent, session or start time for short queries; end time alone is insufficient", () => {
    expect(validateMessageFilters({ q: "ok", to: 100 })).toBe("range-required");
    expect(validateMessageFilters({ q: "ok", agentId: "ops" })).toBeUndefined();
    expect(validateMessageFilters({ q: "ok", sessionKey: "thread" })).toBeUndefined();
    expect(validateMessageFilters({ q: "ok", from: 0 })).toBeUndefined();
    expect(validateMessageFilters({ q: "ok", agentId: " ", sessionKey: " " })).toBe("range-required");
  });

  it("rejects malformed dates and inverted ranges before requests", () => {
    for (const from of [NaN, Infinity, -1, .5, Number.MAX_SAFE_INTEGER + 1]) expect(validateMessageFilters({ q: "release", from })).toBe("invalid-range");
    expect(validateMessageFilters({ q: "release", from: 101, to: 100 })).toBe("invalid-range");
    expect(validateMessageFilters(readMessageFilters(new URLSearchParams("q=release&from=%20")))).toBe("invalid-range");
    expect(validateMessageFilters(readMessageFilters(new URLSearchParams("q=release&from=")))).toBe("invalid-range");
    expect(readMessageFilters(new URLSearchParams("q=ok&messageAgentId=%20&sessionKey=%20"))).toEqual({ q: "ok" });
  });
});

describe("fixed readable session window", () => {
  it("uses 72px rows with bounded rendering for 600 sessions", () => {
    expect(SESSION_ROW_HEIGHT).toBe(72);
    expect(sessionWindow(100, 0, 560)).toEqual({ first: 0, count: 100, virtualized: false });
    expect(sessionWindow(600, 72 * 200, 560)).toEqual({ first: 192, count: 24, virtualized: true });
    expect(sessionWindow(600, 0, 288).count).toBe(20);
  });
});

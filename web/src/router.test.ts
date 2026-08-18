import { describe, expect, it } from "vitest";
import { matchPath } from "./router";

describe("matchPath", () => {
  it("matches a literal path", () => {
    expect(matchPath("/agents", "/agents")).toEqual({});
  });

  it("treats the root path as matching an empty pattern", () => {
    expect(matchPath("/", "/")).toEqual({});
  });

  it("ignores a trailing slash on either side", () => {
    expect(matchPath("/agents", "/agents/")).toEqual({});
    expect(matchPath("/agents/", "/agents")).toEqual({});
  });

  it("captures a named parameter", () => {
    expect(matchPath("/agents/:agentId", "/agents/builder")).toEqual({ agentId: "builder" });
  });

  it("captures several parameters", () => {
    expect(matchPath("/agents/:agentId/sessions/:sessionKey", "/agents/builder/sessions/s-1")).toEqual({
      agentId: "builder",
      sessionKey: "s-1",
    });
  });

  it("decodes an encoded parameter", () => {
    expect(matchPath("/sessions/:sessionKey", "/sessions/agent%3Abuilder%3Aone")).toEqual({
      sessionKey: "agent:builder:one",
    });
  });

  it("rejects a path with extra segments", () => {
    expect(matchPath("/agents", "/agents/builder")).toBeUndefined();
  });

  it("rejects a path with missing segments", () => {
    expect(matchPath("/agents/:agentId", "/agents")).toBeUndefined();
  });

  it("rejects a different literal at the same depth", () => {
    expect(matchPath("/agents/:agentId", "/sessions/builder")).toBeUndefined();
  });

  it("does not confuse the root with a one-segment path", () => {
    expect(matchPath("/", "/agents")).toBeUndefined();
    expect(matchPath("/agents", "/")).toBeUndefined();
  });
});

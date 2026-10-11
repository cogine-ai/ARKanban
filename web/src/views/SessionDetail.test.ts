// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchivedMessage, MessageSearchResult, TranscriptSyncState } from "../../../src/contracts";
import type { SessionDetail } from "../api";
import { SessionDetailView } from "./SessionDetail";

const api = vi.hoisted(() => ({ session: vi.fn(), sessionActivities: vi.fn(), sessionMessages: vi.fn(), searchMessages: vi.fn() }));
const collector = vi.hoisted(() => ({ subscribeTopics: () => () => {} }));
vi.mock("../api", () => ({ collectorApi: api, TRANSCRIPT_PAGE_SIZE: 200, isAbortError: (cause: unknown) => cause instanceof Error && cause.name === "AbortError" }));
vi.mock("../state/collector-context", () => ({ useCollector: () => collector }));

function session(key: string): SessionDetail {
  return { sessionKey: key, hostId: "desk", agentId: "writer", label: `Session ${key}`, kindHint: "main", archived: false, hasActiveRun: false, lastActivityAt: 100, lastObservedAt: 100, activityCount: 0, coverage: { index: "live", detail: "live", usage: "unreported", messages: "live" }, lineage: {} };
}
function transcript(key: string, content: string, count = 1, seq = 1): { messages: ArchivedMessage[]; sync: TranscriptSyncState } {
  return { messages: [{ id: seq, sessionKey: key, seq, role: "assistant", content, divergent: false, createdAt: 100 }], sync: { sessionKey: key, syncedCount: count, syncedBytes: 100, complete: false } };
}
function searchResult(key: string, query: string, count: number, truncated = false): MessageSearchResult {
  return { mode: "fts", truncated, hits: Array.from({ length: count }, (_, index) => ({
    sessionLabel: `Session ${key}`, agentId: "writer", message: transcript(key, `${query} message ${index + 1}`, count, index + 1).messages[0]!,
  })) };
}

describe("session navigation request ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    api.sessionActivities.mockResolvedValue({ activities: [] });
    api.sessionMessages.mockImplementation(async (key: string) => transcript(key, `Transcript ${key}`));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const mount = async (key: string) => { await act(async () => root.render(createElement(SessionDetailView, { sessionKey: key }))); };
  const enterSearch = async (query: string) => {
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>(".transcript-search input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const settleSearch = async () => { await act(async () => vi.advanceTimersByTimeAsync(250)); };

  it("ignores a prior session's detail response that arrives after navigation", async () => {
    let finishOld!: (record: SessionDetail) => void;
    api.session.mockImplementation((key: string) => key === "old" ? new Promise<SessionDetail>((resolve) => { finishOld = resolve; }) : Promise.resolve(session(key)));
    await mount("old");
    const oldSignal = api.session.mock.calls[0]![1] as AbortSignal;
    await mount("current");
    expect(oldSignal.aborted).toBe(true);
    expect(container.querySelector("h1")?.textContent).toBe("Session current");
    await act(async () => finishOld(session("old")));
    expect(container.querySelector("h1")?.textContent).toBe("Session current");
    expect(container.textContent).not.toContain("Session old");
  });

  it("never appends a previous session's late transcript page to the new session", async () => {
    let finishOldPage!: (page: ReturnType<typeof transcript>) => void;
    api.session.mockImplementation(async (key: string) => session(key));
    api.sessionMessages.mockImplementation((key: string, after?: number) => key === "old" && after !== undefined
      ? new Promise<ReturnType<typeof transcript>>((resolve) => { finishOldPage = resolve; })
      : Promise.resolve(transcript(key, `Transcript ${key}`, key === "old" ? 2 : 1)));
    await mount("old");
    expect(container.querySelector(".transcript-watermark")?.textContent).toContain("2 messages");
    await act(async () => container.querySelector<HTMLButtonElement>(".transcript-more")!.click());
    await mount("current");
    await act(async () => finishOldPage(transcript("old", "Old transcript late", 2, 2)));
    expect(container.querySelector(".transcript")?.textContent).toContain("Transcript current");
    expect(container.querySelector(".transcript")?.textContent).not.toContain("Old transcript late");
    expect(container.querySelector(".transcript-watermark")?.textContent).toContain("partial");
    expect(container.textContent).toContain("Usage unreported");
    expect(container.textContent).not.toContain("$0");
  });

  it("labels the 200 returned matches as limited results when the archive reports more", async () => {
    vi.useFakeTimers();
    api.session.mockImplementation(async (key: string) => session(key));
    api.searchMessages.mockResolvedValue(searchResult("current", "release", 200, true));
    await mount("current");
    await enterSearch("release");
    await settleSearch();
    expect(api.searchMessages).toHaveBeenCalledWith({ q: "release", sessionKey: "current" }, expect.objectContaining({ limit: 200 }));
    expect(container.querySelector(".transcript-search small")?.textContent).toBe("200 shown · Results limited");
    expect(container.querySelectorAll(".transcript-message")).toHaveLength(200);
    expect(container.textContent).not.toContain("200 matching messages");
  });

  it("clears the limited flag on a changed query and keeps exact match counts for complete results", async () => {
    vi.useFakeTimers();
    api.session.mockImplementation(async (key: string) => session(key));
    api.searchMessages.mockImplementation(async ({ q }: { q: string }) => searchResult("current", q, q === "old" ? 2 : 1, q === "old"));
    await mount("current");
    await enterSearch("old");
    await settleSearch();
    expect(container.querySelector(".transcript-search small")?.textContent).toBe("2 shown · Results limited");
    await enterSearch("new");
    expect(container.querySelector(".transcript-search small")?.textContent).toBe("Searching…");
    expect(container.querySelector(".transcript")?.textContent).not.toContain("old message");
    await settleSearch();
    expect(container.querySelector(".transcript-search small")?.textContent).toBe("1 matching message");
    expect(container.querySelector(".transcript")?.textContent).toContain("new message");
    await enterSearch("");
    expect(container.querySelector(".transcript-search small")).toBeNull();
    expect(container.querySelector(".transcript")?.textContent).toContain("Transcript current");
  });

  it("does not restore an old truncated search after a later complete search has answered", async () => {
    vi.useFakeTimers();
    api.session.mockImplementation(async (key: string) => session(key));
    let finishOld!: (result: MessageSearchResult) => void;
    api.searchMessages.mockImplementation(({ q }: { q: string }) => q === "old"
      ? new Promise<MessageSearchResult>((resolve) => { finishOld = resolve; })
      : Promise.resolve(searchResult("current", q, 2)));
    await mount("current");
    await enterSearch("old");
    await settleSearch();
    const signal = api.searchMessages.mock.calls[0]![1].signal as AbortSignal;
    await enterSearch("new");
    expect(signal.aborted).toBe(true);
    await settleSearch();
    await act(async () => finishOld(searchResult("current", "old", 200, true)));
    expect(container.querySelector(".transcript-search small")?.textContent).toBe("2 matching messages");
    expect(container.querySelector(".transcript")?.textContent).not.toContain("old message");
    expect(container.textContent).not.toContain("Results limited");
  });

  it("resets search and its limit indicator when following a different session", async () => {
    vi.useFakeTimers();
    api.session.mockImplementation(async (key: string) => session(key));
    api.searchMessages.mockResolvedValue(searchResult("old", "release", 200, true));
    await mount("old");
    await enterSearch("release");
    await settleSearch();
    expect(container.textContent).toContain("Results limited");
    await mount("current");
    expect(container.querySelector<HTMLInputElement>(".transcript-search input")?.value).toBe("");
    expect(container.querySelector(".transcript-search small")).toBeNull();
    expect(container.querySelector(".transcript")?.textContent).toContain("Transcript current");
    expect(container.textContent).not.toContain("Results limited");
  });
});

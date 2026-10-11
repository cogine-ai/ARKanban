// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageSearchHit, MessageSearchResult } from "../../../src/contracts";
import { TranscriptSearch } from "./TranscriptSearch";

const mocks = vi.hoisted(() => ({ api: { searchMessages: vi.fn(), transcriptStatus: vi.fn() }, context: { status: { host: { role: "node" }, gateway: { connected: true } }, subscribeTopics: vi.fn(() => () => {}) } }));
vi.mock("../api", () => ({ collectorApi: mocks.api, isAbortError: (error: unknown) => error instanceof DOMException && error.name === "AbortError" }));
vi.mock("../state/collector-context", () => ({ useCollector: () => mocks.context }));
const hit = (id: number, patch: Partial<MessageSearchHit["message"]> = {}): MessageSearchHit => ({ sessionLabel: "Release notes", agentId: "writer", message: { id, sessionKey: "agent:writer:notes", sessionId: "generation-new", seq: id, role: "assistant", content: "Preparing the release notes", createdAt: 1000, divergent: false, ...patch } });
const result = (hits: MessageSearchHit[] = [hit(1)]): MessageSearchResult => ({ hits, mode: "fts", truncated: false });

describe("message search surface", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
    mocks.context.status.host.role = "node"; mocks.context.status.gateway.connected = true;
    mocks.api.transcriptStatus.mockResolvedValue({ enabled: true, messageCount: 5, contentBytes: 200, sync: null });
    mocks.api.searchMessages.mockResolvedValue(result());
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const mount = async (props: Parameters<typeof TranscriptSearch>[0]) => { await act(async () => root.render(createElement(TranscriptSearch, props))); };

  it("starts with an archive state and no query request", async () => {
    mocks.api.transcriptStatus.mockResolvedValue({ enabled: false, messageCount: 0, sync: null });
    await mount({ query: "" });
    expect(mocks.api.searchMessages).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Archive off");
    expect(container.querySelector<HTMLAnchorElement>(".message-empty-action")?.href).toContain("/settings?section=archive");
  });
  it("uses only actual message filters and safely highlights text", async () => {
    mocks.api.searchMessages.mockResolvedValue(result([hit(1, { content: '<script>release</script>' })]));
    await mount({ query: "release", agentId: "writer", sessionKey: "scope", from: 10, to: 100 });
    expect(mocks.api.searchMessages.mock.calls[0]?.[0]).toEqual({ q: "release", agentId: "writer", sessionKey: "scope", from: 10, to: 100 });
    expect(container.querySelector(".message-hit-body script")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("release");
    expect(container.querySelector<HTMLAnchorElement>(".message-view-session")?.getAttribute("href")).toBe("/sessions/agent%3Awriter%3Anotes");
  });
  it("keeps returned generations and flags truthful without inventing version numbers", async () => {
    mocks.api.searchMessages.mockResolvedValue({ ...result([hit(1), hit(2, { sessionId: "generation-old", supersededBySessionId: "generation-new", divergent: true })]), truncated: true });
    await mount({ query: "release" });
    expect(container.querySelectorAll(".message-result-group")).toHaveLength(1);
    expect(container.querySelectorAll(".message-hit")).toHaveLength(2);
    expect(container.textContent).toContain("2 shown"); expect(container.textContent).toContain("Previous version"); expect(container.textContent).toContain("Content differs");
    expect(container.textContent).not.toContain("V1");
    expect(container.querySelectorAll(".message-hit-fields[open]")).toHaveLength(0);
  });
  it("offers a clean zero-result state and clear action", async () => {
    const onClear = vi.fn(); mocks.api.searchMessages.mockResolvedValue(result([]));
    await mount({ query: "no-match", onClear });
    expect(container.textContent).toContain("No matching messages");
    expect(container.querySelectorAll(".message-result-group, .session-row")).toHaveLength(0);
    await act(async () => container.querySelector<HTMLButtonElement>(".message-empty-action")!.click()); expect(onClear).toHaveBeenCalledOnce();
  });
  it("does not reject an archive when sync is off or the source is offline", async () => {
    mocks.context.status.gateway.connected = false;
    mocks.api.transcriptStatus.mockResolvedValue({ enabled: false, messageCount: 5, sync: null });
    await mount({ query: "release" });
    expect(mocks.api.searchMessages).toHaveBeenCalledOnce();
    expect(container.querySelectorAll(".message-hit")).toHaveLength(1);
    expect(container.textContent).toContain("saved messages searchable"); expect(container.textContent).toContain("Source offline");
  });
  it("blocks a Unicode-short, end-only query until a real scope is supplied", async () => {
    await mount({ query: "你好", to: 100 }); expect(mocks.api.searchMessages).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choose a search scope");
    await mount({ query: "你好", to: 100, from: 0 }); expect(mocks.api.searchMessages).toHaveBeenCalledOnce();
  });
  it("blocks a reversed range locally", async () => {
    await mount({ query: "release", from: 100, to: 10 }); expect(mocks.api.searchMessages).not.toHaveBeenCalled(); expect(container.textContent).toContain("Check the time range");
  });
  it("aborts previous queries and never displays their late hits under a new term", async () => {
    let finish!: (value: MessageSearchResult) => void;
    mocks.api.searchMessages.mockImplementation((filters: { q: string }) => filters.q === "old" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(result([hit(2, { content: "New query result" })])));
    await mount({ query: "old" }); const oldSignal = mocks.api.searchMessages.mock.calls[0]?.[1].signal as AbortSignal;
    await mount({ query: "new" }); expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(result([hit(1, { content: "Old query result" })])));
    expect(container.textContent).toContain("New query result"); expect(container.textContent).not.toContain("Old query result");
    await mount({ query: "" }); expect(container.querySelectorAll(".message-hit")).toHaveLength(0);
  });
  it("recovers failed searches through a visible retry", async () => {
    mocks.api.searchMessages.mockRejectedValueOnce(new Error("read failed"));
    await mount({ query: "release" }); expect(container.textContent).toContain("Search failed");
    await act(async () => container.querySelector<HTMLButtonElement>(".message-search-error button")!.click());
    expect(container.querySelectorAll(".message-hit")).toHaveLength(1); expect(container.textContent).not.toContain("Search failed");
  });
  it("does not query Hub stubs or label them as zero matches", async () => {
    mocks.context.status.host.role = "hub";
    await mount({ query: "release" });
    expect(mocks.api.searchMessages).not.toHaveBeenCalled(); expect(mocks.api.transcriptStatus).not.toHaveBeenCalled(); expect(container.textContent).toContain("Messages unavailable in aggregate mode"); expect(container.textContent).not.toContain("0");
  });
  it("refreshes sync capacity without requiring new archived messages", async () => {
    await mount({ query: "release" });
    mocks.api.transcriptStatus.mockResolvedValue({ enabled: true, messageCount: 5, sync: { sessions: 0, inserted: 0, capacity: "paused" } });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("Backfill paused");
    mocks.api.transcriptStatus.mockResolvedValue({ enabled: true, messageCount: 5, sync: { sessions: 0, inserted: 0, capacity: "full" } });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).toContain("New messages paused");
    expect(container.querySelectorAll(".message-hit")).toHaveLength(1);
  });
});

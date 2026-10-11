// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../../src/contracts";
import { SessionSource } from "./SessionSource";

const api = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("../api", () => ({ collectorApi: api }));

function session(key: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return { sessionKey: key, hostId: "desk", agentId: "writer", label: `Session ${key}`, kindHint: "main", archived: false, hasActiveRun: true, lastActivityAt: 100, lastObservedAt: 100, activityCount: 1, coverage: { index: "live", detail: "live", usage: "live", messages: "live" }, lineage: {}, ...patch };
}

describe("session source structure", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });
  const mount = async (record: SessionRecord) => { await act(async () => root.render(createElement(SessionSource, { session: record }))); };

  it("resolves and focuses one deduplicated parent node with a real session link", async () => {
    api.session.mockResolvedValue(session("parent", { label: "Draft plan", agentId: "planner" }));
    await mount(session("current", { lineage: { parentSessionKey: "parent", spawnedBy: "parent", spawnDepth: 3 } }));
    expect(api.session).toHaveBeenCalledOnce();
    const source = container.querySelector<HTMLAnchorElement>(".session-source-node")!;
    expect(source.tagName).toBe("A");
    expect(source.getAttribute("href")).toBe("/sessions/parent");
    expect(source.textContent).toContain("Parent · Spawned by");
    expect(source.textContent).toContain("Draft plan");
    expect(source.textContent).toContain("planner");
    expect(container.querySelectorAll(".session-source-node")).toHaveLength(1);
    expect(container.querySelector(".session-current-node")?.getAttribute("tabindex")).toBe("0");
    source.focus();
    expect(document.activeElement).toBe(source);
    expect(container.querySelector<HTMLDetailsElement>(".session-raw-source")?.open).toBe(false);
    expect(container.querySelectorAll(".session-source-node")).toHaveLength(1);
  });

  it("keeps failed lookups and arbitrary spawn actors honest and navigable only when resolved", async () => {
    api.session.mockRejectedValue(new Error("session_not_found"));
    await mount(session("current", { lineage: { parentSessionKey: "missing-parent", spawnedBy: "scheduler" } }));
    expect(api.session).toHaveBeenCalledOnce();
    expect(container.querySelectorAll(".session-source-node[data-unresolved=true]")).toHaveLength(2);
    expect(container.querySelectorAll(".session-source-node[href]")).toHaveLength(0);
    expect(container.textContent).toContain("Source unresolved");
    expect(container.textContent).not.toContain("does not exist");
  });

  it("shows a previous-version reference as copyable context, never as a source link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await mount(session("current", { lineage: { previousSessionId: "previous-generation-7", spawnDepth: 2, subagentRole: "researcher", worktreeBranch: "feature/report" } }));
    expect(api.session).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Source not reported");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll(".session-source-node")).toHaveLength(0);
    await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Copy previous version reference']")!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("previous-generation-7");
    expect(container.textContent).toContain("Copied");
  });

  it("copies a full parent key from the collapsed source fields after opening them", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    api.session.mockResolvedValue(session("agent:planner:very-long-parent-reference", { label: "Parent plan" }));
    await mount(session("current", { lineage: { parentSessionKey: "agent:planner:very-long-parent-reference" } }));
    const fields = container.querySelector<HTMLDetailsElement>(".session-raw-source")!;
    expect(fields.open).toBe(false);
    await act(async () => fields.querySelector<HTMLElement>("summary")!.click());
    expect(fields.open).toBe(true);
    await act(async () => fields.querySelector<HTMLButtonElement>("[aria-label='Copy parent session reference']")!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("agent:planner:very-long-parent-reference");
  });

  it("can retry a temporary lookup failure without pretending the source did not exist", async () => {
    api.session.mockRejectedValueOnce(new Error("network failed")).mockResolvedValueOnce(session("parent", { label: "Recovered source" }));
    await mount(session("current", { lineage: { parentSessionKey: "parent" } }));
    expect(container.textContent).toContain("Source unresolved");
    await act(async () => container.querySelector<HTMLButtonElement>(".session-source-retry")!.click());
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".session-source-node[href='/sessions/parent']")?.textContent).toContain("Recovered source");
    expect(container.querySelector(".session-source-retry")).toBeNull();
  });

  it("aborts old lookups and prevents their late result from replacing the current source", async () => {
    let finishOld!: (value: SessionRecord) => void;
    api.session.mockImplementation((key: string) => key === "old-parent" ? new Promise<SessionRecord>((resolve) => { finishOld = resolve; }) : Promise.resolve(session(key, { label: "New source" })));
    await mount(session("old", { lineage: { parentSessionKey: "old-parent" } }));
    const oldSignal = api.session.mock.calls[0]![1] as AbortSignal;
    await mount(session("new", { lineage: { parentSessionKey: "new-parent" } }));
    expect(oldSignal.aborted).toBe(true);
    expect(container.textContent).toContain("New source");
    await act(async () => finishOld(session("old-parent", { label: "Old source" })));
    expect(container.textContent).not.toContain("Old source");
    expect(container.textContent).toContain("Session new");
  });

  it("rejects a mismatched key or host instead of fabricating a source destination", async () => {
    api.session.mockResolvedValue(session("other", { hostId: "another-host" }));
    await mount(session("current", { lineage: { forkSourceKey: "requested" } }));
    expect(container.querySelector(".session-source-node[href]")).toBeNull();
    expect(container.textContent).toContain("Source unresolved");
  });
});

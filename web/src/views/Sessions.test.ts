// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../../src/contracts";
import { navigate } from "../router";
import { SessionsView } from "./Sessions";

const api = vi.hoisted(() => ({ sessions: vi.fn(), session: vi.fn() }));
const context = vi.hoisted(() => ({ status: { host: { role: "node" } } as { host: { role: string } } | undefined, subscribeTopics: () => () => {} }));
const searchProps = vi.hoisted(() => vi.fn());
const searchMounts = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ collectorApi: api }));
vi.mock("../state/collector-context", () => ({ useCollector: () => context }));
vi.mock("../state/use-agents", () => ({ useAgents: () => ({ agents: [{ id: "writer", displayName: "Writer" }, { id: "ops", displayName: "Operations" }], reload: vi.fn() }) }));
vi.mock("../components/TranscriptSearch", () => ({ TranscriptSearch: (props: unknown) => { useEffect(() => { searchMounts(); }, []); searchProps(props); return createElement("div", { className: "transcript-search" }, "Message results"); } }));

function session(index: number): SessionSummary {
  return { sessionKey: `private-key-${index}`, hostId: "desk", agentId: "writer", label: `Readable session ${index}`, kindHint: "main", archived: false, hasActiveRun: index === 1, activityCount: index, lastActivityAt: 100, lastObservedAt: 100, coverage: { index: "live", detail: "live", usage: "unreported", messages: "live" } };
}

describe("Sessions mode and scope", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    context.status = { host: { role: "node" } };
    api.sessions.mockResolvedValue({ items: [session(1), session(2)] });
    api.session.mockRejectedValue(new Error("Session unresolved"));
    navigate("/sessions", { replace: true });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const mount = async (url = "/sessions") => { await act(async () => { navigate(url); root.render(createElement(SessionsView)); }); };
  const click = async (selector: string) => { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()); };
  const select = async (selector: string, value: string) => { await act(async () => { const control = container.querySelector<HTMLSelectElement>(selector)!; control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); }); };
  const input = async (selector: string, value: string) => { await act(async () => { const control = container.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); }); };
  const submit = async () => { await act(async () => container.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };

  it("renders one result surface and only the filters that apply to it", async () => {
    await mount("/sessions?mode=messages&q=release&state=active&grade=F&sort=cost");
    expect(api.sessions).not.toHaveBeenCalled();
    expect(container.querySelector(".session-list")).toBeNull();
    expect(container.querySelector(".sessions-filters")).toBeNull();
    expect(container.querySelector(".messages-search-form")).not.toBeNull();
    await click("#sessions-mode-sessions");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(container.querySelector(".messages-search-form")).toBeNull();
    expect(container.querySelectorAll(".session-row")).toHaveLength(2);
    expect(api.sessions).toHaveBeenLastCalledWith({ state: "active", grade: "F", sort: "cost" }, undefined);
    expect(container.querySelector(".session-row")!.textContent).not.toContain("private-key");
  });

  it("keeps each mode's Agent and typed query when switching; URL navigation restores submitted scope", async () => {
    await mount("/sessions?agentId=writer&state=active");
    await click("#sessions-mode-messages");
    await input("#message-query", "release");
    await select("#message-agent", "ops");
    expect(searchProps.mock.lastCall?.[0].query).toBe("");
    await click("#sessions-mode-sessions");
    expect(container.querySelector<HTMLSelectElement>("#session-agent")!.value).toBe("writer");
    await click("#sessions-mode-messages");
    expect(container.querySelector<HTMLInputElement>("#message-query")!.value).toBe("release");
    expect(container.querySelector<HTMLSelectElement>("#message-agent")!.value).toBe("ops");
    await submit();
    const submittedUrl = `${window.location.pathname}${window.location.search}`;
    expect(new URLSearchParams(window.location.search).get("messageAgentId")).toBe("ops");
    expect(new URLSearchParams(window.location.search).get("agentId")).toBe("writer");
    expect(searchProps.mock.lastCall?.[0]).toMatchObject({ query: "release", agentId: "ops" });
    await act(async () => navigate("/sessions?mode=messages&q=prior&messageAgentId=writer&from=0"));
    expect(container.querySelector<HTMLInputElement>("#message-query")!.value).toBe("prior");
    await act(async () => { window.history.replaceState({}, "", submittedUrl); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(container.querySelector<HTMLInputElement>("#message-query")!.value).toBe("release");
    expect(container.querySelector<HTMLSelectElement>("#message-agent")!.value).toBe("ops");
  });

  it("admits short searches after choosing a scope and never submits end time alone", async () => {
    await mount("/sessions?mode=messages");
    await input("#message-query", "😀😀");
    await input("#message-to", "2026-10-11T14:00");
    await submit();
    expect(container.querySelector(".messages-validation")?.textContent).toBe("Choose a scope");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(container.querySelector(".messages-scope")?.getAttribute("data-range-needed")).toBe("true");
    expect(window.location.search).not.toContain("q=");
    expect(document.activeElement?.id).toBe("message-agent");
    await select("#message-agent", "writer");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(container.querySelector(".messages-validation")?.textContent).toBe("Ready to search");
    await submit();
    expect(new URLSearchParams(window.location.search).get("q")).toBe("😀😀");
    expect(searchProps.mock.lastCall?.[0]).toMatchObject({ query: "😀😀", agentId: "writer" });
  });

  it("re-runs an explicitly submitted search even when its URL and scope stay the same", async () => {
    await mount("/sessions?mode=messages&q=release&messageAgentId=writer");
    expect(searchMounts).toHaveBeenCalledTimes(1);
    const search = window.location.search;
    await submit();
    expect(window.location.search).toBe(search);
    expect(searchMounts).toHaveBeenCalledTimes(2);
    await submit();
    expect(window.location.search).toBe(search);
    expect(searchMounts).toHaveBeenCalledTimes(3);
  });

  it("hides the previous result whenever the visible query, Agent, session or dates change", async () => {
    await mount("/sessions?mode=messages&q=release&messageAgentId=writer");
    await input("#message-query", "release notes");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(container.querySelector(".messages-validation")?.textContent).toBe("Ready to search");
    await submit();
    expect(container.querySelector(".transcript-search")).not.toBeNull();
    expect(searchProps.mock.lastCall?.[0].query).toBe("release notes");
    await select("#message-agent", "ops");
    expect(container.querySelector(".transcript-search")).toBeNull();
    await submit();
    expect(searchProps.mock.lastCall?.[0].agentId).toBe("ops");
    await input("#message-from", "2026-10-01T09:30");
    expect(container.querySelector(".transcript-search")).toBeNull();
    await submit();
    expect(container.querySelector(".transcript-search")).not.toBeNull();
    await click("#message-session");
    await click(".session-picker-option:nth-child(2)");
    expect(container.querySelector(".transcript-search")).toBeNull();
    await submit();
    expect(searchProps.mock.lastCall?.[0].sessionKey).toBe("private-key-1");
  });

  it("compares displayed minute ranges and normalizes submitted whitespace", async () => {
    const from = new Date("2026-10-01T09:30:12.345").getTime();
    await mount(`/sessions?mode=messages&q=release&from=${from}`);
    expect(container.querySelector(".transcript-search")).not.toBeNull();
    await input("#message-query", " release ");
    expect(container.querySelector(".transcript-search")).toBeNull();
    await submit();
    expect(container.querySelector<HTMLInputElement>("#message-query")?.value).toBe("release");
    expect(container.querySelector(".transcript-search")).not.toBeNull();
    expect(searchProps.mock.lastCall?.[0].query).toBe("release");
  });

  it("waits for Search after editing even when the draft returns to its submitted value", async () => {
    await mount("/sessions?mode=messages&q=release");
    expect(searchMounts).toHaveBeenCalledTimes(1);
    await input("#message-query", "release notes");
    await input("#message-query", "release");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(container.querySelector(".messages-validation")?.textContent).toBe("Ready to search");
    expect(searchMounts).toHaveBeenCalledTimes(1);
    await submit();
    expect(container.querySelector(".transcript-search")).not.toBeNull();
    expect(searchMounts).toHaveBeenCalledTimes(2);
  });

  it("rejects inverted date ranges without replacing the previous submitted query", async () => {
    await mount("/sessions?mode=messages&q=release");
    await input("#message-from", "2026-10-12T14:00");
    await input("#message-to", "2026-10-11T14:00");
    await submit();
    expect(container.querySelector(".messages-validation")?.textContent).toBe("Check the date range");
    expect(container.querySelector(".transcript-search")).toBeNull();
    expect(new URLSearchParams(window.location.search).has("from")).toBe(false);
    expect(searchProps.mock.lastCall?.[0].query).toBe("release");
  });

  it("keeps an unknown deep-linked exact Agent selectable and exposes matching empty state", async () => {
    api.sessions.mockResolvedValue({ items: [] });
    await mount("/sessions?agentId=unknown-agent");
    const agent = container.querySelector<HTMLSelectElement>("#session-agent")!;
    expect(agent.value).toBe("unknown-agent");
    expect([...agent.options].some((option) => option.value === "unknown-agent")).toBe(true);
    expect(container.textContent).toContain("No matching sessions");
    await click(".sessions-empty button");
    expect(window.location.search).toBe("");
  });

  it("does not fetch a stub session list while role is unknown or Hub", async () => {
    context.status = undefined;
    await mount();
    expect(container.textContent).toContain("Loading collector");
    expect(api.sessions).not.toHaveBeenCalled();
    context.status = { host: { role: "hub" } };
    await act(async () => root.render(createElement(SessionsView)));
    expect(container.textContent).toContain("Sessions stay on each collector");
    expect(container.textContent).not.toContain("0 loaded");
    expect(api.sessions).not.toHaveBeenCalled();
    await click("#sessions-mode-messages");
    expect(container.textContent).toContain("Messages stay on each collector");
    expect(searchProps).not.toHaveBeenCalled();
  });

  it("opens a named session picker on demand and chooses a key without submitting the search", async () => {
    await mount("/sessions?mode=messages&q=release&messageAgentId=writer");
    expect(api.sessions).not.toHaveBeenCalled();
    expect(container.querySelector("#message-session")?.textContent).toContain("Any session");
    await click("#message-session");
    expect(api.sessions).toHaveBeenLastCalledWith({ agentId: "writer" }, undefined);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find loaded sessions");
    expect(container.querySelector(".session-picker-options")?.textContent).toContain("Readable session 1");
    expect(container.querySelector(".session-picker-options")?.textContent).toContain("Writer");
    expect(container.querySelector(".session-picker-options")?.textContent).not.toContain("private-key");
    await click(".session-picker-option:nth-child(2)");
    expect(container.querySelector("#message-session")?.textContent).toContain("Readable session 1");
    expect(container.querySelector(".session-scope-picker")).toBeNull();
    expect(document.activeElement?.id).toBe("message-session");
    expect(new URLSearchParams(window.location.search).has("sessionKey")).toBe(false);
    expect(searchProps.mock.lastCall?.[0]).toMatchObject({ query: "release", agentId: "writer" });
    expect(searchProps.mock.lastCall?.[0].sessionKey).toBeUndefined();
    expect(searchMounts).toHaveBeenCalledTimes(1);
    await submit();
    expect(new URLSearchParams(window.location.search).get("sessionKey")).toBe("private-key-1");
    expect(searchProps.mock.lastCall?.[0]).toMatchObject({ sessionKey: "private-key-1" });
    await select("#message-agent", "ops");
    expect(container.querySelector("#message-session")?.textContent).toContain("Readable session 1");
    await submit();
    expect(searchProps.mock.lastCall?.[0]).toMatchObject({ agentId: "ops", sessionKey: "private-key-1" });
  });

  it("filters only loaded names and loads the next real cursor page", async () => {
    api.sessions.mockImplementation(async (_filters: unknown, cursor?: string) => cursor ? { items: [session(3)] } : { items: [session(1), session(2)], nextCursor: "next-page" });
    await mount("/sessions?mode=messages");
    await click("#message-session");
    await input("input[aria-label='Find loaded sessions']", "session 3");
    expect(container.textContent).toContain("No match in loaded sessions");
    expect(container.querySelector(".session-picker-paging")?.textContent).toContain("2 loaded+");
    await click(".session-picker-paging button");
    expect(api.sessions).toHaveBeenLastCalledWith({}, "next-page");
    expect(container.querySelector(".session-picker-options")?.textContent).toContain("Readable session 3");
    expect(container.querySelector(".session-picker-paging")?.textContent).toContain("3 loaded");
    expect(searchMounts).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown URL keys in a folded reference and closes the chooser with Escape", async () => {
    await mount("/sessions?mode=messages&q=release&sessionKey=unresolved-key");
    expect(api.sessions).not.toHaveBeenCalled();
    expect(container.querySelector("#message-session")?.textContent).toContain("Selected session");
    await click("#message-session");
    const details = container.querySelector<HTMLDetailsElement>(".session-picker-reference")!;
    expect(details.open).toBe(false);
    expect(container.querySelector<HTMLInputElement>("input[aria-label='Session key']")?.value).toBe("unresolved-key");
    await act(async () => container.querySelector<HTMLInputElement>("input[aria-label='Find loaded sessions']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".session-scope-picker")).toBeNull();
    expect(document.activeElement?.id).toBe("message-session");
    expect(new URLSearchParams(window.location.search).get("sessionKey")).toBe("unresolved-key");
  });

  it("resolves a known URL session reference to its readable name without loading an index", async () => {
    api.session.mockResolvedValue(session(2));
    await mount("/sessions?mode=messages&q=release&sessionKey=private-key-2");
    expect(api.session).toHaveBeenCalledWith("private-key-2", expect.any(AbortSignal));
    expect(api.sessions).not.toHaveBeenCalled();
    expect(container.querySelector("#message-session")?.textContent).toContain("Readable session 2");
  });

  it("bounds 600-row rendering and keeps the 72px window unit in the rendered list", async () => {
    api.sessions.mockResolvedValue({ items: Array.from({ length: 600 }, (_unused, index) => session(index)) });
    await mount();
    const list = container.querySelector<HTMLDivElement>(".session-list")!;
    expect(list.dataset.virtualized).toBe("true");
    expect(list.style.getPropertyValue("--session-row-height")).toBe("72px");
    expect(container.querySelectorAll(".session-row").length).toBeLessThan(30);
    await act(async () => { list.scrollTop = 72 * 200; list.dispatchEvent(new Event("scroll", { bubbles: true })); });
    expect(container.querySelector(".session-label b")?.textContent).toBe("Readable session 192");
    expect((list.firstElementChild as HTMLElement).style.height).toBe(`${192 * 72}px`);
  });

  it("changes tabs with arrow keys and preserves a visible focus target", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLButtonElement>("#sessions-mode-sessions")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector(".sessions-view")?.getAttribute("data-mode")).toBe("messages");
    expect(document.activeElement?.id).toBe("sessions-mode-messages");
  });
});

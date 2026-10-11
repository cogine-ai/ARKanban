// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptArchiveStatus } from "../api";
import { useTranscriptStatus } from "./use-transcript-status";

const mocks = vi.hoisted(() => ({ status: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() }));
const connection = vi.hoisted(() => ({ gatewayConnected: true, hostId: "desk", pageStream: "open", revision: 1 }));
vi.mock("../api", () => ({ collectorApi: { transcriptStatus: mocks.status } }));
vi.mock("./collector-context", () => ({ useCollector: () => ({
  subscribeTopics: mocks.subscribe,
  status: { host: { id: connection.hostId }, gateway: { connected: connection.gatewayConnected }, revision: connection.revision },
  live: { state: connection.pageStream },
}) }));

let root: Root;
let container: HTMLDivElement;
const archive: TranscriptArchiveStatus = { enabled: false, retentionDays: 180, maxBytes: 2_147_483_648, filePermissionsEnforced: true, messageCount: 3, contentBytes: 125, sync: null };
function Disclosure() {
  const { status, error, reload } = useTranscriptStatus();
  return createElement("div", null,
    createElement("span", null, error ?? (status ? String(status.messageCount) : "Loading")),
    createElement("output", null, status?.sync?.capacity, " ", status?.sync?.skipped),
    createElement("button", { onClick: () => void reload() }, "Retry"),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  vi.useFakeTimers();
  connection.gatewayConnected = true;
  connection.hostId = "desk";
  connection.pageStream = "open";
  connection.revision = 1;
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("can retry a failed archive disclosure without remounting", async () => {
  mocks.status.mockRejectedValueOnce(new Error("Archive unavailable")).mockResolvedValueOnce(archive);
  await act(async () => root.render(createElement(Disclosure)));
  expect(container.textContent).toContain("Archive unavailable");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("span")?.textContent).toBe("3");
});

it("does not let an older refresh overwrite a successful retry", async () => {
  let finishOld!: (status: TranscriptArchiveStatus) => void;
  mocks.status.mockImplementationOnce(() => new Promise<TranscriptArchiveStatus>((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(archive);
  await act(async () => root.render(createElement(Disclosure)));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => finishOld({ ...archive, messageCount: 0 }));
  expect(container.querySelector("span")?.textContent).toBe("3");
});

it("unsubscribes the archive topic listener on leaving the local view", async () => {
  mocks.status.mockResolvedValue(archive);
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.subscribe).toHaveBeenCalledWith(["sessions", "messages"], expect.any(Function));
  await act(async () => root.render(createElement("div", null, "Hub")));
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
});

it("refreshes capacity changes without new messages or topic notifications", async () => {
  mocks.status
    .mockResolvedValueOnce({ ...archive, enabled: true, sync: { sessions: 1, inserted: 0, capacity: "ok" } })
    .mockResolvedValueOnce({ ...archive, enabled: true, sync: { sessions: 0, inserted: 0, capacity: "full" } });
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.status).toHaveBeenCalledTimes(1);
  expect(container.querySelector("output")?.textContent).toContain("ok");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(mocks.status).toHaveBeenCalledTimes(2);
  expect(container.querySelector("span")?.textContent).toBe("3");
  expect(container.querySelector("output")?.textContent).toContain("full");
});

it("lets a slow request complete instead of superseding it on each poll", async () => {
  let finishRead!: (status: TranscriptArchiveStatus) => void;
  mocks.status.mockImplementationOnce(() => new Promise<TranscriptArchiveStatus>((resolve) => { finishRead = resolve; }))
    .mockResolvedValueOnce({ ...archive, messageCount: 4 });
  await act(async () => root.render(createElement(Disclosure)));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.status).toHaveBeenCalledTimes(1);
  await act(async () => finishRead(archive));
  expect(container.querySelector("span")?.textContent).toBe("3");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(mocks.status).toHaveBeenCalledTimes(2);
  expect(container.querySelector("span")?.textContent).toBe("4");
});

it("refreshes on connection primitives without refetching every collector revision", async () => {
  mocks.status.mockResolvedValue(archive);
  await act(async () => root.render(createElement(Disclosure)));
  connection.revision += 1;
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.status).toHaveBeenCalledTimes(1);
  connection.gatewayConnected = false;
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.status).toHaveBeenCalledTimes(2);
  connection.pageStream = "stopped";
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.status).toHaveBeenCalledTimes(3);
  connection.hostId = "other-desk";
  await act(async () => root.render(createElement(Disclosure)));
  expect(mocks.status).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(1);
});

it("reads on focus and visibility return while skipping polls for hidden pages", async () => {
  mocks.status.mockResolvedValue(archive);
  const visibility = vi.spyOn(document, "visibilityState", "get");
  await act(async () => root.render(createElement(Disclosure)));
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.status).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(mocks.status).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(mocks.status).toHaveBeenCalledTimes(3);
});

it("discards an old connected result after refreshing the disconnected status", async () => {
  let finishOld!: (status: TranscriptArchiveStatus) => void;
  mocks.status.mockImplementationOnce(() => new Promise<TranscriptArchiveStatus>((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce({ ...archive, enabled: true, sync: { sessions: 0, inserted: 0, capacity: "ok", skipped: "not_connected" } });
  await act(async () => root.render(createElement(Disclosure)));
  connection.gatewayConnected = false;
  await act(async () => root.render(createElement(Disclosure)));
  expect(container.querySelector("output")?.textContent).toContain("not_connected");
  await act(async () => finishOld({ ...archive, enabled: true, sync: { sessions: 1, inserted: 1, capacity: "ok" } }));
  expect(container.querySelector("output")?.textContent).toContain("not_connected");
});

it("does not let a failed earlier poll replace a newer successful retry", async () => {
  let failPoll!: (cause: Error) => void;
  mocks.status.mockResolvedValueOnce(archive)
    .mockImplementationOnce(() => new Promise<TranscriptArchiveStatus>((_, reject) => { failPoll = reject; }))
    .mockResolvedValueOnce({ ...archive, messageCount: 4 });
  await act(async () => root.render(createElement(Disclosure)));
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  await act(async () => container.querySelector("button")!.click());
  await act(async () => failPoll(new Error("Earlier poll failed")));
  expect(container.querySelector("span")?.textContent).toBe("4");
});

it("cleans up polling and visibility listeners when leaving the local view", async () => {
  mocks.status.mockResolvedValue(archive);
  const removeFocus = vi.spyOn(window, "removeEventListener");
  const removeVisibility = vi.spyOn(document, "removeEventListener");
  await act(async () => root.render(createElement(Disclosure)));
  await act(async () => root.render(createElement("div", null, "Hub")));
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  expect(removeFocus).toHaveBeenCalledWith("focus", expect.any(Function));
  expect(removeVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(mocks.status).toHaveBeenCalledTimes(1);
});

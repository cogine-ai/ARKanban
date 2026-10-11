// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Inspector } from "./Inspector";

vi.mock("../api", () => ({ collectorApi: { detail: () => new Promise(() => {}) } }));

function Harness({ removeOpener = false }: { removeOpener?: boolean }) {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  return createElement("div", null,
    visible ? createElement("button", { onClick: () => setOpen(true), "data-opener": true }, "Open retained activity") : null,
    open ? createElement(Inspector, { id: "desk::retained", onClose: () => { setOpen(false); if (removeOpener) setVisible(false); } }) : null,
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  container.remove();
  vi.unstubAllGlobals();
});

it("returns keyboard focus to the activity that opened the Inspector", async () => {
  await act(async () => root.render(createElement(Harness)));
  const opener = container.querySelector<HTMLButtonElement>("[data-opener]")!;
  opener.focus();
  await act(async () => opener.click());
  const close = document.querySelector<HTMLButtonElement>("[aria-label='Close inspector']")!;
  expect(document.activeElement).toBe(close);
  await act(async () => { close.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(document.activeElement).toBe(opener);
});

it("does not attempt to focus an activity removed while its Inspector was open", async () => {
  await act(async () => root.render(createElement(Harness, { removeOpener: true })));
  const opener = container.querySelector<HTMLButtonElement>("[data-opener]")!;
  opener.focus();
  await act(async () => opener.click());
  await act(async () => { document.querySelector<HTMLButtonElement>("[aria-label='Close inspector']")!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(opener.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(opener);
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicSettings } from "../api";
import { SettingsView } from "./Settings";
import { navigate } from "../router";

const api = vi.hoisted(() => ({ settings: vi.fn(), saveSettings: vi.fn(), pairingClaim: vi.fn(), pairingOffer: vi.fn() }));
vi.mock("../api", () => ({ collectorApi: api }));
vi.mock("../state/collector-context", () => ({ useCollector: () => ({ status: undefined, live: { state: "open" } }) }));

function fixture(): PublicSettings {
  return {
    role: "node", host: { id: "writer", label: "Writer Mac" },
    gateway: { name: "OpenClaw", url: "ws://127.0.0.1:18789", token: { configured: true } },
    server: { host: "192.168.1.24", port: 47123, lanExposed: true, token: { configured: true } },
    hub: { nodes: [] }, localSources: { standaloneCli: "enabled" }, storage: { transcriptSync: "disabled" }, pairing: {}, paths: { config: "/config", secrets: "/secrets" }, restartRequired: false,
    runtime: { role: "node", host: { id: "writer", label: "Writer Mac" }, server: { host: "192.168.1.24", port: 47123, lanExposed: true }, gateway: { name: "OpenClaw", url: "ws://127.0.0.1:18789" }, storage: { transcriptSync: "disabled" }, nodeIds: [], startedAt: 1000 },
  };
}

describe("settings save normalization", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    navigate("/settings");
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
  });

  it("adopts the canonical URL after saving, so a real restart re-enables sharing", async () => {
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.saveSettings.mockImplementation(async (patch: { gateway: { url: string } }) => {
      current = { ...current, gateway: { ...current.gateway, url: new URL(patch.gateway.url).toString() }, restartRequired: true };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    const gatewayUrl = container.querySelector<HTMLInputElement>(".setup-advanced input[type=url]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gatewayUrl, "ws://127.0.0.1:18888");
      gatewayUrl.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("有未保存更改");
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-applied .setup-primary")!.click(); });
    expect(api.saveSettings).toHaveBeenCalledOnce();
    expect(gatewayUrl.value).toBe("ws://127.0.0.1:18888/");
    expect(container.textContent).not.toContain("有未保存更改");
    expect(container.textContent).toContain("已保存 · 待重启");
    expect(container.querySelector<HTMLButtonElement>(".setup-share-actions .setup-primary")!.disabled).toBe(true);
    current = { ...current, restartRequired: false, runtime: { ...current.runtime, gateway: { name: current.gateway.name, url: current.gateway.url }, startedAt: 2000 } };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).not.toContain("有未保存更改");
    expect(container.querySelector<HTMLButtonElement>(".setup-share-actions .setup-primary")!.disabled).toBe(false);
    expect(api.pairingOffer).not.toHaveBeenCalled();
  });

  it("retains an Advanced draft when recovering a failed hub role save", async () => {
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.pairingClaim.mockImplementation(async () => {
      current = { ...current, hub: { nodes: [{ id: "reader", url: "http://192.168.1.42:47123", label: "Reader Mac", token: { configured: true } }] }, restartRequired: true };
      return { ok: true, node: { id: "reader", url: "http://192.168.1.42:47123", label: "Reader Mac" }, settings: current };
    });
    let saves = 0;
    api.saveSettings.mockImplementation(async () => {
      if (++saves === 1) throw new Error("disk write failed");
      current = { ...current, role: "hub" };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    const gatewayName = container.querySelector<HTMLInputElement>(".setup-advanced-grid fieldset:nth-child(2) input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gatewayName, "Unpublished Gateway name");
      gatewayName.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelectorAll<HTMLButtonElement>(".setup-intent")[1]!.click();
    });
    const incoming = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(incoming, JSON.stringify({ version: 1, nodeUrl: "http://192.168.1.42:47123", code: "A7K2-9MQX", label: "Reader Mac", hostId: "reader", expiresAt: Date.now() + 600_000 }));
      incoming.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-preview .setup-primary")!.click(); });
    expect(container.textContent).toContain("采集机已加入；汇总设置尚未保存");
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-recovery .setup-primary")!.click(); });
    expect(api.saveSettings).toHaveBeenNthCalledWith(2, { role: "hub" });
    expect(gatewayName.value).toBe("Unpublished Gateway name");
    expect(container.textContent).toContain("有未保存更改");
    expect(container.querySelector<HTMLButtonElement>(".setup-intent[aria-pressed=true]")?.textContent).toContain("汇总多机");
    expect(container.querySelector(".setup-recovery")).toBeNull();
    expect(api.pairingClaim).toHaveBeenCalledOnce();
  });

  it("copies a newly generated connection with an accurate countdown and no duplicate success banner", async () => {
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.pairingOffer.mockImplementation(async () => {
      // The response arrives partway through the UI clock's first second.
      vi.setSystemTime(Date.now() + 450);
      const offer = { code: "A7K2-9MQX", hostId: current.host.id, label: current.host.label, expiresAt: Date.now() + 600_000 };
      current = { ...current, pairing: { active: offer } };
      return { ...offer, createdToken: false, restartRequired: false };
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      await act(async () => { root.render(createElement(SettingsView)); });
      await act(async () => { container.querySelector<HTMLButtonElement>(".setup-share-actions .setup-primary")!.click(); });
      expect(writeText).toHaveBeenCalledOnce();
      expect(container.querySelector(".setup-feedback")).toBeNull();
      expect(container.querySelector(".setup-package-fact strong")?.textContent).toBe("10:00");
      expect(container.querySelector(".setup-share-actions .setup-primary")?.textContent).toContain("已复制");
    } finally { Reflect.deleteProperty(navigator, "clipboard"); }
  });

  it("opens the archive section without enabling storage, then distinguishes save from real application", async () => {
    navigate("/settings?section=archive");
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.saveSettings.mockImplementation(async (patch: { storage: PublicSettings["storage"] }) => {
      current = { ...current, storage: patch.storage, restartRequired: true };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    const toggle = container.querySelector<HTMLButtonElement>(".setup-archive-switch")!;
    expect(container.querySelector(".setup-intents")).toBeNull();
    expect(container.querySelector(".setup-sections [aria-current=page]")?.textContent).toBe("正文归档");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("保存在本机");
    expect(container.textContent).toContain("关闭不删除已存正文");
    expect(api.saveSettings).not.toHaveBeenCalled();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("有未保存更改");
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-actions .setup-primary")!.click(); });
    expect(api.saveSettings).toHaveBeenCalledWith({ storage: { transcriptSync: "enabled" } });
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("归档已关闭");
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("开启 · 待重启");
    expect(container.textContent).not.toContain("有未保存更改");

    current = { ...current, restartRequired: false, runtime: { ...current.runtime, storage: { transcriptSync: "enabled" }, startedAt: 2000 } };
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("归档已开启");
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("配置已应用");
    expect(container.textContent).not.toContain("待重启");
  });

  it("retains the archive choice across setting sections and includes it in the common save", async () => {
    navigate("/settings?section=archive");
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.saveSettings.mockImplementation(async (patch: { storage: PublicSettings["storage"] }) => {
      current = { ...current, storage: patch.storage, restartRequired: true };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-switch")!.click(); });
    await act(async () => { navigate("/settings"); });
    expect(container.querySelector(".setup-archive")).toBeNull();
    expect(container.textContent).toContain("有未保存更改");
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-applied .setup-primary")!.click(); });
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ storage: { transcriptSync: "enabled" } }));
    await act(async () => { navigate("/settings?section=archive"); });
    expect(container.querySelector(".setup-archive-switch")?.getAttribute("aria-checked")).toBe("true");
  });

  it("saves only archive consent while preserving an unsaved machine draft", async () => {
    let current = fixture();
    api.settings.mockImplementation(async () => current);
    api.saveSettings.mockImplementation(async (patch: { storage: PublicSettings["storage"] }) => {
      current = { ...current, storage: patch.storage, restartRequired: true };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    const gatewayUrl = container.querySelector<HTMLInputElement>(".setup-advanced input[type=url]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(gatewayUrl, "ws://127.0.0.1:19999");
      gatewayUrl.dispatchEvent(new Event("input", { bubbles: true }));
      container.querySelectorAll<HTMLButtonElement>(".setup-intent")[1]!.click();
      navigate("/settings?section=archive");
    });
    expect(container.querySelector(".setup-archive-actions")?.textContent).not.toContain("有未保存更改");
    expect(container.querySelector<HTMLButtonElement>(".setup-archive-actions .setup-primary")!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".setup-archive-switch")!.disabled).toBe(false);
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-switch")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-actions .setup-primary")!.click(); });
    expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith({ storage: { transcriptSync: "enabled" } });
    expect(current.gateway.url).toBe("ws://127.0.0.1:18789");
    expect(container.querySelector(".setup-archive-actions")?.textContent).not.toContain("有未保存更改");
    await act(async () => { navigate("/settings"); });
    expect(container.querySelector<HTMLInputElement>(".setup-advanced input[type=url]")!.value).toBe("ws://127.0.0.1:19999");
    expect(container.querySelector(".setup-intent[aria-pressed=true]")?.textContent).toContain("汇总多机");
    expect(container.textContent).toContain("有未保存更改");
  });

  it("keeps the active archive on when disabling is only saved", async () => {
    navigate("/settings?section=archive");
    let current = fixture();
    current.storage.transcriptSync = "enabled";
    current.runtime.storage.transcriptSync = "enabled";
    api.settings.mockImplementation(async () => current);
    api.saveSettings.mockImplementation(async (patch: { storage: PublicSettings["storage"] }) => {
      current = { ...current, storage: patch.storage, restartRequired: true };
      return current;
    });
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-switch")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-actions .setup-primary")!.click(); });
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("归档已开启");
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("关闭 · 待重启");
    expect(api.saveSettings).toHaveBeenCalledOnce();
  });

  it("keeps an unsaved archive choice after a save error", async () => {
    navigate("/settings?section=archive");
    api.settings.mockResolvedValue(fixture());
    api.saveSettings.mockRejectedValue(new Error("config_write_failed"));
    await act(async () => { root.render(createElement(SettingsView)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-switch")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".setup-archive-actions .setup-primary")!.click(); });
    expect(container.querySelector(".setup-archive-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("有未保存更改");
    expect(container.textContent).not.toContain("待重启");
    expect(container.querySelector("[role=alert]")?.textContent).toContain("config_write_failed");
  });

  it("does not offer local archive collection in Hub mode", async () => {
    navigate("/settings?section=archive");
    const current = fixture();
    current.role = "hub";
    current.runtime.role = "hub";
    api.settings.mockResolvedValue(current);
    await act(async () => { root.render(createElement(SettingsView)); });
    const toggle = container.querySelector<HTMLButtonElement>(".setup-archive-switch")!;
    expect(toggle.disabled).toBe(true);
    expect(container.textContent).toContain("汇总机不采集会话正文");
    expect(container.querySelector(".setup-archive-runtime")?.textContent).toContain("汇总模式");
    await act(async () => { toggle.click(); });
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

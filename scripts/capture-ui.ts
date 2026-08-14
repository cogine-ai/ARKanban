import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.COLLECTOR_URL ?? "http://127.0.0.1:47123";
const output = path.resolve(process.env.COLLECTOR_SCREENSHOT ?? "docs/v1/openclaw-collector-v1-implementation-inspector.png");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1_600, height: 960 }, colorScheme: "light" });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const snapshot = await page.evaluate(async () => {
    const response = await fetch("/api/v1/snapshot");
    if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
    return response.json() as Promise<{ items: Array<{ id: string; stage: string; evidence: unknown[] }> }>;
  });
  const activity = snapshot.items.find((item) => item.stage === "in_flight" && item.evidence.length > 1)
    ?? snapshot.items.find((item) => item.stage === "in_flight");
  if (!activity) throw new Error("No in-flight activity available for Inspector capture");
  await page.locator(`[data-activity-id="${activity.id}"]`).click();
  await page.locator(".inspector").waitFor({ state: "visible" });
  await page.waitForTimeout(350);
  await page.screenshot({ path: output, fullPage: false });
  if (browserErrors.length > 0) throw new Error(`Browser console errors:\n${browserErrors.join("\n")}`);
  process.stdout.write(`${output}\n`);
} finally {
  await browser.close();
}

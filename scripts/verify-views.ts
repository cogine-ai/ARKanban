/**
 * Structural snapshot of every view, used to prove a refactor did not change
 * what the app renders. Emits a normalised JSON report so two runs (before and
 * after a change) can be diffed directly.
 *
 * Relative timestamps are normalised away because they drift between runs; the
 * point of comparison is structure and wiring, not the clock.
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const baseUrl = process.env.COLLECTOR_URL ?? "http://127.0.0.1:47123";
const output = path.resolve(process.env.VERIFY_OUTPUT ?? "/tmp/view-report.json");

const normalise = (value: string | null): string =>
  (value ?? "")
    .replace(/\d+[smhd] ago/g, "<rel>")
    .replace(/in <?\d+m/g, "<in>")
    .replace(/\s+/g, " ")
    .trim();

const count = (page: Page, selector: string) => page.locator(selector).count();

const browser = await chromium.launch({ channel: "chrome", headless: true });
const consoleErrors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1_600, height: 960 }, colorScheme: "light" });

  // Passed as source text, not a function: the bundler rewrites function
  // arguments and injects helpers that do not exist in the page.
  //
  // Installed before app code runs so the count reflects every construction,
  // which is how a duplicated collector subscription would show up.
  await page.addInitScript(`(() => {
    const Original = window.EventSource;
    window.__eventSourceCount = 0;
    window.EventSource = new Proxy(Original, {
      construct(target, args) {
        window.__eventSourceCount += 1;
        return new target(...args);
      },
    });
  })()`);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".app-shell").waitFor({ state: "visible" });
  await page.waitForTimeout(600);

  // Tolerates the nav being buttons or links so one harness can compare a
  // build from before a routing change against one from after it.
  const navSelector = "nav[aria-label='Primary'] :is(a, button)";
  const navLabels = await page.locator(navSelector).allTextContents();

  const live = {
    heading: normalise(await page.locator(".summary-copy h1, .live-flow-title h1").textContent()),
    metrics: (await page.locator(".summary-copy .metrics span").allTextContents()).map(normalise),
    truthPills: (await page.locator(".truth-pill, .board-health").allTextContents()).map(normalise),
    flowHeads: (await page.locator(".flow-head, .lfb-lane-head > span").allTextContents()).map(normalise),
    laneRows: await count(page, ".lane-row, .lfb-lane"),
    activityCards: await count(page, ".activity-card, .lfb-card"),
    settledCards: await count(page, ".series-group-card"),
    fleetMapRows: await count(page, ".fleet-map-row"),
    footer: normalise(await page.locator(".flow-footer, .lfb-record-count").textContent()),
    rangeButtons: await page.locator("[aria-label='Settled time range'] button").allTextContents(),
    kindButtons: await page.locator("[aria-label='Activity kind'] button").allTextContents(),
  };

  const inspector: Record<string, unknown> = { opened: false };
  const firstCard = page.locator(".flow-table [data-activity-id], .lfb-current [data-activity-id]").first();
  if (await firstCard.count() > 0) {
    await firstCard.click();
    await page.locator(".inspector").waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    inspector.opened = true;
    inspector.sections = await page.locator(".inspector-section h3").allTextContents();
    inspector.nowGrid = (await page.locator(".now-grid span").allTextContents()).map(normalise);
    await page.locator(".inspector [aria-label='Close inspector']").click();
    await page.waitForTimeout(300);
  }

  const gotoView = async (label: string) => {
    await page.locator(`${navSelector}:text-is("${label}")`).click();
    await page.waitForTimeout(400);
  };

  const hasAgentsNav = await page.locator(`${navSelector}:text-is("Agents")`).count() > 0;
  const agents = hasAgentsNav
    ? await (async () => {
        await gotoView("Agents");
        const cards = page.locator(".agent-card");
        const first = cards.first();
        await first.waitFor({ state: "visible" });
        const detailsCollapsedByDefault = await first.locator(".roster-more").getAttribute("aria-expanded") === "false";
        await first.locator(".roster-more").click();
        await page.waitForTimeout(250);
        return {
          heading: normalise(await page.locator(".roster-heading h1").textContent()),
          count: normalise(await page.locator(".roster-count").textContent()),
          visibleCards: await cards.count(),
          detailsCollapsedByDefault,
          filters: (await page.locator(".roster-filters button").allTextContents()).map(normalise),
          firstSignal: normalise(await first.locator(".roster-signal").textContent()),
          rollupWindows: await first.locator(".roster-rollup").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-window"))),
          rollupColumns: (await first.locator(".roster-primary-rollup .roster-rollup small").allTextContents()).map(normalise),
          firstCardRollup: (await first.locator(".roster-primary-rollup .roster-rollup b").allTextContents()).map(normalise),
          costLine: normalise(await first.locator(".agent-cost").textContent()),
          // Capture the priority order and detail disclosure without exposing IDs by default.
          order: (await page.locator(".agent-card .agent-identity b").allTextContents()).slice(0, 8),
        };
      })()
    : { present: false };

  if (hasAgentsNav) {
    await gotoView("Agents");
    await page.waitForTimeout(300);
    await page.screenshot({ path: "/tmp/agents-view.png", fullPage: false });
  }

  await gotoView("Relations");
  const relations = {
    heading: normalise(await page.locator(".view-heading h1, .relations-heading h1").textContent()),
    chip: normalise(await page.locator(".count-chip, .relations-observed-count").textContent()),
    modes: await page.locator(".relations-mode [role='tab']").allTextContents(),
    groups: await count(page, ".relations-group"),
    nodes: await count(page, ".relation-cards button, .relations-node"),
  };

  await gotoView("Sessions");
  const sessions = {
    heading: normalise(await page.locator(".sessions-heading h1").textContent()),
    mode: await page.locator(".sessions-view").getAttribute("data-mode"),
    modes: (await page.locator(".sessions-mode [role='tab']").allTextContents()).map(normalise),
    filters: (await page.locator(".sessions-filters .sessions-control > span").allTextContents()).map(normalise),
    loaded: normalise(await page.locator(".sessions-result-toolbar > span").textContent()),
    rows: await count(page, ".sessions-view .session-row"),
    rawKeysVisible: (await page.locator(".sessions-view .session-list").textContent())?.includes("agent:") ?? false,
  };

  await gotoView("Archive");
  const archive = {
    heading: normalise(await page.locator(".archive-view-heading h1").textContent()),
    subtitle: normalise(await page.locator(".archive-view-heading > div > span").textContent()),
    recent: normalise(await page.locator(".archive-retained-count").textContent()),
    filters: await page.locator(".archive-control > span").allTextContents(),
    groups: (await page.locator(".archive-day h2").allTextContents()).map(normalise),
    rows: await count(page, ".archive-row"),
    pagination: normalise(await page.locator(".archive-paging").textContent()),
  };

  await gotoView("Connections");
  const diagnostics = page.locator(".connection-diagnostics");
  const diagnosticsCollapsedByDefault = await diagnostics.getAttribute("open") === null;
  await diagnostics.locator("summary").click();
  const connections = {
    heading: normalise(await page.locator(".view-heading h1").textContent()),
    pageStatus: normalise(await page.locator(".connection-heading-actions .connection-signal").textContent()),
    flow: await page.locator(".connection-flow").getAttribute("aria-label"),
    steps: (await page.locator(".connection-step-label").allTextContents()).map(normalise),
    coverage: (await page.locator(".connection-sources article strong").allTextContents()).map(normalise),
    archiveDisclosure: await page.locator(".connection-archive-disclosure, .connection-hub-archive").first().textContent(),
    diagnosticsCollapsedByDefault,
    diagnosticTerms: (await diagnostics.locator("dt").allTextContents()).map(normalise),
  };

  // Search text is held above the view switch; losing it on navigation would be
  // a regression an operator notices immediately.
  await gotoView("Live flow");
  await page.locator("[aria-label='Search board']").fill("verify-probe");
  await gotoView("Archive");
  await gotoView("Live flow");
  const searchSurvivesViewSwitch = await page.locator("[aria-label='Search board']").inputValue();
  await page.locator("[aria-label='Search board']").fill("");
  await page.waitForTimeout(300);

  const eventSourceCount = await page.evaluate(() => (window as unknown as { __eventSourceCount: number }).__eventSourceCount);

  // The point of routing is that a view has an address. Clicking must change
  // it, the address alone must be enough to land on the view, and Back must
  // return where it came from.
  const pathAfterNav = async (label: string) => {
    await gotoView(label);
    return new URL(page.url()).pathname;
  };
  const routing = {
    liveIsRoot: await pathAfterNav("Live flow"),
    archivePath: await pathAfterNav("Archive"),
    connectionsPath: await pathAfterNav("Connections"),
    backReturnsToArchive: await (async () => {
      await page.goBack();
      await page.waitForTimeout(400);
      return { path: new URL(page.url()).pathname, heading: normalise(await page.locator(".archive-view-heading h1").textContent()) };
    })(),
    deepLinkRendersView: await (async () => {
      await page.goto(`${baseUrl}/relations`, { waitUntil: "networkidle" });
      await page.locator(".view-heading h1, .relations-heading h1").waitFor({ state: "visible" });
      return normalise(await page.locator(".view-heading h1, .relations-heading h1").textContent());
    })(),
    unknownPathFallsBackToShell: await (async () => {
      await page.goto(`${baseUrl}/not-a-route`, { waitUntil: "networkidle" });
      return page.locator(".app-shell").isVisible();
    })(),
  };

  const report = {
    navLabels,
    live,
    inspector,
    agents,
    relations,
    sessions,
    archive,
    connections,
    searchSurvivesViewSwitch,
    eventSourceCount,
    routing,
    consoleErrors,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
  if (consoleErrors.length > 0) {
    process.stderr.write(`Browser console errors:\n${consoleErrors.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (eventSourceCount !== 1) throw new Error(`Expected one collector stream, observed ${eventSourceCount}`);
} finally {
  await browser.close();
}

/**
 * Serves a built web bundle against frozen API fixtures.
 *
 * Refactor verification needs both builds to see byte-identical data; a live
 * collector keeps ingesting, so its numbers drift between the two runs and the
 * resulting diff says nothing. Capture once, replay twice.
 *
 *   capture: tsx scripts/fixture-server.ts capture <collectorUrl> <dir>
 *   serve:   tsx scripts/fixture-server.ts serve <dir> <webDir> [port]
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

type Fixtures = {
  meta: unknown;
  snapshot: unknown;
  agents: unknown;
  settled: Record<string, unknown>;
  detail: Record<string, unknown>;
  seriesRuns: Record<string, unknown>;
};

const [mode, ...rest] = process.argv.slice(2);

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

if (mode === "capture") {
  const [collectorUrl, dir] = rest;
  mkdirSync(dir, { recursive: true });
  const meta = await getJson(`${collectorUrl}/api/v1/meta`);
  const snapshot = (await getJson(`${collectorUrl}/api/v1/snapshot`)) as {
    items: Array<{ id: string; stage: string; evidence: unknown[] }>;
  };
  const settled: Record<string, unknown> = {};
  for (const range of ["24h", "7d", "30d"]) {
    settled[range] = await getJson(`${collectorUrl}/api/v1/settled-groups?range=${range}`);
  }
  const detail: Record<string, unknown> = {};
  for (const item of snapshot.items) {
    detail[item.id] = await getJson(`${collectorUrl}/api/v1/activities/${encodeURIComponent(item.id)}`);
  }
  const agents = (await getJson(`${collectorUrl}/api/v1/agents`)) as { agents: unknown[] };
  const fixtures: Fixtures = { meta, snapshot, agents, settled, detail, seriesRuns: {} };
  writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify(fixtures));
  process.stdout.write(
    `captured ${snapshot.items.length} items, ${Object.keys(detail).length} details, ${agents.agents.length} agents\n`,
  );
} else if (mode === "serve") {
  const [dir, webDir, rawPort] = rest;
  const port = Number(rawPort ?? 47901);
  const fixtures = JSON.parse(readFileSync(path.join(dir, "fixtures.json"), "utf8")) as Fixtures;

  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };

  const json = (response: import("node:http").ServerResponse, body: unknown) => {
    const payload = JSON.stringify(body);
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(payload);
  };

  createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const route = url.pathname;

    if (route === "/api/v1/events") {
      // Held open with no traffic: the fixtures are static, so any invalidate
      // frame would only trigger an identical refetch.
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write(": connected\n\n");
      return;
    }
    if (route === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    if (route === "/api/v1/meta") return json(response, fixtures.meta);
    if (route === "/api/v1/snapshot") return json(response, fixtures.snapshot);
    if (route === "/api/v1/agents") return json(response, fixtures.agents);
    if (route === "/api/v1/settled-groups") {
      return json(response, fixtures.settled[url.searchParams.get("range") ?? "7d"] ?? fixtures.settled["7d"]);
    }
    if (route.startsWith("/api/v1/activities/")) {
      const id = decodeURIComponent(route.slice("/api/v1/activities/".length));
      const found = fixtures.detail[id];
      if (!found) {
        response.writeHead(404, { "content-type": "application/json" });
        return response.end('{"error":"not captured"}');
      }
      return json(response, found);
    }
    if (route.startsWith("/api/v1/settled-groups/")) {
      return json(response, fixtures.seriesRuns[route] ?? { apiVersion: 1, seriesKey: "", range: "7d", runs: [] });
    }

    // Unknown non-asset paths fall back to index.html so history-API routes are
    // reachable by direct navigation, matching how the collector serves the app.
    const relative = route === "/" ? "index.html" : route.replace(/^\//, "");
    const candidate = path.join(webDir, relative);
    const file = existsSync(candidate) ? candidate : path.join(webDir, "index.html");
    if (!existsSync(file)) {
      response.writeHead(404);
      return response.end("not found");
    }
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  }).listen(port, "127.0.0.1", () => process.stdout.write(`fixture server on http://127.0.0.1:${port}\n`));
} else {
  process.stderr.write("usage: capture <collectorUrl> <dir> | serve <dir> <webDir> [port]\n");
  process.exit(1);
}

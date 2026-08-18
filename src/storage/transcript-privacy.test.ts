import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectorRuntime } from "../collector/runtime.js";
import { loadConfig, transcriptNotice, type ResolvedCollectorConfig } from "../config.js";
import { createHttpServer } from "../http/server.js";
import { CollectorRepository } from "./repository.js";

/**
 * Automated audit of the `local_archive` boundary.
 *
 * The v1.1 amendment allows transcripts on disk in exchange for these
 * guarantees: the text never reaches logs, SSE, or diagnostics, and only one
 * module may write it. Each is cheap to break by accident during a refactor and
 * expensive to notice, so they are asserted rather than documented.
 *
 * Every case runs against a database that genuinely contains transcripts —
 * an audit over an empty archive would pass no matter what leaked.
 */

const SECRET = "ZQX-canary-transcript-payload-4417";
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function configFixture(): ResolvedCollectorConfig {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-privacy-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return {
    gateway: { name: "test", url: "ws://127.0.0.1:18789", tokenEnv: "TEST_TOKEN", token: "secret" },
    server: { host: "127.0.0.1", port: 47_123 },
    storage: {
      path: path.join(directory, "collector.sqlite"),
      terminalRetentionDays: 30,
      usageRetentionDays: 14,
      sessionRetentionDays: 90,
      transcriptRetentionDays: 180,
      transcriptMaxBytes: 64 * 1024 * 1024,
      transcriptSync: "enabled",
    },
    reconcile: { tasksMs: 15_000, sessionsMs: 8_000 },
    ui: { recentLimit: 200 },
    configPath: path.join(directory, "collector.config.json"),
  };
}

function seedTranscript(repository: CollectorRepository): void {
  repository.upsertSessions([
    {
      sessionKey: "agent:builder:1",
      agentId: "builder",
      label: "Audit session",
      kindHint: "main",
      archived: false,
      hasActiveRun: true,
      lineage: {},
      lastActivityAt: 5_000,
      observedAt: 5_000,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
    },
  ]);
  repository.transcripts.append([
    { sessionKey: "agent:builder:1", seq: 0, role: "user", content: SECRET, createdAt: 1_000, observedAt: 1_000 },
  ]);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

describe("local_archive boundary", () => {
  it("keeps transcript text out of every non-transcript endpoint", async () => {
    const config = configFixture();
    const runtime = new CollectorRuntime(config);
    cleanups.push(() => runtime.stop());
    seedTranscript(runtime.repository);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    const urls = [
      "/api/v1/meta",
      "/api/v1/snapshot",
      "/api/v1/diagnostics/field-coverage",
      "/api/v1/transcripts/status",
      "/api/v1/sessions",
      "/api/v1/sessions/agent%3Abuilder%3A1",
      "/api/v1/sessions/agent%3Abuilder%3A1/activities",
      "/api/v1/agents",
      "/api/v1/agents/builder",
      "/api/v1/settled-groups",
    ];
    for (const url of urls) {
      const response = await app.inject({ method: "GET", url });
      expect(response.body, `${url} leaked transcript text`).not.toContain(SECRET);
    }
  });

  it("serves the text only from the two endpoints meant to", async () => {
    const config = configFixture();
    const runtime = new CollectorRuntime(config);
    cleanups.push(() => runtime.stop());
    seedTranscript(runtime.repository);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    // The counterpart to the case above: proves the canary is reachable at all,
    // so a leak test passing does not just mean the archive was empty.
    const messages = await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3A1/messages" });
    expect(messages.body).toContain(SECRET);

    const search = await app.inject({ method: "GET", url: `/api/v1/search/messages?q=${SECRET.slice(0, 12)}` });
    expect(search.json().hits).toHaveLength(1);
  });

  it("writes no transcript text to the log, including at debug level", async () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    cleanups.push(() => {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    });

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const config = configFixture();
    const runtime = new CollectorRuntime(config);
    cleanups.push(() => runtime.stop());
    seedTranscript(runtime.repository);
    const app = await createHttpServer(runtime, config);
    cleanups.push(() => app.close());

    // Reading the transcript is the operation most likely to log it.
    await app.inject({ method: "GET", url: "/api/v1/sessions/agent%3Abuilder%3A1/messages" });
    await app.inject({ method: "GET", url: `/api/v1/search/messages?q=${SECRET.slice(0, 12)}` });
    await app.inject({ method: "GET", url: "/api/v1/snapshot" });

    expect(written.join("")).not.toContain(SECRET);
  });

  it("emits no change event carrying transcript text", async () => {
    const config = configFixture();
    const runtime = new CollectorRuntime(config);
    cleanups.push(() => runtime.stop());

    const changes: string[] = [];
    runtime.repository.subscribe((change) => changes.push(JSON.stringify(change)));
    seedTranscript(runtime.repository);

    // SSE carries counts and watermarks; a fragment must never ride along.
    expect(changes.join("")).not.toContain(SECRET);
  });

  it("does not archive conversations unless the config asks for it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "collector-optin-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, "collector.config.json");
    // A config that says nothing about transcripts, which is what an operator
    // upgrading into this feature has. Invariant 10 forbids reading that silence
    // as consent to store every conversation on disk.
    writeFileSync(configPath, JSON.stringify({ storage: { path: path.join(directory, "c.sqlite") } }));

    const config = loadConfig(configPath, { OPENCLAW_GATEWAY_TOKEN: "t" });
    expect(config.storage.transcriptSync).toBe("disabled");
  });

  it("says on every start whether conversations are being stored, and how to erase them", () => {
    const off = configFixture();
    off.storage.transcriptSync = "disabled";
    expect(transcriptNotice(off)).toMatch(/no conversation text is stored/i);

    // The operator turns this on in a file and starts the process in a terminal,
    // so the terminal has to name the location and the way back out.
    const on = configFixture();
    const notice = transcriptNotice(on);
    expect(notice).toMatch(/ON/);
    expect(notice).toContain(on.storage.path);
    expect(notice).toContain("purge-transcripts");
  });

  it("has exactly one module that inserts into session_messages", () => {
    const offenders = sourceFiles(SOURCE_ROOT).filter((file) =>
      /INSERT\s+INTO\s+session_messages\s*\(/i.test(readFileSync(file, "utf8")),
    );

    expect(offenders.map((file) => path.relative(SOURCE_ROOT, file))).toEqual(["storage/transcript-archive.ts"]);
  });
});

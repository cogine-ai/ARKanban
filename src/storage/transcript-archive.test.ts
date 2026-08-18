import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollectorRepository } from "./repository.js";
import type { MessageWrite } from "./transcript-archive.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-transcript-"));
  const result = new CollectorRepository(path.join(directory, "collector.sqlite"));
  cleanups.push(() => {
    result.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return result;
}

function seedSession(repo: CollectorRepository, sessionKey: string, agentId = "builder", lastActivityAt = 5_000): void {
  repo.upsertSessions([
    {
      sessionKey,
      agentId,
      label: `Session ${sessionKey}`,
      kindHint: "main",
      archived: false,
      hasActiveRun: false,
      lineage: {},
      lastActivityAt,
      observedAt: lastActivityAt,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "live" },
    },
  ]);
}

function message(overrides: Partial<MessageWrite> & Pick<MessageWrite, "seq" | "content">): MessageWrite {
  return {
    sessionKey: "agent:builder:one",
    role: "assistant",
    createdAt: 1_000 + overrides.seq,
    observedAt: 2_000,
    ...overrides,
  };
}

describe("TranscriptArchive", () => {
  it("is idempotent when the same history range is fetched twice", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    const batch = [message({ seq: 0, content: "first" }), message({ seq: 1, content: "second" })];

    expect(repo.transcripts.append(batch)).toEqual({ inserted: 2, skipped: 0 });
    expect(repo.transcripts.append(batch)).toEqual({ inserted: 0, skipped: 2 });
    expect(repo.transcripts.listMessages("agent:builder:one")).toHaveLength(2);
  });

  it("keeps both generations when a session's transcript is rebuilt under a new sessionId", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "pre-compaction detail", sessionId: "gen-1" })]);

    expect(repo.transcripts.supersede("agent:builder:one", "gen-2")).toBe(1);
    repo.transcripts.append([message({ seq: 0, content: "compacted summary", sessionId: "gen-2" })]);

    const all = repo.transcripts.listMessages("agent:builder:one");
    expect(all).toHaveLength(2);
    expect(all.find((m) => m.sessionId === "gen-1")?.supersededBySessionId).toBe("gen-2");
    expect(all.find((m) => m.sessionId === "gen-2")?.supersededBySessionId).toBeUndefined();
  });

  it("finds Chinese text of three characters or more through the trigram index", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([
      message({ seq: 0, content: "修复了登录接口的空指针异常" }),
      message({ seq: 1, content: "导出功能在大数据量下超时" }),
    ]);

    const hit = repo.transcripts.search({ text: "登录接口" });
    expect(hit.mode).toBe("fts");
    expect(hit.hits).toHaveLength(1);
    expect(hit.hits[0]?.message.content).toContain("空指针");
    expect(hit.hits[0]?.agentId).toBe("builder");
  });

  it("falls back to a bounded scan for queries shorter than the trigram minimum", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "修复了登录接口的空指针异常" })]);

    const narrowed = repo.transcripts.search({ text: "登录", agentId: "builder" });
    expect(narrowed.mode).toBe("fallback");
    expect(narrowed.hits).toHaveLength(1);
  });

  it("refuses an unbounded short query instead of scanning the whole archive", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "修复了登录接口的空指针异常" })]);

    const unbounded = repo.transcripts.search({ text: "登录" });
    expect(unbounded.mode).toBe("fallback");
    expect(unbounded.hits).toEqual([]);
  });

  it("treats FTS5 operators in user input as literal text", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([
      message({ seq: 0, content: 'the value was "quoted" OR missing' }),
      message({ seq: 1, content: "unrelated content entirely" }),
    ]);

    expect(() => repo.transcripts.search({ text: '"quoted" OR' })).not.toThrow();
    expect(repo.transcripts.search({ text: "OR missing" }).hits).toHaveLength(1);
  });

  it("keeps the full-text index consistent after deletion", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "临时排查数据库连接池配置", createdAt: 1_000 })]);
    expect(repo.transcripts.search({ text: "数据库连接池" }).hits).toHaveLength(1);

    expect(repo.transcripts.pruneOlderThan(2_000)).toBe(1);
    expect(repo.transcripts.search({ text: "数据库连接池" }).hits).toEqual([]);
  });

  it("evicts whole sessions oldest first rather than truncating conversations", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:old", "builder", 1_000);
    seedSession(repo, "agent:builder:new", "builder", 9_000);
    const bulk = (sessionKey: string) =>
      Array.from({ length: 40 }, (_unused, index) =>
        message({ sessionKey, seq: index, content: `padding ${"x".repeat(500)} ${index}` }),
      );
    repo.transcripts.append(bulk("agent:builder:old"));
    repo.transcripts.append(bulk("agent:builder:new"));

    const before = repo.transcripts.usage();
    expect(before.storedBytes).toBeGreaterThan(0);
    const evicted = repo.transcripts.evictOldestSessions(Math.floor(before.storedBytes * 0.6));

    expect(evicted.sessions).toBe(1);
    expect(repo.transcripts.listMessages("agent:builder:old")).toEqual([]);
    expect(repo.transcripts.listMessages("agent:builder:new")).toHaveLength(40);
  });

  it("reports sync watermarks so a stale local copy is not shown as live", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "hello" }), message({ seq: 1, content: "world" })]);
    repo.transcripts.recordSync({
      sessionKey: "agent:builder:one",
      cursor: "cursor-2",
      lastSeq: 1,
      complete: false,
      syncedAt: 4_000,
    });

    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({
      syncedCount: 2,
      complete: false,
      syncedAt: 4_000,
    });
  });

  it("purges every message and its index entries", () => {
    const repo = repository();
    seedSession(repo, "agent:builder:one");
    repo.transcripts.append([message({ seq: 0, content: "敏感的会话正文内容" })]);
    repo.transcripts.recordSync({ sessionKey: "agent:builder:one", complete: true, syncedAt: 4_000 });

    expect(repo.transcripts.purgeAll()).toBe(1);
    expect(repo.transcripts.search({ text: "敏感的会话" }).hits).toEqual([]);
    expect(repo.transcripts.usage()).toMatchObject({ messageCount: 0, contentBytes: 0 });
    expect(repo.transcripts.syncState("agent:builder:one")).toMatchObject({ syncedCount: 0, complete: false });
  });
});

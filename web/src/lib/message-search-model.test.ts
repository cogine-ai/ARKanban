import { describe, expect, it } from "vitest";
import type { MessageSearchHit } from "../../../src/contracts";
import type { MessageSearchFilters, TranscriptArchiveStatus } from "../api";
import { archiveSearchState, groupMessageHits, messageSearchIssue, messageSnippet } from "./message-search-model";
import { validateMessageFilters } from "./session-filters";

const archive = (patch: Partial<TranscriptArchiveStatus> = {}): TranscriptArchiveStatus => ({ enabled: true, retentionDays: 180, maxBytes: 1000, filePermissionsEnforced: true, messageCount: 4, contentBytes: 200, sync: null, ...patch });
const hit = (key: string, id: number, sessionId?: string): MessageSearchHit => ({ sessionLabel: "Same name", agentId: "writer", message: { id, sessionKey: key, sessionId, seq: id, role: "assistant", content: "release", createdAt: id, divergent: false } });

describe("message search facts", () => {
  it("keeps form and result admission consistent, including an empty query with a malformed range", () => {
    const cases: Array<[MessageSearchFilters, ReturnType<typeof validateMessageFilters>, ReturnType<typeof messageSearchIssue>]> = [
      [{ q: "", from: NaN }, "invalid-range", "range"],
      [{ q: " ", from: 200, to: 100 }, "invalid-range", "range"],
      [{ q: " " }, "empty", "empty"],
      [{ q: "😀😀", to: 100 }, "range-required", "scope"],
      [{ q: "😀😀", from: 0 }, undefined, undefined],
    ];
    for (const [filters, formIssue, resultIssue] of cases) {
      expect(validateMessageFilters(filters)).toBe(formIssue);
      expect(messageSearchIssue(filters)).toBe(resultIssue);
    }
  });
  it("counts Unicode code points and refuses an end-only scope", () => {
    expect(messageSearchIssue({ q: "你好", to: 100 })).toBe("scope");
    expect(messageSearchIssue({ q: "😀😀", to: 100 })).toBe("scope");
    expect(messageSearchIssue({ q: "  abc  " })).toBeUndefined();
    expect(messageSearchIssue({ q: "你好", from: 0 })).toBeUndefined();
    expect(messageSearchIssue({ q: "你好", agentId: "writer" })).toBeUndefined();
    expect(messageSearchIssue({ q: "你好", sessionKey: "key" })).toBeUndefined();
  });
  it("rejects bad timestamps and reversed ranges before searching", () => {
    expect(messageSearchIssue({ q: "release", from: 200, to: 100 })).toBe("range");
    expect(messageSearchIssue({ q: "release", from: NaN })).toBe("range");
    expect(messageSearchIssue({ q: "release", to: Infinity })).toBe("range");
    expect(messageSearchIssue({ q: "release", to: -1 })).toBe("range");
    expect(messageSearchIssue({ q: "release", from: .5 })).toBe("range");
    expect(messageSearchIssue({ q: "release", to: Number.MAX_SAFE_INTEGER + 1 })).toBe("range");
  });
  it("preserves distinct keys and both reported generations within returned hits", () => {
    const hits = [hit("one", 1, "generation-new"), hit("two", 2), hit("one", 3, "generation-old")];
    const groups = groupMessageHits(hits);
    expect(groups.map((group) => group.key)).toEqual(["one", "two"]);
    expect(groups[0]?.hits.map((entry) => entry.message.sessionId)).toEqual(["generation-new", "generation-old"]);
  });
  it("keeps saved messages searchable with sync disabled", () => {
    expect(archiveSearchState(archive({ enabled: false })).label).toContain("saved messages searchable");
    expect(archiveSearchState(archive({ enabled: false, messageCount: 0 })).empty).toBe("No saved messages");
  });
  it("separates paused backfill from paused new messages", () => {
    expect(archiveSearchState(archive({ sync: { sessions: 1, inserted: 1, capacity: "paused" } })).label).toBe("Backfill paused");
    expect(archiveSearchState(archive({ sync: { sessions: 0, inserted: 0, capacity: "full" } })).label).toBe("New messages paused");
  });
  it("distinguishes missing source, unsupported archive and waiting for archive", () => {
    expect(archiveSearchState(archive({ messageCount: 0, sync: { sessions: 0, inserted: 0, capacity: "ok", skipped: "not_connected" } })).empty).toBe("Waiting for source");
    expect(archiveSearchState(archive({ messageCount: 0, sync: { sessions: 0, inserted: 0, capacity: "ok", skipped: "unavailable" } })).empty).toBe("Messages unavailable from source");
    expect(archiveSearchState(archive({ messageCount: 0 })).empty).toBe("Waiting for archive");
  });
  it("bounds unmatched large bodies and centres literal matched text", () => {
    expect(messageSnippet("x".repeat(1000), "no-match").length).toBeLessThan(120);
    expect(messageSnippet(`${"x".repeat(300)}release${"y".repeat(300)}`, "release")).toContain("release");
    expect(messageSnippet("short text", "text")).toBe("short text");
  });
});

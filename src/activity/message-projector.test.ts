import { describe, expect, it } from "vitest";
import { FieldInventory } from "../collector/field-inventory.js";
import { flattenContent, messageRole, projectHistoryPage } from "./message-projector.js";

const base = { sessionKey: "agent:builder:demo", observedAt: 5_000, seqBase: -1 };

describe("content flattening", () => {
  it("joins the text of structured content blocks", () => {
    expect(flattenContent([{ type: "text", text: "first" }, { type: "text", text: "second" }])).toBe("first\nsecond");
  });

  it("drops blocks that carry no text rather than stringifying them", () => {
    expect(flattenContent([{ type: "image", source: { data: "..." } }, { type: "text", text: "caption" }])).toBe("caption");
  });

  it("reads a bare string and a nested text field alike", () => {
    expect(flattenContent("plain")).toBe("plain");
    expect(flattenContent({ text: "nested" })).toBe("nested");
  });
});

describe("role normalisation", () => {
  it("maps the vendor spellings onto the four archive roles", () => {
    expect(messageRole("human")).toBe("user");
    expect(messageRole("model")).toBe("assistant");
    expect(messageRole("function")).toBe("tool");
    expect(messageRole({ role: "Assistant" })).toBe("assistant");
  });

  it("falls back to system for an unrecognised role", () => {
    expect(messageRole("narrator")).toBe("system");
  });
});

describe("history page projection", () => {
  it("reads the documented shape and carries the cursor through", () => {
    const page = projectHistoryPage(
      {
        messages: [
          { id: "m1", seq: 0, role: "user", content: "hello", createdAt: 1_000 },
          { id: "m2", seq: 1, role: "assistant", content: "hi", createdAt: 2_000 },
        ],
        nextCursor: "2",
        hasMore: true,
      },
      base,
    );

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("2");
    expect(page.writes).toHaveLength(2);
    expect(page.writes[0]).toMatchObject({ messageId: "m1", seq: 0, role: "user", content: "hello", createdAt: 1_000 });
  });

  it("numbers rows the Gateway left unnumbered, continuing from the stored watermark", () => {
    const page = projectHistoryPage(
      { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
      { ...base, seqBase: 41 },
    );

    expect(page.writes.map((write) => write.seq)).toEqual([42, 43]);
  });

  it("drops empty rows instead of letting them occupy a sequence number", () => {
    const page = projectHistoryPage(
      { messages: [{ role: "user", content: "   " }, { role: "user", content: "real" }] },
      base,
    );

    expect(page.dropped).toBe(1);
    expect(page.writes).toHaveLength(1);
    expect(page.writes[0]!.content).toBe("real");
  });

  it("treats a cursor as proof of more history when no explicit flag is sent", () => {
    const page = projectHistoryPage({ messages: [{ role: "user", content: "a" }], nextCursor: "7" }, base);
    expect(page.hasMore).toBe(true);
  });

  it("stops when neither a flag nor a cursor is returned", () => {
    const page = projectHistoryPage({ messages: [{ role: "user", content: "a" }] }, base);
    expect(page.hasMore).toBe(false);
  });

  it("prefers the row's own generation over the session's", () => {
    const page = projectHistoryPage(
      { messages: [{ role: "user", content: "a", sessionId: "gen-2" }] },
      { ...base, sessionId: "gen-1" },
    );

    expect(page.writes[0]!.sessionId).toBe("gen-2");
  });

  it("reports which aliases matched so a real Gateway can be diffed against the guesses", () => {
    const inventory = new FieldInventory("chat.history");
    projectHistoryPage({ items: [{ uuid: "m1", author: "human", body: "hi", ts: 10, surprise: 1 }] }, { ...base, inventory });
    const report = inventory.report();

    expect(report.consumed).toEqual(expect.arrayContaining(["uuid", "author", "body", "ts", "items"]));
    expect(report.unknown).toContain("surprise");
    expect(report.missing.join(" ")).toContain("toolName");
  });
});

import { describe, expect, it } from "vitest";
import { FieldInventory } from "../collector/field-inventory.js";
import { flattenContent, messageRole, projectHistoryPage } from "./message-projector.js";

/**
 * Real millisecond epochs, because the projector now refuses a timestamp from
 * before this project existed: that is what a seconds-epoch looks like when it is
 * read as milliseconds, and transcript retention deletes on age.
 */
const OBSERVED_AT = Date.UTC(2026, 7, 1, 12, 0, 0);
const base = {
  sessionKey: "agent:builder:demo",
  observedAt: OBSERVED_AT,
  seqBase: -1,
  // Large enough that these small fixtures never look like a full page, so cases
  // about the reported fields are not answered by the derived fallback.
  request: { limit: 100, offset: 0 },
};

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

  /**
   * The role is a Gateway-supplied string used as a lookup key. On a plain object
   * these names resolve up the prototype chain, and the function that came back
   * was written to the archive as a role — where SQLite refused to bind it and
   * took the whole sync round down with it.
   */
  it("does not resolve a role through the prototype chain", () => {
    expect(messageRole("constructor")).toBe("system");
    expect(messageRole("__proto__")).toBe("system");
    expect(messageRole("toString")).toBe("system");
  });
});

describe("history page projection", () => {
  /**
   * The shape here is the one OpenClaw 2026.7.1-2 actually returns: identity and
   * ordering under `__openclaw`, `timestamp` for the time, and offset paging.
   * The earlier version of this test asserted a top-level `id`/`seq` and a
   * `nextCursor`, none of which the Gateway sends — it passed while the code it
   * covered could not have read a single real message.
   */
  it("reads the real shape, taking identity from the envelope", () => {
    const page = projectHistoryPage(
      {
        messages: [
          { role: "user", content: "hello", timestamp: OBSERVED_AT - 4_000, __openclaw: { id: "m1", seq: 1 } },
          { role: "assistant", content: "hi", timestamp: OBSERVED_AT - 3_000, __openclaw: { id: "m2", seq: 2 } },
        ],
        nextOffset: 200,
        hasMore: true,
      },
      base,
    );

    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(200);
    expect(page.writes).toHaveLength(2);
    expect(page.writes[0]).toMatchObject({
      messageId: "m1",
      seq: 1,
      role: "user",
      content: "hello",
      createdAt: OBSERVED_AT - 4_000,
    });
  });

  /**
   * The shape a live Gateway returns for a tool result: `isError` sits on the
   * message beside `toolName`, and it is set either way — a `false` is the Gateway
   * saying the call worked, which is worth as much to a grade as a failure is.
   */
  it("keeps the Gateway's verdict on a tool call, both ways", () => {
    const page = projectHistoryPage(
      {
        messages: [
          {
            role: "toolResult",
            toolName: "exec",
            isError: true,
            content: "exit status 1",
            timestamp: OBSERVED_AT - 2_000,
            __openclaw: { id: "m1", seq: 1 },
          },
          {
            role: "toolResult",
            toolName: "exec",
            isError: false,
            content: "ok",
            timestamp: OBSERVED_AT - 1_000,
            __openclaw: { id: "m2", seq: 2 },
          },
        ],
      },
      base,
    );

    expect(page.writes[0]).toMatchObject({ role: "tool", toolName: "exec", isError: true });
    expect(page.writes[1]).toMatchObject({ role: "tool", isError: false });
  });

  /**
   * Absent is a third state, and the one nearly every message is in. Storing it as
   * `false` would enter every ordinary turn into the tool tally as a call that
   * succeeded, which is how a session with no tools at all ends up confidently
   * graded.
   */
  it("leaves the verdict off a message that carries none, or carries a non-boolean", () => {
    const page = projectHistoryPage(
      {
        messages: [
          { role: "user", content: "hello", timestamp: OBSERVED_AT - 3_000, __openclaw: { id: "m1", seq: 1 } },
          {
            role: "toolResult",
            isError: "true",
            content: "stringly typed",
            timestamp: OBSERVED_AT - 2_000,
            __openclaw: { id: "m2", seq: 2 },
          },
        ],
      },
      base,
    );

    expect(page.writes[0]).not.toHaveProperty("isError");
    expect(page.writes[1]).not.toHaveProperty("isError");
  });

  /**
   * The block shapes a live Gateway returned: a `toolCall` has no text field at
   * all, and dropping it removed the assistant's turn from the archive entirely,
   * leaving a tool result that appeared to arrive unprompted.
   */
  it("keeps a tool call, which carries no text field", () => {
    const page = projectHistoryPage(
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: '{"command":"ls"}',
                input: { command: "ls" },
              },
            ],
            timestamp: 4_000,
            __openclaw: { id: "m4", seq: 17 },
          },
        ],
      },
      base,
    );

    expect(page.dropped).toBe(0);
    expect(page.writes[0]).toMatchObject({ role: "assistant", seq: 17, content: 'bash {"command":"ls"}' });
  });

  it("reads block-array content and the camelCase tool role", () => {
    const page = projectHistoryPage(
      {
        messages: [
          {
            role: "toolResult",
            content: [
              { type: "text", text: "first" },
              { type: "image", source: "ignored" },
              { type: "text", text: "second" },
            ],
            timestamp: 3_000,
            __openclaw: { id: "m3", seq: 7 },
          },
        ],
      },
      base,
    );

    expect(page.writes[0]).toMatchObject({ role: "tool", seq: 7, content: "first\nsecond" });
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

  it("treats an offset as proof of more history when no explicit flag is sent", () => {
    const page = projectHistoryPage({ messages: [{ role: "user", content: "a" }], nextOffset: 7 }, base);
    expect(page.hasMore).toBe(true);
  });

  it("stops when neither a flag nor an offset is returned and the page is short", () => {
    const page = projectHistoryPage({ messages: [{ role: "user", content: "a" }] }, base);
    expect(page.hasMore).toBe(false);
  });

  /**
   * The shape a real Gateway returns. 2026.7.1-2 reports no paging whatsoever —
   * verified against a live 18789: a response carries `sessionKey`, `sessionId`,
   * `messages`, `defaults`, `sessionInfo` and `thinkingLevel`, and nothing else,
   * however much history the session holds. Believing that absence meant every
   * conversation looked like one complete page: a long one was truncated to its
   * newest page on disk and reported as fully archived, and backfill had no offset
   * to advance to, so it re-read that same page every round forever.
   *
   * `offset` is honoured by that build even though it is never reported, and a
   * request past the end comes back empty — so a full page is the signal to keep
   * walking, and a short one is the end.
   */
  it("keeps walking a full page the Gateway said nothing about", () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({ role: "user", content: `turn ${index}` }));
    const request = { limit: 4, offset: 8 };

    const full = projectHistoryPage({ sessionKey: "s", sessionId: "gen", messages: rows }, { ...base, request });
    expect(full.hasMore).toBe(true);
    expect(full.nextOffset).toBe(12);

    const short = projectHistoryPage(
      { sessionKey: "s", sessionId: "gen", messages: rows.slice(0, 3) },
      { ...base, request },
    );
    expect(short.hasMore).toBe(false);
    expect(short.nextOffset).toBeUndefined();
  });

  it("prefers the row's own generation over the session's", () => {
    const page = projectHistoryPage(
      { messages: [{ role: "user", content: "a", sessionId: "gen-2" }] },
      { ...base, sessionId: "gen-1" },
    );

    expect(page.writes[0]!.sessionId).toBe("gen-2");
  });

  /**
   * Rows carry no generation of their own on a real Gateway — it sits on the page.
   * Reading it there beats the id stored with the session, which is what says a
   * transcript has been rebuilt since, and so which messages are superseded.
   */
  it("takes the generation from the page when the rows do not carry one", () => {
    const page = projectHistoryPage(
      { sessionKey: "s", sessionId: "gen-live", messages: [{ role: "user", content: "a", sourceChannel: "telegram" }] },
      { ...base, sessionId: "gen-stored" },
    );

    expect(page.writes[0]!.sessionId).toBe("gen-live");
    expect(page.writes[0]!.channel).toBe("telegram");
  });

  /**
   * Age is what transcript retention deletes on, so a timestamp is not a display
   * detail here. A seconds-epoch read as milliseconds dates every message to 1970,
   * and the first retention pass would erase the archive.
   */
  it("refuses a timestamp that is a seconds epoch, and one from the future", () => {
    const page = projectHistoryPage(
      {
        messages: [
          { role: "user", content: "seconds", timestamp: 1_775_000_000, __openclaw: { seq: 1 } },
          { role: "user", content: "ahead", timestamp: OBSERVED_AT + 60_000, __openclaw: { seq: 2 } },
        ],
      },
      base,
    );

    expect(page.writes.map((write) => write.createdAt)).toEqual([OBSERVED_AT, OBSERVED_AT]);
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

import type { MessageRole } from "../contracts.js";
import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { MessageWrite } from "../storage/transcript-archive.js";
import { boundedTimestamp } from "./timestamps.js";

/**
 * Projects raw `chat.history` rows into archive writes.
 *
 * Every field is read through an alias list, so correcting one is a single-line
 * edit: put the real key at the front. The lists were checked against the
 * `chat.history` handler in OpenClaw 2026.7.1-2, which moved two of them.
 */

/**
 * Identity and ordering live in a reserved envelope rather than on the message.
 *
 * `chat.history` returns provider-shaped messages and attaches its own metadata
 * under `__openclaw` — `{ id, seq, recordTimestampMs, ... }`. Reading a
 * top-level `id` finds nothing, which costs both the idempotency key and any
 * chance of resolving the row later through `chat.message.get`.
 */
const ENVELOPE_KEY = "__openclaw";

export const MESSAGE_FIELD_ALIASES = {
  messageId: ["id", "messageId", "uuid"],
  seq: ["seq", "index", "ordinal", "position"],
  role: ["role", "author", "sender"],
  // 2026.7.1-2 names it `sourceChannel`; it is how a transcript shows that a turn
  // arrived over Telegram rather than the terminal.
  channel: ["sourceChannel", "channel", "source"],
  toolName: ["toolName", "tool_name", "tool", "functionName"],
  // The Gateway's own verdict on a tool call, on the message rather than in the
  // block: a `role: "toolResult"` turn carries `isError` next to `toolCallId` and
  // `toolName`, and reports `false` as readily as `true`. The alias list stays
  // narrow on purpose — a key merely named `error` is as likely to hold a message
  // or an object, and reading that as a boolean would invent a failed call.
  isError: ["isError", "is_error"],
  content: ["content", "text", "body", "message", "parts"],
  createdAt: ["timestamp", "recordTimestampMs", "createdAt", "ts", "time"],
  sessionId: ["sessionId", "conversationId"],
} as const satisfies Record<string, readonly string[]>;

/**
 * Paging is by offset counted back from the newest message, and 2026.7.1-2
 * reports none of it: a response is `{ sessionKey, sessionId, messages, defaults,
 * sessionInfo, thinkingLevel }` whatever the offset. The aliases stay because a
 * build that does answer should be believed; `projectHistoryPage` derives the
 * same two facts from the request when they are missing.
 */
export const HISTORY_PAGE_ALIASES = {
  messages: ["messages", "items", "history", "entries"],
  nextOffset: ["nextOffset"],
  hasMore: ["hasMore", "more"],
  totalMessages: ["totalMessages"],
  sessionId: ["sessionId", "conversationId"],
} as const satisfies Record<string, readonly string[]>;

type MessageField = keyof typeof MESSAGE_FIELD_ALIASES;

/**
 * Null-prototype: the key is a Gateway-supplied string, and on a plain object
 * `roles["constructor"]` would resolve up the prototype chain to a function.
 */
const ROLES: Record<string, MessageRole> = Object.assign(Object.create(null), {
  user: "user",
  human: "user",
  operator: "user",
  assistant: "assistant",
  ai: "assistant",
  model: "assistant",
  agent: "assistant",
  system: "system",
  tool: "tool",
  function: "tool",
  tool_result: "tool",
  // 2026.7.1-2 emits the camelCase form, which lowercases to this rather than
  // to the underscored spelling above.
  toolresult: "tool",
  tooluse: "tool",
});

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Renders a tool invocation as text.
 *
 * A `toolCall` block carries `{ type, id, name, arguments, input }` and no text
 * field of any kind, so the text probe below found nothing and the whole message
 * was discarded as empty. That silently removed every turn where the assistant
 * called a tool: a transcript would show the reasoning and the tool's output
 * with the call between them missing, which reads as though the result arrived
 * unprompted. The call is the most informative line in a tool exchange.
 *
 * The arguments are kept verbatim, like the rest of the archive.
 */
function flattenToolCall(object: Record<string, unknown>): string {
  const type = typeof object.type === "string" ? object.type.toLowerCase() : "";
  if (!type.includes("tool")) return "";
  const name = typeof object.name === "string" && object.name.trim() ? object.name.trim() : undefined;
  const input = object.input !== undefined ? object.input : object.arguments;
  const rendered =
    typeof input === "string"
      ? input
      : input !== undefined && input !== null
        ? JSON.stringify(input)
        : undefined;
  if (name && rendered) return `${name} ${rendered}`;
  return name ?? rendered ?? "";
}

/**
 * Flattens the content block shapes chat APIs use into plain text.
 *
 * Anything that is neither text nor a tool call is dropped rather than
 * stringified: a JSON blob of an image block in the middle of a transcript is
 * noise in the reader and false matches in search.
 */
export function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => flattenContent(part))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  const object = record(value);
  if (!object) return "";
  for (const key of ["text", "content", "value"]) {
    const nested = object[key];
    if (typeof nested === "string") return nested;
    if (Array.isArray(nested)) return flattenContent(nested);
  }
  return flattenToolCall(object);
}

export function messageRole(raw: unknown): MessageRole {
  const token = asString(raw)?.toLowerCase();
  if (token && ROLES[token]) return ROLES[token]!;
  const nested = record(raw);
  if (nested) return messageRole(nested.role ?? nested.type ?? nested.name);
  return "system";
}

export type ProjectMessagesOptions = {
  sessionKey: string;
  /** Generation the page belongs to; part of the idempotency key. */
  sessionId?: string;
  observedAt: number;
  /** First synthesised sequence number, used only for rows the Gateway did not number. */
  seqBase: number;
  /** What the request asked for, so paging can be derived when the response omits it. */
  request: { limit: number; offset: number };
  inventory?: FieldInventory;
};

export type ProjectedPage = {
  writes: MessageWrite[];
  /** Offset to request for the next older page, absent when the page is the last. */
  nextOffset?: number;
  hasMore: boolean;
  /** Rows carrying neither text nor a usable identity. */
  dropped: number;
};

/**
 * Rows without content are dropped: an empty transcript entry occupies a
 * sequence number and a search slot while telling a reader nothing.
 */
export function projectHistoryPage(payload: Record<string, unknown>, options: ProjectMessagesOptions): ProjectedPage {
  const rawMessages = pick(payload, "messages", HISTORY_PAGE_ALIASES.messages, options.inventory);
  const rows = Array.isArray(rawMessages) ? rawMessages : [];
  /**
   * The generation these rows belong to, as the Gateway sees it now.
   *
   * Rows carry no `sessionId` of their own — 2026.7.1-2 puts it on the page — and
   * this is a better answer than the one stored with the session: a transcript
   * that has been compacted or rebuilt gets a new id, and that is precisely what
   * marks the older messages superseded rather than interleaving two generations.
   */
  const pageSessionId = asString(pick(payload, "sessionId", HISTORY_PAGE_ALIASES.sessionId, options.inventory));
  const writes: MessageWrite[] = [];
  let dropped = 0;
  let synthesised = options.seqBase;

  for (const entry of rows) {
    const row = record(entry);
    if (!row) {
      dropped += 1;
      continue;
    }
    options.inventory?.observeRow(row);
    const envelope = record(row[ENVELOPE_KEY]);
    // Recorded as consumed because it is: the fields below are read out of it.
    // Without this the coverage report lists `__openclaw` as a key no alias
    // claimed, which is the report's way of saying "you are probably missing
    // something" — a false alarm aimed at whoever is calibrating next.
    if (envelope) options.inventory?.observeLookup("messageEnvelope", [ENVELOPE_KEY], ENVELOPE_KEY);
    const read = (field: MessageField): unknown => {
      const direct = pick(row, field, MESSAGE_FIELD_ALIASES[field], options.inventory);
      if (direct !== undefined) return direct;
      return envelope ? pick(envelope, field, MESSAGE_FIELD_ALIASES[field], options.inventory) : undefined;
    };

    const content = flattenContent(read("content"));
    if (!content.trim()) {
      dropped += 1;
      continue;
    }

    const seq = asInteger(read("seq"));
    if (seq === undefined) synthesised += 1;
    const sessionId = asString(read("sessionId")) ?? pageSessionId ?? options.sessionId;

    writes.push({
      sessionKey: options.sessionKey,
      ...(sessionId ? { sessionId } : {}),
      ...(asString(read("messageId")) ? { messageId: asString(read("messageId"))! } : {}),
      seq: seq ?? synthesised,
      role: messageRole(read("role")),
      ...(asString(read("channel")) ? { channel: asString(read("channel"))! } : {}),
      ...(asString(read("toolName")) ? { toolName: asString(read("toolName"))! } : {}),
      // Only a boolean counts. Absent means the turn is not a tool result at all,
      // which is a third state: storing it as `false` would turn every ordinary
      // message into evidence of a tool call that succeeded.
      ...(typeof read("isError") === "boolean" ? { isError: read("isError") as boolean } : {}),
      content,
      createdAt: boundedTimestamp(read("createdAt"), options.observedAt) ?? options.observedAt,
      observedAt: options.observedAt,
    });
  }

  const reportedOffset = asInteger(pick(payload, "nextOffset", HISTORY_PAGE_ALIASES.nextOffset, options.inventory));
  const reportedMore = pick(payload, "hasMore", HISTORY_PAGE_ALIASES.hasMore, options.inventory);

  /**
   * Derived from the request when the response says nothing about paging.
   *
   * 2026.7.1-2 returns neither field: a `chat.history` payload is
   * `{ sessionKey, sessionId, messages, defaults, sessionInfo, thinkingLevel }`
   * and nothing else, however much history the session has. Trusting the absence
   * meant every session looked like one complete page — the newest one — so a long
   * conversation was truncated on disk and reported as fully archived, and backfill
   * had no offset to advance to and re-read the same page forever.
   *
   * A short page is the end of the history: the Gateway returned everything it had
   * left. A full page means there is probably more, and asking once more for an
   * offset past the end simply comes back empty, which costs one request and is
   * the only way to be sure on a build that will not say.
   */
  const full = rows.length >= options.request.limit;
  const nextOffset = reportedOffset ?? (full ? options.request.offset + rows.length : undefined);
  // An explicit flag wins. Failing that, a reported offset is itself the claim
  // that more exists, and a full page is the only remaining evidence.
  const hasMore = typeof reportedMore === "boolean" ? reportedMore : reportedOffset !== undefined || full;

  return {
    writes,
    ...(hasMore && nextOffset !== undefined ? { nextOffset } : {}),
    hasMore,
    dropped,
  };
}

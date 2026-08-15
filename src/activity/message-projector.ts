import type { MessageRole } from "../contracts.js";
import { FieldInventory, pick } from "../collector/field-inventory.js";
import type { MessageWrite } from "../storage/transcript-archive.js";

/**
 * Projects raw `chat.history` rows into archive writes.
 *
 * As with the session and agent projectors, every field is read through an
 * alias list because these names come from the protocol documentation rather
 * than from an observed Gateway. Correcting one is a single-line edit: put the
 * real key at the front of the relevant list.
 */

export const MESSAGE_FIELD_ALIASES = {
  messageId: ["id", "messageId", "uuid"],
  seq: ["seq", "index", "ordinal", "position"],
  role: ["role", "author", "sender"],
  channel: ["channel", "source"],
  toolName: ["toolName", "tool", "functionName"],
  content: ["content", "text", "body", "message", "parts"],
  createdAt: ["createdAt", "ts", "timestamp", "time"],
  sessionId: ["sessionId", "conversationId"],
} as const satisfies Record<string, readonly string[]>;

export const HISTORY_PAGE_ALIASES = {
  messages: ["messages", "items", "history", "entries"],
  nextCursor: ["nextCursor", "cursor", "next"],
  hasMore: ["hasMore", "more"],
} as const satisfies Record<string, readonly string[]>;

type MessageField = keyof typeof MESSAGE_FIELD_ALIASES;

const ROLES: Record<string, MessageRole> = {
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
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
 * Flattens the content block shapes chat APIs use into plain text.
 *
 * Anything that is not recognisably text is dropped rather than stringified:
 * a JSON blob of an image block in the middle of a transcript is noise in the
 * reader and false matches in search.
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
  return "";
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
  inventory?: FieldInventory;
};

export type ProjectedPage = {
  writes: MessageWrite[];
  nextCursor?: string;
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
    const read = (field: MessageField): unknown => pick(row, field, MESSAGE_FIELD_ALIASES[field], options.inventory);

    const content = flattenContent(read("content"));
    if (!content.trim()) {
      dropped += 1;
      continue;
    }

    const seq = asInteger(read("seq"));
    if (seq === undefined) synthesised += 1;
    const sessionId = asString(read("sessionId")) ?? options.sessionId;

    writes.push({
      sessionKey: options.sessionKey,
      ...(sessionId ? { sessionId } : {}),
      ...(asString(read("messageId")) ? { messageId: asString(read("messageId"))! } : {}),
      seq: seq ?? synthesised,
      role: messageRole(read("role")),
      ...(asString(read("channel")) ? { channel: asString(read("channel"))! } : {}),
      ...(asString(read("toolName")) ? { toolName: asString(read("toolName"))! } : {}),
      content,
      createdAt: asTimestamp(read("createdAt")) ?? options.observedAt,
      observedAt: options.observedAt,
    });
  }

  const nextCursor = asString(pick(payload, "nextCursor", HISTORY_PAGE_ALIASES.nextCursor, options.inventory));
  const hasMore = pick(payload, "hasMore", HISTORY_PAGE_ALIASES.hasMore, options.inventory);

  return {
    writes,
    ...(nextCursor ? { nextCursor } : {}),
    // An explicit flag wins; otherwise a cursor is itself the signal there is more.
    hasMore: typeof hasMore === "boolean" ? hasMore : nextCursor !== undefined,
    dropped,
  };
}

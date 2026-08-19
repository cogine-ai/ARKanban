/**
 * Checks the collector's field projections against a live Gateway payload.
 *
 * Reads one JSON payload on stdin, either describing its shape or running it
 * through the collector's own projectors and reporting what came out.
 *
 * Nothing is printed that could carry conversation content: the shape mode
 * reports key names, types and string lengths but never string values, and the
 * projection modes report counts and which fields came out populated. A Gateway
 * payload contains real conversations, along with contact identifiers in
 * `senderName` and host paths in `MediaPath`, and the same rule that keeps
 * transcript text out of logs and diagnostics applies to this script.
 *
 * The Gateway's own CLI supplies the payload, so no token is handled here:
 *
 *   openclaw gateway call sessions.list --json --params '{"limit":20}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts sessions
 *
 *   openclaw gateway call chat.history --json --params '{"sessionKey":"…","limit":30}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts history 30
 *
 *   openclaw gateway call sessions.usage --json --params '{"key":"…","range":"all"}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts usage
 *
 *   openclaw gateway call audit.list --json --params '{"limit":100}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts audit
 *
 * Any method can be explored with `shape`, which is how the mismatches recorded
 * in docs/v1/real-gateway-field-calibration.md were found.
 */

import {
  AUDIT_KIND_RUN,
  AUDIT_KIND_TOOL,
  AUDIT_RUN_OUTCOMES,
  auditToolVerdict,
  projectAuditPage,
} from "../src/activity/audit-projector.js";
import { projectHistoryPage } from "../src/activity/message-projector.js";
import { HISTORY_PAGE_LIMIT } from "../src/collector/transcript-sync.js";
import { projectSession } from "../src/activity/session-projector.js";
import { projectUsagePage } from "../src/activity/usage-projector.js";
import { FieldInventory } from "../src/collector/field-inventory.js";

const MODES = ["shape", "history", "sessions", "usage", "audit"] as const;
type Mode = (typeof MODES)[number];

const requested = process.argv[2] ?? "shape";
if (!MODES.includes(requested as Mode)) {
  process.stderr.write(`unknown mode ${requested}; expected one of ${MODES.join(", ")}\n`);
  process.exit(1);
}
const mode = requested as Mode;
const now = Date.now();

/**
 * The `limit` the call was made with, because 2026.7.1-2 reports no paging at all
 * and the projector derives `hasMore` from whether the page came back full. Pass
 * the same number here that the call used, or the paging verdict this prints is
 * about a request nobody made.
 */
const limitArgument = (process.argv[3] ?? "").trim();
// Whole positive integers only. `parseInt` reads `30x` as 30 and `-5` as -5, and
// a negative limit makes every page look full — this script exists to report the
// paging verdict, so it may not invent one out of a typo and say nothing.
const requestLimit = /^[1-9]\d*$/.test(limitArgument) ? Number(limitArgument) : HISTORY_PAGE_LIMIT;
if (limitArgument && requestLimit !== Number(limitArgument)) {
  process.stderr.write(`ignoring limit "${limitArgument}"; using ${HISTORY_PAGE_LIMIT}\n`);
}

const MAX_DEPTH = 5;

/** Describes a value by its structure alone. Strings report length, never content. */
function shapeOf(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[] (empty)";
    return `[${value.length} items] first = ${shapeOf(value[0], depth + 1)}`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    if (depth >= MAX_DEPTH) return `{…${entries.length} keys}`;
    const lines = entries.map(([key, nested]) => `\n${pad}  ${key}: ${shapeOf(nested, depth + 1)}`);
    return `{${lines.join("")}\n${pad}}`;
  }
  if (typeof value === "string") return `str(len=${value.length})`;
  if (typeof value === "boolean") return `bool(${value})`;
  if (value === null) return "null";
  // Numbers are structure rather than content here: the magnitude is what
  // distinguishes milliseconds from seconds, and a token count from a cost.
  if (typeof value === "number") return `number(${value})`;
  return typeof value;
}

const raw = await new Promise<string>((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (text += chunk));
  process.stdin.on("end", () => resolve(text));
  process.stdin.on("error", reject);
});

const parsed = JSON.parse(raw) as Record<string, unknown>;
// `openclaw gateway call --json` wraps the reply; a raw payload is accepted too.
const payload = (parsed.result as Record<string, unknown> | undefined) ?? parsed;

function reportInventory(inventory: FieldInventory): void {
  const report = inventory.report();
  process.stdout.write(`unknown keys:   ${report.unknown.join(", ") || "none"}\n`);
  process.stdout.write(`missing fields: ${report.missing.join(", ") || "none"}\n`);
}

if (mode === "shape") {
  process.stdout.write(`${shapeOf(payload)}\n`);
} else if (mode === "history") {
  const inventory = new FieldInventory("chat.history");
  const page = projectHistoryPage(payload, {
    sessionKey: "probe",
    observedAt: now,
    seqBase: -1,
    request: { limit: requestLimit, offset: 0 },
    inventory,
  });
  const roles = new Map<string, number>();
  for (const write of page.writes) roles.set(write.role, (roles.get(write.role) ?? 0) + 1);
  const inPayload = Array.isArray(payload.messages) ? payload.messages.length : 0;
  process.stdout.write(`messages in payload: ${inPayload}\n`);
  process.stdout.write(`projected:           ${page.writes.length}\n`);
  process.stdout.write(`dropped:             ${page.dropped}\n`);
  process.stdout.write(`roles:               ${[...roles].map(([role, n]) => `${role}=${n}`).join(" ") || "none"}\n`);
  process.stdout.write(`ids present:         ${page.writes.filter((w) => w.messageId !== undefined).length}/${page.writes.length}\n`);
  // Three states, counted separately: a stated failure, a stated success, and a
  // turn that is not a tool result. Collapsing the last two is the mistake this
  // line exists to catch.
  const failed = page.writes.filter((write) => write.isError === true).length;
  const worked = page.writes.filter((write) => write.isError === false).length;
  process.stdout.write(`tool verdicts:       failed=${failed} ok=${worked} absent=${page.writes.length - failed - worked}\n`);
  if (page.writes.length > 0) {
    const seqs = page.writes.map((write) => write.seq);
    process.stdout.write(`seq range:           ${Math.min(...seqs)}..${Math.max(...seqs)}\n`);
  }
  process.stdout.write(`nextOffset:          ${page.nextOffset ?? "none"} (hasMore=${page.hasMore})\n`);
  reportInventory(inventory);
} else if (mode === "sessions") {
  const inventory = new FieldInventory("sessions.list");
  // A `chat.history` reply embeds one row as `sessionInfo`, which is a way to
  // check this projection without a second call.
  const rows = Array.isArray(payload.sessions)
    ? (payload.sessions as Record<string, unknown>[])
    : payload.sessionInfo
      ? [payload.sessionInfo as Record<string, unknown>]
      : [];
  const writes = rows.flatMap((row) => projectSession(row, now, inventory) ?? []);
  const ratio = (predicate: (write: (typeof writes)[number]) => boolean): string =>
    `${writes.filter(predicate).length}/${writes.length}`;
  process.stdout.write(`rows: ${rows.length}  projected: ${writes.length}\n`);
  process.stdout.write(`agentId resolved:  ${ratio((w) => w.agentId !== "Unattributed")}\n`);
  process.stdout.write(`runtime populated: ${ratio((w) => w.runtime !== undefined)}\n`);
  process.stdout.write(`model populated:   ${ratio((w) => w.model !== undefined)}\n`);
  process.stdout.write(`kindHint:          ${[...new Set(writes.map((w) => w.kindHint))].join(", ") || "none"}\n`);
  // The index's `inputTokens`, `totalTokens` and `estimatedCostUsd` show up in
  // the unknown list below and are deliberately unconsumed: the runtime assigns
  // them per run rather than accumulating, so they describe the last run and not
  // the session. Reporting them here would invite reading them as spend.
  reportInventory(inventory);
} else if (mode === "audit") {
  const inventory = new FieldInventory("audit.list");
  const page = projectAuditPage(payload, { observedAt: now, inventory });
  const kinds = new Map<string, number>();
  for (const write of page.writes) kinds.set(write.kind, (kinds.get(write.kind) ?? 0) + 1);
  const inPayload = Array.isArray(payload.events) ? payload.events.length : 0;
  process.stdout.write(`events in payload: ${inPayload}\n`);
  process.stdout.write(`projected:         ${page.writes.length}\n`);
  // A drop here is either a record missing an identity field or one that did not
  // promise `metadata_only`; both are reasons this table stays metadata.
  process.stdout.write(`dropped:           ${page.dropped}\n`);
  process.stdout.write(`kinds:             ${[...kinds].map(([kind, n]) => `${kind}=${n}`).join(" ") || "none"}\n`);
  const statuses = new Map<string, number>();
  for (const write of page.writes) statuses.set(write.status, (statuses.get(write.status) ?? 0) + 1);
  process.stdout.write(`statuses:          ${[...statuses].map(([status, n]) => `${status}=${n}`).join(" ")}\n`);
  // What the trail can actually settle, which is the reason to collect it: a
  // status this build cannot read either way is worth as much as no record.
  const tools = page.writes.filter((write) => write.kind === AUDIT_KIND_TOOL);
  const settled = tools.map((write) => auditToolVerdict(write.status, write.errorCode));
  process.stdout.write(
    `tool verdicts:     failed=${settled.filter((v) => v === true).length} ok=${settled.filter((v) => v === false).length} unsettled=${settled.filter((v) => v === undefined).length}\n`,
  );
  const runs = page.writes.filter((write) => write.kind === AUDIT_KIND_RUN);
  const classified = runs.filter((write) => AUDIT_RUN_OUTCOMES[write.status.toLowerCase()] !== undefined);
  process.stdout.write(`run outcomes:      classified=${classified.length}/${runs.length}\n`);
  process.stdout.write(`sessions attached: ${page.writes.filter((w) => w.sessionKey !== undefined).length}/${page.writes.length}\n`);
  process.stdout.write(`tool call ids:     ${tools.filter((w) => w.toolCallId !== undefined).length}/${tools.length}\n`);
  process.stdout.write(`sequence range:    ${page.oldestSequence ?? "none"}..${page.newestSequence ?? "none"}\n`);
  process.stdout.write(`nextCursor:        ${page.nextCursor ?? "none"}\n`);
  reportInventory(inventory);
} else {
  const inventory = new FieldInventory("sessions.usage");
  const page = projectUsagePage(payload, { observedAt: now, inventory });
  process.stdout.write(`projected: ${page.writes.length}  dropped: ${page.dropped}\n`);
  for (const write of page.writes) {
    process.stdout.write(
      `  in/out=${write.inputTokens}/${write.outputTokens} cost=${write.costMicroUsd ?? "none"} hasCost=${write.hasCost} models=${write.models.length}\n`,
    );
  }
  // A reply that answers with every count zero is dropped, because storing it
  // would assert the session was free. `cacheStatus` does not explain it away:
  // the calibration machine reported `fresh` while returning zeros for sessions
  // the index priced, so a drop here means the cost view falls back to the index.
  const cache = payload.cacheStatus;
  if (cache && typeof cache === "object") process.stdout.write(`cacheStatus:    ${shapeOf(cache, 1)}\n`);
  reportInventory(inventory);
}

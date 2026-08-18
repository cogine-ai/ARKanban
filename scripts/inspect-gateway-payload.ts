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
 *   openclaw gateway call chat.history --json --params '{"sessionKey":"…","offset":0}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts history
 *
 *   openclaw gateway call sessions.usage --json --params '{"key":"…","range":"all"}' \
 *     | npx tsx scripts/inspect-gateway-payload.ts usage
 *
 * Any method can be explored with `shape`, which is how the mismatches recorded
 * in docs/v1/real-gateway-field-calibration.md were found.
 */

import { projectHistoryPage } from "../src/activity/message-projector.js";
import { projectSession } from "../src/activity/session-projector.js";
import { projectUsagePage } from "../src/activity/usage-projector.js";
import { FieldInventory } from "../src/collector/field-inventory.js";

const MODES = ["shape", "history", "sessions", "usage"] as const;
type Mode = (typeof MODES)[number];

const requested = process.argv[2] ?? "shape";
if (!MODES.includes(requested as Mode)) {
  process.stderr.write(`unknown mode ${requested}; expected one of ${MODES.join(", ")}\n`);
  process.exit(1);
}
const mode = requested as Mode;
const now = Date.now();

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
  const page = projectHistoryPage(payload, { sessionKey: "probe", observedAt: now, seqBase: -1, inventory });
  const roles = new Map<string, number>();
  for (const write of page.writes) roles.set(write.role, (roles.get(write.role) ?? 0) + 1);
  const inPayload = Array.isArray(payload.messages) ? payload.messages.length : 0;
  process.stdout.write(`messages in payload: ${inPayload}\n`);
  process.stdout.write(`projected:           ${page.writes.length}\n`);
  process.stdout.write(`dropped:             ${page.dropped}\n`);
  process.stdout.write(`roles:               ${[...roles].map(([role, n]) => `${role}=${n}`).join(" ") || "none"}\n`);
  process.stdout.write(`ids present:         ${page.writes.filter((w) => w.messageId !== undefined).length}/${page.writes.length}\n`);
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

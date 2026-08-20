import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { ActivityWrite } from "../activity/projector.js";
import { stageFor } from "../activity/projector.js";
import type { CollectorRepository } from "../storage/repository.js";

const execFileAsync = promisify(execFile);

export type StandaloneCliKind = "claude" | "codex";

export type ObservedCliProcess = {
  pid: number;
  kind: StandaloneCliKind;
  command: string;
  args: string;
};

const CLI_POLL_MS = 5_000;

/**
 * Observe standalone Claude Code / Codex CLI processes on this host.
 *
 * OpenClaw-backed harness sessions already appear via the Gateway. This path
 * only covers processes whose basename is `claude` or `codex` so the board can
 * show operator work that never entered the Gateway.
 */
type KnownCliProcess = {
  firstSeen: number;
  lastSeen: number;
};

export class StandaloneCliSynchronizer {
  private timer?: ReturnType<typeof setInterval>;
  private readonly known = new Map<string, KnownCliProcess>();
  private stopped = true;
  private shutdown = false;

  constructor(
    private readonly repository: CollectorRepository,
    private readonly options: {
      enabled: boolean;
      listProcesses?: () => Promise<ObservedCliProcess[]>;
    },
  ) {}

  start(): void {
    if (!this.options.enabled || !this.stopped) return;
    this.stopped = false;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), CLI_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.shutdown = true;
    if (this.timer) clearInterval(this.timer);
  }

  async sync(now = Date.now()): Promise<number> {
    if (!this.options.enabled) return 0;
    try {
      const processes = await (this.options.listProcesses ?? listStandaloneCliProcesses)();
      if (this.shutdown) return 0;
      const seen = new Set<string>();
      const writes: ActivityWrite[] = [];

      for (const process of processes) {
        const sourceKey = `standalone_cli:${process.kind}:${process.pid}`;
        seen.add(sourceKey);
        const previous = this.known.get(sourceKey);
        const firstSeen = previous?.firstSeen ?? now;
        this.known.set(sourceKey, { firstSeen, lastSeen: now });
        writes.push(cliProcessToActivity(process, firstSeen, now));
      }

      for (const [sourceKey, known] of this.known) {
        if (seen.has(sourceKey)) continue;
        if (now - known.lastSeen < CLI_POLL_MS * 2) continue;
        const kind = sourceKey.includes(":claude:") ? "claude" : "codex";
        const pid = Number(sourceKey.split(":").at(-1) ?? 0);
        writes.push(terminalCliActivity(kind, pid, known.firstSeen, now));
        this.known.delete(sourceKey);
      }

      if (writes.length === 0 || this.shutdown) return 0;
      const change = this.repository.upsertMany(writes, ["standalone_cli_sync"]);
      return change?.ids.length ?? 0;
    } catch {
      // A fire-and-forget poll must not become an unhandled rejection, and must
      // not touch the repository after stop() has closed it.
      return 0;
    }
  }
}

export function cliProcessToActivity(
  process: ObservedCliProcess,
  startedAt: number,
  now = startedAt,
): ActivityWrite {
  const id = stableCliActivityId(process.kind, process.pid);
  return {
    id,
    kind: "attempt",
    origin: "standalone_cli",
    catalog: "operational",
    sourceKey: `standalone_cli:${process.kind}:${process.pid}`,
    runRef: `cli:${process.kind}:${process.pid}`,
    agentId: `cli:${process.kind}`,
    runtime: process.kind === "claude" ? "claude-code" : "codex",
    state: "active",
    outcome: "none",
    phase: "model",
    attention: "none",
    stage: stageFor("active", "model", "none"),
    freshness: "live",
    title: summarizeCliTitle(process),
    startedAt,
    updatedAt: now,
    lastObservedAt: now,
    evidence: [{ source: "session", health: "live", observedAt: now, code: "standalone_cli" }],
    observation: {
      source: "collector",
      kind: "standalone_cli_alive",
      phase: "model",
      status: "running",
      occurredAt: now,
    },
  };
}

function terminalCliActivity(
  kind: StandaloneCliKind,
  pid: number,
  startedAt: number,
  now: number,
): ActivityWrite {
  const id = stableCliActivityId(kind, pid);
  return {
    id,
    kind: "attempt",
    origin: "standalone_cli",
    catalog: "terminal_history",
    sourceKey: `standalone_cli:${kind}:${pid}`,
    runRef: `cli:${kind}:${pid}`,
    agentId: `cli:${kind}`,
    runtime: kind === "claude" ? "claude-code" : "codex",
    state: "terminal",
    outcome: "unknown",
    phase: "none",
    attention: "none",
    stage: "settled",
    freshness: "live",
    title: `${kind} CLI #${pid}`,
    startedAt,
    endedAt: now,
    updatedAt: now,
    lastObservedAt: now,
    evidence: [{ source: "session", health: "snapshot", observedAt: now, code: "standalone_cli_exit" }],
    observation: {
      source: "collector",
      kind: "standalone_cli_exit",
      status: "exited",
      occurredAt: now,
    },
  };
}

export function stableCliActivityId(kind: StandaloneCliKind, pid: number): string {
  return `attempt:cli_${createHash("sha256").update(`${kind}:${pid}`).digest("base64url").slice(0, 18)}`;
}

function summarizeCliTitle(process: ObservedCliProcess): string {
  return `${process.kind} CLI #${process.pid}`;
}

export async function listStandaloneCliProcesses(): Promise<ObservedCliProcess[]> {
  // pid,comm,args keeps this portable across macOS and Linux procps.
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return parsePsOutput(stdout);
}

export function parsePsOutput(stdout: string): ObservedCliProcess[] {
  const results: ObservedCliProcess[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    const args = match[3] ?? "";
    const kind = classifyCliCommand(command, args);
    if (!kind) continue;
    results.push({ pid, kind, command, args });
  }
  return results;
}

/**
 * Match the CLI binary itself, not helper shells that merely mention it in args
 * and not OpenClaw's own node workers (those are Gateway-visible already).
 */
export function classifyCliCommand(command: string, args: string): StandaloneCliKind | undefined {
  const base = command.split("/").at(-1)?.toLowerCase() ?? "";
  if (base === "claude" || base === "claude.exe") return "claude";
  if (base === "codex" || base === "codex.exe") return "codex";
  // Some installs wrap the binary as `node …/claude` / `node …/codex`.
  if (base === "node" || base === "nodejs") {
    const tokens = args.split(/\s+/);
    for (const token of tokens) {
      const leaf = token.split("/").at(-1)?.toLowerCase() ?? "";
      if (leaf === "claude" || leaf.startsWith("claude.")) return "claude";
      if (leaf === "codex" || leaf.startsWith("codex.")) return "codex";
    }
  }
  return undefined;
}

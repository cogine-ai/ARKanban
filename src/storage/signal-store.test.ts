import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attemptPatch } from "../activity/projector.js";
import { SIGNAL_ALGORITHM_VERSION } from "../activity/session-signals.js";
import { CollectorRepository } from "./repository.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const NOW = 1_800_000_000_000;

function repository(): CollectorRepository {
  const directory = mkdtempSync(path.join(tmpdir(), "collector-signals-"));
  const repo = new CollectorRepository(path.join(directory, "collector.db"));
  cleanups.push(() => {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return repo;
}

function session(
  repo: CollectorRepository,
  sessionKey: string,
  overrides: { hasActiveRun?: boolean; lastActivityAt?: number } = {},
): void {
  repo.upsertSessions([
    {
      sessionKey,
      agentId: "builder",
      label: sessionKey,
      kindHint: "main",
      archived: false,
      hasActiveRun: overrides.hasActiveRun ?? false,
      lineage: {},
      lastActivityAt: overrides.lastActivityAt ?? NOW,
      observedAt: NOW,
      coverage: { index: "live", detail: "not_observed", usage: "not_observed", messages: "not_observed" },
    },
  ]);
}

/** One tool observation on its own activity row, so each event survives the upsert. */
function toolEvent(
  repo: CollectorRepository,
  sessionKey: string,
  id: string,
  status: string,
  toolName: string,
  at: number,
): void {
  repo.upsertMany(
    [
      attemptPatch({
        id: `attempt:${id}`,
        sourceKey: `attempt:${id}`,
        origin: "session_segment",
        agentId: "builder",
        title: "Tool call",
        now: at,
        sessionKey,
        state: "active",
        phase: "tool",
        lastToolName: toolName,
        source: "events",
        eventKind: `session.tool:tool:${status}`,
        status,
      }),
    ],
    ["test"],
  );
}

/** An archived tool result, which states its outcome rather than implying it. */
function toolResult(
  repo: CollectorRepository,
  sessionKey: string,
  seq: number,
  toolName: string,
  isError: boolean,
  at: number,
  sessionId = "gen-1",
): void {
  repo.transcripts.append([
    {
      sessionKey,
      sessionId,
      messageId: `${sessionKey}:${sessionId}:${seq}`,
      seq,
      role: "tool",
      toolName,
      isError,
      content: isError ? "command failed" : "command output",
      createdAt: at,
      observedAt: at,
    },
  ]);
}

function terminalRun(
  repo: CollectorRepository,
  sessionKey: string,
  id: string,
  outcome: "succeeded" | "failed",
  at: number,
): void {
  repo.upsertMany(
    [
      attemptPatch({
        id: `attempt:${id}`,
        sourceKey: `attempt:${id}`,
        origin: "session_segment",
        agentId: "builder",
        title: "Run",
        now: at,
        sessionKey,
        state: "terminal",
        outcome,
        endedAt: at,
        ...(outcome === "failed" ? { attention: "error" as const } : {}),
        source: "events",
        eventKind: "agent:lifecycle:end",
        status: "end",
      }),
    ],
    ["test"],
  );
}

/** A tool verdict the Gateway stated in its audit trail. */
function auditTool(
  repo: CollectorRepository,
  sessionKey: string,
  sequence: number,
  toolName: string,
  status: string,
  at: number,
): void {
  repo.audit.append([
    {
      eventId: `${sessionKey}:tool:${sequence}`,
      sequence,
      occurredAt: at,
      kind: "tool_action",
      action: "tool.action.finished",
      status,
      agentId: "builder",
      sessionKey,
      runId: "run-1",
      toolName,
      observedAt: at,
    },
  ]);
}

function auditRun(
  repo: CollectorRepository,
  sessionKey: string,
  sequence: number,
  status: string,
  at: number,
): void {
  repo.audit.append([
    {
      eventId: `${sessionKey}:run:${sequence}`,
      sequence,
      occurredAt: at,
      kind: "agent_run",
      action: "agent.run.finished",
      status,
      agentId: "builder",
      sessionKey,
      runId: "run-1",
      observedAt: at,
    },
  ]);
}

describe("SignalStore evidence", () => {
  it("scores from stored activities and tool observations", () => {
    const repo = repository();
    session(repo, "agent:builder:one");
    toolEvent(repo, "agent:builder:one", "t1", "error", "exec", NOW - 3_000);
    toolEvent(repo, "agent:builder:one", "t2", "end", "exec", NOW - 2_000);
    terminalRun(repo, "agent:builder:one", "r1", "succeeded", NOW - 1_000);

    const signals = repo.signals.recompute("agent:builder:one", NOW);

    expect(signals).toMatchObject({
      sessionKey: "agent:builder:one",
      outcome: "completed",
      confidence: "high",
      toolFailures: 1,
      toolRetries: 1,
      algorithmVersion: SIGNAL_ALGORITHM_VERSION,
    });
    expect(signals?.penalties.map((penalty) => penalty.code)).toEqual(["tool_failure"]);
  });

  it("reads evidence from an activity whose session reference has not been promoted yet", () => {
    const repo = repository();
    // The activity arrives before the session row, so `session_ref` is still null.
    toolEvent(repo, "agent:builder:late", "t1", "error", "exec", NOW - 2_000);
    session(repo, "agent:builder:late");

    const signals = repo.signals.recompute("agent:builder:late", NOW);

    expect(signals?.toolFailures).toBe(1);
  });

  it("scores an archived tool result the Gateway called an error", () => {
    const repo = repository();
    session(repo, "agent:builder:archived");
    toolResult(repo, "agent:builder:archived", 1, "exec", true, NOW - 3_000);
    toolResult(repo, "agent:builder:archived", 2, "exec", false, NOW - 2_000);

    const signals = repo.signals.recompute("agent:builder:archived", NOW);

    expect(signals).toMatchObject({ toolFailures: 1, toolRetries: 1, confidence: "medium" });
    expect(signals?.penalties.map((penalty) => penalty.code)).toEqual(["tool_failure"]);
  });

  it("charges one failed call once when both the archive and the events hold it", () => {
    const repo = repository();
    session(repo, "agent:builder:both");
    toolEvent(repo, "agent:builder:both", "t1", "error", "exec", NOW - 3_000);
    toolResult(repo, "agent:builder:both", 1, "exec", true, NOW - 3_000);

    const signals = repo.signals.recompute("agent:builder:both", NOW);

    expect(signals?.toolFailures).toBe(1);
  });

  /**
   * The state a session is in for the first rounds after transcripts are switched
   * on: the archive holds the newest page, the events hold the whole run the
   * collector watched. Scoring the page alone would drop the earlier failures and
   * let the grade improve as the archive filled in.
   */
  it("keeps the older failures when the archive has only caught up to the newest turn", () => {
    const repo = repository();
    session(repo, "agent:builder:catching-up");
    toolEvent(repo, "agent:builder:catching-up", "t1", "error", "exec", NOW - 9_000);
    toolEvent(repo, "agent:builder:catching-up", "t2", "error", "exec", NOW - 8_000);
    toolEvent(repo, "agent:builder:catching-up", "t3", "error", "deploy", NOW - 7_000);
    toolResult(repo, "agent:builder:catching-up", 40, "search", false, NOW - 1_000);

    const signals = repo.signals.recompute("agent:builder:catching-up", NOW);

    expect(signals?.toolFailures).toBe(3);
    expect(signals?.consecutiveFailureMax).toBe(3);
  });

  it("switches to the archive once it holds more than the events did", () => {
    const repo = repository();
    session(repo, "agent:builder:caught-up");
    toolEvent(repo, "agent:builder:caught-up", "t1", "error", "exec", NOW - 9_000);
    for (const [index, failed] of [true, true, false, false].entries()) {
      toolResult(repo, "agent:builder:caught-up", index, "exec", failed, NOW - 8_000 + index);
    }

    const signals = repo.signals.recompute("agent:builder:caught-up", NOW);

    // Two, not three: the event and the first archived result are the same call.
    expect(signals?.toolFailures).toBe(2);
  });

  it("leaves a compacted generation out rather than counting its results twice", () => {
    const repo = repository();
    session(repo, "agent:builder:compacted");
    toolResult(repo, "agent:builder:compacted", 1, "exec", true, NOW - 5_000, "gen-1");
    repo.transcripts.supersede("agent:builder:compacted", "gen-2");
    toolResult(repo, "agent:builder:compacted", 1, "exec", true, NOW - 4_000, "gen-2");

    const signals = repo.signals.recompute("agent:builder:compacted", NOW);

    expect(signals?.toolFailures).toBe(1);
  });

  it("scores the audit trail when it holds the most settled calls", () => {
    const repo = repository();
    session(repo, "agent:builder:audited");
    toolEvent(repo, "agent:builder:audited", "t1", "error", "exec", NOW - 9_000);
    auditTool(repo, "agent:builder:audited", 1, "exec", "failed", NOW - 9_000);
    auditTool(repo, "agent:builder:audited", 2, "exec", "failed", NOW - 8_000);
    auditTool(repo, "agent:builder:audited", 3, "exec", "succeeded", NOW - 7_000);

    const signals = repo.signals.recompute("agent:builder:audited", NOW);

    expect(signals).toMatchObject({ toolFailures: 2, toolRetries: 2, consecutiveFailureMax: 2 });
  });

  /**
   * Both state the outcome, but the audit trail pairs each call by `toolCallId`
   * while the archive holds whichever pages have been fetched, so a tie goes to
   * the trail.
   */
  it("takes the audit trail over the archive when they saw the same number of calls", () => {
    const repo = repository();
    session(repo, "agent:builder:tie");
    toolResult(repo, "agent:builder:tie", 1, "exec", false, NOW - 5_000);
    auditTool(repo, "agent:builder:tie", 1, "exec", "failed", NOW - 5_000);

    const signals = repo.signals.recompute("agent:builder:tie", NOW);

    expect(signals?.toolFailures).toBe(1);
  });

  /**
   * The backwards walk has only reached the newest record. Scoring on it alone
   * would drop the failures the events already recorded — and the grade would
   * improve as collection caught up.
   */
  it("keeps the richer observations while the audit walk is still catching up", () => {
    const repo = repository();
    session(repo, "agent:builder:partial");
    toolEvent(repo, "agent:builder:partial", "t1", "error", "exec", NOW - 9_000);
    toolEvent(repo, "agent:builder:partial", "t2", "error", "exec", NOW - 8_000);
    toolEvent(repo, "agent:builder:partial", "t3", "error", "deploy", NOW - 7_000);
    auditTool(repo, "agent:builder:partial", 9, "search", "succeeded", NOW - 1_000);

    const signals = repo.signals.recompute("agent:builder:partial", NOW);

    expect(signals?.toolFailures).toBe(3);
    expect(signals?.consecutiveFailureMax).toBe(3);
  });

  /**
   * Without a run verdict this session is graded on quiet time alone, which calls
   * a finished run abandoned six hours after it ended.
   */
  it("fills an outcome nothing else classified from the audit trail's run verdict", () => {
    const repo = repository();
    const quietSince = NOW - 8 * 60 * 60 * 1_000;
    session(repo, "agent:builder:quiet-run", { lastActivityAt: quietSince });
    expect(repo.signals.recompute("agent:builder:quiet-run", NOW)).toMatchObject({ outcome: "abandoned" });

    auditRun(repo, "agent:builder:quiet-run", 1, "succeeded", quietSince);

    expect(repo.signals.recompute("agent:builder:quiet-run", NOW)).toMatchObject({
      outcome: "completed",
      penalties: [],
    });
  });

  it("does not let a run verdict overrule an outcome the Activity rows classified", () => {
    const repo = repository();
    session(repo, "agent:builder:contested");
    terminalRun(repo, "agent:builder:contested", "r1", "failed", NOW - 2_000);
    auditRun(repo, "agent:builder:contested", 1, "succeeded", NOW - 1_000);

    const signals = repo.signals.recompute("agent:builder:contested", NOW);

    expect(signals?.outcome).toBe("errored");
    expect(signals?.penalties.map((penalty) => penalty.code)).toContain("errored_outcome");
  });

  it("ignores messages that are not tool results at all", () => {
    const repo = repository();
    session(repo, "agent:builder:chat");
    repo.transcripts.append([
      {
        sessionKey: "agent:builder:chat",
        sessionId: "gen-1",
        messageId: "m1",
        seq: 1,
        role: "user",
        content: "hello",
        createdAt: NOW - 1_000,
        observedAt: NOW - 1_000,
      },
    ]);

    const signals = repo.signals.recompute("agent:builder:chat", NOW);

    expect(signals).toMatchObject({ toolFailures: 0, grade: "unscored", confidence: "low" });
  });

  it("returns nothing for a session that was never observed", () => {
    const repo = repository();

    expect(repo.signals.recompute("agent:builder:ghost", NOW)).toBeUndefined();
  });

  it("round-trips penalties and an absent score through storage", () => {
    const repo = repository();
    session(repo, "agent:builder:failed");
    terminalRun(repo, "agent:builder:failed", "r1", "failed", NOW - 1_000);
    session(repo, "agent:builder:bare", { hasActiveRun: true });

    repo.signals.recompute("agent:builder:failed", NOW);
    repo.signals.recompute("agent:builder:bare", NOW);

    const failed = repo.signals.get("agent:builder:failed");
    expect(failed?.penalties).toEqual([
      { code: "errored_outcome", points: 45 },
      { code: "attention_error", points: 10 },
    ]);
    expect(failed?.score).toBe(45);

    const bare = repo.signals.get("agent:builder:bare");
    expect(bare?.grade).toBe("unscored");
    expect(bare).not.toHaveProperty("score");
  });
});

describe("SignalStore staleness", () => {
  it("treats a never-scored session as stale", () => {
    const repo = repository();
    session(repo, "agent:builder:one");

    expect(repo.signals.staleSessions()).toEqual(["agent:builder:one"]);
  });

  it("treats a session that moved after scoring as stale, and a quiet one as fresh", () => {
    const repo = repository();
    session(repo, "agent:builder:quiet", { lastActivityAt: NOW - 10_000 });
    session(repo, "agent:builder:moved", { lastActivityAt: NOW - 10_000 });
    repo.signals.recompute("agent:builder:quiet", NOW);
    repo.signals.recompute("agent:builder:moved", NOW);
    expect(repo.signals.staleSessions()).toEqual([]);

    session(repo, "agent:builder:moved", { lastActivityAt: NOW + 5_000 });

    expect(repo.signals.staleSessions()).toEqual(["agent:builder:moved"]);
  });

  it("marks every row stale when the algorithm version moves", () => {
    const repo = repository();
    session(repo, "agent:builder:one");
    const scored = repo.signals.recompute("agent:builder:one", NOW)!;
    expect(repo.signals.staleSessions()).toEqual([]);

    repo.signals.record([{ ...scored, algorithmVersion: SIGNAL_ALGORITHM_VERSION - 1 }]);

    expect(repo.signals.staleSessions()).toEqual(["agent:builder:one"]);
  });

  it("puts active sessions at the front of the queue", () => {
    const repo = repository();
    session(repo, "agent:builder:idle", { lastActivityAt: NOW });
    session(repo, "agent:builder:running", { hasActiveRun: true, lastActivityAt: NOW - 60_000 });

    expect(repo.signals.staleSessions()).toEqual(["agent:builder:running", "agent:builder:idle"]);
  });

  it("drains the backlog in batches rather than in one pass", () => {
    const repo = repository();
    for (let index = 0; index < 5; index += 1) {
      session(repo, `agent:builder:${index}`, { lastActivityAt: NOW - index });
    }

    expect(repo.signals.recomputeStale(NOW, 2)).toBe(2);
    expect(repo.signals.staleSessions()).toHaveLength(3);
    expect(repo.signals.recomputeStale(NOW, 10)).toBe(3);
    expect(repo.signals.staleSessions()).toEqual([]);
  });
});

describe("SignalStore read-through", () => {
  it("recomputes on read when the stored row is behind the evidence", () => {
    const repo = repository();
    session(repo, "agent:builder:one", { lastActivityAt: NOW - 10_000 });
    const first = repo.signals.freshFor("agent:builder:one", NOW - 9_000)!;
    expect(first.outcome).toBe("unknown");

    terminalRun(repo, "agent:builder:one", "r1", "failed", NOW - 1_000);
    session(repo, "agent:builder:one", { lastActivityAt: NOW });

    const second = repo.signals.freshFor("agent:builder:one", NOW)!;
    expect(second.outcome).toBe("errored");
    expect(second.computedAt).toBe(NOW);
  });

  it("returns the stored row untouched when nothing moved", () => {
    const repo = repository();
    session(repo, "agent:builder:one", { lastActivityAt: NOW - 10_000 });
    const first = repo.signals.freshFor("agent:builder:one", NOW - 9_000)!;

    const second = repo.signals.freshFor("agent:builder:one", NOW)!;

    expect(second.computedAt).toBe(first.computedAt);
  });
});

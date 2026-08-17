import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentActivityRollup, AgentRollupWindow, UpcomingSchedule } from "../../../src/contracts";
import { collectorApi, type AgentDetail as AgentDetailData } from "../api";
import { AgentCost, ROLLUP_WINDOWS } from "../components/AgentCost";
import { GradeChip } from "../components/GradeChip";
import { useScheduleNow } from "../hooks/use-schedule-now";
import { AGENT_COLORS } from "../lib/board";
import {
  formatDateTime,
  formatDuration,
  formatPercent,
  formatRelative,
  formatScheduleRelative,
  hash,
  shortAgent,
} from "../lib/format";
import { Link } from "../router";
import { useCollector } from "../state/collector-context";

/**
 * One agent, in more depth than its card.
 *
 * The card answers "is this agent healthy right now"; this page answers "what
 * has it been doing". The difference that matters is the outcome distribution:
 * the card shows a success rate, which cannot distinguish an agent that fails
 * from one that is cancelled, times out, or ends without a verdict at all.
 */

/** Outcome buckets in the order they are worth reading, worst last. */
const OUTCOMES: Array<{ key: keyof AgentActivityRollup; label: string }> = [
  { key: "succeeded", label: "succeeded" },
  { key: "unknown", label: "unclassified" },
  { key: "cancelled", label: "cancelled" },
  { key: "blocked", label: "blocked" },
  { key: "timedOut", label: "timed out" },
  { key: "failed", label: "failed" },
];

function OutcomeBar({ rollup }: { rollup: AgentActivityRollup }) {
  if (rollup.completed === 0) return <p className="muted">Nothing finished in this window.</p>;

  return (
    <>
      <div className="outcome-bar" role="img" aria-label={OUTCOMES.map((entry) => `${rollup[entry.key]} ${entry.label}`).join(", ")}>
        {OUTCOMES.map((entry) => {
          const count = rollup[entry.key] as number;
          if (count === 0) return null;
          return (
            <span
              key={entry.key}
              data-outcome={entry.key}
              style={{ flexGrow: count }}
              title={`${count} ${entry.label} (${formatPercent(count / rollup.completed)})`}
            />
          );
        })}
      </div>
      <ul className="outcome-legend">
        {OUTCOMES.map((entry) => {
          const count = rollup[entry.key] as number;
          if (count === 0) return null;
          return (
            <li key={entry.key} data-outcome={entry.key}>
              <span className="outcome-swatch" aria-hidden="true" />
              {entry.label} <b>{count}</b>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function WindowPanel({ window, rollup }: { window: AgentRollupWindow; rollup: AgentActivityRollup }) {
  return (
    <div className="detail-panel" data-window={window}>
      <h2>Last {window}</h2>
      <div className="fact-grid">
        <div className="fact">
          <span className="eyebrow">FINISHED</span>
          <span>{rollup.completed}</span>
        </div>
        <div className="fact">
          <span className="eyebrow">SUCCESS</span>
          <span>{formatPercent(rollup.successRate)}</span>
        </div>
        <div className="fact" title={rollup.durationSampleCount > 0 ? `${rollup.durationSampleCount} runs reported both a start and an end` : "No run reported both a start and an end"}>
          <span className="eyebrow">AVG DURATION</span>
          <span>{formatDuration(rollup.avgDurationMs)}</span>
        </div>
      </div>
      <OutcomeBar rollup={rollup} />
    </div>
  );
}

function SchedulePanel({ schedules }: { schedules: UpcomingSchedule[] }) {
  const now = useScheduleNow();
  return (
    <div className="detail-panel">
      <h2>Next hour</h2>
      {schedules.length === 0 ? (
        <p className="muted">No cron job is due for this agent within the hour.</p>
      ) : (
        <ol className="schedule-list">
          {[...schedules].sort((left, right) => left.nextRunAt - right.nextRunAt).map((schedule) => (
            <li key={schedule.id}>
              <span className="schedule-title">{schedule.title}</span>
              <span className="muted" title={formatDateTime(schedule.nextRunAt)}>
                {formatScheduleRelative(schedule.nextRunAt, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function AgentDetailView({ agentId }: { agentId: string }) {
  const { snapshot, subscribeTopics } = useCollector();
  const [detail, setDetail] = useState<AgentDetailData>();
  const [error, setError] = useState<string>();

  // Four topics feed this page, so reloads overlap readily. Only the newest may
  // write, or an earlier response would land on top of a later one.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const requested = (generation.current += 1);
    try {
      const agent = await collectorApi.agent(agentId);
      if (requested !== generation.current) return;
      setDetail(agent);
      setError(undefined);
    } catch (cause) {
      if (requested !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [agentId]);

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    void reload();
    return subscribeTopics(["agents", "sessions", "activities", "usage"], () => void reload());
  }, [reload, subscribeTopics]);

  // Live counters and the cron forecast are not on the roster endpoint; both
  // are already computed on the activity snapshot the whole app shares.
  const live = useMemo(() => {
    const items = (snapshot?.items ?? []).filter((item) => item.agentId === agentId && item.state !== "terminal");
    return {
      running: items.filter((item) => item.state === "active").length,
      attention: items.filter((item) => item.attention !== "none").length,
      schedules: (snapshot?.schedule.items ?? []).filter((schedule) => schedule.agentId === agentId),
    };
  }, [agentId, snapshot]);

  if (error) {
    return (
      <section className="surface view-surface">
        <div className="inline-error">{error}</div>
        <Link to="/agents">Back to agents</Link>
      </section>
    );
  }

  if (!detail) return <section className="surface view-surface"><div className="simple-empty">Loading agent…</div></section>;

  const { agent, sessions } = detail;
  const descriptors = [agent.model, agent.runtime].filter(Boolean).join(" · ");

  return (
    <section className="surface view-surface agent-detail">
      <div className="view-heading">
        <div className="agent-detail-identity">
          <span className="agent-avatar" style={{ background: AGENT_COLORS[hash(agent.id) % AGENT_COLORS.length] }}>
            {shortAgent(agent.id)}
          </span>
          <div>
            <span className="eyebrow">
              <Link to="/agents">AGENT ROSTER</Link>
            </span>
            <h1>{agent.displayName}</h1>
            <small className="muted">{descriptors || "runtime not reported"}</small>
          </div>
        </div>
        <span className="agent-badges">
          {agent.kind === "system" ? <span className="agent-badge system">SYSTEM</span> : null}
          {agent.origin === "observed" ? (
            <span className="agent-badge inferred" title="Inferred from observed activity; not in the Gateway roster">
              INFERRED
            </span>
          ) : null}
        </span>
      </div>

      <div className="detail-grid">
        <div className="detail-panel">
          <h2>Now</h2>
          <div className="fact-grid">
            <div className="fact"><span className="eyebrow">ACTIVE SESSIONS</span><span>{agent.activeSessionCount}</span></div>
            <div className="fact"><span className="eyebrow">RUNNING</span><span>{live.running}</span></div>
            <div className="fact"><span className="eyebrow">NEED ATTENTION</span><span>{live.attention}</span></div>
            <div className="fact"><span className="eyebrow">SESSIONS</span><span>{agent.sessionCount}</span></div>
            <div className="fact"><span className="eyebrow">ARCHIVED</span><span>{agent.archivedSessionCount}</span></div>
            <div className="fact"><span className="eyebrow">ACTIVITIES</span><span>{agent.activityCount}</span></div>
          </div>
          <footer className="detail-foot muted">
            First seen {formatRelative(agent.firstObservedAt)}
            {agent.lastSessionActivityAt ? ` · active ${formatRelative(agent.lastSessionActivityAt)}` : " · no session observed"}
          </footer>
        </div>

        {ROLLUP_WINDOWS.map((window) => <WindowPanel key={window} window={window} rollup={agent.recent[window]} />)}

        <div className="detail-panel">
          <h2>Cost</h2>
          <AgentCost cost={agent.cost} />
          <footer className="detail-foot muted">
            {agent.cost.source === "gateway" ? "Priced by the Gateway" : "Totalled from stored session readings"}
          </footer>
        </div>

        <SchedulePanel schedules={live.schedules} />
      </div>

      <div className="detail-panel">
        <h2>
          Recent sessions
          <Link className="panel-link" to={`/sessions?agentId=${encodeURIComponent(agent.id)}`}>
            all {agent.sessionCount} →
          </Link>
        </h2>
        {sessions.items.length === 0 ? (
          <p className="muted">No session has been archived for this agent.</p>
        ) : (
          <div className="session-list">
            {sessions.items.map((session) => (
              <Link key={session.sessionKey} className="session-row" to={`/sessions/${encodeURIComponent(session.sessionKey)}`}>
                <span className="session-label">
                  <b>{session.label}</b>
                  <small>{session.sessionKey}</small>
                </span>
                <GradeChip signals={session.signals} />
                <span className="session-state" data-active={session.hasActiveRun ? "true" : "false"}>
                  {session.archived ? "archived" : session.hasActiveRun ? "running" : "idle"}
                </span>
                <span className="session-count">{session.activityCount}</span>
                <span className="session-seen">{formatRelative(session.lastActivityAt)}</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

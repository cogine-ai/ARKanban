import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  ArchivedMessage,
  SessionSignals,
  SessionUsage,
  TranscriptSyncState,
} from "../../../src/contracts";
import { collectorApi, type SessionDetail as SessionDetailData } from "../api";
import { GradeChip } from "../components/GradeChip";
import { TranscriptText } from "../components/TranscriptText";
import {
  formatBytes,
  formatCost,
  formatDateTime,
  formatRelative,
  formatTokens,
  outcomeLabel,
} from "../lib/format";
import { Link } from "../router";
import { useCollector } from "../state/collector-context";

/** A label/value pair, rendering "not reported" rather than collapsing the row. */
function Fact({ label, value, title }: { label: string; value?: string | number; title?: string }) {
  return (
    <div className="fact" {...(title ? { title } : {})}>
      <span className="eyebrow">{label}</span>
      <span>{value === undefined || value === "" ? <em className="muted">not reported</em> : value}</span>
    </div>
  );
}

function SignalPanel({ signals }: { signals?: SessionSignals }) {
  if (!signals) {
    return (
      <div className="detail-panel">
        <h2>Signals</h2>
        <p className="muted">Not scored yet.</p>
      </div>
    );
  }

  return (
    <div className="detail-panel" data-grade={signals.grade}>
      <h2>
        Signals <GradeChip signals={signals} />
      </h2>
      <div className="fact-grid">
        <Fact label="OUTCOME" value={signals.outcome} />
        <Fact label="SCORE" value={signals.score ?? "—"} title={signals.score === undefined ? "Evidence did not support a score" : undefined} />
        <Fact label="CONFIDENCE" value={signals.confidence} />
        <Fact label="TOOL FAILURES" value={signals.toolFailures} />
        <Fact label="RETRIES" value={signals.toolRetries} />
        <Fact label="LONGEST FAILURE RUN" value={signals.consecutiveFailureMax} />
      </div>
      {signals.penalties.length > 0 ? (
        <ul className="penalty-list">
          {signals.penalties.map((penalty) => (
            <li key={penalty.code}>
              <span>{penalty.code.replaceAll("_", " ")}</span>
              <b>−{penalty.points}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No penalties charged.</p>
      )}
      {/* Shown, not hidden: the grade is heuristic and the version is what makes
          a number from last week comparable to one from today. */}
      <footer className="detail-foot muted">
        Algorithm v{signals.algorithmVersion} · scored {formatRelative(signals.computedAt)}
      </footer>
    </div>
  );
}

function UsagePanel({ usage, coverage }: { usage?: SessionUsage; coverage: string }) {
  if (!usage) {
    return (
      <div className="detail-panel">
        <h2>Usage</h2>
        <p className="muted">
          {coverage === "unavailable"
            ? "The Gateway does not report usage."
            : coverage === "unauthorized"
              ? "This token lacks the usage scope."
              : coverage === "unreported"
                ? "The Gateway was asked and reported no usage for this session. Its harness records no token counts, so there is nothing to price — not a session that cost nothing."
                : coverage === "error"
                  ? "The last usage read failed. Nothing here has been measured yet."
                  : "No reading collected for this session yet."}
        </p>
      </div>
    );
  }

  const tokens = usage.inputTokens + usage.outputTokens;
  return (
    <div className="detail-panel">
      <h2>Usage</h2>
      <div className="fact-grid">
        <Fact
          label="COST"
          value={`${formatCost(usage.costMicroUsd)}${usage.hasCost || usage.costMicroUsd === undefined ? "" : "+"}`}
          title={usage.hasCost ? undefined : `At least this much; no price for ${usage.unpricedModels.join(", ") || "some models"}`}
        />
        <Fact label="TOKENS" value={formatTokens(tokens)} title={`${tokens.toLocaleString()} input + output`} />
        <Fact label="CACHE READ" value={formatTokens(usage.cacheReadTokens)} />
        <Fact label="CACHE WRITE" value={formatTokens(usage.cacheWriteTokens)} />
        <Fact label="PEAK CONTEXT" value={usage.peakContextTokens === undefined ? "—" : formatTokens(usage.peakContextTokens)} />
        <Fact label="MODELS" value={usage.models.join(", ")} />
      </div>
      <footer className="detail-foot muted">Read {formatRelative(usage.observedAt)}</footer>
    </div>
  );
}

function TranscriptPanel({ sessionKey, revision }: { sessionKey: string; revision: number }) {
  const [messages, setMessages] = useState<ArchivedMessage[]>();
  const [sync, setSync] = useState<TranscriptSyncState>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ArchivedMessage[]>();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let active = true;
    // Reset first. Held state belongs to the session that has just been left, and
    // rendering it under the new key puts one conversation's text on another
    // conversation's page for as long as the request takes.
    setMessages(undefined);
    setSync(undefined);
    setError(undefined);
    void (async () => {
      try {
        const page = await collectorApi.sessionMessages(sessionKey);
        if (!active) return;
        setMessages(page.messages);
        setSync(page.sync);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionKey]);

  /**
   * Extends the loaded range from the highest sequence already on screen.
   *
   * Serves both the button and the sync loop, because from here they are the same
   * request. Appending rather than reloading is what keeps a reader who has paged
   * through a long transcript where they were.
   */
  const extend = useCallback(async () => {
    const loaded = messages;
    if (!loaded || loaded.length === 0) return;
    setLoadingMore(true);
    try {
      const page = await collectorApi.sessionMessages(sessionKey, loaded[loaded.length - 1]!.seq);
      setMessages((current) => [...(current ?? []), ...page.messages]);
      setSync(page.sync);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [messages, sessionKey]);

  const extendRef = useRef(extend);
  useEffect(() => {
    extendRef.current = extend;
  }, [extend]);

  // A round of transcript sync that added messages. Without this an open
  // transcript stays frozen at the moment the page loaded, while the sync loop
  // keeps archiving the conversation the reader is watching.
  useEffect(() => {
    if (revision === 0) return;
    void extendRef.current();
  }, [revision]);

  /**
   * Searching runs against the archive, not against what happens to be on
   * screen. Filtering the loaded page locally made this box disagree with the
   * cross-session search: a phrase further down the transcript was reported as
   * absent here while the other search found it.
   */
  useEffect(() => {
    const needle = query.trim();
    if (needle.length === 0) {
      setHits(undefined);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await collectorApi.searchMessages({ q: needle, sessionKey }, 200);
          if (active) setHits(result.hits.map((hit) => hit.message));
        } catch (cause) {
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (active) setSearching(false);
        }
      })();
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, sessionKey]);

  const searchActive = query.trim().length > 0;
  const shown = searchActive ? (hits ?? []) : (messages ?? []);
  const archived = sync?.syncedCount ?? 0;
  const remaining = messages === undefined ? 0 : Math.max(0, archived - messages.length);

  return (
    <div className="detail-panel transcript-panel">
      <h2>Transcript</h2>
      {/* The watermark is not optional decoration: the archive is local, so the
          reader must be able to tell a complete transcript from a partial one
          without assuming this view is live. */}
      <p className="transcript-watermark muted">
        {sync === undefined
          ? "Loading…"
          : sync.syncedCount === 0
            ? "Nothing archived for this session."
            : `${sync.syncedCount} messages · ${formatBytes(sync.syncedBytes)} · ${sync.complete ? "complete" : "partial"}${sync.syncedAt ? ` · synced ${formatRelative(sync.syncedAt)}` : ""}`}
        {sync?.errorCode ? ` · last sync failed (${sync.errorCode})` : ""}
      </p>

      {error ? <div className="inline-error">{error}</div> : null}

      {messages && messages.length > 0 ? (
        <label className="transcript-search">
          <span className="eyebrow">FIND IN TRANSCRIPT</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this session" />
          {searchActive ? (
            <small className="muted">
              {searching ? "searching the archive…" : `${shown.length} matching ${shown.length === 1 ? "message" : "messages"}`}
            </small>
          ) : null}
        </label>
      ) : null}

      {/* The list is paged, so how much of the transcript is on screen is stated
          rather than left to be inferred from where the scrollbar stops. */}
      {!searchActive && messages && remaining > 0 ? (
        <p className="transcript-truncation muted">
          Showing the oldest {messages.length} of {archived} archived messages.
        </p>
      ) : null}

      <ol className="transcript">
        {shown.map((message) => (
          <li key={message.id} className="transcript-message" data-role={message.role}>
            <header>
              <span className="transcript-role">{message.role}</span>
              {message.toolName ? <span className="transcript-tool">{message.toolName}</span> : null}
              <span className="muted">{formatDateTime(message.createdAt)}</span>
              {message.supersededBySessionId ? (
                <span className="transcript-superseded" title={`Replaced by generation ${message.supersededBySessionId}`}>
                  superseded
                </span>
              ) : null}
            </header>
            <p className="transcript-body">
              <TranscriptText text={message.content} highlight={query} />
            </p>
          </li>
        ))}
      </ol>

      {!searchActive && remaining > 0 ? (
        <button type="button" className="transcript-more" onClick={() => void extend()} disabled={loadingMore}>
          {loadingMore ? "Loading…" : `Load ${Math.min(remaining, 200)} more`}
        </button>
      ) : null}
    </div>
  );
}

function TimelinePanel({ activities }: { activities?: ActivityItem[] }) {
  return (
    <div className="detail-panel">
      <h2>Activity</h2>
      {activities === undefined ? (
        <p className="muted">Loading…</p>
      ) : activities.length === 0 ? (
        <p className="muted">No activity is attributed to this session.</p>
      ) : (
        <ol className="detail-timeline">
          {activities.map((activity) => (
            <li key={activity.id} data-state={activity.state} data-attention={activity.attention}>
              <span className="timeline-title">{activity.title}</span>
              <span className="timeline-outcome">{outcomeLabel(activity)}</span>
              <span className="muted">{formatRelative(activity.endedAt ?? activity.updatedAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function SessionDetailView({ sessionKey }: { sessionKey: string }) {
  const { subscribeTopics } = useCollector();
  const [detail, setDetail] = useState<SessionDetailData>();
  const [activities, setActivities] = useState<ActivityItem[]>();
  const [error, setError] = useState<string>();
  // Counts rounds of transcript sync that added something, which is what tells
  // the panel below to pick up messages archived since the page opened.
  const [transcriptRevision, setTranscriptRevision] = useState(0);

  // Change events can arrive faster than a fetch completes, and the key changes
  // when the reader follows a link from here. Only the newest request may write:
  // an earlier one landing later would show another session under this URL.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const requested = (generation.current += 1);
    try {
      const [session, timeline] = await Promise.all([
        collectorApi.session(sessionKey),
        collectorApi.sessionActivities(sessionKey),
      ]);
      if (requested !== generation.current) return;
      setDetail(session);
      setActivities(timeline.activities);
      setError(undefined);
    } catch (cause) {
      if (requested !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionKey]);

  useEffect(() => {
    // Cleared first so a new session shows its loading state rather than the
    // previous session's facts.
    setDetail(undefined);
    setActivities(undefined);
    setError(undefined);
    void reload();
    return subscribeTopics(["sessions", "activities", "usage"], () => void reload());
  }, [reload, subscribeTopics]);

  useEffect(
    () => subscribeTopics(["messages"], () => setTranscriptRevision((current) => current + 1)),
    [subscribeTopics],
  );

  if (error) {
    return (
      <section className="surface view-surface">
        <div className="inline-error">{error}</div>
        <Link to="/sessions">Back to sessions</Link>
      </section>
    );
  }

  if (!detail) return <section className="surface view-surface"><div className="simple-empty">Loading session…</div></section>;

  const { lineage } = detail;
  const hasLineage = Object.values(lineage).some((value) => value !== undefined);

  return (
    <section className="surface view-surface session-detail">
      <div className="view-heading">
        <div>
          <span className="eyebrow">
            <Link to={`/sessions?agentId=${encodeURIComponent(detail.agentId)}`}>{detail.agentId}</Link>
          </span>
          <h1>{detail.label}</h1>
          <code className="session-key">{detail.sessionKey}</code>
        </div>
        <span className="detail-badges">
          <GradeChip signals={detail.signals} />
          <span className="session-state" data-active={detail.hasActiveRun ? "true" : "false"}>
            {detail.archived ? "archived" : detail.hasActiveRun ? "running" : "idle"}
          </span>
        </span>
      </div>

      <div className="detail-grid">
        <div className="detail-panel">
          <h2>Archive</h2>
          <div className="fact-grid">
            <Fact label="KIND" value={detail.kindHint} />
            <Fact label="RUNTIME" value={detail.runtime} />
            <Fact label="MODEL" value={detail.model} />
            <Fact label="CATEGORY" value={detail.category} />
            <Fact label="PLACEMENT" value={detail.placement} />
            <Fact label="ACTIVITIES" value={detail.activityCount} />
            <Fact label="CREATED" value={detail.createdAt ? formatDateTime(detail.createdAt) : undefined} />
            <Fact label="LAST ACTIVITY" value={formatDateTime(detail.lastActivityAt)} />
          </div>
          {/* Coverage per source, so a blank field reads as "not observed"
              rather than "not there". */}
          <footer className="detail-foot muted">
            index {detail.coverage.index} · detail {detail.coverage.detail} · usage {detail.coverage.usage} · messages{" "}
            {detail.coverage.messages}
          </footer>
        </div>

        <div className="detail-panel">
          <h2>Lineage</h2>
          {hasLineage ? (
            <div className="fact-grid">
              <Fact label="PARENT SESSION" value={lineage.parentSessionKey} />
              <Fact label="PREVIOUS GENERATION" value={lineage.previousSessionId} />
              <Fact label="FORKED FROM" value={lineage.forkSourceKey} />
              <Fact label="SPAWNED BY" value={lineage.spawnedBy} />
              <Fact label="DEPTH" value={lineage.spawnDepth} />
              <Fact label="SUBAGENT ROLE" value={lineage.subagentRole} />
              <Fact label="WORKTREE" value={lineage.worktreeBranch} />
            </div>
          ) : (
            <p className="muted">No lineage reported; this session stands alone.</p>
          )}
        </div>

        <SignalPanel signals={detail.signals} />
        <UsagePanel usage={detail.usage} coverage={detail.coverage.usage} />
        <TimelinePanel activities={activities} />
      </div>

      <TranscriptPanel sessionKey={sessionKey} revision={transcriptRevision} />
    </section>
  );
}

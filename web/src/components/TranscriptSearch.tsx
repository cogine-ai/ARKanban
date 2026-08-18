import { useEffect, useState } from "react";
import type { MessageSearchResult } from "../../../src/contracts";
import { collectorApi } from "../api";
import { formatDateTime } from "../lib/format";
import { Link } from "../router";
import { TranscriptText } from "./TranscriptText";

/**
 * Cross-session search over the local transcript archive.
 *
 * Reads the archive only, never the Gateway, so it keeps working while the
 * connection is down — which is most of the point of keeping transcripts on
 * this machine at all.
 *
 * Answers a different question from the list it sits above ("which sessions
 * said this" rather than "which sessions are worth reviewing"), so it renders
 * as its own result set instead of pretending to filter the rows below.
 */

/** Enough of a hit to recognise it; the full message lives on the session page. */
const SNIPPET_RADIUS = 90;

function snippet(content: string, needle: string): { text: string; clipped: boolean } {
  const at = content.toLowerCase().indexOf(needle.toLowerCase());
  if (at === -1 || content.length <= SNIPPET_RADIUS * 2) return { text: content, clipped: false };
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + needle.length + SNIPPET_RADIUS);
  return { text: `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`, clipped: true };
}

export function TranscriptSearch({ query, agentId }: { query: string; agentId?: string }) {
  const [result, setResult] = useState<MessageSearchResult>();
  const [error, setError] = useState<string>();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (query.length === 0) {
      setResult(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setSearching(true);
    void (async () => {
      try {
        const found = await collectorApi.searchMessages({ q: query, ...(agentId ? { agentId } : {}) });
        if (!active) return;
        setResult(found);
        setError(undefined);
      } catch (cause) {
        if (!active) return;
        setResult(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setSearching(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [agentId, query]);

  if (query.length === 0) return null;

  return (
    <div className="transcript-hits">
      <div className="transcript-hits-head">
        <span className="eyebrow">TRANSCRIPT MATCHES</span>
        {searching ? <small className="muted">Searching…</small> : null}
        {result ? (
          <small className="muted">
            {result.hits.length} message{result.hits.length === 1 ? "" : "s"}
            {/* Both qualifiers are load-bearing. A truncated list is not "all
                there is", and a fallback scan only covered the narrowed set. */}
            {result.truncated ? " · more matches not shown" : ""}
            {result.mode === "fallback" ? " · scanned without the index (query under 3 characters)" : ""}
          </small>
        ) : null}
      </div>

      {error ? <div className="inline-error">{error}</div> : null}

      {result && result.hits.length === 0 && !searching ? (
        <p className="muted">
          No archived message matches. Only sessions with a synced transcript are searchable.
        </p>
      ) : null}

      <ol className="transcript-hit-list">
        {(result?.hits ?? []).map((hit) => {
          const body = snippet(hit.message.content, query);
          return (
            <li key={hit.message.id}>
              <Link className="transcript-hit" to={`/sessions/${encodeURIComponent(hit.message.sessionKey)}`}>
                <span className="transcript-hit-head">
                  <b>{hit.sessionLabel}</b>
                  <span className="muted">{hit.agentId}</span>
                  <span className="transcript-role">{hit.message.role}</span>
                  <span className="muted">{formatDateTime(hit.message.createdAt)}</span>
                </span>
                <span className="transcript-hit-body">
                  <TranscriptText text={body.text} highlight={query} />
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

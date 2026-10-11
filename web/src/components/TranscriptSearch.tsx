import { useEffect, useMemo, useState } from "react";
import type { MessageSearchResult } from "../../../src/contracts";
import { collectorApi, isAbortError, type TranscriptArchiveStatus } from "../api";
import { archiveSearchState, groupMessageHits, messageSearchIssue, messageSnippet } from "../lib/message-search-model";
import { Link } from "../router";
import { useCollector } from "../state/collector-context";
import { Timestamp } from "./Timestamp";
import { TranscriptText } from "./TranscriptText";
import "./transcript-search.css";

function SearchIcon() {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 5 5" strokeLinecap="round" /></svg>;
}

type Props = { query: string; agentId?: string; sessionKey?: string; from?: number; to?: number; onClear?: () => void };
type SearchResponse = { signature: string; result?: MessageSearchResult; error?: string };

export function TranscriptSearch({ query, agentId, sessionKey, from, to, onClear }: Props) {
  const { status, subscribeTopics } = useCollector();
  const text = query.trim();
  const filters = useMemo(() => ({ q: text, ...(agentId ? { agentId } : {}), ...(sessionKey ? { sessionKey } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }), [text, agentId, sessionKey, from, to]);
  const signature = JSON.stringify(filters);
  const issue = messageSearchIssue(filters);
  const hub = status?.host?.role === "hub";
  const [response, setResponse] = useState<SearchResponse>();
  const [retry, setRetry] = useState(0);
  const [archive, setArchive] = useState<TranscriptArchiveStatus>();
  const [archiveError, setArchiveError] = useState<string>();
  const [archiveRetry, setArchiveRetry] = useState(0);

  useEffect(() => {
    if (hub) return;
    let active = true;
    let generation = 0;
    const read = async () => {
      const requested = ++generation;
      try { const next = await collectorApi.transcriptStatus(); if (active && requested === generation) { setArchive(next); setArchiveError(undefined); } }
      catch (cause) { if (active && requested === generation) setArchiveError(cause instanceof Error ? cause.message : String(cause)); }
    };
    void read();
    const unsubscribe = subscribeTopics(["messages"], () => void read());
    // Capacity and failed sync rounds can change without inserting a message.
    const readWhenVisible = () => { if (document.visibilityState !== "hidden") void read(); };
    const timer = window.setInterval(readWhenVisible, 15_000);
    window.addEventListener("focus", readWhenVisible);
    document.addEventListener("visibilitychange", readWhenVisible);
    return () => { active = false; unsubscribe(); window.clearInterval(timer); window.removeEventListener("focus", readWhenVisible); document.removeEventListener("visibilitychange", readWhenVisible); };
  }, [hub, subscribeTopics, archiveRetry, status?.gateway.connected]);

  useEffect(() => {
    if (hub || issue) { setResponse(undefined); return; }
    const controller = new AbortController();
    setResponse(undefined);
    void collectorApi.searchMessages(filters, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setResponse({ signature, result });
    }).catch((cause: unknown) => {
      if (!isAbortError(cause) && !controller.signal.aborted) setResponse({ signature, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => controller.abort();
  }, [filters, signature, issue, hub, retry]);

  const current = response?.signature === signature ? response : undefined;
  const result = current?.result;
  const groups = useMemo(() => groupMessageHits(result?.hits ?? []), [result]);
  const archiveState = archive ? archiveSearchState(archive) : undefined;
  const noArchive = archive?.messageCount === 0;

  if (hub) return <div className="message-search-empty"><SearchIcon /><strong>Messages unavailable in aggregate mode</strong></div>;

  return <div className="message-search" aria-busy={!issue && !current}>
    <div className="message-archive-status" aria-label="Message archive">
      <span className="message-archive-symbol" aria-hidden="true">▤</span>
      <span className="message-archive-state" data-tone={archiveState?.tone ?? "neutral"}>{archiveError ? "Archive status unavailable" : archiveState?.label ?? "Loading archive…"}</span>
      {archive && archive.messageCount > 0 ? <span className="message-archive-count">{archive.messageCount.toLocaleString()} saved</span> : null}
      {status && !status.gateway.connected && archiveState?.label !== "Source offline" ? <span className="message-source-offline">Source offline</span> : null}
      {archiveError ? <button type="button" onClick={() => setArchiveRetry((value) => value + 1)}>Retry status</button> : null}
      <Link className="message-archive-settings" to="/settings?section=archive">Archive settings <span aria-hidden="true">↗</span></Link>
    </div>
    {issue ? <div className="message-search-empty"><SearchIcon /><strong>{issue === "scope" ? "Choose a search scope" : issue === "range" ? "Check the time range" : noArchive ? archiveState?.empty : "Search saved messages"}</strong>
      {noArchive && !archive?.enabled ? <Link className="message-empty-action" to="/settings?section=archive">Enable archive</Link> : null}
    </div> : current?.error ? <div className="message-search-empty message-search-error" role="alert"><span className="message-empty-symbol" aria-hidden="true">!</span><strong>Search failed</strong><button type="button" className="message-empty-action" onClick={() => setRetry((value) => value + 1)}>Retry search</button><details><summary>Error details</summary><code>{current.error}</code></details></div>
      : !result ? <div className="message-search-empty" role="status"><SearchIcon /><strong>Searching…</strong></div>
      : result.hits.length === 0 ? <div className="message-search-empty"><SearchIcon /><strong>{noArchive ? archiveState?.empty ?? "No saved messages" : "No matching messages"}</strong>
        {noArchive && !archive?.enabled ? <Link className="message-empty-action" to="/settings?section=archive">Enable archive</Link> : onClear ? <button type="button" className="message-empty-action" onClick={onClear}>Clear search</button> : null}
      </div> : <>
        <div className="message-results-heading" role="status"><b>{result.truncated ? `${result.hits.length} shown` : `${result.hits.length} ${result.hits.length === 1 ? "message" : "messages"}`}</b>{result.truncated ? <span className="message-results-limit">Results limited</span> : null}{result.mode === "fallback" ? <span>Scoped search</span> : null}</div>
        <div className="message-result-groups">{groups.map((group) => <section key={group.key} className="message-result-group" data-session-key={group.key}>
          <header className="message-group-heading"><span className="message-session-icon" aria-hidden="true">▤</span><div><Link to={`/sessions/${encodeURIComponent(group.key)}`} className="message-session-name">{group.label}</Link><span className="message-session-agent">{group.agentId}</span></div><Link className="message-view-session" to={`/sessions/${encodeURIComponent(group.key)}`}>View session <span aria-hidden="true">↗</span></Link></header>
          <ol className="message-hit-list">{group.hits.map((hit) => <li key={hit.message.id} className="message-hit" data-message-id={hit.message.id} data-history={Boolean(hit.message.supersededBySessionId)}>
            <div className="message-hit-meta"><span className="message-hit-role">{hit.message.role}</span>{hit.message.toolName ? <span className="message-hit-tool">{hit.message.toolName}</span> : null}<Timestamp value={hit.message.createdAt} />{hit.message.isError ? <span className="message-hit-warning">Failed</span> : null}{hit.message.supersededBySessionId ? <span className="message-hit-version">Previous version</span> : null}{hit.message.divergent ? <span className="message-hit-warning">Content differs</span> : null}</div>
            <Link className="message-hit-body" to={`/sessions/${encodeURIComponent(group.key)}`} aria-label={`View session ${group.label}`}><TranscriptText text={messageSnippet(hit.message.content, text)} highlight={text} /></Link>
            <details className="message-hit-fields"><summary>Message fields</summary><dl><div><dt>Session key</dt><dd>{hit.message.sessionKey}</dd></div><div><dt>Version reference</dt><dd>{hit.message.sessionId ?? "Not reported"}</dd></div>{hit.message.messageId ? <div><dt>Message ID</dt><dd>{hit.message.messageId}</dd></div> : null}{hit.message.supersededBySessionId ? <div><dt>Replaced by</dt><dd>{hit.message.supersededBySessionId}</dd></div> : null}</dl></details>
          </li>)}</ol>
        </section>)}</div>
      </>}
  </div>;
}

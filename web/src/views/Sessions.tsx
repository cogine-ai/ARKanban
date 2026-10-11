import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type UIEvent } from "react";
import type { AgentOverview, ChangeTopic, SessionSummary } from "../../../src/contracts";
import { collectorApi, type MessageSearchFilters, type SessionListFilters } from "../api";
import { GradeChip } from "../components/GradeChip";
import { TranscriptSearch } from "../components/TranscriptSearch";
import { AGENT_COLORS } from "../lib/board";
import { formatExact, formatRelative, hash, shortAgent } from "../lib/format";
import {
  localDateInput, MESSAGE_FILTER_KEYS, readMessageFilters, readSessionFilters, readSessionsMode,
  SESSION_FILTER_KEYS, SESSION_GRADES, SESSION_ROW_HEIGHT, SESSION_SORTS, SESSION_STATES,
  SESSION_VIRTUALIZE_ABOVE, sessionFilterSignature, sessionWindow, setSessionsMode, validateMessageFilters,
  type MessageValidation, type SessionsMode,
} from "../lib/session-filters";
import { Link, useLocation, useNavigate } from "../router";
import { useAgents } from "../state/use-agents";
import { useCollector } from "../state/collector-context";
import { useMeasuredHeight } from "../state/use-measured-height";
import { usePagedQuery } from "../state/use-paged-query";
import "./sessions.css";

const SESSION_TOPICS: readonly ChangeTopic[] = ["sessions"];

function SessionSymbol({ type = "sessions" }: { type?: SessionsMode }) {
  return type === "messages" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 9h8M8 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><rect x="4" y="14" width="16" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" /></svg>
  );
}

function AgentSelect({ agents, value, onChange, id, highlighted = false }: { agents?: AgentOverview[]; value: string; onChange: (value: string) => void; id: string; highlighted?: boolean }) {
  const known = agents?.some((agent) => agent.id === value);
  return (
    <label className={`sessions-control${highlighted ? " sessions-control-needed" : ""}`} htmlFor={id}>
      <span>Agent</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} data-filtered={value ? "true" : "false"}>
        <option value="">All agents</option>
        {value && !known ? <option value={value}>{value}</option> : null}
        {(agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName || agent.id}</option>)}
      </select>
    </label>
  );
}

type SessionChoice = Pick<SessionSummary, "sessionKey" | "label" | "agentId">;

function SessionChoices({ agentId, agents, value, onChoose }: { agentId: string; agents?: AgentOverview[]; value: string; onChoose: (choice?: SessionChoice) => void }) {
  const fetchPage = useCallback((cursor?: string) => collectorApi.sessions(agentId ? { agentId } : {}, cursor), [agentId]);
  const { items, error, loading, loadingMore, hasMore, loadMore, reload } = usePagedQuery(fetchPage, SESSION_TOPICS);
  const [name, setName] = useState("");
  const [reference, setReference] = useState(value);
  const searchInput = useRef<HTMLInputElement>(null);
  const names = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.displayName])), [agents]);
  const matches = useMemo(() => {
    const needle = name.trim().toLocaleLowerCase();
    return items.filter((session) => !needle || session.label.toLocaleLowerCase().includes(needle));
  }, [items, name]);

  useEffect(() => { searchInput.current?.focus(); }, []);

  return (
    <>
      <div className="session-picker-search"><span aria-hidden="true">⌕</span><input ref={searchInput} type="search" aria-label="Find loaded sessions" placeholder={loading ? "Find a session" : `Find in ${items.length} loaded`} value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest(".session-scope-picker")?.querySelector<HTMLButtonElement>(".session-picker-option")?.focus(); } }} /></div>
      <div className="session-picker-options">
        <button type="button" className="session-picker-option" data-selected={!value ? "true" : "false"} onClick={() => onChoose()}><span><b>Any session</b></span><span aria-hidden="true">{!value ? "✓" : ""}</span></button>
        {matches.map((session) => <button key={session.sessionKey} type="button" className="session-picker-option" data-selected={value === session.sessionKey ? "true" : "false"} onClick={() => onChoose(session)}><span><b>{session.label}</b><small>{names.get(session.agentId) || session.agentId} · {formatRelative(session.lastActivityAt)}</small></span><span aria-hidden="true">{value === session.sessionKey ? "✓" : ""}</span></button>)}
        {loading ? <div className="session-picker-state" role="status">Loading sessions…</div> : null}
        {!loading && !error && matches.length === 0 ? <div className="session-picker-state" role="status">{name ? "No match in loaded sessions" : "No sessions yet"}</div> : null}
        {error ? <div className="session-picker-state" role="alert">Sessions unavailable <button type="button" onClick={reload}>Retry</button></div> : null}
      </div>
      <div className="session-picker-paging"><span>{items.length} loaded{hasMore ? "+" : ""}</span>{hasMore ? <button type="button" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}</button> : null}</div>
      <details className="session-picker-reference"><summary>Session key <span aria-hidden="true">⌄</span></summary><div><input type="text" aria-label="Session key" placeholder="Paste session key" value={reference} onChange={(event) => setReference(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (reference.trim()) onChoose({ sessionKey: reference.trim(), label: "Selected session", agentId }); } }} /><button type="button" disabled={!reference.trim()} onClick={() => onChoose({ sessionKey: reference.trim(), label: "Selected session", agentId })}>Use key</button></div></details>
    </>
  );
}

// A named chooser stays separate from the message search: it only reads a
// paged session index after opening, and never submits an archive query itself.
function SessionScope({ value, agentId, agents, highlighted, onChange }: { value: string; agentId: string; agents?: AgentOverview[]; highlighted: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<SessionChoice>();
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!value) { setResolved(undefined); return; }
    if (resolved?.sessionKey === value && resolved.label !== "Selected session") return;
    const controller = new AbortController();
    void collectorApi.session(value, controller.signal).then((session) => {
      if (!controller.signal.aborted) setResolved(session);
    }).catch(() => { /* The reported reference remains selectable when unresolved. */ });
    return () => controller.abort();
  }, [value, resolved?.sessionKey, resolved?.label]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !control.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const choose = (choice?: SessionChoice) => { setResolved(choice); onChange(choice?.sessionKey ?? ""); setOpen(false); trigger.current?.focus(); };
  const label = !value ? "Any session" : resolved?.sessionKey === value ? resolved.label : "Selected session";
  return (
    <div ref={control} className={`sessions-control session-scope-control${highlighted ? " sessions-control-needed" : ""}`} onBlur={(event) => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
      <span id="message-session-label">Session</span>
      <button ref={trigger} id="message-session" className="session-scope-trigger" type="button" aria-labelledby="message-session-label message-session-value" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "session-scope-picker" : undefined} data-filtered={value ? "true" : "false"} onClick={() => setOpen((current) => !current)}><span id="message-session-value">{label}</span><span aria-hidden="true">⌄</span></button>
      {open ? <div id="session-scope-picker" className="session-scope-picker" role="dialog" aria-label="Choose a session"><SessionChoices agentId={agentId} agents={agents} value={value} onChoose={choose} /></div> : null}
    </div>
  );
}

function SessionRow({ session, agentName }: { session: SessionSummary; agentName?: string }) {
  const tone = AGENT_COLORS[hash(session.agentId) % AGENT_COLORS.length];
  const state = session.archived ? "archived" : session.hasActiveRun ? "running" : "idle";
  return (
    <Link className="session-row" to={`/sessions/${encodeURIComponent(session.sessionKey)}`}>
      <span className="session-agent" style={{ background: tone }} aria-hidden="true">{shortAgent(session.agentId)}</span>
      <span className="session-label"><b>{session.label}</b><small>{agentName || session.agentId}</small></span>
      <span className="session-row-grade"><GradeChip signals={session.signals} /></span>
      <span className="session-row-meta">
        <span className="session-state" data-active={state === "running" ? "true" : "false"}>
          <span className={`session-state-symbol session-state-${state}`} aria-hidden="true">{state === "archived" ? "▣" : state === "idle" ? "Ⅱ" : ""}</span>{state === "running" ? "Running" : state === "idle" ? "Idle" : "Archived"}
        </span>
        <span className="session-count">{session.activityCount}<span> activities</span></span>
        <time className="session-seen" dateTime={new Date(session.lastActivityAt).toISOString()} title={formatExact(session.lastActivityAt)}>{formatRelative(session.lastActivityAt)}</time>
      </span>
      <span className="session-row-chevron" aria-hidden="true">›</span>
    </Link>
  );
}

// This component only mounts in Sessions mode. Search and Hub views therefore
// cannot fetch an unrelated session list or render its empty response as truth.
function SessionResults({ filters, agents, onClear }: { filters: SessionListFilters; agents?: AgentOverview[]; onClear: () => void }) {
  const fetchPage = useCallback((cursor?: string) => collectorApi.sessions(filters, cursor), [filters]);
  const { items, error, loading, loadingMore, hasMore, hasNewData, loadMore, reload } = usePagedQuery(fetchPage, SESSION_TOPICS);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const virtualized = items.length > SESSION_VIRTUALIZE_ABOVE;
  const viewportHeight = useMeasuredHeight(viewport, 560, virtualized);
  const window = sessionWindow(items.length, scrollTop, viewportHeight);
  const visible = items.slice(window.first, window.first + window.count);
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.displayName])), [agents]);
  const filtered = Boolean(filters.agentId || filters.state || filters.grade || (filters.sort && filters.sort !== "lastActivity"));

  useEffect(() => {
    setScrollTop(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [filters]);

  return (
    <div className="sessions-results" role="tabpanel" id="sessions-panel" aria-labelledby="sessions-mode-sessions">
      <div className="sessions-result-toolbar">
        <span aria-live="polite">{loading ? "Loading…" : error && !items.length ? "Sessions unavailable" : `${items.length} loaded${hasMore ? "+" : ""}`}</span>
        {filtered ? <button type="button" className="sessions-clear" onClick={onClear}>Clear filters <span aria-hidden="true">×</span></button> : null}
        {hasNewData ? <button type="button" className="session-refresh-hint" onClick={reload}><span aria-hidden="true">↻</span> Refresh</button> : null}
      </div>
      {error ? <div className="sessions-error" role="alert"><strong>Could not load sessions</strong><span>{error}</span><button type="button" onClick={reload}>Retry</button></div> : null}
      {loading ? <div className="sessions-empty" aria-live="polite"><SessionSymbol /><strong>Loading sessions…</strong></div> : null}
      {!loading && !error && items.length === 0 ? (
        <div className="sessions-empty"><SessionSymbol /><strong>{filtered ? "No matching sessions" : "No sessions yet"}</strong>{filtered ? <button type="button" onClick={onClear}>Clear filters</button> : null}</div>
      ) : null}
      {items.length > 0 ? (
        <div className="session-list" ref={viewport} data-virtualized={virtualized ? "true" : "false"} style={{ "--session-row-height": `${SESSION_ROW_HEIGHT}px` } as CSSProperties}
          {...(virtualized ? { onScroll: (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop) } : {})}>
          {virtualized ? <div style={{ height: window.first * SESSION_ROW_HEIGHT }} aria-hidden="true" /> : null}
          {visible.map((session) => <SessionRow key={session.sessionKey} session={session} {...(agentNames.get(session.agentId) ? { agentName: agentNames.get(session.agentId)! } : {})} />)}
          {virtualized ? <div style={{ height: Math.max(0, (items.length - window.first - visible.length) * SESSION_ROW_HEIGHT) }} aria-hidden="true" /> : null}
        </div>
      ) : null}
      {hasMore ? <button type="button" className="session-load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "Loading…" : "Load more"}<span aria-hidden="true"> ↓</span></button> : null}
    </div>
  );
}

function HubSessions({ mode }: { mode: SessionsMode }) {
  return <div className="sessions-empty sessions-hub" role="tabpanel" id={`${mode}-panel`} aria-labelledby={`sessions-mode-${mode}`}><SessionSymbol type={mode} /><strong>{mode === "messages" ? "Messages stay on each collector" : "Sessions stay on each collector"}</strong><span>Hub view</span><Link to="/settings">View collectors <span aria-hidden="true">↗</span></Link></div>;
}

type MessageDraft = { query: string; agentId: string; sessionKey: string; from: string; to: string };
function toDraft(filters: MessageSearchFilters): MessageDraft { return { query: filters.q, agentId: filters.agentId ?? "", sessionKey: filters.sessionKey ?? "", from: localDateInput(filters.from), to: localDateInput(filters.to) }; }
function draftFilters(draft: MessageDraft): MessageSearchFilters {
  return { q: draft.query.trim(), ...(draft.agentId ? { agentId: draft.agentId } : {}), ...(draft.sessionKey.trim() ? { sessionKey: draft.sessionKey.trim() } : {}), ...(draft.from ? { from: new Date(draft.from).getTime() } : {}), ...(draft.to ? { to: new Date(draft.to).getTime() } : {}) };
}

export function SessionsView() {
  const { searchParams } = useLocation();
  const navigateTo = useNavigate();
  const { status } = useCollector();
  const { agents, error: agentError, reload: reloadAgents } = useAgents();
  const search = searchParams.toString();
  const mode = readSessionsMode(searchParams);
  const filterKey = sessionFilterSignature(searchParams);
  const filters = useMemo(() => readSessionFilters(new URLSearchParams(filterKey)), [filterKey]);
  const messageKey = JSON.stringify(readMessageFilters(searchParams));
  const messageFilters = useMemo(() => readMessageFilters(new URLSearchParams(search)), [messageKey]);
  const [draft, setDraft] = useState<MessageDraft>(() => toDraft(messageFilters));
  const [validation, setValidation] = useState<MessageValidation>();
  const [searchBlocked, setSearchBlocked] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const submittedDraft = toDraft(messageFilters);
  const draftDirty = (Object.keys(draft) as Array<keyof MessageDraft>).some((key) => draft[key] !== submittedDraft[key]);
  const form = useRef<HTMLFormElement>(null);
  const isHub = status?.host.role === "hub";

  useEffect(() => { setDraft(toDraft(messageFilters)); setValidation(undefined); setSearchBlocked(false); }, [messageFilters]);

  const go = useCallback((params: URLSearchParams) => { const query = params.toString(); navigateTo(`/sessions${query ? `?${query}` : ""}`); }, [navigateTo]);
  const setParam = (key: string, value: string) => { const next = new URLSearchParams(search); if (value) next.set(key, value); else next.delete(key); go(next); };
  const clearSessions = () => { const next = new URLSearchParams(search); for (const key of SESSION_FILTER_KEYS) next.delete(key); go(next); };
  const clearMessages = () => {
    setDraft({ query: "", agentId: "", sessionKey: "", from: "", to: "" }); setValidation(undefined); setSearchBlocked(false);
    const next = setSessionsMode(new URLSearchParams(search), "messages"); for (const key of MESSAGE_FILTER_KEYS) next.delete(key); go(next);
  };
  const changeDraft = (key: keyof MessageDraft, value: string) => { setDraft({ ...draft, [key]: value }); setSearchBlocked(true); setValidation(undefined); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const submitted = draftFilters(draft);
    const nextValidation = validateMessageFilters(submitted);
    if (nextValidation) {
      setValidation(nextValidation);
      setSearchBlocked(true);
      form.current?.querySelector<HTMLElement>(nextValidation === "range-required" ? "#message-agent" : nextValidation === "invalid-range" ? "#message-from" : "#message-query")?.focus();
      return;
    }
    setValidation(undefined);
    setSearchBlocked(false);
    setDraft(toDraft(submitted));
    setSearchRevision((revision) => revision + 1);
    const next = setSessionsMode(new URLSearchParams(search), "messages");
    for (const key of MESSAGE_FILTER_KEYS) next.delete(key);
    next.set("q", submitted.q);
    if (submitted.agentId) next.set("messageAgentId", submitted.agentId);
    if (submitted.sessionKey) next.set("sessionKey", submitted.sessionKey);
    if (submitted.from !== undefined) next.set("from", String(submitted.from));
    if (submitted.to !== undefined) next.set("to", String(submitted.to));
    go(next);
  };

  return (
    <section className="surface view-surface sessions-view" data-mode={mode}>
      <div className="sessions-heading"><h1>Sessions</h1></div>
      <div className="sessions-mode" role="tablist" aria-label="Search mode">
        {(["sessions", "messages"] as const).map((value) => <button type="button" role="tab" key={value} id={`sessions-mode-${value}`} aria-selected={mode === value} aria-controls={`${value}-panel`} tabIndex={mode === value ? 0 : -1}
          onClick={() => go(setSessionsMode(new URLSearchParams(search), value))}
          onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "sessions" : event.key === "End" ? "messages" : mode === "sessions" ? "messages" : "sessions"; go(setSessionsMode(new URLSearchParams(search), next)); document.getElementById(`sessions-mode-${next}`)?.focus(); } }}>
          <SessionSymbol type={value} />{value === "sessions" ? "Sessions" : "Messages"}</button>)}
      </div>

      {!status ? <div className="sessions-empty"><SessionSymbol type={mode} /><strong>Loading collector…</strong></div> : isHub ? <HubSessions mode={mode} /> : mode === "sessions" ? (
        <>
          <div className="sessions-filters" aria-label="Session filters">
            <AgentSelect agents={agents} value={filters.agentId ?? ""} id="session-agent" onChange={(value) => setParam("agentId", value)} />
            <label className="sessions-control"><span>State</span><select aria-label="State" value={filters.state ?? ""} onChange={(event) => setParam("state", event.target.value)} data-filtered={filters.state ? "true" : "false"}><option value="">Any state</option>{SESSION_STATES.map((state) => <option key={state} value={state}>{state === "active" ? "Running" : state === "terminal" ? "Idle" : "Archived"}</option>)}</select></label>
            <label className="sessions-control"><span>Grade</span><select aria-label="Grade" value={filters.grade ?? ""} onChange={(event) => setParam("grade", event.target.value)} data-filtered={filters.grade ? "true" : "false"}><option value="">Any grade</option>{SESSION_GRADES.map((grade) => <option key={grade} value={grade}>{grade === "unscored" ? "Unscored" : grade}</option>)}</select></label>
            <label className="sessions-control"><span>Sort</span><select aria-label="Sort" value={filters.sort ?? "lastActivity"} onChange={(event) => setParam("sort", event.target.value)} data-filtered={filters.sort && filters.sort !== "lastActivity" ? "true" : "false"}>{SESSION_SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}</select></label>
          </div>
          {agentError ? <div className="sessions-roster-error"><span>Agent list unavailable</span><button type="button" onClick={() => void reloadAgents()}>Retry</button></div> : null}
          <SessionResults filters={filters} agents={agents} onClear={clearSessions} />
        </>
      ) : (
        <>
          <form ref={form} className="messages-search-form" onSubmit={submit} aria-label="Message search">
            <div className="messages-query-row"><label className="messages-query"><span aria-hidden="true">⌕</span><input id="message-query" type="search" aria-label="Search messages" placeholder="Search messages" value={draft.query} onChange={(event) => changeDraft("query", event.target.value)} /></label><button className="messages-search-submit" type="submit">Search <span aria-hidden="true">→</span></button></div>
            <div className="messages-scope" data-range-needed={validation === "range-required" ? "true" : "false"}>
              <AgentSelect agents={agents} value={draft.agentId} id="message-agent" highlighted={validation === "range-required"} onChange={(value) => changeDraft("agentId", value)} />
              <SessionScope value={draft.sessionKey} agentId={draft.agentId} agents={agents} highlighted={validation === "range-required"} onChange={(value) => changeDraft("sessionKey", value)} />
              <label className={`sessions-control${validation === "range-required" ? " sessions-control-needed" : ""}`} htmlFor="message-from"><span>From</span><input id="message-from" type="datetime-local" value={draft.from} aria-invalid={validation === "invalid-range" ? true : undefined} onChange={(event) => changeDraft("from", event.target.value)} /></label>
              <label className="sessions-control" htmlFor="message-to"><span>To</span><input id="message-to" type="datetime-local" value={draft.to} aria-invalid={validation === "invalid-range" ? true : undefined} onChange={(event) => changeDraft("to", event.target.value)} /></label>
            </div>
          </form>
          {agentError ? <div className="sessions-roster-error"><span>Agent list unavailable</span><button type="button" onClick={() => void reloadAgents()}>Retry</button></div> : null}
          <div role="tabpanel" id="messages-panel" aria-labelledby="sessions-mode-messages">
            {searchBlocked || draftDirty ? <div className="sessions-empty messages-search-blocked"><SessionSymbol type="messages" /><strong className="messages-validation" role="status">{validation === "range-required" ? "Choose a scope" : validation === "invalid-range" ? "Check the date range" : validation === "empty" ? "Enter a search" : "Ready to search"}</strong><button type="button" onClick={clearMessages}>Clear filters</button></div> : <TranscriptSearch key={searchRevision} query={messageFilters.q} {...(messageFilters.agentId ? { agentId: messageFilters.agentId } : {})} {...(messageFilters.sessionKey ? { sessionKey: messageFilters.sessionKey } : {})} {...(messageFilters.from !== undefined ? { from: messageFilters.from } : {})} {...(messageFilters.to !== undefined ? { to: messageFilters.to } : {})} onClear={clearMessages} />}
          </div>
        </>
      )}
    </section>
  );
}

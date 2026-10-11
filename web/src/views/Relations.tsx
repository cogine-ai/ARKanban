import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";
import type { ActivitySnapshot, CollectorStatus } from "../../../src/contracts";
import { collectorApi, isAbortError } from "../api";
import { displayedAgent, pageOf } from "../lib/flow-board-model";
import { buildRelationsModel, type RelationGroup, type RelationMode, type RelationNode, type UnresolvedRelation } from "../lib/relations-model";
import "./relations.css";

function countLabel(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? "" : "s"}`; }

function LinkIcon({ tree = false }: { tree?: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{tree ? <><path d="M5 4v15m0-10h13M5 19h13" /><rect x="15" y="6" width="6" height="6" rx="1.5" fill="white" /><rect x="15" y="16" width="6" height="6" rx="1.5" fill="white" /></> : <><path d="m10 14 4-4M8 16l-1.2 1.2a4.2 4.2 0 0 1-6-6L5 7a4.2 4.2 0 0 1 6 0m2 10a4.2 4.2 0 0 0 6 0l4.2-4.2a4.2 4.2 0 0 0-6-6L16 8" transform="translate(0 -1) scale(.9)" /></>}</svg>;
}

function nodeState(node: RelationNode, observed: boolean): { label: string; glyph: string; tone: string } {
  const item = node.item;
  if (!item) return { label: node.ambiguous ? "Ambiguous identity" : "Record outside view", glyph: "?", tone: "unknown" };
  if (item.freshness !== "live" || item.state === "unknown" || !observed) return { label: "Last observed", glyph: "?", tone: "unknown" };
  if (item.state === "terminal") {
    if (item.outcome === "succeeded") return { label: "Succeeded", glyph: "✓", tone: "success" };
    if (["failed", "timed_out"].includes(item.outcome)) return { label: item.outcome === "failed" ? "Failed" : "Timed out", glyph: "×", tone: "error" };
    if (item.outcome === "blocked") return { label: "Blocked", glyph: "Ⅱ", tone: "waiting" };
    return { label: item.outcome === "cancelled" ? "Cancelled" : "Unknown outcome", glyph: item.outcome === "cancelled" ? "−" : "?", tone: "unknown" };
  }
  if (item.phase === "waiting_approval") return { label: "Waiting approval", glyph: "Ⅱ", tone: "waiting" };
  if (item.state === "queued") return { label: "Queued", glyph: "◷", tone: "queued" };
  return { label: "In progress", glyph: "", tone: "running" };
}

function RelationObject({ node, selectedId, observed, onSelect, hostLabel }: { node: RelationNode; selectedId?: string; observed: boolean; onSelect: (id: string) => void; hostLabel?: string }) {
  const state = nodeState(node, observed);
  const item = node.item;
  return <button className={`relations-node relations-node-${state.tone}`} data-activity-id={node.id} data-host-id={node.hostId} disabled={!item} aria-pressed={item ? selectedId === item.id : undefined} onClick={() => item && onSelect(item.id)} title={item ? `${item.title} · ${item.hostId} · ${state.label}` : node.id}>
    <span className={`relations-node-state relations-state-${state.tone}`} aria-label={state.label}>{state.glyph}</span>
    <span className="relations-node-copy"><strong>{item?.title ?? (node.ambiguous ? "Ambiguous record" : "Record outside view")}</strong><span>{item ? displayedAgent(item.hostId, item.agentId) : node.id}<span className="relations-node-host">{hostLabel ?? node.hostId ?? "Unknown host"}</span></span></span>
    <span className="relations-node-kind">{item ? item.kind === "task" ? "Task" : "Attempt" : "?"}</span>
  </button>;
}

function CopyIdentity({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState("copied"); }
    catch { setState("failed"); }
  };
  return <div className="relations-identity-row"><span>{label}</span><code>{value}</code><button onClick={() => { void copy(); }} aria-label={`Copy ${label}`} title={`Copy ${label}`}>{state === "copied" ? "✓" : state === "failed" ? "!" : "⧉"}</button><span className="sr-only" role="status">{state === "copied" ? `${label} copied` : state === "failed" ? "Copy unavailable" : ""}</span></div>;
}

function RunReference({ id }: { id: string }) {
  const [reference, setReference] = useState<string>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setReference(undefined);
    void collectorApi.detail(id, controller.signal).then((detail) => {
      if (!controller.signal.aborted) setReference(detail.identity.runRef);
    }).catch((cause: unknown) => {
      if (!isAbortError(cause) && !controller.signal.aborted) setReference(undefined);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id]);
  return reference ? <CopyIdentity label="Run reference" value={reference} /> : <div className="relations-identity-row"><span>Run reference</span><span>{loading ? "Loading…" : "Unavailable"}</span></div>;
}

function GroupIdentity({ group, shared }: { group: RelationGroup; shared: boolean }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(8);
  return <details className="relations-identities" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Identity <span aria-hidden="true">⌄</span></summary>{open ? <div className="relations-identity-list">{shared && group.nodes[0]?.item ? <RunReference id={group.nodes[0].id} /> : null}{group.nodes.slice(0, limit).map((node) => <CopyIdentity key={node.key} label={`${node.item?.kind === "attempt" ? "Attempt" : "Task"} ID`} value={node.id} />)}{limit < group.nodes.length ? <button className="relations-expand" onClick={() => setLimit((value) => value + 16)}>+{group.nodes.length - limit} IDs</button> : null}</div> : null}</details>;
}

type GroupProps = { group: RelationGroup; selectedId?: string; onSelect: (id: string) => void; hostLabels: Map<string, string>; isObserved: (node: RelationNode) => boolean };

function SharedRunGroup({ group, selectedId, onSelect, hostLabels, isObserved }: GroupProps) {
  const [limit, setLimit] = useState(3);
  const tasks = group.nodes.filter((node) => node.item?.kind === "task");
  const attempts = group.nodes.filter((node) => node.item?.kind === "attempt");
  const preview = (nodes: RelationNode[]) => {
    const entries = nodes.slice(0, limit);
    const selected = nodes.find((node) => node.id === selectedId);
    if (selected && !entries.includes(selected)) entries[entries.length - 1] = selected;
    return entries;
  };
  const hidden = Math.max(0, tasks.length - limit) + Math.max(0, attempts.length - limit);
  return <article className="relations-group relations-shared-group" data-relation-group="run_correlation">
    <header className="relations-group-heading"><span className="relations-group-icon"><LinkIcon /></span><div><h2>Shared run</h2><span>{hostLabels.get(group.hostId) ?? group.hostId}</span></div><span className="relations-group-count">{countLabel(group.nodes.length, "object")} <span>· {countLabel(group.links.length, "link")}</span></span></header>
    <div className="relations-shared-columns">{[{ label: "Tasks", nodes: tasks }, { label: "Attempts", nodes: attempts }].map(({ label, nodes }) => <section className="relations-shared-column" key={label} aria-label={label}><h3>{label}<span>{nodes.length}</span></h3>{preview(nodes).map((node) => <RelationObject key={node.key} node={node} selectedId={selectedId} observed={isObserved(node)} onSelect={onSelect} hostLabel={hostLabels.get(node.hostId ?? "")} />)}</section>)}</div>
    {hidden > 0 ? <button className="relations-expand" onClick={() => setLimit((value) => value + 8)}>+{hidden} objects</button> : limit > 3 ? <button className="relations-expand" onClick={() => setLimit(3)}>Show fewer</button> : null}
    <GroupIdentity group={group} shared />
  </article>;
}

function ParentGroup({ group, selectedId, onSelect, hostLabels, isObserved }: GroupProps) {
  const [limit, setLimit] = useState(8);
  const visible = group.rows.slice(0, limit);
  return <article className="relations-group relations-parent-group" data-relation-group="parent_task">
    <header className="relations-group-heading"><span className="relations-group-icon"><LinkIcon tree /></span><div><h2>Parent tasks</h2><span>{hostLabels.get(group.hostId) ?? group.hostId}</span></div><span className="relations-group-count">{countLabel(group.nodes.length, "object")} <span>· {countLabel(group.links.length, "link")}</span></span></header>
    <div className="relations-tree" role="list">{visible.map(({ node, depth, continues, ancestorBranches }) => <div className="relations-tree-row" key={node.key} role="listitem" style={{ "--relation-depth": Math.min(depth, 4) } as CSSProperties} data-depth={depth}>{depth > 0 ? <span className={`relations-tree-branch${continues ? " continues" : ""}`} aria-hidden="true" /> : null}{ancestorBranches?.filter((level) => level < 4).map((level) => <span className="relations-tree-continuation" key={level} data-ancestor-depth={level} style={{ "--ancestor-distance": Math.min(depth, 4) - level } as CSSProperties} aria-hidden="true" />)}<span className="sr-only">{depth === 0 ? "Parent task" : `Child at level ${depth}`}</span><RelationObject node={node} selectedId={selectedId} observed={isObserved(node)} onSelect={onSelect} hostLabel={hostLabels.get(node.hostId ?? "")} />{depth > 4 ? <span className="relations-tree-level">Level {depth}</span> : null}</div>)}</div>
    {visible.length < group.rows.length ? <button className="relations-expand" onClick={() => setLimit(visible.length + 16)}>+{group.rows.length - visible.length} objects</button> : limit > 8 ? <button className="relations-expand" onClick={() => setLimit(8)}>Show fewer</button> : null}
    <GroupIdentity group={group} shared={false} />
  </article>;
}

function UnresolvedLinks({ entries, selectedId, onSelect, hostLabels, isObserved }: Omit<GroupProps, "group"> & { entries: UnresolvedRelation[] }) {
  const [limit, setLimit] = useState(8);
  return entries.length > 0 ? <details className="relations-unresolved"><summary><span aria-hidden="true">?</span> Unresolved links <b>{entries.length}</b><span className="relations-summary-chevron" aria-hidden="true">⌄</span></summary><div className="relations-unresolved-list">{entries.slice(0, limit).map((entry) => <article key={entry.key} className="relations-unresolved-pair"><div className="relations-unresolved-label">{entry.relation.type.replaceAll("_", " ")}<span>{entry.reason === "Other relation" ? entry.relation.certainty.replaceAll("_", " ") : entry.reason}</span></div><div><RelationObject node={entry.from} selectedId={selectedId} onSelect={onSelect} observed={isObserved(entry.from)} hostLabel={hostLabels.get(entry.from.hostId ?? "")} /><RelationObject node={entry.to} selectedId={selectedId} onSelect={onSelect} observed={isObserved(entry.to)} hostLabel={hostLabels.get(entry.to.hostId ?? "")} /></div></article>)}{limit < entries.length ? <button className="relations-expand" onClick={() => setLimit((value) => value + 16)}>+{entries.length - limit} links</button> : null}</div></details> : null;
}

export function RelationsView({ snapshot, status, selectedId, paused = false, onSelect }: { snapshot?: ActivitySnapshot; status?: CollectorStatus; selectedId?: string; paused?: boolean; onSelect: (id: string) => void }) {
  const model = useMemo(() => buildRelationsModel(snapshot?.items, snapshot?.relations), [snapshot?.items, snapshot?.relations]);
  const [mode, setMode] = useState<RelationMode>("run_correlation");
  const [page, setPage] = useState(0);
  const id = useId();
  const current = mode === "parent_task" ? model.parent : model.shared;
  const pagination = pageOf(current.groups, page, 8);
  const hostLabels = useMemo(() => new Map([...(status?.hosts?.map((host) => [host.id, host.label] as const) ?? []), ...(status?.host ? [[status.host.id, status.host.label] as const] : [])]), [status]);
  const isObserved = (node: RelationNode) => {
    if (paused || !snapshot) return false;
    const coverage = status?.hosts?.find((host) => host.id === node.hostId);
    return coverage ? coverage.reachable && coverage.syncState === "live" : snapshot.sync.state === "live" && (!status || status.syncState === "live");
  };
  const changeMode = (next: RelationMode) => { setMode(next); setPage(0); };
  return <section className="surface view-surface relations-view">
    <header className="relations-heading"><h1>Relations</h1><span className="relations-observed-count"><b>{current.groups.length}</b> {current.groups.length === 1 ? "group" : "groups"} <span>·</span><b>{current.linkCount}</b> {current.linkCount === 1 ? "link" : "links"}</span></header>
    <div className="relations-mode" role="tablist" aria-label="Relation type">{[{ type: "parent_task", title: "Parent tasks", count: model.parent.linkCount, tree: true }, { type: "run_correlation", title: "Shared run", count: model.shared.linkCount, tree: false }].map(({ type, title, count, tree }) => <button key={type} id={`${id}-${type}`} role="tab" aria-selected={mode === type} aria-controls={`${id}-panel`} tabIndex={mode === type ? 0 : -1} onClick={() => changeMode(type as RelationMode)} onKeyDown={(event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next: RelationMode = event.key === "Home" ? "parent_task" : event.key === "End" ? "run_correlation" : mode === "parent_task" ? "run_correlation" : "parent_task";
        changeMode(next);
        document.getElementById(`${id}-${next}`)?.focus();
      }
    }}><LinkIcon tree={tree} />{title}<span>{count}</span></button>)}</div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`} className="relations-panel">
      {pagination.entries.length > 0 ? <div className={`relations-groups${mode === "parent_task" && current.groups.length === 1 ? " relations-single-tree" : ""}`}>{pagination.entries.map((group) => mode === "parent_task" ? <ParentGroup key={group.key} group={group} selectedId={selectedId} onSelect={onSelect} hostLabels={hostLabels} isObserved={isObserved} /> : <SharedRunGroup key={group.key} group={group} selectedId={selectedId} onSelect={onSelect} hostLabels={hostLabels} isObserved={isObserved} />)}</div> : <div className="relations-empty"><span className="relations-empty-icon"><LinkIcon tree={mode === "parent_task"} /></span><strong>{!snapshot ? "Loading relations…" : current.unresolved.length > 0 ? "No resolved groups" : mode === "parent_task" ? "No observed parent links" : "No observed shared runs"}</strong></div>}
      {pagination.pageCount > 1 ? <nav className="relations-pagination" aria-label="Relation groups pages"><button disabled={pagination.page === 0} onClick={() => setPage(pagination.page - 1)} aria-label="Previous relation groups page">‹</button><span>{pagination.page + 1} / {pagination.pageCount}</span><button disabled={pagination.page + 1 === pagination.pageCount} onClick={() => setPage(pagination.page + 1)} aria-label="Next relation groups page">›</button></nav> : null}
      <UnresolvedLinks key={mode} entries={current.unresolved} selectedId={selectedId} onSelect={onSelect} hostLabels={hostLabels} isObserved={isObserved} />
    </div>
    {model.other.length > 0 ? <UnresolvedLinks entries={model.other} selectedId={selectedId} onSelect={onSelect} hostLabels={hostLabels} isObserved={isObserved} /> : null}
  </section>;
}

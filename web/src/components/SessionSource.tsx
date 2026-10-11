import { useEffect, useMemo, useState } from "react";
import type { SessionRecord } from "../../../src/contracts";
import { collectorApi } from "../api";
import { buildSessionSources, reportedLineageFields, shortReference } from "../lib/session-source";
import { Link } from "../router";

export function CopyReference({ value, label = "Copy reference" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    setState("idle");
  }, [value]);
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2200);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button type="button" className="session-copy" aria-label={state === "idle" ? label : state === "copied" ? "Reference copied" : "Copy failed"}
      onClick={() => {
        void (async () => {
          try { await navigator.clipboard.writeText(value); setState("copied"); }
          catch { setState("failed"); }
        })();
      }}>
      <span aria-hidden="true">{state === "copied" ? "✓" : state === "failed" ? "!" : "⧉"}</span>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

type SourceResolution = { forReferences: string; sessions: Record<string, SessionRecord | null> };

export function SessionSource({ session }: { session: SessionRecord }) {
  const sourceModel = useMemo(() => buildSessionSources(session.sessionKey, session.lineage), [
    session.sessionKey, session.lineage.parentSessionKey, session.lineage.forkSourceKey, session.lineage.spawnedBy,
  ]);
  const fingerprint = JSON.stringify([session.sessionKey, session.hostId, sourceModel.sources.map((source) => [source.reference, source.lookupKey])]);
  const [resolution, setResolution] = useState<SourceResolution>({ forReferences: "", sessions: {} });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setResolution({ forReferences: fingerprint, sessions: {} });
    const keys = [...new Set(sourceModel.sources.flatMap((source) => source.lookupKey ? [source.lookupKey] : []))];
    void Promise.all(keys.map(async (key) => {
      try {
        const resolved = await collectorApi.session(key, controller.signal);
        return [key, resolved.sessionKey === key && resolved.hostId === session.hostId ? resolved : null] as const;
      } catch {
        return [key, null] as const;
      }
    })).then((entries) => {
      if (active) setResolution({ forReferences: fingerprint, sessions: Object.fromEntries(entries) });
    });
    return () => { active = false; controller.abort(); };
  }, [fingerprint, retry]);

  const resolvedSessions = resolution.forReferences === fingerprint ? resolution.sessions : {};
  const rawFields = reportedLineageFields(session.lineage);
  const previousVersion = session.lineage.previousSessionId?.trim();
  const unresolvedLookup = sourceModel.sources.some((source) => source.lookupKey && resolvedSessions[source.lookupKey] === null);
  return (
    <section className="detail-panel session-source-panel" aria-labelledby="session-source-heading">
      <h2 id="session-source-heading">Source{unresolvedLookup ? <button className="session-source-retry" type="button" onClick={() => setRetry((value) => value + 1)}><span aria-hidden="true">↻</span>Retry</button> : null}</h2>
      <div className="session-source-graph" data-has-source={sourceModel.sources.length > 0}>
        <div className="session-source-list">
          {sourceModel.sources.length === 0 ? <div className="session-source-empty"><span aria-hidden="true">?</span>{sourceModel.selfReferences.length > 0 ? "Source unresolved" : "Source not reported"}</div> : null}
          {sourceModel.sources.map((source) => {
            const resolved = source.lookupKey ? resolvedSessions[source.lookupKey] : null;
            const pending = source.lookupKey !== undefined && resolved === undefined;
            const body = <>
              <span className="session-node-top"><span className="session-node-icon" aria-hidden="true">▤</span><span className="session-source-relations">{source.relations.join(" · ")}</span>{resolved ? <span className="session-node-open" aria-hidden="true">↗</span> : null}</span>
              <strong>{resolved?.label ?? (pending ? "Loading source…" : "Source unresolved")}</strong>
              <span className="session-node-agent">{resolved?.agentId ?? shortReference(source.reference)}</span>
            </>;
            return resolved ? (
              <Link key={source.reference} to={`/sessions/${encodeURIComponent(resolved.sessionKey)}`} className="session-source-node" data-source-reference={source.reference} aria-label={`${source.relations.join(" and ")}: ${resolved.label}, ${resolved.agentId}`}>{body}</Link>
            ) : (
              <div key={source.reference} className="session-source-node" data-source-reference={source.reference} data-unresolved={!pending} tabIndex={0} aria-label={`${source.relations.join(" and ")}: ${pending ? "loading source" : "source unresolved"}, ${source.reference}`}>{body}</div>
            );
          })}
        </div>
        <div className="session-source-connector" aria-hidden="true"><span /></div>
        <div className="session-current-node" tabIndex={0} aria-label={`Current session: ${session.label}, ${session.agentId}`}>
          <span className="session-node-top"><span className="session-node-icon" aria-hidden="true">▤</span><span>Current session</span><span className="session-current-mark" aria-hidden="true">●</span></span>
          <strong>{session.label}</strong>
          <span className="session-node-agent">{session.agentId}</span>
        </div>
      </div>
      {sourceModel.selfReferences.length > 0 ? <div className="session-source-self">Self reference · {sourceModel.selfReferences.join(" · ")}</div> : null}
      {previousVersion ? <div className="session-source-reference-row"><span>Previous version</span><code title={previousVersion}>{shortReference(previousVersion)}</code><CopyReference value={previousVersion} label="Copy previous version reference" /></div> : null}
      {session.lineage.subagentRole || session.lineage.worktreeBranch || session.lineage.spawnDepth !== undefined ? (
        <div className="session-source-context"><span>Context</span>
          {session.lineage.subagentRole ? <span className="session-context-chip">{session.lineage.subagentRole}</span> : null}
          {session.lineage.worktreeBranch ? <span className="session-context-chip"><span aria-hidden="true">⑂</span>{session.lineage.worktreeBranch}</span> : null}
          {session.lineage.spawnDepth !== undefined ? <span className="session-context-chip">Depth {session.lineage.spawnDepth}</span> : null}
        </div>
      ) : null}
      {rawFields.length > 0 ? (
        <details className="session-raw-source"><summary>Source fields <span>{rawFields.length}</span></summary>
          <dl>{rawFields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd><code>{field.value}</code>{typeof field.value === "string" && ["parentSessionKey", "forkSourceKey", "spawnedBy", "previousSessionId"].includes(field.key) ? <CopyReference value={field.value} label={`Copy ${field.label.toLowerCase()} reference`} /> : null}</dd></div>)}</dl>
        </details>
      ) : null}
    </section>
  );
}

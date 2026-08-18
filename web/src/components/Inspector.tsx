import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ActivityDetail } from "../../../src/contracts";
import { collectorApi } from "../api";
import { formatExact, formatRelative, formatTime, outcomeLabel } from "../lib/format";

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="inspector-section"><h3>{title}</h3>{children}</section>;
}

export function Inspector({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    void collectorApi.detail(id).then((value) => { if (live) setDetail(value); }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [id]);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div className="inspector-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.aside className="inspector" aria-label="Activity inspector" initial={{ opacity: 0, x: 28, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ duration: 0.22, ease: "easeOut" }}>
            <div className="inspector-head">
              <div><span className="eyebrow">ACTIVITY INSPECTOR</span><Dialog.Title asChild><h2>{detail?.item.title ?? "Loading activity…"}</h2></Dialog.Title></div>
              <Dialog.Close asChild><button className="icon-button" aria-label="Close inspector">×</button></Dialog.Close>
            </div>
            {error ? <div className="inline-error">{error}</div> : null}
            {detail ? (
              <>
                <section className="inspector-now">
                  <div className={`large-state ${detail.item.attention !== "none" ? "attention" : ""}`}><span />{detail.item.stage.replaceAll("_", " ")}</div>
                  <p>{detail.item.progressSummary ?? (detail.item.lastToolName ? `Using ${detail.item.lastToolName}` : outcomeLabel(detail.item))}</p>
                  <div className="now-grid"><span>State<b>{detail.item.state}</b></span><span>Phase<b>{detail.item.phase}</b></span><span>Outcome<b>{detail.item.outcome}</b></span></div>
                </section>
                <InspectorSection title="OBSERVATION EVIDENCE">
                  <div className="evidence-list">
                    {detail.item.evidence.map((evidence) => <div key={evidence.source}><span className={`evidence-dot ${evidence.health}`} /><b>{evidence.source}</b><span>{evidence.health.replaceAll("_", " ")}</span><time>{formatRelative(evidence.observedAt)}</time></div>)}
                  </div>
                </InspectorSection>
                <InspectorSection title="IDENTITY">
                  <dl className="identity-grid">
                    <div><dt>Activity</dt><dd>{detail.item.id}</dd></div>
                    <div><dt>Kind</dt><dd>{detail.item.kind}</dd></div>
                    {Object.entries(detail.identity).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
                  </dl>
                </InspectorSection>
                <InspectorSection title="TIMELINE">
                  <div className="timeline">
                    {detail.timeline.length === 0 ? <p className="muted">No state transition has been retained yet.</p> : detail.timeline.map((entry) => <div className="timeline-entry" key={entry.id}><span /><div><b>{entry.kind}</b><small>{entry.toolName ?? entry.status ?? entry.phase ?? entry.source}</small></div><time dateTime={new Date(entry.occurredAt).toISOString()} title={formatExact(entry.occurredAt)}>{formatTime(entry.occurredAt)}</time></div>)}
                  </div>
                </InspectorSection>
                <InspectorSection title="RELATIONSHIPS">
                  {detail.relations.length === 0 ? <p className="muted">No exact or correlation-only relation observed.</p> : detail.relations.map((relation) => <div className="relation-line" key={`${relation.type}:${relation.from}:${relation.to}`}><span>{relation.label}</span><b>{relation.certainty.replaceAll("_", " ")}</b></div>)}
                </InspectorSection>
              </>
            ) : null}
          </motion.aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

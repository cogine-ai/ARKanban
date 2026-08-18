import type { ActivityItem } from "../../../src/contracts";
import { formatRelative } from "../lib/format";

export function ArchiveView({ items, onSelect }: { items: ActivityItem[]; onSelect: (id: string) => void }) {
  const terminal = items.filter((item) => item.state === "terminal").sort((left, right) => (right.endedAt ?? right.updatedAt) - (left.endedAt ?? left.updatedAt));
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">RECENT TERMINAL HISTORY</span><h1>Archive</h1></div><span className="count-chip">{terminal.length} retained</span></div>
      <div className="archive-table">
        <div className="archive-head"><span>Activity</span><span>Agent</span><span>Kind</span><span>Outcome</span><span>Terminal time</span></div>
        {terminal.map((item) => <button key={item.id} onClick={() => onSelect(item.id)}><span><i className={`archive-state outcome-${item.outcome}`} />{item.title}</span><span>{item.agentId}</span><span>{item.kind}</span><span>{item.outcome}</span><span>{formatRelative(item.endedAt ?? item.updatedAt)}</span></button>)}
        {terminal.length === 0 ? <div className="simple-empty">No terminal activity has been observed yet.</div> : null}
      </div>
    </section>
  );
}

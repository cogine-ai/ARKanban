import type { ActivitySnapshot } from "../../../src/contracts";

export function RelationsView({ snapshot, onSelect }: { snapshot?: ActivitySnapshot; onSelect: (id: string) => void }) {
  const itemsById = new Map(snapshot?.items.map((item) => [item.id, item]) ?? []);
  return (
    <section className="surface view-surface">
      <div className="view-heading"><div><span className="eyebrow">OBSERVED LINKS</span><h1>Relations</h1></div><span className="count-chip">{snapshot?.relations.length ?? 0} links</span></div>
      <div className="relation-cards">
        {snapshot?.relations.map((relation) => {
          const from = itemsById.get(relation.from);
          const to = itemsById.get(relation.to);
          return <button key={`${relation.type}:${relation.from}:${relation.to}`} onClick={() => onSelect(to?.id ?? relation.to)}><span className="relation-kind">{relation.type.replaceAll("_", " ")}</span><b>{from?.title ?? relation.from}</b><i>→</i><b>{to?.title ?? relation.to}</b><small>{relation.certainty.replaceAll("_", " ")}</small></button>;
        })}
        {snapshot?.relations.length === 0 ? <div className="simple-empty">Relations appear when Task and Attempt records share a run reference or parent identity.</div> : null}
      </div>
    </section>
  );
}

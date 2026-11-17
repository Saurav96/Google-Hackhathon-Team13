import { useEffect } from "react";

const percent = (x) => `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;

// Explains one link on the map: what kind it is, which way it points, and how far to trust it.
export default function RelationshipCard({ relation, onClose }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const supply = relation.type === "supply";
  return (
    <aside className="relation" role="dialog" aria-label={supply ? "Supply relationship" : "Worker spending"}>
      <div className="relation-head">
        <h3>{supply ? "Supply relationship" : "Worker spending"}</h3>
        <span className="relation-tag">Modeled</span>
        <button type="button" onClick={onClose} aria-label="Close" title="Close">×</button>
      </div>
      {supply ? (
        <>
          <p className="relation-pair">{relation.sourceName} → {relation.targetName}</p>
          <p className="relation-soft">Supplier → buyer{relation.hop > 1 ? `, step ${relation.hop} of the chain` : ""}</p>
          {relation.intensity > 0 && <p>{percent(relation.intensity)} of buyer input spending</p>}
          <p className="relation-soft">Industry estimate, not a verified contract.</p>
        </>
      ) : (
        <>
          <p className="relation-pair">Workplace block → {relation.targetName}</p>
          {relation.workers > 0 && <p>{Math.round(relation.workers).toLocaleString("en-US")} workers allocated from this block</p>}
          {relation.share > 0 && <p>{percent(relation.share)} of this business's allocated worker demand</p>}
          <p className="relation-soft">Job counts are real. Which shops workers use is modeled. Not a measure of total sales.</p>
        </>
      )}
    </aside>
  );
}

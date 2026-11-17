import { useMemo, useState } from "react";
import { smallPct } from "./api.js";
import Icon from "./Icons.jsx";
import Info from "./Info.jsx";
import MapCard from "./MapCard.jsx";
import MapView from "./MapView.jsx";
import { SectionHead } from "./Report.jsx";

const FILTERS = [["all", "All links"], ["supply", "Supply"], ["worker", "Worker spending"]];

// Section 2: the map, the selection card on it, and the same facts as a plain list.
export default function ImpactMap({ ctx, config, nodes, theme, funded, protectedIds, proposedIds, edgeIntensity, askAdvisor, asks, narrow }) {
  const { mode, selected, cascade, closure, select, actions } = ctx;
  const [filter, setFilter] = useState("all");
  const [cardOpen, setCardOpen] = useState(true);
  const [big, setBig] = useState(false);

  const pending = selected && mode === "queue" && cascade?.seed.business_id !== selected;
  const view = useMemo(() => {
    if (pending) return { kind: "cascade", seed: selected, exposed: [], links: [] };
    if (cascade) return { kind: "cascade", seed: cascade.seed.business_id, exposed: cascade.exposed, links: cascade.links, inbound: cascade.worker_links || [] };
    if (closure?.map) {
      return {
        kind: "closure", first: closure.map.first_order, second: closure.map.second_order, links: closure.map.links,
        origin: closure.map.origin, footfall: closure.map.footfall,
      };
    }
    return null;
  }, [pending, selected, cascade, closure]);

  // The same links the map draws, as rows a keyboard or screen reader can walk through.
  const links = useMemo(() => {
    const name = (id) => nodes.find((n) => n.id === id)?.name || id;
    const supply = (l) => ({
      key: `s${l.source}${l.target}`, type: "Supply", from: name(l.source), to: name(l.target),
      measure: edgeIntensity.has(`${l.source}>${l.target}`) ? `${smallPct(edgeIntensity.get(`${l.source}>${l.target}`))} of input spending` : "not available",
    });
    if (cascade && !pending) {
      return [
        ...(filter === "worker" ? [] : cascade.links.map(supply)),
        ...(filter === "supply" ? [] : (cascade.worker_links || []).map((w) => ({
          key: `w${w.block_id}`, type: "Worker spending", from: `Workplace block, ${w.jobs.toLocaleString("en-US")} workers`, to: cascade.seed.name,
          measure: `${Math.round(w.workers).toLocaleString("en-US")} workers allocated`,
        }))),
      ];
    }
    if (closure?.map) {
      return [
        ...(filter === "supply" ? [] : closure.map.footfall.map((f) => ({
          key: `w${f.target}`, type: "Worker spending", from: "Workplace block", to: name(f.target),
          measure: `${Math.round(f.workers).toLocaleString("en-US")} workers allocated`,
        }))),
        ...(filter === "worker" ? [] : closure.map.links.map(supply)),
      ];
    }
    return [];
  }, [cascade, closure, pending, filter, nodes, edgeIntensity]);

  const pendingName = pending ? nodes.find((n) => n.id === selected)?.name : null;
  const headline = pendingName ? <>Tracing what depends on <b>{pendingName}</b></>
    : cascade ? (cascade.exposed_total
      ? <><b>{cascade.seed.name}</b> closes. {cascade.exposed_total} businesses lose a supplier.</>
      : <><b>{cascade.seed.name}</b> closes. No other business here buys from it.</>)
    : closure ? <><b>{closure.employer_block.jobs.toLocaleString("en-US")} workers</b> leave. {closure.first_order_total} businesses lose worker demand, then {closure.second_order_total} suppliers behind them.</>
    : mode === "employer" ? "Pick a workplace block above to see who is exposed."
    : "Click any dot to see what happens if that business closes.";
  const showCard = cardOpen && !pending && (cascade || closure);

  return (
    <section className="sec" aria-labelledby="sec-impact">
      <SectionHead number={2} id="impact" title="Impact on the corridor" onDiscuss={actions.discuss}
        sub="Explore modeled connections, including businesses outside the applicant queue.">
        <button type="button" className="ghost" onClick={() => setBig(!big)}>{big ? "Smaller map" : "Expand map"}</button>
      </SectionHead>

      <div className="map-tools">
        <div className="chips" role="group" aria-label="Which links to show">
          {FILTERS.map(([id, label]) => (
            <button type="button" key={id} className={filter === id ? "is-on" : ""} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        {cascade && (
          <label className="steps-pick">Steps
            <select value={cascade.max_hops} onChange={(e) => { setCardOpen(true); select(cascade.seed.business_id, { hops: Number(e.target.value), toggle: false }); }}>
              <option value="1">1 step</option><option value="2">2 steps</option><option value="3">3 steps</option>
            </select>
            <Info label="steps">Two steps is the default. Three steps reaches most of the corridor and stops telling you anything.</Info>
          </label>
        )}
        {(cascade || closure) && !cardOpen && <button type="button" className="ghost" onClick={() => setCardOpen(true)}>Show the card</button>}
        {selected && <button type="button" className="ghost" onClick={() => select(null)}>Clear selection</button>}
      </div>

      <div className={`stage${showCard ? " has-card" : ""}${big ? " is-big" : ""}`}>
        <MapView apiKey={config.maps_api_key} nodes={nodes} view={view} funded={funded} protectedIds={protectedIds} proposedIds={proposedIds}
          theme={theme} linkFilter={filter} edgeIntensity={edgeIntensity} reserveRight={showCard && !narrow ? 320 : 40}
          onSelect={(id) => { setCardOpen(true); select(id || null); }} />
        <p className="headline" aria-live="polite">{headline}</p>
        {showCard && <MapCard cascade={cascade} closure={closure} onClose={() => setCardOpen(false)} onAsk={(q) => askAdvisor(q, "impact")}
          ask={cascade ? asks.get(cascade.seed.business_id) : null} />}
      </div>

      <ul className="legend">
        <li><i className="line is-supply" />Supply: supplier to buyer</li>
        <li><i className="line is-worker" />Worker spending</li>
        <li><i className="dot" style={{ background: "var(--closed)" }} />Closes</li>
        <li><i className="dot" style={{ background: "var(--safe)" }} />In reach of a selected grant</li>
        <li><i className="dot is-proposed" />In an unapplied proposal</li>
        <li><i className="dot is-queue" />Applicant</li>
        <li className="sub">Real addresses. Links are modeled. Click a line to inspect it.</li>
      </ul>

      {cascade && cascade.strongest_chains.length > 0 && (
        <details className="why">
          <summary>The same result as a list: {cascade.exposed_total} businesses in modeled reach of {cascade.seed.name}</summary>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th scope="col">Chain, supplier to buyer</th><th scope="col" className="n">Steps</th><th scope="col" className="n">Share of buyer input spending</th></tr></thead>
              <tbody>
                {[...cascade.strongest_chains, ...cascade.furthest_chains].filter((c, i, all) => all.findIndex((x) => x.chain === c.chain) === i).map((ch) => (
                  <tr key={ch.chain}><td>{ch.chain.replaceAll(" -> ", " → ")}</td><td className="n">{ch.hops}</td><td className="n">{smallPct(ch.path_strength)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub"><span className="tag is-modeled">Modeled relationship</span> The strongest chains are shown. The percentage is a modeled share of spending, not a chance of failure.</p>
        </details>
      )}
      {links.length > 0 && (
        <details className="why">
          <summary>Every link in this view, as a list ({links.length})</summary>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th scope="col">Type</th><th scope="col">From</th><th scope="col">To</th><th scope="col" className="n">Measure</th></tr></thead>
              <tbody>
                {links.slice(0, 60).map((l) => (
                  <tr key={l.key}><td>{l.type}</td><td>{l.from}</td><td>{l.to}</td><td className="n">{l.measure}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub">
            <span className="tag is-modeled">Modeled relationship</span> Supply runs supplier to buyer, and the measure is a share of the buyer's input spending, not a chance of failure.
            Worker spending runs workplace block to business, and the measure is workers allocated, not sales.
            {links.length > 60 && ` Showing the first 60 of ${links.length}.`}
          </p>
        </details>
      )}
      {closure && (
        <details className="why">
          <summary>The same result as a list: who loses worker demand, then their suppliers</summary>
          <div className="two">
            <ul className="plain-rows">{closure.first_order_lose_footfall.map((s) => <li key={s.business_id}><span>{s.name}</span><em>{(100 * s.share_of_footfall_lost).toFixed(1)}% of allocated worker demand</em></li>)}</ul>
            <ul className="plain-rows">{closure.second_order_suppliers.map((s) => <li key={s.business_id}><span>{s.name}</span><em>supplier, {s.min_hops} step{s.min_hops > 1 ? "s" : ""} back</em></li>)}</ul>
          </div>
          <p className="sub"><span className="tag is-modeled">Modeled relationship</span> {closure.evidence_note}</p>
        </details>
      )}
    </section>
  );
}

import { useState } from "react";
import { pct, roleOf, smallPct, usd } from "./api.js";
import Icon from "./Icons.jsx";

function verdict(c) {
  const role = roleOf(c.seed.network_role);
  const peers = c.replaceability.same_industry_peers_in_corridor;
  if (role === "Ubiquitous Hub") return ["warn", "A weak signal. It is the only business of its kind here, so the model gives it every nearby buyer."];
  if (c.exposed_total === 0) return ["warn", "No cascade. The model sees few links for this industry, which is a limit of the model."];
  if (peers === 0) return ["good", "No other local business does the same work, so its buyers have no local substitute."];
  return ["warn", `${peers} other local businesses do the same work, so many buyers could switch.`];
}

// The short version of a selection, shown on the map so the chat stays in view.
export default function MapCard({ cascade, closure, onClose, onAsk }) {
  const [more, setMore] = useState(false);
  if (cascade) {
    const hood = cascade.neighborhood;
    const [tone, sentence] = verdict(cascade);
    return (
      <aside className="card" aria-label="Selected business">
        <div className="card-head">
          <h2>{cascade.seed.name}</h2>
          <button type="button" onClick={onClose} aria-label="Hide this card" title="Hide this card"><Icon name="close" /></button>
        </div>
        <p className="sub">{cascade.seed.address.split(",")[0]}. {roleOf(cascade.seed.network_role)}.</p>
        <div className="card-figures">
          <div><strong>{cascade.exposed_by_hops["1_hop"] || 0}</strong><span>buy from it directly</span></div>
          <div><strong>{(cascade.exposed_by_hops["2_hop"] || 0) + (cascade.exposed_by_hops["3_hop"] || 0)}</strong><span>one step further</span></div>
          <div><strong>{cascade.exposed_not_in_applicant_queue}</strong><span>never applied</span></div>
        </div>
        <p className={`flag is-${tone}`}>{sentence}</p>
        <p className="card-need"><span>Poverty in this tract</span><b>{pct(hood.poverty_rate)} <small>vs {pct(hood.corridor_average.poverty_rate)}</small></b></p>
        <p className="card-need"><span>Households with no vehicle</span><b>{pct(hood.no_vehicle_rate)} <small>vs {pct(hood.corridor_average.no_vehicle_rate)}</small></b></p>
        <div className="card-tags">
          <span className="tag">Public record: business, tract</span>
          <span className="tag is-modeled">Modeled: supply links</span>
        </div>
        <div className="card-actions">
          <button type="button" className="btn" onClick={() => onAsk(`Should I fund ${cascade.seed.name}? Give me the short case.`)}>Discuss this business</button>
          <button type="button" className="btn is-plain" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Less" : "More details"}</button>
        </div>
        {more && (
          <div className="card-more">
            <h3>Strongest chains</h3>
            <ul>{cascade.strongest_chains.slice(0, 5).map((ch) => (
              <li key={ch.chain}><span>{ch.chain.replaceAll(" -> ", " → ")}</span><em>{smallPct(ch.path_strength)}</em></li>
            ))}</ul>
            <p className="sub">Share of the last buyer's input spending. Outside corridor alternatives are unknown.</p>
            {cascade.duplicate_registrations.length > 0 && <p className="sub">Also registered as {cascade.duplicate_registrations.join(", ")}.</p>}
            {cascade.sba_loans.length > 0 && <p className="sub">SBA loan on record: {cascade.sba_loans.map((l) => `${usd(l.gross_approval)} from ${l.bank_name}`).join("; ")}.</p>}
          </div>
        )}
      </aside>
    );
  }
  const block = closure.employer_block;
  return (
    <aside className="card" aria-label="Selected employer block">
      <div className="card-head">
        <h2>{block.jobs.toLocaleString("en-US")} workers leave</h2>
        <button type="button" onClick={onClose} aria-label="Hide this card" title="Hide this card"><Icon name="close" /></button>
      </div>
      <p className="sub">A census block of workplaces, not one company.</p>
      <div className="card-figures">
        <div><strong>{closure.first_order_total}</strong><span>lose customers</span></div>
        <div><strong>{closure.second_order_total}</strong><span>suppliers behind them</span></div>
        <div><strong>{closure.exposed_not_in_applicant_queue}</strong><span>never applied</span></div>
      </div>
      <p className="flag is-warn">The suppliers are nowhere near the employer. They are hurt because their buyers lose trade.</p>
      <div className="card-tags">
        <span className="tag">Public record: job counts</span>
        <span className="tag is-modeled">Modeled: foot traffic, supply links</span>
      </div>
      <div className="card-actions">
        <button type="button" className="btn" onClick={() => onAsk(`Employer block ${block.block_id} with ${block.jobs} jobs is leaving in 90 days. Who is exposed, and who should we contact first?`)}>Discuss this closure</button>
      </div>
    </aside>
  );
}

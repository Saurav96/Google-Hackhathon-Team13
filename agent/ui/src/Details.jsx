import { useEffect, useState } from "react";
import { getJson, pct, roleOf, smallPct, usd } from "./api.js";
import Info from "./Info.jsx";

function Bars({ rows }) {
  const max = Math.max(...rows.flatMap((r) => [r.here, r.corridor]));
  return (
    <div className="bars">
      {rows.map((r) => (
        <div className="bars-group" key={r.label}>
          <p>{r.label}</p>
          {[[r.hereLabel || "This tract", r.here, ""], [r.corridorLabel || "Corridor", r.corridor, " is-base"]].map(([name, value, cls]) => (
            <div className="bars-row" key={name}>
              <span>{name}</span>
              <div className={`track${cls}`}><i style={{ width: `${(100 * value) / max}%` }} /></div>
              <span className="num">{pct(value)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function verdict(c) {
  const role = roleOf(c.seed.network_role);
  const peers = c.replaceability.same_industry_peers_in_corridor;
  if (role === "Ubiquitous Hub") {
    return ["warn", `A reach this large is a weak signal. ${c.seed.name} is the only business of its kind here, so the model gives it every nearby buyer. In practice those buyers can order from outside the corridor.`];
  }
  if (c.exposed_total === 0) {
    return ["warn", "The graph cannot argue for this grant. That is a limit of the model, which sees few links for this industry, not proof the business matters less."];
  }
  if (peers === 0) return ["good", "No other business in the corridor does the same work, so its buyers have no local substitute."];
  return ["warn", `${peers} other local businesses do the same work, so many of its buyers could switch.`];
}

export function CaseDetails({ c, ask, grant, compareTo, others, setHops }) {
  const [scenarios, setScenarios] = useState(null);
  const [whatIf, setWhatIf] = useState("");
  const id = c.seed.business_id;

  useEffect(() => {
    setScenarios(null);
    setWhatIf("");
    if (!grant) return;
    getJson(`/api/scenarios/${encodeURIComponent(id)}?grant_usd=${grant}&compare_to=${encodeURIComponent(compareTo || "")}`)
      .then(setScenarios).catch(() => setScenarios(null));
  }, [id, grant, compareTo]);

  const [tone, sentence] = verdict(c);
  const chains = [];
  for (const ch of [...c.furthest_chains.slice(0, 3), ...c.strongest_chains]) {
    if (!chains.some((x) => x.chain === ch.chain)) chains.push(ch);
  }
  const hood = c.neighborhood;

  return (
    <div className="details">
      <h2>{c.exposed_total
        ? `If ${c.seed.name} closes, ${c.exposed_total} businesses lose a supplier.`
        : `${c.seed.name} supplies no other business in the corridor.`}</h2>
      <p className="sub">{c.seed.address}. {roleOf(c.seed.network_role)}.</p>

      <div className="figures">
        <div><strong>{c.exposed_by_hops["1_hop"] || 0}</strong><span>buy from it directly</span></div>
        <div><strong>{(c.exposed_by_hops["2_hop"] || 0) + (c.exposed_by_hops["3_hop"] || 0)}</strong><span>further down the chain</span></div>
        <div><strong>{c.exposed_not_in_applicant_queue}</strong><span>never applied</span></div>
      </div>
      <p className={`flag is-${tone}`}>{sentence}</p>
      {c.duplicate_registrations.length > 0 && (
        <p className="sub">Also registered as {c.duplicate_registrations.join(", ")}. Treat them as one business.</p>
      )}
      <button type="button" className="btn" onClick={() => ask(`Write the grant memo for ${c.seed.name}. Say plainly if it is not a good grant.`)}>
        Ask the advisor for the memo
      </button>

      <h3>
        The chains, as traversed
        <span className="hops" role="group" aria-label="Steps to follow">
          {[1, 2, 3].map((n) => (
            <button type="button" key={n} className={n === c.max_hops ? "is-on" : ""} onClick={() => setHops(n)}>{n}</button>
          ))}
        </span>
      </h3>
      {c.max_hops === 3 && <p className="sub">Three steps reaches most of the corridor and says little.</p>}
      {chains.length > 0 ? (
        <ul className="rows">
          {chains.slice(0, 7).map((ch) => (
            <li key={ch.chain}>
              <span>{ch.chain.replaceAll(" -> ", " → ")}</span>
              <em>{ch.hops} step{ch.hops > 1 ? "s" : ""}, {smallPct(ch.path_strength)}</em>
            </li>
          ))}
        </ul>
      ) : <p className="sub">No chains to show.</p>}
      {chains.length > 0 && <p className="sub">The percentage is the modeled share of the last buyer's input spending that travels along the chain.</p>}

      <h3>Who the neighborhood is</h3>
      <Bars rows={[
        { label: "People below the poverty line", here: hood.poverty_rate, corridor: hood.corridor_average.poverty_rate },
        { label: "Households with no vehicle", here: hood.no_vehicle_rate, corridor: hood.corridor_average.no_vehicle_rate },
      ]} />

      {scenarios && (
        <>
          <h3>
            <span>What a {usd(scenarios.grant_usd)} grant changes
              <Info label="the scenarios">No data says how likely a business is to close or how much a grant helps. So we show three assumptions instead of one invented number. "Shielded" is the expected number of businesses that keep a supplier because of this grant.</Info>
            </span>
          </h3>
          <table className="plain">
            <thead><tr><th>If we assume</th><th>Closure risk</th><th>Grant cuts it by</th><th>Shielded</th><th>Cost each</th></tr></thead>
            <tbody>
              {Object.entries(scenarios.scenarios).map(([name, s]) => (
                <tr key={name}>
                  <td>{name[0].toUpperCase() + name.slice(1)}</td>
                  <td className="n">{pct(s.closure_risk_without_grant)}</td>
                  <td className="n">{pct(s.risk_cut_by_grant)}</td>
                  <td className="n">{s.expected_businesses_shielded.toFixed(1)}</td>
                  <td className="n">{s.cost_per_business_shielded_usd ? usd(s.cost_per_business_shielded_usd) : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sub">{scenarios.what_is_assumed}</p>
          {scenarios.flip_condition && <p className="sub">{scenarios.flip_condition}</p>}
        </>
      )}

      {c.exposed_total > 0 && others.length > 0 && (
        <>
          <h3>If we fund this one and another closes anyway</h3>
          <select aria-label="Business that closes anyway" defaultValue="" key={id} onChange={async (e) => {
            if (!e.target.value) return setWhatIf("");
            const r = await getJson(`/api/what-if?funded=${encodeURIComponent(id)}&fails=${encodeURIComponent(e.target.value)}`);
            setWhatIf(r.reading);
          }}>
            <option value="">Choose a business</option>
            {others.map((o) => <option key={o.business_id} value={o.business_id}>{o.name}</option>)}
          </select>
          {whatIf && <p className="sub">{whatIf}</p>}
        </>
      )}

      {c.sba_loans.length > 0 && (
        <>
          <h3>SBA loan record</h3>
          <ul className="rows">
            {c.sba_loans.map((l) => (
              <li key={l.approval_date + l.gross_approval}>
                <span>{l.bank_name}</span>
                <em>{usd(l.gross_approval)}, {l.approval_date}, {l.charged_off ? "charged off" : "not charged off"}</em>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="sub foot">{c.evidence_note}</p>
    </div>
  );
}

export function ClosureDetails({ r, ask }) {
  const block = r.employer_block;
  return (
    <div className="details">
      <h2>If this block's {block.jobs.toLocaleString("en-US")} workers leave, {r.first_order_total + r.second_order_total} businesses are exposed.</h2>
      <p className="sub">An employer block is a census block of workplaces with a real job count, not one company.</p>
      <div className="figures">
        <div><strong>{r.first_order_total}</strong><span>lose weekday customers</span></div>
        <div><strong>{r.second_order_total}</strong><span>suppliers behind them</span></div>
        <div><strong>{r.exposed_not_in_applicant_queue}</strong><span>never applied</span></div>
      </div>
      <p className="flag is-warn">The second group is nowhere near the employer. They are hurt because their buyers lose trade. No application queue would ever show them.</p>
      <button type="button" className="btn" onClick={() => ask(`Employer block ${block.block_id} with ${block.jobs} jobs is leaving in 90 days. Who is exposed, and who should we reach out to before they apply?`)}>
        Ask the advisor what to do
      </button>
      <h3>Lose weekday customers first</h3>
      <ul className="rows">
        {r.first_order_lose_footfall.slice(0, 8).map((s) => (
          <li key={s.business_id}><span>{s.name}</span><em>{pct(s.share_of_footfall_lost)} of footfall</em></li>
        ))}
      </ul>
      <h3>Then their suppliers</h3>
      <ul className="rows">
        {r.second_order_suppliers.slice(0, 8).map((s) => (
          <li key={s.business_id}>
            <span>{s.example_chain.replace("  (buyer loses footfall)", "").replaceAll(" -> ", " → ")}</span>
            <em>{s.buyers_losing_footfall.length}{s.buyers_losing_footfall.length === 6 ? "+" : ""} buyers hit</em>
          </li>
        ))}
      </ul>
      <p className="sub foot">{r.evidence_note}</p>
    </div>
  );
}

export function Evidence({ overview }) {
  const k = overview.health, a = overview.audit, bias = a?.structural_bias_in_the_model;
  const checks = [
    ["Supply links have unique keys", k.duplicate_supply_keys === 0, `${k.supply_edges} links`],
    ["Footfall links have unique keys", k.duplicate_footfall_keys === 0, `${k.footfall_edges} links`],
    ["No link points at a missing business", k.dangling_supply_edges === 0, `${k.businesses} businesses`],
    ["No business supplies itself", k.supply_self_loops === 0, ""],
    ["Every business has a census tract", k.businesses_without_a_census_tract === 0, ""],
  ];
  const sources = [
    ["Businesses, addresses, industries", "Real", "City of San Francisco registry"],
    ["Bank loans and failures", "Real", "SBA 7(a) records"],
    ["Neighborhood need", "Real", "Census ACS, by tract"],
    ["Worker counts per block", "Real", "Census LEHD"],
    ["Who supplies whom", "Modeled", "Federal BEA purchase rates, assigned to pairs within 1,200 m"],
    ["Which workers shop where", "Modeled", "Block job counts split equally across nearby businesses"],
  ];
  return (
    <div className="details">
      <h2>What this rests on</h2>
      <table className="plain">
        <thead><tr><th>Evidence</th><th>Status</th><th>Source</th></tr></thead>
        <tbody>{sources.map(([what, status, source]) => (
          <tr key={what}><td>{what}</td><td><span className={`tag is-${status.toLowerCase()}`}>{status}</span></td><td>{source}</td></tr>
        ))}</tbody>
      </table>
      <p className="sub">The link types and their industry average strengths are measured by the federal government. Assigning them to specific pairs of businesses is our modeling choice.</p>

      <h3>Checks run on the tables</h3>
      <ul className="rows">
        {checks.map(([label, ok, detail]) => (
          <li key={label}><span>{label}</span><em>{ok ? "Passed" : "Problem"}{detail ? `, ${detail}` : ""}</em></li>
        ))}
      </ul>
      <p className="sub">{k.why_it_matters}</p>

      {bias && (
        <>
          <h3>A bias we found in our own output</h3>
          <Bars rows={[{
            label: "Food service, as a share of", hereLabel: "With a cascade", corridorLabel: "All businesses",
            here: bias.food_service_share_of_businesses_with_a_cascade, corridor: bias.food_service_share_of_all_businesses,
          }]} />
          <p className="sub">{bias.reading}</p>
          <p className={`flag is-${a.need.money_went_to_higher_need ? "good" : "warn"}`}>
            The advisor's split funds businesses in tracts averaging {pct(a.need.funded_avg_tract_poverty)} poverty,
            against {pct(a.need.corridor_avg_tract_poverty)} for the corridor.
          </p>
        </>
      )}

      <h3>What this cannot tell you</h3>
      <ul className="plain-list">
        <li>Whether the model is right about failures. {k.sba_loans} loans matched this corridor and {k.sba_loans_charged_off} were charged off, so there is no local ground truth.</li>
        <li>How distressed a business is. There is no revenue, rent or arrears data.</li>
        <li>How many jobs are at stake. No public source lists jobs per small business.</li>
        <li>Whether a buyer already orders from outside the corridor.</li>
        <li>A grant changes a probability, not an outcome.</li>
      </ul>
      <p className="sub foot">Race and ethnicity are never inputs to a recommendation.</p>
    </div>
  );
}

import { useEffect, useState } from "react";
import { getJson, pct, roleOf, usd } from "./api.js";
import Icon from "./Icons.jsx";
import Info from "./Info.jsx";
import { fingerprint, SECTIONS } from "./useReport.js";

const roleClass = (role) => roleOf(role).split(/[ /]/)[0].toLowerCase();

export function SectionHead({ number, id, title, sub, onDiscuss, children }) {
  return (
    <header className="sec-head">
      <span className="sec-num" aria-hidden="true">{String(number).padStart(2, "0")}</span>
      <div className="sec-title">
        <h2 id={`sec-${id}`}>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
      </div>
      <div className="sec-tools">
        {children}
        <button type="button" className="ghost" onClick={() => onDiscuss(id)}><Icon name="chat" size={14} />Discuss</button>
      </div>
    </header>
  );
}

// Officer or advisor text for a section, with its freshness against the current inputs.
export function Narrative({ id, auto, report, onSave, onDraft }) {
  const saved = report.narrative[id];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const stale = saved && saved.basis !== fingerprint(report);
  const text = saved ? saved.text : auto;

  if (editing) {
    return (
      <form className="narrative-edit" onSubmit={(e) => { e.preventDefault(); onSave(id, draft, "officer"); setEditing(false); }}>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} aria-label="Section text" autoFocus />
        <div>
          <button type="submit" className="btn">Save text</button>
          <button type="button" className="btn is-plain" onClick={() => setEditing(false)}>Cancel</button>
          {saved && <button type="button" className="btn is-plain" onClick={() => { onSave(id, "", "officer"); setEditing(false); }}>Use the computed text</button>}
        </div>
        <p className="sub">Numbers you type here are your own words. They are not checked against the data.</p>
      </form>
    );
  }
  return (
    <div className="narrative">
      {text ? <p>{text}</p> : <p className="sub">No text yet for this section.</p>}
      <div className="narrative-meta">
        {saved && <span className={`state ${stale ? "is-stale" : "is-current"}`}>{stale ? "Needs update" : "Current"}</span>}
        {saved && <span className="sub">{saved.author === "advisor" ? "Written by the advisor, applied by you" : "Edited by you"}</span>}
        {stale && <span className="sub">The budget or selection changed after this was written.</span>}
        <button type="button" className="ghost" onClick={() => { setDraft(text || ""); setEditing(true); }}><Icon name="edit" size={14} />Edit</button>
        <button type="button" className="ghost" onClick={() => onDraft(id)}>{text ? "Ask the advisor to rewrite" : "Draft this section"}</button>
      </div>
    </div>
  );
}

export function Proposals({ proposals, report, onApply, onDismiss }) {
  if (!proposals.length) return null;
  return proposals.map((p) => {
    const outdated = p.baseRevision !== report.revision;
    return (
      <article className="proposal-card" key={p.id} aria-label="Proposed change from the advisor">
        <p className="proposal-tag">Proposed by the advisor, not yet applied</p>
        <h3>{p.summary}</h3>
        {p.kind === "text" ? (
          <div className="diff">
            <div className="diff-before"><span>Before</span><p>{p.before || "No text yet."}</p></div>
            <div className="diff-after"><span>After</span><p>{p.after}</p></div>
          </div>
        ) : (
          <ul className="proposal-list">
            {p.plan.plan.map((s) => (
              <li key={s.business_id}><span>{s.name}</span><span>{usd(s.grant_usd)}</span><em>{s.newly_protected} newly in reach</em></li>
            ))}
            <li className="is-total"><span>{p.plan.plan.length} grants</span><span>{usd(p.plan.plan_total_usd)} of {usd(p.plan.budget_usd)}</span>
              <em>{p.plan.plan_distinct_businesses_protected} distinct businesses</em></li>
          </ul>
        )}
        {outdated && <p className="error">The report changed after this was proposed. Ask the advisor again so it uses the current report.</p>}
        <div className="proposal-actions">
          <button type="button" className="btn" disabled={outdated} onClick={() => onApply(p)}>Apply changes</button>
          <button type="button" className="btn is-plain" onClick={() => onDismiss(p.id)}>Dismiss</button>
          <span className="sub">{p.kind === "text" ? "Text only. Numbers stay the same." : "Changes the selected grants in this report."}</span>
        </div>
      </article>
    );
  });
}

export function Recommendation({ ctx }) {
  const { overview, report, evaluation, plan, mode, setMode, actions, proposals, selected, select, selectBlock, closure } = ctx;
  const [editingBudget, setEditingBudget] = useState(false);
  const picks = new Map((plan?.plan || []).map((s) => [s.business_id, s.step]));
  const chosen = new Set(report.selection);
  const ev = evaluation;
  const auto = ev && ev.grants.length
    ? `Propose ${ev.grants.length} grant${ev.grants.length > 1 ? "s" : ""} totaling ${usd(ev.total_usd)}. Their modeled reach includes ${ev.distinct_businesses_in_reach} distinct businesses. These estimates do not guarantee survival.`
    : "No grants are selected yet. Tick applicants below, or use the advisor's split.";
  const isDraft = report.revision === 1;
  const matchesPlan = plan && plan.plan.length === report.selection.length && plan.plan.every((s) => chosen.has(s.business_id));

  return (
    <section className="sec" aria-labelledby="sec-recommendation">
      <SectionHead number={1} id="recommendation" title="Recommendation" onDiscuss={actions.discuss} />
      <div className="seg" role="tablist" aria-label="Situation">
        <button type="button" role="tab" aria-selected={mode === "queue"} className={mode === "queue" ? "is-on" : ""} onClick={() => setMode("queue")}>Allocate relief</button>
        <button type="button" role="tab" aria-selected={mode === "employer"} className={mode === "employer" ? "is-on" : ""} onClick={() => setMode("employer")}>Employer closure</button>
      </div>

      {mode === "employer" ? (
        <>
          <p className="narrative-lead">A large employer leaves in 90 days and nobody has applied for anything. Pick a workplace block to see who is exposed before they know it.</p>
          <ul className="blocks">
            {overview.employer_blocks.map((b) => (
              <li key={b.block_id}>
                <button type="button" className={selected === b.block_id ? "is-on" : ""} onClick={() => selectBlock(b.block_id)}>
                  <strong>{b.jobs.toLocaleString("en-US")} workers</strong>
                  <span>{b.businesses_drawing_footfall} nearby businesses rely on them</span>
                </button>
              </li>
            ))}
          </ul>
          {closure && (
            <p className="flag is-warn">
              {closure.first_order_total} businesses lose modeled worker demand and {closure.second_order_total} suppliers behind them are exposed.
              {" "}{closure.exposed_not_in_applicant_queue} of them are outside the demo applicant queue.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="stats">
            <div>
              <span>Budget</span>
              {editingBudget ? (
                <form onSubmit={(e) => { e.preventDefault(); actions.setBudget(e.target.elements.budget.value); setEditingBudget(false); }}>
                  $<input name="budget" type="number" min="0" step="1000" defaultValue={report.budget} autoFocus aria-label="Relief budget in dollars"
                    onBlur={(e) => { actions.setBudget(e.target.value); setEditingBudget(false); }} />
                </form>
              ) : (
                <strong>{usd(report.budget)}
                  <button type="button" className="ghost icon-only" onClick={() => setEditingBudget(true)} aria-label="Change the budget" title="Change the budget"><Icon name="edit" size={15} /></button>
                </strong>
              )}
            </div>
            <div><span>Proposed</span><strong>{usd(ev?.total_usd || 0)}</strong></div>
            <div className={ev?.over_budget ? "is-over" : ""}><span>{ev?.over_budget ? "Over budget" : "Unallocated"}</span><strong>{usd(Math.abs(ev?.unallocated_usd ?? report.budget))}</strong></div>
            <div><span className="with-info">Modeled reach
              <Info label="modeled reach">Distinct businesses with a modeled supply link, within two steps, to a selected business. Each is counted once. Reach is not a count of businesses saved.</Info>
            </span><strong>{ev?.distinct_businesses_in_reach ?? 0}</strong></div>
          </div>

          <Proposals proposals={proposals} report={report} onApply={actions.applyProposal} onDismiss={actions.dismissProposal} />
          {isDraft && <p className="sub"><span className="state is-stale">Draft</span> A computed starting point, not yet reviewed by you or written up by the advisor.</p>}
          <Narrative id="recommendation" auto={auto} report={report} onSave={actions.setNarrative} onDraft={actions.draft} />

          <div className="table-head">
            <p className="sub">Demo applicants and requested amounts. The registry lists businesses, not applicants.</p>
            <button type="button" className="btn" onClick={actions.useAdvisorSplit}>Use the advisor's split</button>
            {report.selection.length > 0 && <button type="button" className="btn is-plain" onClick={() => actions.setSelection([], "Selection cleared")}>Clear</button>}
          </div>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th scope="col"><span className="visually-hidden">Fund</span></th><th scope="col">Business</th><th scope="col">Role</th>
                <th scope="col" className="n">Reach</th><th scope="col" className="n">Requested</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {overview.applicants.map((a) => (
                  <tr key={a.business_id} className={selected === a.business_id ? "is-selected" : ""}>
                    <td><input type="checkbox" checked={chosen.has(a.business_id)} onChange={() => actions.toggle(a.business_id, a.name)} aria-label={`Fund ${a.name}`} /></td>
                    <td><button type="button" className="link-row" onClick={() => select(a.business_id)}>{a.name}</button></td>
                    <td><i className={`role-dot is-${roleClass(a.network_role)}`} />{roleOf(a.network_role)}</td>
                    <td className="n">{a.exposed_total}</td>
                    <td className="n">{usd(a.requested_usd)}</td>
                    <td>{chosen.has(a.business_id) ? <span className="pill is-on">Proposed</span>
                      : picks.has(a.business_id) ? <span className="pill">Advisor pick {picks.get(a.business_id)}</span> : <span className="pill is-off">Not selected</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan && matchesPlan && plan.budget_left_usd > 0 && plan.not_funded.length > 0 && (
            <details className="why">
              <summary>Why leave {usd(plan.budget_left_usd)} unallocated?</summary>
              <ul>{plan.not_funded.map((n) => <li key={n.name}><strong>{n.name}.</strong> {n.reason}</li>)}</ul>
              <p className="sub">The split is a rule of thumb, not a proven best answer: most newly reached businesses per dollar, with hubs left out.</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}

export function Alternatives({ ctx }) {
  const { overview, report, plan, actions, select } = ctx;
  const chosen = new Set(report.selection);
  const reasons = new Map((plan?.not_funded || []).map((n) => [n.name, n.reason]));
  const cmp = plan?.comparison;
  return (
    <section className="sec" aria-labelledby="sec-alternatives">
      <SectionHead number={3} id="alternatives" title="Alternatives and tradeoffs" onDiscuss={actions.discuss}
        sub="Local substitutes, overlapping reach, and why the biggest hub is not the automatic choice." />
      <Narrative id="alternatives" auto="" report={report} onSave={actions.setNarrative} onDraft={actions.draft} />
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th scope="col">Business</th><th scope="col" className="n">Reach</th><th scope="col" className="n">Same industry peers</th>
            <th scope="col" className="n">Tract poverty</th><th scope="col">In this report</th></tr></thead>
          <tbody>
            {overview.applicants.map((a) => (
              <tr key={a.business_id}>
                <td><button type="button" className="link-row" onClick={() => select(a.business_id)}>{a.name}</button></td>
                <td className="n">{a.exposed_total}</td>
                <td className="n">{a.same_industry_peers_in_corridor}</td>
                <td className="n">{pct(a.tract_poverty_rate)}</td>
                <td>{chosen.has(a.business_id) ? <strong>Selected</strong> : (reasons.get(a.name) || "Not selected")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cmp && (
        <p className="sub">
          Funding by reach alone would pick {cmp.fund_by_reach_until_money_runs_out.grants.join(", ")} and show {cmp.fund_by_reach_until_money_runs_out.distinct_protected} businesses in reach.
          That number is inflated: a hub is the only local producer of its input, so the model hands it every nearby buyer.
          <Info label="peers">Same industry peers are a stand in for substitutes. A business with no local peer may still have rivals outside the corridor, which this data cannot see.</Info>
        </p>
      )}
    </section>
  );
}

export function Scenarios({ ctx }) {
  const { overview, report, cascade, actions } = ctx;
  const applicants = overview.applicants;
  const subjectId = (cascade && applicants.find((a) => a.business_id === cascade.seed.business_id)?.business_id) || report.selection[0];
  const subject = applicants.find((a) => a.business_id === subjectId);
  const runnerUp = report.selection.find((id) => id !== subjectId);
  const [scenarios, setScenarios] = useState(null);
  const [whatIf, setWhatIf] = useState("");

  useEffect(() => {
    setScenarios(null);
    setWhatIf("");
    if (!subject) return undefined;
    let live = true;
    getJson(`/api/scenarios/${encodeURIComponent(subject.business_id)}?grant_usd=${subject.requested_usd}&compare_to=${encodeURIComponent(runnerUp || "")}`)
      .then((s) => { if (live) setScenarios(s); }).catch(() => {});
    return () => { live = false; };
  }, [subject?.business_id, runnerUp]);

  return (
    <section className="sec" aria-labelledby="sec-scenarios">
      <SectionHead number={4} id="scenarios" title="What the grant changes" onDiscuss={actions.discuss}
        sub="No data says how likely a closure is, so this shows stated assumptions, never one invented number." />
      <Narrative id="scenarios" auto="" report={report} onSave={actions.setNarrative} onDraft={actions.draft} />
      {!subject && <p className="sub">Select a grant above, or click an applicant on the map, to see its scenarios.</p>}
      {subject && scenarios && (
        <>
          <p><strong>{subject.name}</strong>, {usd(scenarios.grant_usd)} grant. <span className="tag is-assumption">Scenario assumption</span></p>
          <div className="table-wrap">
            <table className="grid">
              <thead><tr><th scope="col">If we assume</th><th scope="col" className="n">Closure risk without a grant</th><th scope="col" className="n">Grant cuts the risk by</th>
                <th scope="col" className="n">Businesses shielded</th><th scope="col" className="n">Cost per business</th></tr></thead>
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
          </div>
          {scenarios.flip_condition && <p className="sub">{scenarios.flip_condition}</p>}
          <label className="whatif">
            <span>If we fund {subject.name} and another business closes anyway</span>
            <select value="" onChange={async (e) => {
              if (!e.target.value) return;
              const r = await getJson(`/api/what-if?funded=${encodeURIComponent(subject.business_id)}&fails=${encodeURIComponent(e.target.value)}`).catch(() => null);
              setWhatIf(r ? r.reading : "Could not run this check. Try again.");
            }}>
              <option value="">Choose a business</option>
              {applicants.filter((a) => a.business_id !== subject.business_id && a.exposed_total > 0).map((a) => <option key={a.business_id} value={a.business_id}>{a.name}</option>)}
            </select>
          </label>
          {whatIf && <p className="flag is-warn">{whatIf}</p>}
        </>
      )}
    </section>
  );
}

function Bar({ label, value, max, base }) {
  return (
    <div className="bars-row">
      <span>{label}</span>
      <div className={`track${base ? " is-base" : ""}`}><i style={{ width: `${(100 * value) / max}%` }} /></div>
      <span className="num">{pct(value)}</span>
    </div>
  );
}

export function Neighborhood({ ctx }) {
  const { evaluation, overview, report, actions } = ctx;
  const audit = evaluation?.audit;
  const bias = (audit || overview.audit)?.structural_bias_in_the_model;
  return (
    <section className="sec" aria-labelledby="sec-neighborhood">
      <SectionHead number={5} id="neighborhood" title="Neighborhood impact" onDiscuss={actions.discuss}
        sub="Did the money go where the need is, or where the model happened to have the most links?" />
      <Narrative id="neighborhood" auto="" report={report} onSave={actions.setNarrative} onDraft={actions.draft} />
      <div className="two">
        <div>
          <h3>Need in the funded tracts</h3>
          {audit ? (
            <>
              <Bar label="Funded, poverty" value={audit.need.funded_avg_tract_poverty} max={0.5} />
              <Bar label="Corridor, poverty" value={audit.need.corridor_avg_tract_poverty} max={0.5} base />
              <Bar label="Funded, no vehicle" value={audit.need.funded_avg_no_vehicle} max={1} />
              <Bar label="Corridor, no vehicle" value={audit.need.corridor_avg_no_vehicle} max={1} base />
              <p className={`flag is-${audit.need.money_went_to_higher_need ? "good" : "warn"}`}>
                {audit.need.money_went_to_higher_need
                  ? "This selection lands in tracts with more poverty than the corridor average."
                  : "This selection lands in tracts with less poverty than the corridor average."}
              </p>
            </>
          ) : <p className="sub">Select at least one grant to audit where the money lands.</p>}
        </div>
        <div>
          <h3>A bias in the model itself</h3>
          {bias && (
            <>
              <Bar label="Food service, with a cascade" value={bias.food_service_share_of_businesses_with_a_cascade} max={0.6} />
              <Bar label="Food service, all businesses" value={bias.food_service_share_of_all_businesses} max={0.6} base />
              <p className="sub">Supply links exist only where federal tables say one local industry buys from another. Food service gets far more links than its share. A business with no modeled links is unseen by the model, not unimportant.</p>
            </>
          )}
        </div>
      </div>
      <p className="sub"><span className="tag">Public record</span> Census tract demographics. Race and ethnicity are never inputs to a recommendation.</p>
    </section>
  );
}

export function SectionNav() {
  return (
    <nav className="sec-nav" aria-label="Report sections">
      {SECTIONS.map(([id, label]) => (
        <a key={id} href={`#sec-${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{label}</a>
      ))}
    </nav>
  );
}

// Renderers for the case file and the evidence tab. Pure functions of data, no fetching.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const usd = (n) => `$${Number(n).toLocaleString("en-US")}`;
export const pct = (x) => `${(100 * x).toFixed(1)}%`;
const smallPct = (x) => (x < 0.01 ? `${(100 * x).toFixed(2)}%` : pct(x));

function bars(rows) {
  const max = Math.max(...rows.flatMap((r) => [r.here, r.corridor]));
  const out = h("div", { class: "bars" });
  for (const r of rows) {
    out.append(
      h("div", { class: "group" }, r.label),
      h("span", {}, "This tract"),
      h("div", { class: "track" }, h("i", { style: `width:${(100 * r.here) / max}%` })),
      h("span", { class: "num" }, pct(r.here)),
      h("span", {}, "Corridor"),
      h("div", { class: "track is-base" }, h("i", { style: `width:${(100 * r.corridor) / max}%` })),
      h("span", { class: "num" }, pct(r.corridor)),
    );
  }
  return out;
}

function scenarioTable(s) {
  const table = h("table", { class: "plain" },
    h("tr", {}, h("th", {}, "If we assume"), h("th", {}, "Closure risk"), h("th", {}, "Grant cuts it by"),
      h("th", {}, "Businesses shielded"), h("th", {}, "Cost each")));
  for (const [name, row] of Object.entries(s.scenarios)) {
    table.append(h("tr", {},
      h("td", {}, name[0].toUpperCase() + name.slice(1)),
      h("td", { class: "n" }, pct(row.closure_risk_without_grant)),
      h("td", { class: "n" }, pct(row.risk_cut_by_grant)),
      h("td", { class: "n" }, row.expected_businesses_shielded.toFixed(1)),
      h("td", { class: "n" }, row.cost_per_business_shielded_usd ? usd(row.cost_per_business_shielded_usd) : "n/a")));
  }
  return table;
}

function uniqueChains(chains) {
  const seen = new Set();
  return chains.filter((c) => !seen.has(c.chain) && seen.add(c.chain));
}

export function renderCase(pane, c, ctx) {
  const seed = c.seed;
  const role = seed.network_role.split(" (")[0];
  const peers = c.replaceability.same_industry_peers_in_corridor;
  const byHop = c.exposed_by_hops;
  const hopButtons = h("span", { class: "hops", role: "group", "aria-label": "Steps to follow" },
    [1, 2, 3].map((n) => h("button", {
      type: "button", class: n === c.max_hops ? "is-on" : "", onclick: () => ctx.setHops(n),
    }, n)));

  pane.replaceChildren(
    h("h2", {}, c.exposed_total
      ? `If ${seed.name} closes, ${c.exposed_total} businesses lose a supplier.`
      : `${seed.name} supplies no other business in the corridor.`),
    h("p", { class: "sub" }, `${seed.address}. ${role}. Industry code ${seed.industry_naics4}.`),
    h("div", { class: "figures" },
      h("div", {}, h("strong", {}, byHop["1_hop"] || 0), h("span", {}, "buy from it directly")),
      h("div", {}, h("strong", {}, (byHop["2_hop"] || 0) + (byHop["3_hop"] || 0)), h("span", {}, "further down the chain")),
      h("div", {}, h("strong", {}, c.exposed_not_in_applicant_queue), h("span", {}, "of them never applied"))),
    h("p", { class: "sub" }, "Steps followed in the graph", hopButtons,
      c.max_hops === 3 ? " Three steps reaches most of the corridor and says little." : ""),
  );

  if (role === "Ubiquitous Hub") {
    pane.append(h("p", { class: "flag" },
      `A reach this large is a weak signal. ${seed.name} is the only business of its kind here, so the model gives it every nearby buyer. In practice those buyers can order from outside the corridor.`));
  } else if (c.exposed_total === 0) {
    pane.append(h("p", { class: "flag" },
      "The graph cannot argue for this grant. That is a limit of the model, which sees few links for this industry, not proof the business matters less."));
  } else if (peers === 0) {
    pane.append(h("p", { class: "flag is-good" },
      "No other business in the corridor does the same work, so its buyers have no local substitute."));
  } else {
    pane.append(h("p", { class: "flag" },
      `${peers} other local businesses do the same work, so many of its buyers could switch.`));
  }
  if (c.duplicate_registrations.length) {
    pane.append(h("p", { class: "sub" },
      `Also registered as ${c.duplicate_registrations.join(", ")}. Treat them as one business.`));
  }

  if (c.strongest_chains.length) {
    pane.append(h("h3", {}, "The chains, as traversed"),
      h("ul", { class: "chains" }, uniqueChains([...c.furthest_chains.slice(0, 3), ...c.strongest_chains]).slice(0, 8).map((ch) =>
        h("li", {}, h("span", {}, ch.chain.replaceAll(" -> ", " → ")),
          h("em", {}, `${ch.hops} step${ch.hops > 1 ? "s" : ""}, ${smallPct(ch.path_strength)} of inputs`)))),
      h("p", { class: "sub" }, "Percentages are the modeled share of the last buyer's input spending that travels along the chain."));
  }

  const hood = c.neighborhood;
  pane.append(h("h3", {}, `Who the neighborhood is (census tract ${hood.census_tract})`),
    bars([
      { label: "People below the poverty line", here: hood.poverty_rate, corridor: hood.corridor_average.poverty_rate },
      { label: "Households with no vehicle", here: hood.no_vehicle_rate, corridor: hood.corridor_average.no_vehicle_rate },
    ]));

  if (ctx.scenarios) {
    pane.append(h("h3", {}, `What a ${usd(ctx.scenarios.grant_usd)} grant changes`),
      scenarioTable(ctx.scenarios),
      h("p", { class: "sub" }, ctx.scenarios.what_is_assumed),
      ctx.scenarios.flip_condition ? h("p", { class: "sub" }, ctx.scenarios.flip_condition) : null);
  }

  if (c.exposed_total && ctx.others.length) {
    const result = h("p", { class: "sub" });
    const select = h("select", {
      class: "wide", "aria-label": "Business that closes anyway",
      onchange: async (e) => { result.textContent = e.target.value ? await ctx.whatIf(e.target.value) : ""; },
    }, h("option", { value: "" }, "Choose a business"),
      ctx.others.map((o) => h("option", { value: o.business_id }, o.name)));
    pane.append(h("h3", {}, "If we fund this one and another closes anyway"), select, result);
  }

  if (c.sba_loans.length) {
    pane.append(h("h3", {}, "SBA loan record"), h("ul", { class: "chains" }, c.sba_loans.map((l) =>
      h("li", {}, h("span", {}, l.bank_name),
        h("em", {}, `${usd(l.gross_approval)}, ${l.approval_date}, ${l.charged_off ? "charged off" : "not charged off"}`)))));
  }
  pane.append(h("p", { class: "sub", style: "margin-top:18px" }, c.evidence_note));
}

export function renderClosure(pane, r) {
  const block = r.employer_block;
  pane.replaceChildren(
    h("h2", {}, `If this block's ${block.jobs.toLocaleString("en-US")} workers leave, ${r.first_order_total + r.second_order_total} businesses are exposed.`),
    h("p", { class: "sub" }, `Census block ${block.block_id}. An employer block is a block of workplaces with a real job count, not one company.`),
    h("div", { class: "figures" },
      h("div", {}, h("strong", {}, r.first_order_total), h("span", {}, "lose weekday customers")),
      h("div", {}, h("strong", {}, r.second_order_total), h("span", {}, "suppliers behind them")),
      h("div", {}, h("strong", {}, r.exposed_not_in_applicant_queue), h("span", {}, "never applied"))),
    h("p", { class: "flag" }, "The second group is nowhere near the employer. They are hurt because their buyers lose trade. No application queue would ever show them."),
    h("h3", {}, "Lose weekday customers first"),
    h("ul", { class: "chains" }, r.first_order_lose_footfall.slice(0, 8).map((s) =>
      h("li", {}, h("span", {}, s.name), h("em", {}, `${pct(s.share_of_footfall_lost)} of footfall`)))),
    h("h3", {}, "Then their suppliers"),
    h("ul", { class: "chains" }, r.second_order_suppliers.slice(0, 8).map((s) =>
      h("li", {}, h("span", {}, s.example_chain.replace("  (buyer loses footfall)", "").replaceAll(" -> ", " → ")),
        h("em", {}, `${s.buyers_losing_footfall.length}${s.buyers_losing_footfall.length === 6 ? "+" : ""} buyers hit`)))),
    h("p", { class: "sub", style: "margin-top:18px" }, r.evidence_note),
  );
}

export function renderEvidence(pane, o) {
  const k = o.health, a = o.audit, bias = a?.structural_bias_in_the_model;
  const check = (label, ok, detail) => h("tr", {}, h("td", {}, label), h("td", {}, ok ? "Passed" : "Problem"), h("td", {}, detail));
  pane.replaceChildren(
    h("h2", {}, "What this rests on"),
    h("table", { class: "plain" },
      h("tr", {}, h("th", {}, "Evidence"), h("th", {}, "Status"), h("th", {}, "Source")),
      h("tr", {}, h("td", {}, "Businesses, addresses, industries"), h("td", {}, "Real"), h("td", {}, "City of San Francisco registry")),
      h("tr", {}, h("td", {}, "Bank loans and failures"), h("td", {}, "Real"), h("td", {}, "SBA 7(a) records")),
      h("tr", {}, h("td", {}, "Neighborhood need"), h("td", {}, "Real"), h("td", {}, "Census ACS, by tract")),
      h("tr", {}, h("td", {}, "Worker counts per block"), h("td", {}, "Real"), h("td", {}, "Census LEHD")),
      h("tr", {}, h("td", {}, "Who supplies whom"), h("td", {}, "Modeled"), h("td", {}, "Federal BEA purchase rates, assigned to pairs within 1,200 m")),
      h("tr", {}, h("td", {}, "Which workers shop where"), h("td", {}, "Modeled"), h("td", {}, "Block job counts split equally across nearby businesses"))),
    h("p", { class: "sub" }, "The link types and their industry average strengths are measured by the federal government. Assigning them to specific pairs of businesses is our modeling choice."),

    h("h3", {}, "Checks run on the tables"),
    h("table", { class: "plain" },
      check("Supply links have unique keys", k.duplicate_supply_keys === 0, `${k.supply_edges} links`),
      check("Footfall links have unique keys", k.duplicate_footfall_keys === 0, `${k.footfall_edges} links`),
      check("No link points at a missing business", k.dangling_supply_edges === 0, `${k.businesses} businesses`),
      check("No business supplies itself", k.supply_self_loops === 0, ""),
      check("Every business has a census tract", k.businesses_without_a_census_tract === 0, "")),
    h("p", { class: "sub" }, k.why_it_matters),
  );
  if (bias) {
    pane.append(
      h("h3", {}, "A bias we found in our own output"),
      bars([{
        label: "Food service, as a share of",
        here: bias.food_service_share_of_businesses_with_a_cascade,
        corridor: bias.food_service_share_of_all_businesses,
      }]),
      h("p", { class: "sub" }, "Top bar: businesses that have any cascade. Bottom bar: all businesses. " + bias.reading),
      h("p", { class: a.need.money_went_to_higher_need ? "flag is-good" : "flag" },
        `The advisor's plan funds businesses in tracts averaging ${pct(a.need.funded_avg_tract_poverty)} poverty, against ${pct(a.need.corridor_avg_tract_poverty)} for the corridor. Food service is ${pct(a.industry.food_service_share_of_funded)} of the funded set and ${pct(a.industry.food_service_share_of_corridor)} of the corridor.`),
    );
  }
  pane.append(
    h("h3", {}, "What this cannot tell you"),
    h("ul", {},
      h("li", {}, `Whether the model is right about failures. ${k.sba_loans} loans matched this corridor and ${k.sba_loans_charged_off} were charged off, so there is no local ground truth.`),
      h("li", {}, "How distressed a business is. There is no revenue, rent or arrears data."),
      h("li", {}, "How many jobs are at stake. No public source lists jobs per small business."),
      h("li", {}, "Whether a buyer already orders from outside the corridor."),
      h("li", {}, "A grant changes a probability, not an outcome.")),
    h("p", { class: "sub" }, "Race and ethnicity are never inputs to a recommendation."),
  );
}

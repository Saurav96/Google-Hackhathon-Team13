import { ask, renderMarkdown } from "/web/advisor.js";
import { createMap } from "/web/map.js";
import { h, renderCase, renderClosure, renderEvidence, usd } from "/web/panels.js";

const $ = (id) => document.getElementById(id);
const state = {
  overview: null, mode: "queue", selected: null, hops: 2, cascade: null,
  funded: new Set(), reach: new Map(), busy: false,
};

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status}).`);
  }
  return response.json();
}

const map = createMap($("map"), $("tip"), { onSelect: (id) => selectBusiness(id) });

function applicant(id) {
  return state.overview.applicants.find((a) => a.business_id === id);
}

// Budget meter and map tint follow the set of funded applicants.
async function refreshFunding() {
  const budget = state.overview.fund.budget_usd;
  const protectedIds = new Set();
  let committed = 0, summed = 0;
  for (const id of state.funded) {
    if (!state.reach.has(id)) {
      const c = await getJson(`/api/cascade/${encodeURIComponent(id)}?hops=2`);
      state.reach.set(id, c.exposed.map((e) => e.id));
    }
    state.reach.get(id).forEach((x) => protectedIds.add(x));
    summed += state.reach.get(id).length;
    committed += applicant(id).requested_usd;
  }
  map.setFunded(state.funded, protectedIds);
  const overlap = summed - protectedIds.size;
  $("budget").replaceChildren(
    h("div", { class: "budget-row" },
      h("span", {}, h("strong", {}, usd(committed)), ` of ${usd(budget)} committed`),
      h("span", {}, state.funded.size
        ? `${protectedIds.size} businesses protected${overlap ? `, ${overlap} counted once` : ""}`
        : "No grants chosen yet")),
    h("div", { class: `meter${committed > budget ? " is-over" : ""}` },
      h("i", { style: `width:${Math.min(100, (100 * committed) / budget)}%` })),
  );
  renderSide();
}

function renderSide() {
  const side = $("side");
  if (state.mode === "employer") {
    side.replaceChildren(
      h("h2", {}, "Largest employer blocks"),
      h("p", { class: "side-note" }, "Pick a block to see who is exposed if its workers leave. Nobody here has applied for anything."),
      h("ul", { class: "rows" }, state.overview.employer_blocks.map((b) =>
        h("li", { class: `row${state.selected === b.block_id ? " is-selected" : ""}`, onclick: () => selectBlock(b.block_id) },
          h("span", { class: "row-name" }, `${b.jobs.toLocaleString("en-US")} workers`),
          h("span", { class: "row-ask" }, `${b.businesses_drawing_footfall} shops`),
          h("span", { class: "row-meta" }, `Block ${b.block_id}`)))),
    );
    return;
  }
  const order = new Map(state.overview.plan.plan.map((s) => [s.business_id, s.step]));
  side.replaceChildren(
    h("h2", {}, `${state.overview.applicants.length} applicants, ${usd(state.overview.fund.total_requested_usd)} requested`),
    h("p", { class: "side-note" }, "The queue is a demo scenario. The city registry has no applicant list."),
    h("div", { class: "side-actions" },
      h("button", { class: "btn", type: "button", onclick: applyPlan }, "Use the advisor's split"),
      h("button", { class: "btn is-plain", type: "button", onclick: () => { state.funded.clear(); refreshFunding(); } }, "Clear")),
    h("ul", { class: "rows" }, state.overview.applicants.map((a) => {
      const role = a.network_role.split(" (")[0];
      const checkbox = h("input", {
        type: "checkbox", checked: state.funded.has(a.business_id),
        "aria-label": `Fund ${a.name}`,
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          if (e.target.checked) state.funded.add(a.business_id); else state.funded.delete(a.business_id);
          refreshFunding();
        },
      });
      return h("li", {
        class: `row${state.selected === a.business_id ? " is-selected" : ""}${state.funded.has(a.business_id) ? " is-funded" : ""}`,
        onclick: () => selectBusiness(a.business_id),
      },
        h("span", { class: "row-name" }, a.name),
        h("span", { class: "row-ask" }, usd(a.requested_usd)),
        h("span", { class: "row-meta" }, `${role}, reaches ${a.exposed_total}`,
          order.has(a.business_id) ? h("span", { class: "pick" }, `, advisor pick ${order.get(a.business_id)}`) : null),
        h("label", { class: "row-fund", onclick: (e) => e.stopPropagation() }, checkbox, "Fund"));
    })),
  );
}

function applyPlan() {
  state.funded = new Set(state.overview.plan.plan.map((s) => s.business_id));
  refreshFunding();
}

async function selectBusiness(id, hops = 2) {
  if (state.mode !== "queue") setMode("queue", false);
  state.selected = id;
  state.hops = hops;
  renderSide();
  const pane = $("pane-case");
  try {
    const c = await getJson(`/api/cascade/${encodeURIComponent(id)}?hops=${hops}`);
    if (state.selected !== id) return;
    state.cascade = c;
    map.showCascade(id, c.exposed, c.links);
    $("stage-line").replaceChildren(
      h("b", {}, c.seed.name), c.exposed_total
        ? ` closes. ${c.exposed_total} businesses lose a supplier within ${c.max_hops} step${c.max_hops > 1 ? "s" : ""}.`
        : " closes. No other business in the corridor buys from it.");
    const mine = applicant(id);
    const plan = state.overview.plan.plan;
    const runnerUp = plan.find((s) => s.business_id !== id);
    const scenarios = mine
      ? await getJson(`/api/scenarios/${encodeURIComponent(id)}?grant_usd=${mine.requested_usd}&compare_to=${runnerUp ? encodeURIComponent(runnerUp.business_id) : ""}`)
      : null;
    if (state.selected !== id) return;
    renderCase(pane, c, {
      scenarios,
      others: state.overview.applicants.filter((a) => a.business_id !== id && a.exposed_total > 0),
      setHops: (n) => selectBusiness(id, n),
      whatIf: async (other) =>
        (await getJson(`/api/what-if?funded=${encodeURIComponent(id)}&fails=${encodeURIComponent(other)}`)).reading,
    });
    showTab("case");
  } catch (error) {
    pane.replaceChildren(h("p", { class: "error" }, error.message));
  }
}

async function selectBlock(blockId) {
  state.selected = blockId;
  renderSide();
  const pane = $("pane-case");
  pane.replaceChildren(h("p", { class: "empty" }, "Walking the graph forward to lost footfall, then back to suppliers."));
  try {
    const r = await getJson(`/api/closure/${encodeURIComponent(blockId)}`);
    if (state.selected !== blockId) return;
    map.showClosure(r.map);
    $("stage-line").replaceChildren(
      h("b", {}, `${r.employer_block.jobs.toLocaleString("en-US")} workers`),
      ` leave. ${r.first_order_total} businesses lose customers, then ${r.second_order_total} suppliers behind them.`);
    renderClosure(pane, r);
    showTab("case");
  } catch (error) {
    pane.replaceChildren(h("p", { class: "error" }, error.message));
  }
}

function setMode(mode, redraw = true) {
  state.mode = mode;
  document.querySelectorAll(".mode button").forEach((b) => b.classList.toggle("is-on", b.dataset.mode === mode));
  if (!redraw) return;
  state.selected = null;
  map.reset();
  $("stage-line").textContent = mode === "queue"
    ? "Choose a business to see what its closure would expose."
    : "Choose an employer block to see who is exposed before they know it.";
  $("pane-case").replaceChildren(h("p", { class: "empty" }, "Nothing selected yet."));
  renderSide();
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === name));
  for (const tab of ["case", "memo", "evidence"]) $(`pane-${tab}`).hidden = tab !== name;
}

// Memo tab: the agent writes, and every tool it uses is listed as it happens.
function renderMemoPane() {
  const steps = h("ul", { class: "steps", "aria-live": "polite" });
  const sheetBody = h("div", {});
  const sheet = h("article", { class: "sheet", hidden: true },
    h("dl", { class: "sheet-head" },
      h("dt", {}, "To"), h("dd", {}, "Economic development officer, Central Market relief fund"),
      h("dt", {}, "From"), h("dd", {}, "Grant advisor agent"),
      h("dt", {}, "Date"), h("dd", {}, new Date().toLocaleDateString("en-US", { dateStyle: "long" }))),
    sheetBody);
  const problem = h("p", { class: "error" });
  const input = h("input", { type: "text", placeholder: "Ask the advisor a question", "aria-label": "Question for the advisor" });

  async function run(question) {
    if (state.busy || !question.trim()) return;
    state.busy = true;
    problem.textContent = "";
    steps.replaceChildren(h("li", { class: "is-running" }, "Reading the question"));
    sheet.hidden = false;
    sheetBody.replaceChildren(h("p", { class: "sub" }, "Working. A full memo takes about 40 seconds."));
    pane.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await ask(question, {
        onStep: (label) => {
          steps.querySelectorAll(".is-running").forEach((li) => li.classList.remove("is-running"));
          steps.append(h("li", { class: "is-running" }, label));
        },
        onText: (text) => { sheetBody.innerHTML = renderMarkdown(text); },
      });
    } catch (error) {
      problem.textContent = error.message;
    } finally {
      steps.querySelectorAll(".is-running").forEach((li) => li.classList.remove("is-running"));
      pane.querySelectorAll("button").forEach((b) => { b.disabled = false; });
      state.busy = false;
    }
  }

  const selectedName = () => (state.mode === "queue" && state.cascade && state.selected === state.cascade.seed.business_id
    ? state.cascade.seed.name : null);
  const quick = [
    ["Why not fund the biggest hub?", () => "Why should I not just fund the business with the biggest cascade in my queue?"],
    ["What does the money change?", () => `What does a grant actually change for ${selectedName() || "the top pick in my queue"}? Show your assumptions.`],
    ["Who should have applied?", () => "Which businesses hold others up but are not in my queue? Should they have applied?"],
    ["Whose neighborhood does this help?", () => "Audit the recommended grants. Whose neighborhood do they help, and is the model biased?"],
    ["The big office block is leaving", () => "The largest employer block is leaving in 90 days. Who is exposed, including businesses that never applied?"],
  ];
  const pane = $("pane-memo");
  pane.replaceChildren(
    h("div", { class: "memo-actions" },
      h("button", { class: "btn", type: "button", onclick: () => run("I have the applicants in my queue and my budget. Who should I fund, and how should I split the money? Write the grant memo.") }, "Write the memo for the queue"),
      h("button", { class: "btn is-plain", type: "button", onclick: () => {
        const name = selectedName();
        run(name ? `Write the grant memo for ${name}. Say plainly if it is not a good grant.` : "Write the grant memo for the strongest applicant in my queue.");
      } }, "Write it for the selected business"),
      h("button", { class: "btn is-plain", type: "button", onclick: () => window.print() }, "Print")),
    steps, problem, sheet,
    h("form", { class: "ask", onsubmit: (e) => { e.preventDefault(); run(input.value); input.value = ""; } },
      input, h("button", { class: "btn", type: "submit" }, "Ask")),
    h("div", { class: "quick" }, quick.map(([label, make]) =>
      h("button", { type: "button", onclick: () => run(make()) }, label))),
  );
}

function renderLegend() {
  const item = (color, text) => h("li", {}, h("i", { style: `background:${color}` }), text);
  $("legend").replaceChildren(
    item("var(--closed)", "Closes"), item("var(--hop1)", "Loses a supplier directly"),
    item("var(--hop2)", "Further down the chain"), item("var(--safe)", "Protected by a chosen grant"),
    h("li", {}, h("i", { style: "background:var(--quiet);outline:2px solid var(--ink)" }), "In the queue"),
    h("li", {}, "Real coordinates. Cross streets stretched to fit."));
}

async function start() {
  $("pane-case").replaceChildren(h("p", { class: "empty" }, "Loading the corridor."));
  try {
    const [overview, network] = await Promise.all([getJson("/api/overview"), getJson("/api/network")]);
    state.overview = overview;
    map.load(network.nodes);
    $("find-list").replaceChildren(...network.nodes.map((n) => h("option", { value: n.name })));
    $("find").addEventListener("change", (e) => {
      const match = network.nodes.find((n) => n.name.toLowerCase() === e.target.value.trim().toLowerCase());
      if (match) selectBusiness(match.id);
    });
    document.querySelectorAll(".mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    renderLegend();
    renderMemoPane();
    renderEvidence($("pane-evidence"), overview);
    await refreshFunding();
    const first = overview.plan.plan[0]?.business_id || overview.applicants[0]?.business_id;
    if (first) selectBusiness(first);
  } catch (error) {
    $("pane-case").replaceChildren(
      h("p", { class: "error" }, `The corridor data did not load. ${error.message} Reload the page to try again.`));
  }
}

start();

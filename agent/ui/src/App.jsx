import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { getJson, roleOf, usd } from "./api.js";
import Chat from "./Chat.jsx";
import { CaseDetails, ClosureDetails, Evidence } from "./Details.jsx";
import Icon from "./Icons.jsx";
import Info from "./Info.jsx";
import MapView from "./MapView.jsx";

const LEGEND = [
  ["var(--closed)", "Closes"], ["var(--hop1)", "Loses a supplier"], ["var(--hop2)", "One step further"], ["var(--safe)", "Protected by a grant"],
];

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem("relief-desk-theme") || "light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("relief-desk-theme", theme);
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}

function useWide() {
  const query = "(min-width: 1000px)";
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [overview, setOverview] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [problem, setProblem] = useState("");
  const [mode, setMode] = useState("queue");
  const [tab, setTab] = useState("chat");
  const [selected, setSelected] = useState(null);
  const [cascade, setCascade] = useState(null);
  const [closure, setClosure] = useState(null);
  const [budget, setBudget] = useState(50000);
  const [plan, setPlan] = useState(null);
  const [funded, setFunded] = useState(() => new Set());
  const [reach, setReach] = useState(() => new Map());
  const [outbox, setOutbox] = useState(null);
  const latest = useRef(null);
  const cascades = useRef(new Map());
  const wide = useWide();
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    Promise.all([getJson("/api/config"), getJson("/api/overview"), getJson("/api/network")])
      .then(([cfg, ov, net]) => {
        setConfig(cfg);
        setOverview(ov);
        setNodes(net.nodes);
        setBudget(ov.fund.budget_usd);
        setPlan(ov.plan);
        // A link can open the desk on one business: /?select=<business_id>
        const linked = new URLSearchParams(location.search).get("select");
        if (linked) select(linked, { toggle: false });
        // Warm the queue's cascades in the background so a click shows its result at once.
        ov.applicants.forEach((a) => {
          getJson(`/api/cascade/${encodeURIComponent(a.business_id)}?hops=2`)
            .then((c) => cascades.current.set(`${a.business_id}:2`, c)).catch(() => {});
        });
      })
      .catch((error) => setProblem(`The corridor data did not load. ${error.message} Reload the page to try again.`));
  }, []);

  const applicants = overview?.applicants || [];
  const byId = useMemo(() => new Map(applicants.map((a) => [a.business_id, a])), [applicants]);

  const loadReach = useCallback(async (id) => {
    if (reach.has(id)) return;
    const c = await getJson(`/api/cascade/${encodeURIComponent(id)}?hops=2`);
    setReach((old) => new Map(old).set(id, c.exposed.map((e) => e.id)));
  }, [reach]);

  const select = useCallback(async (id, { hops = 2, toggle = true } = {}) => {
    if (!id || (toggle && latest.current === id && hops === 2)) {
      latest.current = null;
      setSelected(null); setCascade(null); setClosure(null);
      return;
    }
    latest.current = id;
    setSelected(id); setClosure(null); setMode("queue");
    const key = `${id}:${hops}`;
    if (cascades.current.has(key)) return setCascade(cascades.current.get(key));
    try {
      const c = await getJson(`/api/cascade/${encodeURIComponent(id)}?hops=${hops}`);
      cascades.current.set(key, c);
      if (latest.current === id) setCascade(c);
    } catch (error) {
      setProblem(error.message);
    }
  }, []);

  const selectBlock = useCallback(async (blockId, { toggle = true } = {}) => {
    if (toggle && latest.current === blockId) {
      latest.current = null;
      setSelected(null); setClosure(null);
      return;
    }
    latest.current = blockId;
    setSelected(blockId); setCascade(null); setMode("employer");
    try {
      const r = await getJson(`/api/closure/${encodeURIComponent(blockId)}`);
      if (latest.current === blockId) setClosure(r);
    } catch (error) {
      setProblem(error.message);
    }
  }, []);

  const toggleFund = useCallback((id) => {
    setFunded((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    loadReach(id);
  }, [loadReach]);

  const applyPlan = useCallback(async (amount) => {
    const p = await getJson(`/api/plan?budget_usd=${Math.max(0, Math.round(amount))}`);
    setPlan(p);
    const ids = p.plan.map((s) => s.business_id);
    await Promise.all(ids.map(loadReach));
    setFunded(new Set(ids));
  }, [loadReach]);

  // The map follows the advisor: whatever it traces or plans shows up without a click.
  const onTool = useCallback((name, args) => {
    if (name === "trace_cascade" && args.business_id) select(args.business_id, { toggle: false });
    if (name === "simulate_employer_closure" && args.block_id) selectBlock(args.block_id, { toggle: false });
    if (name === "plan_budget") applyPlan(args.budget_usd > 0 ? args.budget_usd : budget);
  }, [select, selectBlock, applyPlan, budget]);

  const askAdvisor = useCallback((question) => {
    setTab("chat");
    setOutbox({ question, at: Date.now() });
  }, []);

  const protectedIds = useMemo(() => {
    const all = new Set();
    for (const id of funded) (reach.get(id) || []).forEach((x) => all.add(x));
    return all;
  }, [funded, reach]);
  const committed = [...funded].reduce((sum, id) => sum + (byId.get(id)?.requested_usd || 0), 0);

  const view = useMemo(() => {
    // Mark the clicked business at once, before its cascade has arrived.
    if (selected && mode === "queue" && cascade?.seed.business_id !== selected) {
      return { kind: "cascade", seed: selected, exposed: [], links: [] };
    }
    if (cascade) return { kind: "cascade", seed: cascade.seed.business_id, exposed: cascade.exposed, links: cascade.links };
    if (closure?.map) return { kind: "closure", first: closure.map.first_order, second: closure.map.second_order, links: closure.map.links };
    return null;
  }, [cascade, closure, selected, mode]);

  if (problem && !overview) return <p className="fatal">{problem}</p>;
  if (!overview) return <p className="fatal">Loading the corridor.</p>;

  const planOrder = new Map((plan?.plan || []).map((s) => [s.business_id, s.step]));
  const pendingName = selected && mode === "queue" && cascade?.seed.business_id !== selected
    ? nodes.find((n) => n.id === selected)?.name : null;
  const headline = pendingName
    ? <>Tracing what depends on <b>{pendingName}</b></>
    : cascade
    ? (cascade.exposed_total
      ? <><b>{cascade.seed.name}</b> closes. {cascade.exposed_total} businesses lose a supplier.</>
      : <><b>{cascade.seed.name}</b> closes. No other business here buys from it.</>)
    : closure
      ? <><b>{closure.employer_block.jobs.toLocaleString("en-US")} workers</b> leave. {closure.first_order_total} businesses lose customers, then {closure.second_order_total} suppliers behind them.</>
      : "Click any dot to see what happens if that business closes.";

  const side = (
    <aside className="side">
      <div className="seg" role="tablist" aria-label="Situation">
        <button type="button" className={mode === "queue" ? "is-on" : ""} onClick={() => { setMode("queue"); select(null); }}>Applicants</button>
        <button type="button" className={mode === "employer" ? "is-on" : ""} onClick={() => { setMode("employer"); select(null); }}>An employer leaves</button>
      </div>
      {mode === "queue" ? (
        <>
          <label className="budget">
            <span>Relief budget
              <Info label="the budget">Change the amount to match your fund. "Use the advisor's split" then picks the grants that protect the most businesses per dollar, counting each protected business once.</Info>
            </span>
            <span className="budget-input">$<input type="number" min="0" step="1000" value={budget}
              onChange={(e) => setBudget(Number(e.target.value) || 0)} aria-label="Relief budget in dollars" /></span>
          </label>
          <div className={`meter${committed > budget ? " is-over" : ""}`}><i style={{ width: `${Math.min(100, budget ? (100 * committed) / budget : 0)}%` }} /></div>
          <p className="side-note">
            {funded.size
              ? `${usd(committed)} committed. ${protectedIds.size} businesses protected, each counted once.`
              : "Tick a business to fund it, or let the advisor split the money."}
            {committed > budget && " This is over budget."}
          </p>
          <div className="side-actions">
            <button type="button" className="btn" onClick={() => applyPlan(budget)}>Use the advisor's split</button>
            {funded.size > 0 && <button type="button" className="btn is-plain" onClick={() => setFunded(new Set())}>Clear</button>}
          </div>
          <ul className="queue">
            {applicants.map((a) => (
              <li key={a.business_id} className={`${selected === a.business_id ? "is-selected" : ""}${funded.has(a.business_id) ? " is-funded" : ""}`}>
                <button type="button" className="queue-main" onClick={() => select(a.business_id)}>
                  <span className="queue-name">{a.name}</span>
                  <span className="queue-meta">
                    {roleOf(a.network_role)}, reaches {a.exposed_total}
                    {planOrder.has(a.business_id) && <b>, advisor pick {planOrder.get(a.business_id)}</b>}
                  </span>
                </button>
                <label className="queue-fund">
                  <span>{usd(a.requested_usd)}</span>
                  <input type="checkbox" checked={funded.has(a.business_id)} onChange={() => toggleFund(a.business_id)} aria-label={`Fund ${a.name}`} />
                </label>
              </li>
            ))}
          </ul>
          <p className="side-note">
            A sample queue. The city registry lists businesses, not applicants or amounts.
            <Info label="the labels">"Reaches" is how many businesses lose a supplier within two steps if this one closes. Target Anchor: 10 to 50, the strongest case for a small grant. Ubiquitous Hub: over 80, usually the only local producer of something, so the number is inflated. Leaf Node: none.</Info>
          </p>
        </>
      ) : (
        <>
          <p className="side-note">Pick a block of workplaces. Nobody here has applied for anything yet.</p>
          <ul className="queue">
            {overview.employer_blocks.map((b) => (
              <li key={b.block_id} className={selected === b.block_id ? "is-selected" : ""}>
                <button type="button" className="queue-main" onClick={() => selectBlock(b.block_id)}>
                  <span className="queue-name">{b.jobs.toLocaleString("en-US")} workers</span>
                  <span className="queue-meta">{b.businesses_drawing_footfall} nearby businesses rely on them</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );

  const stage = (
    <section className="stage">
      <MapView apiKey={config.maps_api_key} nodes={nodes} view={view} funded={funded} protectedIds={protectedIds} theme={theme}
        onSelect={(id) => (id ? select(id) : select(null))} />
      <p className="headline" aria-live="polite">{headline}</p>
      <ul className="legend">
        {LEGEND.map(([color, label]) => <li key={label}><i style={{ background: color }} />{label}</li>)}
        <li><i className="ring" />In the queue</li>
        <li><Info label="the map">Each dot is a real registered business at its real address. Lines are modeled supply links: who likely buys from whom, based on federal industry purchase rates. Click a dot to close that business, and click it again to clear.</Info></li>
      </ul>
      {problem && <p className="map-problem">{problem}</p>}
    </section>
  );

  const selectedApplicant = cascade && byId.get(cascade.seed.business_id);
  const runnerUp = (plan?.plan || []).find((s) => s.business_id !== cascade?.seed.business_id);
  const panel = (
    <section className="panel">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "chat"} onClick={() => setTab("chat")}>Chat <small>(grant memo)</small></button>
        <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>Details</button>
        <button type="button" role="tab" aria-selected={tab === "evidence"} onClick={() => setTab("evidence")}>Evidence</button>
      </div>
      <div className="tab-body" hidden={tab !== "chat"}>
        <Chat onTool={onTool} selectedName={cascade?.seed.name} outbox={outbox} />
      </div>
      {tab === "details" && (
        <div className="tab-body is-scroll">
          {cascade ? (
            <CaseDetails c={cascade} ask={askAdvisor} grant={selectedApplicant?.requested_usd} compareTo={runnerUp?.business_id}
              others={applicants.filter((a) => a.business_id !== cascade.seed.business_id && a.exposed_total > 0)}
              setHops={(n) => select(cascade.seed.business_id, { hops: n, toggle: false })} />
          ) : closure ? <ClosureDetails r={closure} ask={askAdvisor} />
            : <p className="empty">Click a business on the map or in the list to see its case.</p>}
        </div>
      )}
      {tab === "evidence" && <div className="tab-body is-scroll"><Evidence overview={overview} /></div>}
    </section>
  );

  return (
    <div className="app">
      <header className="bar">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M8 22L16 9l8 13" stroke="#ffb23e" strokeWidth="2" fill="none" /><circle cx="16" cy="9" r="4" fill="#ff5d73" /><circle cx="8" cy="22" r="3.4" fill="#ffb23e" /><circle cx="24" cy="22" r="3.4" fill="#3ddbb4" /></svg>
        <h1>Central Market relief desk</h1>
        <p>See what each grant protects before you spend it</p>
        <div className="bar-tools">
          <button type="button" onClick={toggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} />{theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>
      {wide ? (
        <PanelGroup direction="horizontal" autoSaveId="relief-desk" className="desk">
          <Panel defaultSize={20} minSize={14}>{side}</Panel>
          <PanelResizeHandle className="grip" aria-label="Resize the list" />
          <Panel defaultSize={46} minSize={25}>{stage}</Panel>
          <PanelResizeHandle className="grip" aria-label="Resize the chat" />
          <Panel defaultSize={34} minSize={22}>{panel}</Panel>
        </PanelGroup>
      ) : (
        <div className="desk is-stacked">{stage}{panel}{side}</div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { getJson, usd } from "./api.js";
import Chat from "./Chat.jsx";
import { Evidence } from "./Details.jsx";
import Icon from "./Icons.jsx";
import ImpactMap from "./ImpactMap.jsx";
import { Alternatives, EvidenceSection, Neighborhood, Recommendation, Scenarios, SectionNav } from "./Report.jsx";
import { fingerprint, SECTIONS, useReport } from "./useReport.js";

const SECTION_NAMES = Object.fromEntries(SECTIONS);

function useMedia(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem("relief-desk-theme") || "light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("relief-desk-theme", theme);
  }, [theme]);
  return [theme, () => setTheme(theme === "dark" ? "light" : "dark")];
}

async function download(response, fallbackName) {
  const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || fallbackName;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await response.blob());
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

export default function App() {
  const [boot, setBoot] = useState(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    Promise.all([getJson("/api/config"), getJson("/api/overview"), getJson("/api/network")])
      .then(([config, overview, network]) => setBoot({ config, overview, network }))
      .catch((error) => setProblem(`The corridor data did not load. ${error.message} Reload the page to try again.`));
  }, []);

  if (problem) return <p className="fatal">{problem}</p>;
  if (!boot) return <p className="fatal">Loading the corridor.</p>;
  return <Desk {...boot} />;
}

function Desk({ config, overview, network }) {
  const applicants = overview.applicants;
  const knownIds = useMemo(() => new Set(applicants.map((a) => a.business_id)), [applicants]);
  const draftSelection = useMemo(() => overview.plan.plan.map((s) => s.business_id), [overview]);
  const { report, setBudget, toggle, setSelection, setNarrative, setNotes, restore, startOver } = useReport(overview.fund.budget_usd, knownIds, draftSelection);
  const [theme, toggleTheme] = useTheme();
  const wide = useMedia("(min-width: 1000px)");

  const [mode, setModeState] = useState("queue");
  const [selected, setSelected] = useState(null);
  const [cascade, setCascade] = useState(null);
  const [closure, setClosure] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [plan, setPlan] = useState(overview.plan);
  const [reach, setReach] = useState(() => new Map());
  const [proposals, setProposals] = useState(() => {
    try { return JSON.parse(localStorage.getItem("relief-desk-proposals") || "[]"); } catch { return []; }
  });
  const [analysis, setAnalysis] = useState("analyzing");
  const [retry, setRetry] = useState(0);
  const [scope, setScope] = useState(null);
  const [outbox, setOutbox] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [menu, setMenu] = useState(null);
  const [toast, setToast] = useState("");
  const [advisorOpen, setAdvisorOpen] = useState(() => matchMedia("(min-width: 1000px)").matches);
  const latest = useRef(null);
  const cascades = useRef(new Map());
  const reportRef = useRef(report);
  reportRef.current = report;

  const edgeIntensity = useMemo(() => new Map(network.edges.map((e) => [`${e.source}>${e.target}`, e.intensity])), [network]);

  // Totals, reach and the audit always describe the selection and budget on screen.
  const inputs = fingerprint(report);
  useEffect(() => {
    let live = true;
    const ids = report.selection.map(encodeURIComponent).join(",");
    setAnalysis("analyzing");
    // A failed recalculation must never leave old numbers on screen looking current.
    Promise.all([getJson(`/api/evaluate?ids=${ids}&budget_usd=${report.budget}`), getJson(`/api/plan?budget_usd=${report.budget}`)])
      .then(([e, p]) => { if (live) { setEvaluation(e); setPlan(p); setAnalysis("ok"); } })
      .catch(() => { if (live) { setEvaluation(null); setAnalysis("error"); } });
    return () => { live = false; };
  }, [inputs, retry]);

  useEffect(() => {
    try { localStorage.setItem("relief-desk-proposals", JSON.stringify(proposals)); } catch { /* storage full or blocked */ }
  }, [proposals]);

  const loadCascade = useCallback(async (id, hops = 2) => {
    const key = `${id}:${hops}`;
    if (!cascades.current.has(key)) cascades.current.set(key, await getJson(`/api/cascade/${encodeURIComponent(id)}?hops=${hops}`));
    return cascades.current.get(key);
  }, []);

  useEffect(() => {
    applicants.forEach((a) => loadCascade(a.business_id).catch(() => {}));
    const linked = new URLSearchParams(location.search).get("select");
    if (linked) select(linked, { toggle: false });
  }, []);

  // Which businesses each selected or proposed grant reaches, for tinting the map.
  const previewIds = useMemo(() => proposals.filter((p) => p.kind === "allocation").flatMap((p) => p.plan.plan.map((s) => s.business_id)), [proposals]);
  useEffect(() => {
    let live = true;
    [...report.selection, ...previewIds].filter((id) => !reach.has(id)).forEach((id) => {
      loadCascade(id).then((c) => { if (live) setReach((old) => new Map(old).set(id, c.exposed.map((e) => e.id))); }).catch(() => {});
    });
    return () => { live = false; };
  }, [inputs, previewIds]);

  const select = useCallback(async (id, { hops = 2, toggle: canToggle = true } = {}) => {
    if (!id || (canToggle && latest.current === id && hops === 2)) {
      latest.current = null;
      setSelected(null); setCascade(null); setClosure(null);
      return;
    }
    latest.current = id;
    setSelected(id); setClosure(null); setModeState("queue");
    try {
      const c = await loadCascade(id, hops);
      if (latest.current === id) setCascade(c);
    } catch (error) {
      setToast(error.message);
    }
  }, [loadCascade]);

  const selectBlock = useCallback(async (blockId, { toggle: canToggle = true } = {}) => {
    if (canToggle && latest.current === blockId) {
      latest.current = null;
      setSelected(null); setClosure(null);
      return;
    }
    latest.current = blockId;
    setSelected(blockId); setCascade(null); setModeState("employer");
    try {
      const r = await getJson(`/api/closure/${encodeURIComponent(blockId)}`);
      if (latest.current === blockId) setClosure(r);
    } catch (error) {
      setToast(error.message);
    }
  }, []);

  const setMode = useCallback((next) => {
    setModeState(next);
    latest.current = null;
    setSelected(null); setCascade(null); setClosure(null);
  }, []);

  // Applicants with their requested amounts, so cards can show a grant only for a real applicant.
  const asks = useMemo(() => new Map(applicants.map((a) => [a.business_id, a.requested_usd])), [applicants]);

  const askAdvisor = useCallback((question, sectionId) => {
    if (sectionId) setScope(sectionId);
    setAdvisorOpen(true);
    setOutbox({ question, at: Date.now() });
  }, []);

  const actions = useMemo(() => ({
    setBudget, toggle, setNarrative,
    setSelection: (ids, summary) => setSelection(ids, summary),
    discuss: (sectionId) => { setScope(sectionId); setAdvisorOpen(true); setTimeout(() => document.querySelector(".composer textarea")?.focus(), 50); },
    draft: (sectionId) => askAdvisor(
      `Write the text for the "${SECTION_NAMES[sectionId]}" section of my report, based on the current budget and selected grants. Two to four sentences a committee can follow. Propose it as a report edit.`, sectionId),
    useAdvisorSplit: async () => {
      const p = await getJson(`/api/plan?budget_usd=${reportRef.current.budget}`).catch(() => null);
      if (!p) return setToast("Could not compute the split. Try again.");
      setSelection(p.plan.map((s) => s.business_id), `Advisor's split applied: ${p.plan.length} grants, ${usd(p.plan_total_usd)}`);
    },
    applyProposal: (p) => {
      if (p.baseRevision !== reportRef.current.revision) return;
      if (p.kind === "text") setNarrative(p.section, p.after, "advisor");
      else setSelection(p.plan.plan.map((s) => s.business_id), `Advisor proposal applied: ${p.plan.plan.length} grants, ${usd(p.plan.plan_total_usd)}`, p.plan.budget_usd);
      setProposals((all) => all.filter((x) => x.id !== p.id));
      setToast("Applied. This is a new revision of the report.");
    },
    dismissProposal: (id) => setProposals((all) => all.filter((x) => x.id !== id)),
  }), [setBudget, toggle, setNarrative, setSelection, askAdvisor]);

  // Tool calls only move the map. Finished tool results become proposals the officer reviews.
  const onTool = useCallback((name, args) => {
    if (name === "trace_cascade" && args.business_id) select(args.business_id, { toggle: false });
    if (name === "simulate_employer_closure" && args.block_id) selectBlock(args.block_id, { toggle: false });
  }, [select, selectBlock]);

  const onToolResult = useCallback((name, args, result) => {
    const baseRevision = reportRef.current.revision;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    if (name === "plan_budget" && Array.isArray(result?.plan) && result.plan.length) {
      const same = result.plan.length === reportRef.current.selection.length
        && result.plan.every((s) => reportRef.current.selection.includes(s.business_id)) && result.budget_usd === reportRef.current.budget;
      if (same) return;
      setProposals((all) => [...all.filter((p) => p.kind !== "allocation"), {
        id, kind: "allocation", baseRevision, plan: result,
        summary: `Fund ${result.plan.length} grants for ${usd(result.plan_total_usd)} of a ${usd(result.budget_usd)} budget`,
      }]);
    }
    if (name === "propose_report_edit" && result?.status === "proposed" && SECTION_NAMES[result.section_id]) {
      setProposals((all) => [...all.filter((p) => !(p.kind === "text" && p.section === result.section_id)), {
        id, kind: "text", baseRevision, section: result.section_id, after: result.new_text,
        before: reportRef.current.narrative[result.section_id]?.text || "",
        summary: result.summary || `New text for ${SECTION_NAMES[result.section_id]}`,
      }]);
      document.getElementById("sec-recommendation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  // What the advisor is told about the report with every question.
  const context = useMemo(() => {
    const names = report.selection.map((id) => applicants.find((a) => a.business_id === id)?.name).filter(Boolean);
    const lines = [
      `Report revision ${report.revision}. Budget $${report.budget}. Use budget_usd=${report.budget} when you call plan_budget.`,
      `Grants selected in the report: ${names.length ? names.join(", ") : "none"}.`,
    ];
    if (cascade) lines.push(`Business open on the map: ${cascade.seed.name} (business_id ${cascade.seed.business_id}).`);
    if (closure) lines.push(`Employer block open on the map: ${closure.employer_block.block_id} with ${closure.employer_block.jobs} workers.`);
    if (scope) {
      lines.push(`The officer is discussing the "${SECTION_NAMES[scope]}" section (section_id "${scope}").`);
      const text = report.narrative[scope]?.text;
      if (text) lines.push(`Current text of that section: "${text}"`);
    }
    return lines.join(" ");
  }, [report, cascade, closure, scope, applicants]);

  const funded = useMemo(() => new Set(report.selection), [report.selection]);
  const protectedIds = useMemo(() => {
    const all = new Set();
    for (const id of funded) (reach.get(id) || []).forEach((x) => all.add(x));
    return all;
  }, [funded, reach]);
  const proposedIds = useMemo(() => new Set(previewIds.filter((id) => !funded.has(id))), [previewIds, funded]);

  const needsUpdate = Object.values(report.narrative).some((n) => n.basis !== inputs);
  const status = analysis === "error" ? ["error", "Error"] : analysis === "analyzing" ? ["analyzing", "Analyzing"]
    : proposals.length ? ["review", "Review changes"] : needsUpdate ? ["stale", "Needs update"]
    : report.revision === 1 ? ["draft", "Draft"] : ["current", "Current"];
  async function exportReport(format) {
    setMenu(null);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format,
          snapshot: {
            revision: report.revision, budget_usd: report.budget, selection_ids: report.selection,
            narrative: report.narrative.recommendation?.text || "", notes_markdown: report.notes,
            subject_id: cascade?.seed.business_id || "", employer_block_id: closure?.employer_block.block_id || "",
            scope: closure ? "employer_closure" : "allocation", needs_update: needsUpdate,
          },
        }),
      });
      if (!response.ok) throw new Error();
      await download(response, `grant-memo.${format}`);
      setToast(`Exported revision ${report.revision}${needsUpdate ? " as a draft" : ""}`);
    } catch {
      setToast("Could not export the report. Try again.");
    }
  }

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { setDrawer(null); setMenu(null); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // A click anywhere outside an open menu closes it.
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (!e.target.closest(".bar-tools")) setMenu(null); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const ctx = { overview, report, evaluation, plan, mode, setMode, actions, proposals, selected, cascade, closure, select, selectBlock, analysis };
  const workspace = (
    <main className="report" id="report">
      <div className="report-inner">
        <header className="report-head">
          <h1>Relief funding recommendation
            <span className={`state is-${status[0]}`} title="Current means the text and numbers match the inputs. It does not mean approved or funded.">{status[1]}</span></h1>
          {analysis === "error" && (
            <p className="flag is-warn">The numbers could not be recalculated, so none are shown. Your edits are kept.
              {" "}<button type="button" className="link" onClick={() => setRetry(retry + 1)}>Try again</button></p>
          )}
          <SectionNav />
        </header>
        <Recommendation ctx={ctx} />
        <ImpactMap ctx={ctx} config={config} nodes={network.nodes} theme={theme} funded={funded} protectedIds={protectedIds}
          proposedIds={proposedIds} edgeIntensity={edgeIntensity} askAdvisor={askAdvisor} asks={asks} narrow={!wide} />
        {mode === "queue" && <Alternatives ctx={ctx} />}
        {mode === "queue" && <Scenarios ctx={ctx} />}
        {mode === "queue" && <Neighborhood ctx={ctx} />}
        <EvidenceSection number={mode === "queue" ? 6 : 3} onOpen={() => setDrawer("sources")} discuss={actions.discuss} />
      </div>
    </main>
  );

  const advisor = (
    <section className="advisor" aria-label="Advisor">
      <Chat onTool={onTool} onToolResult={onToolResult} selectedName={cascade?.seed.name} outbox={outbox} context={context}
        scopeName={scope ? SECTION_NAMES[scope] : null} onClearScope={() => setScope(null)} onHide={() => setAdvisorOpen(false)}
        onAddToReport={(text) => { setNotes(text); setToast("Added to the report as the advisor memo"); }} />
    </section>
  );

  return (
    <div className="app">
      <header className="bar">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M8 22L16 9l8 13" stroke="var(--act)" strokeWidth="2" fill="none" /><circle cx="16" cy="9" r="4" fill="var(--act)" /><circle cx="8" cy="22" r="3.4" fill="var(--safe)" /><circle cx="24" cy="22" r="3.4" fill="var(--safe)" /></svg>
        <h1>Central Market relief desk</h1>
        <div className="bar-tools">
          <button type="button" className="is-link" onClick={() => setDrawer("sources")}><Icon name="info" />Sources and methodology</button>
          <button type="button" onClick={() => setMenu(menu === "history" ? null : "history")} aria-expanded={menu === "history"}><Icon name="history" />Revisions ({report.revision})</button>
          <button type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Light mode" : "Dark mode"}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
          <button type="button" onClick={() => setAdvisorOpen(!advisorOpen)} aria-pressed={advisorOpen}><Icon name="chat" />{advisorOpen ? "Hide advisor" : "Advisor"}</button>
          <button type="button" className="is-primary" onClick={() => setMenu(menu === "export" ? null : "export")} aria-expanded={menu === "export"}><Icon name="download" />Export</button>
          {menu === "export" && (
            <div className="menu" role="menu">
              <button type="button" role="menuitem" onClick={() => exportReport("pdf")}><Icon name="print" />PDF report</button>
              <button type="button" role="menuitem" onClick={() => exportReport("md")}><Icon name="edit" />Markdown</button>
              {needsUpdate && (
                <p className="menu-warn">Some text was written before the last change. Update it first, or it is exported as a draft.
                  {" "}<button type="button" className="link" onClick={() => { setMenu(null); document.querySelector(".state.is-stale")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>Show me</button></p>
              )}
              <p>Exports revision {report.revision}{needsUpdate ? ", marked as a draft" : ""}</p>
            </div>
          )}
          {menu === "history" && (
            <div className="menu is-wide" role="menu">
              <ul>{[...report.history].reverse().map((h) => (
                <li key={h.revision}>
                  <span><strong>Revision {h.revision}</strong> {h.summary}</span>
                  {h.revision !== report.revision && <button type="button" onClick={() => { restore(h.revision); setMenu(null); setToast(`Restored revision ${h.revision} as a new revision`); }}>Restore</button>}
                </li>
              ))}</ul>
              <p>Saved on this device only.</p>
              <button type="button" className="menu-foot" onClick={() => { startOver(); setProposals([]); setMenu(null); }}>Start a new report</button>
            </div>
          )}
        </div>
      </header>

      {wide ? (
        <PanelGroup direction="horizontal" autoSaveId="relief-desk-v3" className="desk">
          <Panel minSize={45} order={1} id="report">{workspace}</Panel>
          {advisorOpen && <PanelResizeHandle className="grip" aria-label="Resize the advisor" />}
          {advisorOpen && <Panel defaultSize={29} minSize={22} maxSize={45} order={2} id="advisor">{advisor}</Panel>}
        </PanelGroup>
      ) : (
        // On small screens the report is the page and the advisor slides over it.
        <div className="desk is-stacked">
          {workspace}
          {advisorOpen && <div className="advisor-drawer">{advisor}</div>}
        </div>
      )}

      {drawer === "sources" && (
        <div className="drawer-back" onClick={() => setDrawer(null)}>
          <aside className="drawer" role="dialog" aria-label="Sources and methodology" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="drawer-close" onClick={() => setDrawer(null)} aria-label="Close"><Icon name="close" /></button>
            <Evidence overview={overview} />
          </aside>
        </div>
      )}
      {toast && <p className="toast is-global" role="status">{toast}</p>}
    </div>
  );
}

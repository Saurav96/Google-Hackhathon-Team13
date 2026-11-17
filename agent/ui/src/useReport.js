// The one report document. Everything on the right side of the screen is drawn from it.

import { useCallback, useEffect, useState } from "react";

const KEY = "relief-desk-report-v1";
const MAX_HISTORY = 25;

export const SECTIONS = [
  ["recommendation", "Recommendation"],
  ["impact", "Impact"],
  ["alternatives", "Alternatives"],
  ["scenarios", "Scenarios"],
  ["neighborhood", "Neighborhood"],
];

// A new report opens on the computed split, so there is something real to explore at once.
const fresh = (budget, selection = []) => ({
  revision: 1,
  budget,
  selection,
  // Per section: officer or advisor text, and the inputs it was written against.
  narrative: {},
  notes: "",
  history: [{ revision: 1, summary: "Draft created from the computed split", at: Date.now(), budget, selection, narrative: {}, notes: "" }],
});

export const fingerprint = (report) => `${report.budget}|${[...report.selection].sort().join(",")}`;

function load(defaultBudget, draftSelection) {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Number.isInteger(saved.revision) && Array.isArray(saved.selection)) return saved;
  } catch { /* fall through to a new report */ }
  return fresh(defaultBudget, draftSelection);
}

export function useReport(defaultBudget, knownIds, draftSelection) {
  const [report, setReport] = useState(() => load(defaultBudget, draftSelection));

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(report)); } catch { /* storage full or blocked */ }
  }, [report]);

  // Every committed change is a new revision with a line in the history.
  const commit = useCallback((summary, change) => {
    setReport((current) => {
      const next = { ...current, ...change(current) };
      next.selection = next.selection.filter((id) => !knownIds || knownIds.has(id));
      next.revision = current.revision + 1;
      const entry = {
        revision: next.revision, summary, at: Date.now(),
        budget: next.budget, selection: next.selection, narrative: next.narrative, notes: next.notes,
      };
      next.history = [...current.history, entry].slice(-MAX_HISTORY);
      return next;
    });
  }, [knownIds]);

  const setBudget = useCallback((budget) => {
    const clean = Math.max(0, Math.round(Number(budget) || 0));
    commit(`Budget set to $${clean.toLocaleString("en-US")}`, () => ({ budget: clean }));
  }, [commit]);

  const toggle = useCallback((id, name) => {
    commit(`Selection changed: ${name}`, (r) => ({
      selection: r.selection.includes(id) ? r.selection.filter((x) => x !== id) : [...r.selection, id],
    }));
  }, [commit]);

  const setSelection = useCallback((ids, summary, budget) => {
    commit(summary, (r) => ({ selection: ids, budget: budget ?? r.budget }));
  }, [commit]);

  const setNarrative = useCallback((section, text, author) => {
    commit(`${author === "advisor" ? "Advisor edit applied" : "Text edited"}: ${section}`, (r) => {
      const narrative = { ...r.narrative };
      if (text.trim()) narrative[section] = { text: text.trim(), author, basis: fingerprint(r) };
      else delete narrative[section];
      return { narrative };
    });
  }, [commit]);

  const setNotes = useCallback((notes) => commit("Advisor memo added to the report", () => ({ notes })), [commit]);

  // Restoring an old revision makes a new one, so nothing is ever lost.
  const restore = useCallback((revision) => {
    commit(`Restored revision ${revision}`, (r) => {
      const old = r.history.find((h) => h.revision === revision);
      return old ? { budget: old.budget, selection: old.selection, narrative: old.narrative, notes: old.notes } : {};
    });
  }, [commit]);

  const startOver = useCallback(() => setReport(fresh(defaultBudget, draftSelection)), [defaultBudget, draftSelection]);

  return { report, setBudget, toggle, setSelection, setNarrative, setNotes, restore, startOver };
}

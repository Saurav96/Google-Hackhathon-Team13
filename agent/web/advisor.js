// Talks to the ADK agent over its streaming endpoint and reports each tool it uses.

const APP = "microgrants";
const USER = "officer";
const SESSION = `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const TOOL_LABELS = {
  find_business: "Looked up the business",
  get_applicant_queue: "Read the applicant queue and budget",
  compare_applicants: "Walked the graph for every applicant",
  trace_cascade: "Traced the cascade, two steps out",
  trace_dependencies: "Traced what the business depends on",
  plan_budget: "Split the budget without double counting",
  grant_impact_scenarios: "Worked out what the grant changes",
  what_if_fails_anyway: "Checked the case where another business closes anyway",
  screen_corridor: "Screened the corridor for businesses that never applied",
  list_employer_blocks: "Listed the largest employer blocks",
  simulate_employer_closure: "Walked forward to lost footfall, then back to suppliers",
  equity_audit: "Audited where the money lands",
  data_health_check: "Validated the tables behind the graph",
  execute_sql_readonly: "Queried BigQuery through the managed MCP server",
};

export function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

// Calls onStep(label) for each tool call and onText(fullText) as the answer grows.
export async function ask(question, { onStep, onText }) {
  const response = await fetch("/run_sse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_name: APP,
      user_id: USER,
      session_id: SESSION,
      streaming: true,
      new_message: { role: "user", parts: [{ text: question }] },
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`The advisor did not answer (status ${response.status}). Try again.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seenCalls = new Set();
  let buffer = "", settled = "", draft = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(5)); } catch { continue; }
      if (event.error || event.errorMessage) {
        throw new Error(event.errorMessage || event.error || "The advisor hit an error.");
      }
      for (const part of event.content?.parts || []) {
        if (part.functionCall && !seenCalls.has(part.functionCall.id)) {
          seenCalls.add(part.functionCall.id);
          onStep(toolLabel(part.functionCall.name));
        } else if (typeof part.text === "string" && !part.thought && event.content.role === "model") {
          if (event.partial) {
            draft += part.text;
          } else {
            settled += part.text;
            draft = "";
          }
          onText(settled + draft);
        }
      }
    }
  }
  if (!settled && !draft) throw new Error("The advisor returned an empty answer. Try again.");
  return settled || draft;
}

export function renderMarkdown(text) {
  const html = window.marked ? window.marked.parse(text) : text.replace(/</g, "&lt;");
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html.replace(/<script/gi, "&lt;script");
}

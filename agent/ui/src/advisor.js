// Talks to the ADK agent over its streaming endpoint and reports each tool it uses.

const APP = "microgrants";

export const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// One id per browser, so each visitor only ever sees their own chats.
export function userId() {
  let id = localStorage.getItem("relief-desk-user");
  if (!id) {
    id = newId("officer");
    localStorage.setItem("relief-desk-user", id);
  }
  return id;
}

export function forgetSession(sessionId) {
  return fetch(`/apps/${APP}/users/${userId()}/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
}

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

function describeArgs(args = {}) {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? `${value.length} items` : String(value).replace(/\s+/g, " ")}`)
    .join(", ");
  return text.length > 150 ? `${text.slice(0, 148)}…` : text;
}

// The advisor ends each answer with suggested next questions inside a follow_ups block.
export function splitFollowUps(text) {
  const start = text.indexOf("<follow_ups>");
  // While streaming, a half-written tag would flash on screen, so trim it.
  if (start === -1) return { body: text.replace(/<\/?f[a-z_]*$/, "").trimEnd(), followUps: [] };
  const inner = text.slice(start + 12).split("</follow_ups>")[0];
  const followUps = inner.split("\n").map((q) => q.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean).slice(0, 3);
  return { body: text.slice(0, start).trimEnd(), followUps };
}

export function fileToPart(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () =>
      resolve({ inlineData: { mimeType: file.type || "text/plain", data: String(reader.result).split(",")[1] } });
    reader.readAsDataURL(file);
  });
}

// Keeps a copy of an attached document in Cloud Storage so the chat can link to it later.
export async function saveFile(file) {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch("/api/upload", { method: "POST", body: form });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Could not save ${file.name}.`);
  }
  return response.json();
}

// onStep(label) per tool call, onTool(name, args) so the map can follow, onText(text) as the answer grows.
export async function ask(question, { sessionId, files = [], signal, onStep, onStepDone, onTool, onText }) {
  const parts = [...(await Promise.all(files.map(fileToPart))), { text: question }];
  const response = await fetch("/run_sse", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_name: APP, user_id: userId(), session_id: sessionId, streaming: true,
      new_message: { role: "user", parts },
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
        if (part.functionCall) {
          if (seenCalls.has(part.functionCall.id)) continue;
          seenCalls.add(part.functionCall.id);
          onStep?.({
            id: part.functionCall.id,
            label: TOOL_LABELS[part.functionCall.name] || part.functionCall.name,
            tool: part.functionCall.name,
            args: describeArgs(part.functionCall.args),
          });
          onTool?.(part.functionCall.name, part.functionCall.args || {});
        } else if (part.functionResponse) {
          onStepDone?.(part.functionResponse.id);
        } else if (typeof part.text === "string" && !part.thought && event.content.role === "model") {
          if (event.partial) draft += part.text;
          else { settled += part.text; draft = ""; }
          onText?.(settled + draft);
        }
      }
    }
  }
  if (!settled && !draft) throw new Error("The advisor returned an empty answer. Try again.");
  return settled || draft;
}

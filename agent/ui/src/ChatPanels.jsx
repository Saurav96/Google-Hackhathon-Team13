import { useState } from "react";

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function History({ chats, activeId, onOpen, onRename, onRemove, onClose }) {
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  return (
    <div className="sheet-over" role="dialog" aria-label="Past chats">
      <div className="sheet-head"><strong>Your chats</strong><button type="button" onClick={onClose}>Close</button></div>
      <ul className="history">
        {[...chats].sort((a, b) => b.updatedAt - a.updatedAt).map((chat) => (
          <li key={chat.id} className={chat.id === activeId ? "is-on" : ""}>
            {editing === chat.id ? (
              <form onSubmit={(e) => { e.preventDefault(); onRename(chat.id, e.target.elements.title.value); setEditing(null); }}>
                <input name="title" defaultValue={chat.title} autoFocus aria-label="Chat name" onBlur={() => setEditing(null)} />
              </form>
            ) : (
              <button type="button" className="history-open" onClick={() => { onOpen(chat.id); onClose(); }}>
                <span>{chat.title}</span>
                <small>{chat.messages.length ? `${Math.ceil(chat.messages.length / 2)} question${chat.messages.length > 2 ? "s" : ""}` : "Empty"}</small>
              </button>
            )}
            {confirming === chat.id ? (
              <>
                <button type="button" className="history-act is-danger" onClick={() => { onRemove(chat.id); setConfirming(null); }}>Delete it</button>
                <button type="button" className="history-act" onClick={() => setConfirming(null)}>Keep</button>
              </>
            ) : (
              <>
                <button type="button" className="history-act" onClick={() => setEditing(chat.id)}>Rename</button>
                <button type="button" className="history-act" onClick={() => setConfirming(chat.id)}>Delete</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="sub">Chats are saved in this browser. Each one keeps its own context with the advisor.</p>
    </div>
  );
}

// The technical record of a chat: every tool the advisor called, with inputs and timings.
export function Activity({ messages, onClose }) {
  const answers = messages.filter((m) => m.role === "agent");
  return (
    <div className="sheet-over" role="dialog" aria-label="How each answer was produced">
      <div className="sheet-head"><strong>Activity in this chat</strong><button type="button" onClick={onClose}>Close</button></div>
      {answers.length === 0 && <p className="sub">Nothing yet. Ask a question, then come back to see which tools ran and how long each took.</p>}
      {answers.map((m, index) => {
        const steps = m.steps.map((s) => (typeof s === "string" ? { label: s } : s));
        const inTools = steps.reduce((sum, s) => sum + (s.ms || 0), 0);
        return (
          <section className="activity" key={m.id}>
            <h3>{index + 1}. {m.question || "Question"}</h3>
            <p className="sub">
              {m.status === "running" ? "Still working" : m.ms ? `${seconds(m.ms)} in total` : "No timing recorded"}
              {inTools > 0 && m.ms ? `, ${seconds(inTools)} in tools and ${seconds(Math.max(0, m.ms - inTools))} in the model` : ""}
              {m.status === "failed" ? ". Failed." : m.status === "stopped" ? ". Stopped by you." : ""}
            </p>
            {steps.length === 0 ? <p className="sub">Answered without calling a tool.</p> : (
              <ol>
                {steps.map((s, i) => (
                  <li key={i}>
                    <div><strong>{s.label}</strong>{s.ms != null && <em>{seconds(s.ms)}</em>}</div>
                    {s.tool && <code>{s.tool}({s.args})</code>}
                    {s.tool === "execute_sql_readonly" && <small>Google's managed BigQuery MCP server</small>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
      <p className="sub">Model: Gemini on Vertex AI. Graph tools run GQL traversals in BigQuery.</p>
    </div>
  );
}

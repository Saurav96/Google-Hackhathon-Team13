import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { ask, saveFile, splitFollowUps } from "./advisor.js";
import { useChats } from "./sessions.js";
import { canListen, canSpeak, listen, speak, stopSpeaking } from "./voice.js";

const STARTERS = [
  ["Who should I fund?", "I have the applicants in my queue and my budget. Who should I fund, and how should I split the money? Write the grant memo."],
  ["Why not the biggest one?", "Look at my queue. Which applicant has the biggest cascade, and why should I not just fund that one?"],
  ["A big employer is leaving", "The largest employer block is leaving in 90 days. Who is exposed, including businesses that never applied?"],
  ["Is this fair?", "Audit the recommended grants. Whose neighborhood do they help, and is the model biased?"],
];
const ACCEPT = "image/*,application/pdf,text/plain,text/csv,.md";
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function printMemo(html) {
  const frame = window.open("", "_blank", "width=820,height=900");
  if (!frame) return;
  frame.document.write(`<title>Grant memo</title><style>
    body{font:16px/1.6 Georgia,serif;max-width:720px;margin:40px auto;color:#111}
    table{border-collapse:collapse;font:13px sans-serif}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left}
    h1,h2,h3,h4{font-family:sans-serif}</style>
    <p style="font:13px sans-serif;border-bottom:2px solid #111;padding-bottom:8px">
    To: Economic development officer, Central Market relief fund<br>From: Grant advisor agent<br>
    Date: ${new Date().toLocaleDateString("en-US", { dateStyle: "long" })}</p>${html}`);
  frame.document.close();
  frame.print();
}

function Answer({ message, onAsk, isLast }) {
  const { body, followUps } = splitFollowUps(message.text || "");
  const html = DOMPurify.sanitize(marked.parse(body));
  const [open, setOpen] = useState(false);
  const running = message.status === "running";
  const steps = message.steps.map((s) => (typeof s === "string" ? { label: s } : s));
  return (
    <div className="msg msg-agent">
      {steps.length > 0 && (
        <div className="steps">
          <button type="button" className="steps-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
            {running ? steps[steps.length - 1].label : `Used ${steps.length} tool${steps.length > 1 ? "s" : ""}`}
            <span aria-hidden="true">{open ? " ▾" : " ▸"}</span>
          </button>
          {open && (
            <ol>
              {steps.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.tool && <code>{s.tool}({s.args})</code>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {body
        ? <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        : running && <p className="thinking">Working on it</p>}
      {message.error && <p className="error">{message.error}</p>}
      {message.status === "done" && isLast && followUps.length > 0 && (
        <div className="follow-ups">
          {followUps.map((q) => <button type="button" key={q} onClick={() => onAsk(q)}>{q}</button>)}
        </div>
      )}
      {message.status === "done" && body && (
        <div className="msg-actions">
          <button type="button" onClick={() => navigator.clipboard?.writeText(body)}>Copy</button>
          <button type="button" onClick={() => printMemo(html)}>Print as memo</button>
          {canSpeak && <button type="button" onClick={() => speak(body)}>Read aloud</button>}
        </div>
      )}
    </div>
  );
}

function History({ chats, activeId, onOpen, onRename, onRemove, onClose }) {
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  return (
    <div className="history" role="dialog" aria-label="Past chats">
      <div className="history-head"><strong>Your chats</strong><button type="button" onClick={onClose}>Close</button></div>
      <ul>
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
              <button type="button" className="history-act is-danger" onClick={() => { onRemove(chat.id); setConfirming(null); }}>Delete it</button>
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

export default function Chat({ onTool, selectedName, outbox }) {
  const { chats, active, open, start, rename, remove, update } = useChats();
  const messages = active.messages;
  const [showHistory, setShowHistory] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState("");
  const scroller = useRef(null);
  const fileInput = useRef(null);
  const stopListening = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, active.id]);

  // Questions sent from elsewhere on the screen, such as the map card.
  useEffect(() => {
    if (outbox?.question) send(outbox.question);
  }, [outbox]);

  async function send(question, spoken = false) {
    const q = question.trim();
    if (!q || busy) return;
    const attached = files;
    setBusy(true);
    setText("");
    setFiles([]);
    setNotice("");
    stopSpeaking();
    const id = Date.now();
    const chatId = active.id;
    const patch = (change) => update(chatId, (c) => ({
      messages: c.messages.map((m) => (m.id === id ? { ...m, ...change(m) } : m)),
    }));
    update(chatId, (c) => ({
      title: c.messages.length ? c.title : q.length > 44 ? `${q.slice(0, 42)}…` : q,
      messages: [
        ...c.messages,
        { id: id - 1, role: "user", text: q, files: attached.map((f) => ({ name: f.name })) },
        { id, role: "agent", text: "", steps: [], status: "running" },
      ],
    }));
    try {
      if (attached.length) {
        const saved = await Promise.all(attached.map(saveFile));
        update(chatId, (c) => ({
          messages: c.messages.map((m) => (m.id === id - 1 ? { ...m, files: saved.map((s) => ({ name: s.name, url: s.url })) } : m)),
        }));
      }
      const answer = await ask(q, {
        sessionId: chatId,
        files: attached,
        onStep: (label) => patch((m) => ({ steps: [...m.steps, label] })),
        onTool,
        onText: (t) => patch(() => ({ text: t })),
      });
      patch(() => ({ status: "done", text: answer }));
      if (spoken) speak(splitFollowUps(answer).body);
    } catch (error) {
      patch(() => ({ status: "failed", error: error.message }));
    } finally {
      setBusy(false);
    }
  }

  function addFiles(list) {
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setNotice(`${tooBig.name} is larger than 4 MB. Attach a smaller file.`);
    setFiles((current) => [...current, ...picked].slice(0, 3));
  }

  function toggleMic() {
    if (listening) return stopListening.current?.();
    setListening(true);
    stopListening.current = listen({
      onInterim: setText,
      onFinal: (said) => send(said, true),
      onEnd: () => setListening(false),
    });
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-title" title={active.title}>{active.title}</span>
        <button type="button" onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}>History ({chats.filter((c) => c.messages.length).length})</button>
        <button type="button" className="is-strong" onClick={() => { start(); setShowHistory(false); }} disabled={busy}>New chat</button>
      </div>
      {showHistory && (
        <History chats={chats} activeId={active.id} onOpen={open} onRename={rename} onRemove={remove} onClose={() => setShowHistory(false)} />
      )}
      <div className="chat-scroll" ref={scroller} aria-live="polite">
        {messages.length === 0 ? (
          <div className="welcome">
            <h2>Ask the advisor</h2>
            <p>Ask in plain words, or click any dot on the map. The advisor walks the business graph and writes a grant memo you can print.</p>
            <div className="starters">
              {STARTERS.map(([label, question]) => (
                <button type="button" key={label} onClick={() => send(question)}>{label}</button>
              ))}
            </div>
          </div>
        ) : messages.map((m) => (m.role === "user" ? (
          <div className="msg msg-user" key={m.id}>
            {m.files.map((f) => {
              const file = typeof f === "string" ? { name: f } : f;
              return file.url
                ? <a className="chip" key={file.name} href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
                : <span className="chip" key={file.name}>{file.name}</span>;
            })}
            <p>{m.text}</p>
          </div>
        ) : <Answer message={m} key={m.id} onAsk={send} isLast={m.id === messages[messages.length - 1].id && !busy} />))}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        {selectedName && messages.length > 0 && !busy && (
          <div className="suggest">
            <button type="button" onClick={() => send(`Write the grant memo for ${selectedName}. Say plainly if it is not a good grant.`)}>
              Write the memo for {selectedName}
            </button>
          </div>
        )}
        {files.length > 0 && (
          <div className="attached">
            {files.map((f, i) => (
              <span className="chip" key={f.name + i}>
                {f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
        {notice && <p className="error">{notice}</p>}
        <div className="composer-box">
          <textarea
            value={text} rows={1} disabled={busy}
            placeholder={listening ? "Listening. Speak your question." : "Ask about a business, the budget, or the whole queue"}
            aria-label="Message to the advisor"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
          />
          <div className="composer-row">
            <input ref={fileInput} type="file" hidden multiple accept={ACCEPT}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="icon-btn" title="Attach an application letter, photo or PDF"
              aria-label="Attach a file" onClick={() => fileInput.current.click()}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8L13.5 4.4a3.7 3.7 0 015.2 5.2l-8.7 8.7a1.8 1.8 0 01-2.6-2.6l8-8" /></svg>
            </button>
            {canListen && (
              <button type="button" className={`icon-btn${listening ? " is-live" : ""}`}
                title={listening ? "Stop listening" : "Ask by voice"} aria-label={listening ? "Stop listening" : "Ask by voice"}
                aria-pressed={listening} onClick={toggleMic}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>
              </button>
            )}
            <span className="composer-hint">{busy ? "The advisor is working" : "Enter to send"}</span>
            <button type="submit" className="send" disabled={busy || !text.trim()}>Send</button>
          </div>
        </div>
      </form>
    </div>
  );
}

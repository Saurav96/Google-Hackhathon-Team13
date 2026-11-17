import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { ask, saveFile, splitFollowUps } from "./advisor.js";
import { Activity, History } from "./ChatPanels.jsx";
import Icon from "./Icons.jsx";
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
const seconds = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;

function Answer({ message, isLast, speaking, onAsk, onSpeak, onRetry, onActivity, notify }) {
  const { body, followUps } = splitFollowUps(message.text || "");
  const html = DOMPurify.sanitize(marked.parse(body));
  const running = message.status === "running";
  const steps = message.steps.map((s) => (typeof s === "string" ? { label: s } : s));
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setElapsed(Date.now() - message.startedAt), 500);
    return () => clearInterval(timer);
  }, [running, message.startedAt]);

  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: body, question: message.question || "" }),
      });
      if (!response.ok) throw new Error();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = "grant-memo.pdf";
      link.click();
      URL.revokeObjectURL(link.href);
      notify("Report downloaded");
    } catch {
      notify("Could not build the report. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      notify("Copied to clipboard");
    } catch {
      notify("Could not copy. Select the text and copy it by hand.");
    }
  }

  return (
    <div className="msg msg-agent">
      {running && (
        <p className="status" aria-live="polite">
          <span className="pulse" aria-hidden="true" />
          {steps.length ? steps[steps.length - 1].label : "Reading your question"}
          {elapsed > 3000 && <small>{seconds(elapsed)}</small>}
        </p>
      )}
      {body && <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />}
      {message.status === "stopped" && <p className="sub">You stopped this answer.</p>}
      {message.error && (
        <p className="error">
          {message.error} <button type="button" className="link" onClick={onRetry}><Icon name="retry" size={13} /> Try again</button>
        </p>
      )}
      {message.status === "done" && isLast && followUps.length > 0 && (
        <div className="follow-ups">
          {followUps.map((q) => <button type="button" key={q} onClick={() => onAsk(q)}>{q}</button>)}
        </div>
      )}
      {!running && body && (
        <div className="msg-actions">
          <button type="button" onClick={copy} title="Copy" aria-label="Copy"><Icon name={copied ? "check" : "copy"} /></button>
          <button type="button" title="Download as a PDF report" aria-label="Download report" onClick={download} disabled={downloading}>
            <Icon name="download" /><span>{downloading ? "Preparing" : "Report"}</span>
          </button>
          {canSpeak && (
            <button type="button" className={speaking ? "is-on" : ""} onClick={onSpeak} aria-pressed={speaking}
              title={speaking ? "Stop reading" : "Read aloud"} aria-label={speaking ? "Stop reading" : "Read aloud"}>
              <Icon name={speaking ? "stop" : "speak"} />{speaking && <span>Stop</span>}
            </button>
          )}
          {message.ms > 0 && (
            <button type="button" className="meta" onClick={onActivity} title="See how this was answered">
              {seconds(message.ms)}{steps.length > 0 && `, ${steps.length} tool${steps.length > 1 ? "s" : ""}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function Chat({ onTool, selectedName, outbox }) {
  const { chats, active, open, start, rename, remove, update } = useChats();
  const messages = active.messages;
  const [overlay, setOverlay] = useState(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState(null);
  const [toast, setToast] = useState("");
  const scroller = useRef(null);
  const fileInput = useRef(null);
  const stopListening = useRef(null);
  const aborter = useRef(null);
  const pinned = useRef(true);

  // Follow new text only while the reader is already at the bottom.
  useEffect(() => {
    if (pinned.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);
  useEffect(() => {
    pinned.current = true;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    stopSpeaking();
    setSpeakingId(null);
  }, [active.id]);

  useEffect(() => {
    if (outbox?.question) send(outbox.question);
  }, [outbox]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setOverlay(null); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); stopSpeaking(); };
  }, []);

  function toggleSpeak(message) {
    if (speakingId === message.id) {
      stopSpeaking();
      return setSpeakingId(null);
    }
    setSpeakingId(message.id);
    speak(splitFollowUps(message.text).body, () => setSpeakingId((id) => (id === message.id ? null : id)));
  }

  async function send(question, { spoken = false, attached = files } = {}) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setText("");
    setFiles([]);
    setOverlay(null);
    stopSpeaking();
    setSpeakingId(null);
    pinned.current = true;
    const id = Date.now();
    const chatId = active.id;
    const startedAt = Date.now();
    const patch = (change) => update(chatId, (c) => ({
      messages: c.messages.map((m) => (m.id === id ? { ...m, ...change(m) } : m)),
    }));
    update(chatId, (c) => ({
      title: c.messages.length ? c.title : q.length > 44 ? `${q.slice(0, 42)}…` : q,
      messages: [
        ...c.messages,
        { id: id - 1, role: "user", text: q, files: attached.map((f) => ({ name: f.name })) },
        { id, role: "agent", question: q, text: "", steps: [], status: "running", startedAt },
      ],
    }));
    aborter.current = new AbortController();
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
        signal: aborter.current.signal,
        onStep: (step) => patch((m) => ({ steps: [...m.steps, { ...step, at: Date.now() - startedAt }] })),
        onStepDone: (callId) => patch((m) => ({
          steps: m.steps.map((s) => (s.id === callId && s.ms == null ? { ...s, ms: Date.now() - startedAt - s.at } : s)),
        })),
        onTool,
        onText: (t) => patch(() => ({ text: t })),
      });
      patch(() => ({ status: "done", text: answer, ms: Date.now() - startedAt }));
      if (spoken && canSpeak) {
        setSpeakingId(id);
        speak(splitFollowUps(answer).body, () => setSpeakingId(null));
      }
    } catch (error) {
      if (error.name === "AbortError") patch(() => ({ status: "stopped", ms: Date.now() - startedAt }));
      else patch(() => ({ status: "failed", error: error.message, ms: Date.now() - startedAt }));
    } finally {
      setBusy(false);
    }
  }

  function addFiles(list) {
    const picked = [...list];
    const tooBig = picked.find((f) => f.size > MAX_FILE_BYTES);
    if (tooBig) return setToast(`${tooBig.name} is larger than 4 MB. Attach a smaller file.`);
    if (files.length + picked.length > 3) setToast("Up to 3 files per message.");
    setFiles((current) => [...current, ...picked].slice(0, 3));
  }

  function toggleMic() {
    if (listening) return stopListening.current?.();
    stopSpeaking();
    setSpeakingId(null);
    setListening(true);
    stopListening.current = listen({
      onInterim: setText,
      onFinal: (said) => send(said, { spoken: true }),
      onEnd: () => setListening(false),
    });
  }

  function editQuestion(message) {
    setText(message.text);
    document.querySelector(".composer textarea")?.focus();
  }

  const lastId = messages.length ? messages[messages.length - 1].id : null;
  const asked = chats.filter((c) => c.messages.length).length;

  return (
    <div className="chat">
      <div className="chat-head">
        <span className="chat-title" title={active.title}>{active.title}</span>
        <button type="button" onClick={() => setOverlay(overlay === "activity" ? null : "activity")} aria-expanded={overlay === "activity"}
          title="Tools, timings and inputs behind each answer"><Icon name="activity" size={14} />Activity</button>
        <button type="button" onClick={() => setOverlay(overlay === "history" ? null : "history")} aria-expanded={overlay === "history"}>
          <Icon name="history" size={14} />History{asked > 0 && ` (${asked})`}
        </button>
        <button type="button" className="is-strong" onClick={() => { start(); setOverlay(null); }} disabled={busy}><Icon name="plus" size={14} />New chat</button>
      </div>
      {overlay === "history" && (
        <History chats={chats} activeId={active.id} onOpen={open} onRename={rename}
          onRemove={(id) => { remove(id); setToast("Chat deleted"); }} onClose={() => setOverlay(null)} />
      )}
      {overlay === "activity" && <Activity messages={messages} onClose={() => setOverlay(null)} />}

      <div className="chat-scroll" ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
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
            {!busy && <button type="button" className="edit" onClick={() => editQuestion(m)} aria-label="Edit this question" title="Edit this question"><Icon name="edit" size={14} /></button>}
          </div>
        ) : (
          <Answer key={m.id} message={m} isLast={m.id === lastId && !busy} speaking={speakingId === m.id}
            onAsk={(q) => send(q)} onSpeak={() => toggleSpeak(m)} onRetry={() => send(m.question || "", { attached: [] })}
            onActivity={() => setOverlay("activity")} notify={setToast} />
        )))}
      </div>

      {toast && <p className="toast" role="status">{toast}</p>}

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
        <div className="composer-box">
          <textarea
            value={text} rows={1} disabled={busy}
            placeholder={listening ? "Listening. Speak your question." : busy ? "The advisor is answering" : "Ask about a business, the budget, or the whole queue"}
            aria-label="Message to the advisor"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
          />
          <div className="composer-row">
            <input ref={fileInput} type="file" hidden multiple accept={ACCEPT}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <button type="button" className="icon-btn" title="Attach an application letter, photo or PDF"
              aria-label="Attach a file" disabled={busy} onClick={() => fileInput.current.click()}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12.5l-8.5 8.5a5.5 5.5 0 01-7.8-7.8L13.5 4.4a3.7 3.7 0 015.2 5.2l-8.7 8.7a1.8 1.8 0 01-2.6-2.6l8-8" /></svg>
            </button>
            {canListen && (
              <button type="button" className={`icon-btn${listening ? " is-live" : ""}`} disabled={busy}
                title={listening ? "Stop listening" : "Ask by voice"} aria-label={listening ? "Stop listening" : "Ask by voice"}
                aria-pressed={listening} onClick={toggleMic}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>
              </button>
            )}
            <span className="composer-hint">{busy ? "" : "Enter to send, Shift Enter for a new line"}</span>
            {busy
              ? <button type="button" className="send is-stop" onClick={() => aborter.current?.abort()}>Stop</button>
              : <button type="submit" className="send" disabled={!text.trim()}>Send</button>}
          </div>
        </div>
      </form>
    </div>
  );
}

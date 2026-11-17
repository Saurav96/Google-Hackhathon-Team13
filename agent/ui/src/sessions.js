// Chat history lives in this browser. The agent keeps each chat's context under the same id.

import { useCallback, useEffect, useState } from "react";
import { forgetSession, newId } from "./advisor.js";

const KEY = "relief-desk-chats";
const MAX_CHATS = 30;

const blank = () => ({ id: newId("chat"), title: "New chat", messages: [], updatedAt: Date.now() });

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
    // An answer that was still streaming when the page closed can never finish.
    return saved.map((chat) => ({
      ...chat,
      messages: chat.messages.map((m) => (m.status === "running"
        ? { ...m, status: "failed", error: "This answer was interrupted. Ask again." } : m)),
    }));
  } catch {
    return [];
  }
}

export function useChats() {
  const [chats, setChats] = useState(() => {
    const saved = load();
    return saved.length ? saved : [blank()];
  });
  const [activeId, setActiveId] = useState(() => chats[0].id);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(chats.slice(0, MAX_CHATS))); } catch { /* storage full or blocked */ }
  }, [chats]);

  const active = chats.find((c) => c.id === activeId) || chats[0];

  const update = useCallback((id, change) => {
    setChats((all) => all.map((c) => (c.id === id ? { ...c, ...change(c), updatedAt: Date.now() } : c)));
  }, []);

  const start = useCallback(() => {
    const empty = chats.find((c) => c.messages.length === 0);
    if (empty) return setActiveId(empty.id);
    const chat = blank();
    setChats((all) => [chat, ...all]);
    setActiveId(chat.id);
  }, [chats]);

  const rename = useCallback((id, title) => {
    const clean = title.trim().slice(0, 60);
    if (clean) update(id, () => ({ title: clean }));
  }, [update]);

  const remove = useCallback((id) => {
    forgetSession(id);
    setChats((all) => {
      const rest = all.filter((c) => c.id !== id);
      const next = rest.length ? rest : [blank()];
      if (id === activeId) setActiveId(next[0].id);
      return next;
    });
  }, [activeId]);

  return { chats, active, open: setActiveId, start, rename, remove, update };
}

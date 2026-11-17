import { useEffect, useRef, useState } from "react";

// A small "i" that opens a short explanation for anyone who wants it.
export default function Info({ label, children, left = false }) {
  const [open, setOpen] = useState(false);
  const holder = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !holder.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <span className={`info${left ? " is-left" : ""}`} ref={holder}>
      <button type="button" aria-label={`More about ${label}`} aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>i</button>
      {open && <span className="info-pop" role="note">{children}</span>}
    </span>
  );
}

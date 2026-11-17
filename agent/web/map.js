// Corridor map: every business at its real coordinates, rotated so the corridor reads left to right.

const NS = "http://www.w3.org/2000/svg";
const W = 1000, PAD = 46;
let H = 560;
const RADIUS = { "Ubiquitous Hub": 9, "Target Anchor": 7.5, "Small/Peripheral Supplier": 5.5, "Leaf Node": 4.5 };
// The corridor is long and thin, so the cross-street axis is stretched to stay readable.
const MAX_STRETCH = 3;
const STEP_MS = 650;

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

function principalAngle(points) {
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  return { angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), mx, my };
}

function streetOf(address) {
  const m = /^\d+\S*\s+(.+?\b(?:St|Ave|Blvd|Plz|Aly))\b/i.exec(address || "");
  return m ? m[1].replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

export function createMap(svg, tip, { onSelect }) {
  const layers = {
    streets: el("g"), links: el("g"), nodes: el("g"), labels: el("g"), extras: el("g"),
  };
  Object.values(layers).forEach((g) => svg.append(g));
  const byId = new Map();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timers = [];
  let northAngle = 0;

  function load(nodes) {
    // Match the drawing to the space it gets, so the map fills the stage.
    const box = svg.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) H = Math.max(420, Math.min(900, (W * box.height) / box.width));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const lat0 = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
    const flat = nodes.map((n) => ({ n, x: n.lon * Math.cos((lat0 * Math.PI) / 180), y: n.lat }));
    const { angle, mx, my } = principalAngle(flat);
    // Rotate only, never mirror, and keep east on the right.
    let theta = -angle;
    if (Math.cos(angle) < 0) theta += Math.PI;
    northAngle = theta;
    const turned = flat.map(({ n, x, y }) => ({
      n,
      x: (x - mx) * Math.cos(theta) - (y - my) * Math.sin(theta),
      y: (x - mx) * Math.sin(theta) + (y - my) * Math.cos(theta),
    }));
    const xs = turned.map((p) => p.x), ys = turned.map((p) => p.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scaleX = (W - 2 * PAD) / (x1 - x0);
    const scaleY = Math.min((H - 2 * PAD) / (y1 - y0), scaleX * MAX_STRETCH);
    const offX = PAD, offY = (H - (y1 - y0) * scaleY) / 2;
    const seen = new Map();
    for (const p of turned) {
      let px = offX + (p.x - x0) * scaleX;
      let py = H - (offY + (p.y - y0) * scaleY);
      // Businesses at one address share coordinates; fan them out so each stays clickable.
      const key = `${px.toFixed(0)}:${py.toFixed(0)}`;
      const k = seen.get(key) || 0;
      seen.set(key, k + 1);
      if (k) {
        px += 9 * Math.cos(k * 2.4) * Math.sqrt(k);
        py += 9 * Math.sin(k * 2.4) * Math.sqrt(k);
      }
      byId.set(p.n.id, { ...p.n, px, py });
    }
    drawStreets();
    drawNodes();
    drawNorth();
  }

  function drawStreets() {
    const groups = new Map();
    for (const n of byId.values()) {
      const street = streetOf(n.address);
      if (!street) continue;
      if (!groups.has(street)) groups.set(street, []);
      groups.get(street).push({ x: n.px, y: n.py });
    }
    for (const [street, pts] of groups) {
      if (pts.length < 8) continue;
      const { angle, mx, my } = principalAngle(pts);
      const along = pts.map((p) => (p.x - mx) * Math.cos(angle) + (p.y - my) * Math.sin(angle));
      const [a, b] = [Math.min(...along) - 22, Math.max(...along) + 22];
      const at = (t) => [mx + t * Math.cos(angle), my + t * Math.sin(angle)];
      const [xa, ya] = at(a), [xb, yb] = at(b);
      layers.streets.append(el("line", { class: "street", x1: xa, y1: ya, x2: xb, y2: yb }));
      const left = xa < xb ? [xa, ya] : [xb, yb];
      let deg = (angle * 180) / Math.PI;
      if (deg > 90) deg -= 180;
      if (deg < -90) deg += 180;
      const label = el("text", {
        class: "street-name", x: left[0] + 6, y: left[1] - 11,
        transform: `rotate(${deg} ${left[0]} ${left[1]})`,
      });
      label.textContent = street;
      layers.streets.append(label);
    }
  }

  function drawNodes() {
    const order = [...byId.values()].sort((a, b) => (RADIUS[b.role] || 4) - (RADIUS[a.role] || 4));
    for (const n of order) {
      const c = el("circle", {
        class: "node" + (n.applicant ? " is-applicant" : ""),
        cx: n.px, cy: n.py, r: RADIUS[n.role] || 4, tabindex: 0,
        "aria-label": `${n.name}, ${n.role}`,
      });
      c.addEventListener("click", () => onSelect(n.id));
      c.addEventListener("keydown", (e) => { if (e.key === "Enter") onSelect(n.id); });
      c.addEventListener("pointermove", (e) => showTip(e, n));
      c.addEventListener("pointerleave", () => { tip.hidden = true; });
      n.el = c;
      layers.nodes.append(c);
    }
  }

  function drawNorth() {
    const g = el("g", { transform: `translate(${W - 44} 44) rotate(${(-northAngle * 180) / Math.PI})` });
    g.append(el("path", { d: "M0 -16 L5 4 L0 0 L-5 4 Z", fill: "#4d626b" }));
    const t = el("text", { class: "north", x: -4, y: -20 });
    t.textContent = "N";
    g.append(t);
    layers.extras.append(g);
  }

  function showTip(event, n) {
    const box = svg.getBoundingClientRect();
    tip.hidden = false;
    tip.replaceChildren(document.createTextNode(n.name));
    const meta = document.createElement("span");
    meta.textContent = `${n.role}, reaches ${n.reach} in two steps${n.applicant ? ", in the queue" : ""}`;
    tip.append(meta);
    tip.style.left = `${Math.min(event.clientX - box.left + 14, box.width - 270)}px`;
    tip.style.top = `${event.clientY - box.top + 14}px`;
  }

  function reset() {
    timers.forEach(clearTimeout);
    timers = [];
    layers.links.replaceChildren();
    layers.labels.replaceChildren();
    labelBoxes = [];
    for (const n of byId.values()) {
      n.el.classList.remove("is-seed", "is-hop1", "is-hop2", "is-dim");
      n.el.setAttribute("r", RADIUS[n.role] || 4);
    }
  }

  let labelBoxes = [];

  // Skips a label that would sit on top of one already placed.
  function label(id, dy = -13) {
    const n = byId.get(id);
    if (!n) return;
    const text = n.name.length > 28 ? `${n.name.slice(0, 26)}…` : n.name;
    const half = text.length * 3.4;
    const x = Math.max(half + 4, Math.min(W - half - 4, n.px));
    for (const y of [n.py + dy, n.py - dy + 9, n.py + dy - 14]) {
      const box = [x - half, y - 12, x + half, y + 3];
      if (labelBoxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      labelBoxes.push(box);
      const t = el("text", { class: "node-label", x, y, "text-anchor": "middle" });
      t.textContent = text;
      layers.labels.append(t);
      return;
    }
  }

  function drawLink(sourceId, targetId, cls, delay) {
    const a = byId.get(sourceId), b = byId.get(targetId);
    if (!a || !b) return;
    const line = el("line", { class: `link ${cls}`, x1: a.px, y1: a.py, x2: b.px, y2: b.py });
    const length = Math.hypot(b.px - a.px, b.py - a.py);
    layers.links.append(line);
    if (!reduceMotion && line.animate) {
      line.style.strokeDasharray = length;
      line.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }],
        { duration: STEP_MS, delay, easing: "ease-out", fill: "backwards" });
    }
  }

  function later(fn, ms) {
    if (reduceMotion) fn(); else timers.push(setTimeout(fn, ms));
  }

  function showCascade(seedId, exposed, links) {
    reset();
    const touched = new Set([seedId, ...exposed.map((e) => e.id)]);
    for (const n of byId.values()) if (!touched.has(n.id)) n.el.classList.add("is-dim");
    const seed = byId.get(seedId);
    if (seed) {
      seed.el.classList.add("is-seed");
      seed.el.setAttribute("r", 12);
      label(seedId, -18);
    }
    for (const hop of [1, 2, 3]) {
      const delay = (hop - 1) * STEP_MS;
      links.filter((l) => l.hop === hop).forEach((l) => drawLink(l.source, l.target, hop === 1 ? "hop1" : "hop2", delay));
      later(() => {
        exposed.filter((e) => e.hops === hop).forEach((e) => byId.get(e.id)?.el.classList.add(hop === 1 ? "is-hop1" : "is-hop2"));
      }, delay + STEP_MS * 0.8);
    }
    later(() => {
      [...exposed].sort((a, b) => b.strength - a.strength).slice(0, 4).forEach((e) => label(e.id));
    }, STEP_MS * 1.2);
  }

  function showClosure(view) {
    reset();
    const first = new Set(view.first_order.map((f) => f.id));
    const second = new Set(view.second_order.map((s) => s.id));
    for (const n of byId.values()) if (!first.has(n.id) && !second.has(n.id)) n.el.classList.add("is-dim");
    first.forEach((id) => {
      const n = byId.get(id);
      if (n) { n.el.classList.add("is-seed"); n.el.setAttribute("r", 9); }
    });
    view.links.forEach((l) => drawLink(l.source, l.target, "loss", STEP_MS));
    later(() => second.forEach((id) => byId.get(id)?.el.classList.add("is-hop1")), STEP_MS * 1.6);
    later(() => {
      view.first_order.slice(0, 3).forEach((f) => label(f.id));
      view.second_order.slice(0, 3).forEach((s) => label(s.id));
    }, STEP_MS * 1.8);
  }

  function setFunded(fundedIds, protectedIds) {
    for (const n of byId.values()) {
      n.el.classList.toggle("is-funded", fundedIds.has(n.id));
      n.el.classList.toggle("is-safe", protectedIds.has(n.id) && !fundedIds.has(n.id));
    }
  }

  return { load, reset, showCascade, showClosure, setFunded, get: (id) => byId.get(id) };
}

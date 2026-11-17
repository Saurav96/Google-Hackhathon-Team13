import { Loader } from "@googlemaps/js-api-loader";
import { useCallback, useEffect, useRef, useState } from "react";
import RelationshipCard from "./RelationshipCard.jsx";
import "./map.css";

const PALETTE = {
  dark: {
    closed: "#ff5d73", hop1: "#ffb23e", hop2: "#ffe08a", safe: "#3ddbb4", idle: "#a9b4d6", ring: "#151a2d", queue: "#ffffff",
    supply: "#9aa8ff", worker: "#3ddbb4", block: "#ffb23e", proposed: "#c79bff",
  },
  light: {
    closed: "#d42a4b", hop1: "#ef8a00", hop2: "#f3c623", safe: "#0c9f80", idle: "#7d88ab", ring: "#ffffff", queue: "#171c30",
    supply: "#3340c4", worker: "#0c8f73", block: "#e07b00", proposed: "#8a3fd1",
  },
};
const QUIET = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];
// Daylight map: the standard Google look with the colour turned down, so the dots stand out.
const LIGHT_STYLE = [...QUIET, { stylers: [{ saturation: -55 }, { lightness: 8 }] }];
const SIZE = { "Ubiquitous Hub": 8, "Target Anchor": 7, "Small/Peripheral Supplier": 5.5, "Leaf Node": 4.5 };
const STEP_MS = 300;
const SQUARE = "M -1 -1 L 1 -1 L 1 1 L -1 1 Z";
const NONE = new Set();

// Quiet night map: streets and names stay, shops and transit icons go, so our dots carry the story.
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1b2238" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8f9bc0" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#151a2d" }] },
  ...QUIET,
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2c3554" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#364066" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#414c78" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#101526" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
];

function icon(maps, fill, scale, { ring, weight = 1.2, opacity = 1 } = {}) {
  return {
    path: maps.SymbolPath.CIRCLE, scale, fillColor: fill, fillOpacity: opacity,
    strokeColor: ring, strokeWeight: weight, strokeOpacity: opacity, labelOrigin: new maps.Point(0, -2.6),
  };
}

export default function MapView({
  apiKey, nodes, view, funded, protectedIds, onSelect, theme, reserveRight = 40,
  linkFilter = "all", edgeIntensity, proposedIds = NONE,
}) {
  const COLORS = PALETTE[theme] || PALETTE.light;
  const holder = useRef(null);
  const ctx = useRef(null);
  const [problem, setProblem] = useState("");
  const [ready, setReady] = useState(false);
  const [relation, setRelation] = useState(null);
  const closeRelation = useCallback(() => setRelation(null), []);

  useEffect(() => {
    if (!apiKey || !nodes.length || ctx.current) return;
    let cancelled = false;
    new Loader({ apiKey, version: "weekly" }).importLibrary("maps").then(() => {
      if (cancelled) return;
      const maps = window.google.maps;
      const map = new maps.Map(holder.current, {
        disableDefaultUI: true, zoomControl: true, clickableIcons: false,
        gestureHandling: "greedy", isFractionalZoomEnabled: true,
      });
      const bounds = new maps.LatLngBounds();
      const markers = new Map();
      const seen = new Map();
      for (const n of nodes) {
        // Businesses at one address share coordinates; fan them out so each stays clickable.
        const key = `${n.lat.toFixed(5)}:${n.lon.toFixed(5)}`;
        const k = seen.get(key) || 0;
        seen.set(key, k + 1);
        const position = {
          lat: n.lat + 0.00007 * Math.sqrt(k) * Math.sin(k * 2.4),
          lng: n.lon + 0.00009 * Math.sqrt(k) * Math.cos(k * 2.4),
        };
        bounds.extend(position);
        const marker = new maps.Marker({ map, position, title: `${n.name} (${n.role}, reaches ${n.reach})` });
        marker.addListener("click", () => onSelectRef.current(n.id));
        markers.set(n.id, { marker, node: n, position });
      }
      map.fitBounds(bounds, 24);
      const c = { maps, map, markers, lines: [], timers: [], all: bounds, framed: null, origin: null, linkClickAt: 0 };
      map.addListener("click", () => {
        setRelation(null);
        // A click on a link must not also clear the selected business.
        if (Date.now() - c.linkClickAt > 300) onSelectRef.current(null);
      });
      ctx.current = c;
      setReady(true);
    }).catch(() => setProblem("Google Maps did not load. The advisor and the lists still work."));
    window.gm_authFailure = () => setProblem("Google Maps rejected the key. The advisor and the lists still work.");
    return () => { cancelled = true; };
  }, [apiKey, nodes]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (ready) ctx.current.map.setOptions({ styles: theme === "dark" ? MAP_STYLE : LIGHT_STYLE });
  }, [ready, theme]);

  useEffect(() => setRelation(null), [view, linkFilter]);

  useEffect(() => {
    const c = ctx.current;
    if (!ready || !c) return;
    const { maps, map, markers } = c;
    c.timers.forEach(clearTimeout);
    c.lines.forEach((l) => l.setMap(null));
    c.timers = [];
    c.lines = [];
    if (c.origin) { c.origin.setMap(null); c.origin = null; }

    const state = new Map();
    const labels = new Set();
    if (view?.kind === "cascade") {
      state.set(view.seed, "closed");
      labels.add(view.seed);
      view.exposed.forEach((e) => state.set(e.id, e.hops === 1 ? "hop1" : "hop2"));
      [...view.exposed].sort((a, b) => b.strength - a.strength).slice(0, 3).forEach((e) => labels.add(e.id));
    } else if (view?.kind === "closure") {
      view.first.forEach((f) => state.set(f.id, "closed"));
      view.second.forEach((s) => state.set(s.id, "hop1"));
      view.first.slice(0, 2).forEach((f) => labels.add(f.id));
      view.second.slice(0, 2).forEach((s) => labels.add(s.id));
    }
    const focused = Boolean(view);
    const showSupply = linkFilter !== "worker";
    const showWorker = linkFilter !== "supply";

    // Only markers whose look actually changed are redrawn, which keeps clicks snappy.
    const paint = (stage) => {
      for (const [id, record] of markers) {
        const { marker, node } = record;
        let kind = state.get(id);
        if (kind === "hop1" && stage < 1) kind = null;
        if (kind === "hop2" && stage < 2) kind = null;
        const size = SIZE[node.role] || 5;
        const isFunded = funded.has(id);
        // A proposal is drawn as an outline only, so it never reads as an applied grant.
        const isProposed = !isFunded && proposedIds.has(id);
        const fill = kind ? COLORS[kind] : isFunded || protectedIds.has(id) ? COLORS.safe : COLORS.idle;
        const dim = focused && !kind && !isFunded && !isProposed;
        const base = kind === "closed" && view.kind === "cascade" ? 12 : kind ? size + 1.5 : size;
        const scale = isProposed ? base + 2 : base;
        const showLabel = labels.has(id) && (stage >= 2 || kind === "closed");
        const key = `${fill}|${scale}|${dim}|${isFunded}|${isProposed}|${showLabel}|${theme}`;
        if (record.key === key) continue;
        record.key = key;
        marker.setIcon(icon(maps, fill, scale, {
          ring: isProposed ? COLORS.proposed : isFunded || node.applicant ? COLORS.queue : COLORS.ring,
          weight: isProposed ? 3.5 : isFunded ? 3 : node.applicant ? 2 : 1.2,
          opacity: dim ? 0.28 : 1,
        }));
        marker.setZIndex(kind === "closed" ? 30 : kind ? 20 : isFunded ? 15 : isProposed ? 14 : node.applicant ? 10 : 1);
        marker.setLabel(showLabel
          ? { text: node.name.length > 26 ? `${node.name.slice(0, 24)}…` : node.name, className: "map-label" }
          : null);
      }
    };

    // Each link is a visible line plus a wide invisible one on top, so it is easy to click.
    const addLine = (from, to, style, info) => {
      c.lines.push(new maps.Polyline({ map, path: [from, to], clickable: false, zIndex: 5, ...style }));
      const hit = new maps.Polyline({ map, path: [from, to], strokeOpacity: 0.01, strokeWeight: 14, clickable: true, zIndex: 6 });
      hit.addListener("click", () => {
        c.linkClickAt = Date.now();
        setRelation(info);
      });
      c.lines.push(hit);
    };
    const arrow = (color, scale = 2) => ({
      icon: { path: maps.SymbolPath.FORWARD_CLOSED_ARROW, scale, strokeColor: color, strokeWeight: 1, fillColor: color, fillOpacity: 1, strokeOpacity: 1 },
      offset: "82%",
    });

    const drawSupply = (links, thin) => {
      if (!showSupply) return;
      for (const l of links) {
        const a = markers.get(l.source), b = markers.get(l.target);
        if (!a || !b) continue;
        addLine(a.position, b.position, {
          strokeColor: COLORS.supply, strokeOpacity: thin ? 0.4 : 0.8, strokeWeight: thin ? 1 : 1.7,
          icons: [arrow(COLORS.supply, thin ? 1.4 : 2)],
        }, {
          type: "supply", sourceName: a.node.name, targetName: b.node.name, hop: l.hop || null,
          intensity: edgeIntensity?.get(`${l.source}>${l.target}`) ?? null,
        });
      }
    };

    const hasOrigin = view?.kind === "closure" && view.origin && Number.isFinite(view.origin.lat) && Number.isFinite(view.origin.lon);
    const originPosition = hasOrigin ? { lat: view.origin.lat, lng: view.origin.lon } : null;
    const drawWorker = () => {
      if (!hasOrigin) return;
      const jobs = Number(view.origin.jobs || 0).toLocaleString("en-US");
      c.origin = new maps.Marker({
        map, position: originPosition, zIndex: 40, clickable: false,
        title: "Workplace block. Approximate location, placed at its census tract.",
        icon: {
          path: SQUARE, scale: 9, fillColor: COLORS.block, fillOpacity: 1, strokeColor: COLORS.queue, strokeWeight: 2,
          labelOrigin: new maps.Point(0, -2.4),
        },
        label: { text: `Workplace block, ${jobs} workers (approximate location)`, className: "map-label" },
      });
      if (!showWorker) return;
      for (const f of view.footfall || []) {
        const b = markers.get(f.target);
        if (!b) continue;
        addLine(originPosition, b.position, {
          strokeOpacity: 0,
          icons: [
            { icon: { path: "M 0,-1 0,1", strokeColor: COLORS.worker, strokeOpacity: 0.95, strokeWeight: 2.2, scale: 2.4 }, offset: "0", repeat: "11px" },
            arrow(COLORS.worker),
          ],
        }, { type: "worker", targetName: b.node.name, workers: f.workers, share: f.share });
      }
    };

    const drawAll = () => {
      if (view?.kind === "cascade") {
        drawSupply(view.links.filter((l) => l.hop === 1), false);
        drawSupply(view.links.filter((l) => l.hop > 1), true);
      } else if (view) {
        drawWorker();
        drawSupply(view.links, false);
      }
    };

    // Replay the spread only for a new selection, not when a grant, a filter or the theme changes.
    const isNew = c.shown !== view;
    c.shown = view;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!view || still || !isNew) {
      drawAll();
      paint(2);
    } else {
      paint(0);
      if (view.kind === "cascade") {
        drawSupply(view.links.filter((l) => l.hop === 1), false);
        c.timers.push(setTimeout(() => {
          paint(1);
          drawSupply(view.links.filter((l) => l.hop > 1), true);
        }, STEP_MS));
      } else {
        // Forward first: the block and the shops it feeds. Then backward to their suppliers.
        drawWorker();
        c.timers.push(setTimeout(() => { paint(1); drawSupply(view.links, false); }, STEP_MS));
      }
      c.timers.push(setTimeout(() => paint(2), STEP_MS * 2));
    }
    if (!view || !isNew) return;

    // Move the map only when part of the selection is off screen.
    const points = [...state.keys()].filter((id) => markers.has(id)).map((id) => markers.get(id).position);
    if (originPosition) points.push(originPosition);
    const frame = () => {
      const visible = map.getBounds();
      // "On screen" means clear of the edges, the headline and the card, not merely inside the frame.
      const comfortable = (p) => {
        const ne = visible.getNorthEast(), sw = visible.getSouthWest();
        const h = ne.lat() - sw.lat(), w = ne.lng() - sw.lng();
        return p.lat() < ne.lat() - 0.16 * h && p.lat() > sw.lat() + 0.1 * h
          && p.lng() > sw.lng() + 0.08 * w && p.lng() < ne.lng() - (reserveRight > 100 ? 0.46 : 0.08) * w;
      };
      const asLatLng = points.map((p) => new maps.LatLng(p));
      if (!asLatLng.length || asLatLng.every(comfortable)) return;
      const focus = new maps.LatLngBounds();
      asLatLng.forEach((p) => focus.extend(p));
      map.fitBounds(focus, { top: 90, bottom: 60, left: 40, right: reserveRight });
    };
    // Right after the map is created its bounds are not known yet, so wait for it to settle.
    if (map.getBounds()) frame();
    else maps.event.addListenerOnce(map, "idle", frame);
  }, [ready, view, funded, protectedIds, theme, linkFilter, edgeIntensity, proposedIds]);

  return (
    <div className="map">
      <div className="map-canvas" ref={holder} role="application" aria-label="Map of businesses in the Central Market corridor" />
      {problem && <p className="map-problem">{problem}</p>}
      {relation && <RelationshipCard relation={relation} onClose={closeRelation} />}
    </div>
  );
}

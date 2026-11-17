import { Loader } from "@googlemaps/js-api-loader";
import { useEffect, useRef, useState } from "react";
import { roleOf } from "./api.js";

const PALETTE = {
  dark: { closed: "#ff5d73", hop1: "#ffb23e", hop2: "#ffe08a", safe: "#3ddbb4", idle: "#a9b4d6", ring: "#151a2d", queue: "#ffffff" },
  light: { closed: "#d42a4b", hop1: "#ef8a00", hop2: "#f3c623", safe: "#0c9f80", idle: "#7d88ab", ring: "#ffffff", queue: "#171c30" },
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

// Quiet night map: streets and names stay, shops and transit icons go, so our dots carry the story.
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#1b2238" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8f9bc0" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#151a2d" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
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

export default function MapView({ apiKey, nodes, view, funded, protectedIds, onSelect, theme }) {
  const COLORS = PALETTE[theme] || PALETTE.light;
  const holder = useRef(null);
  const ctx = useRef(null);
  const [problem, setProblem] = useState("");
  const [ready, setReady] = useState(false);

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
      map.addListener("click", () => onSelectRef.current(null));
      ctx.current = { maps, map, markers, lines: [], timers: [], all: bounds, framed: null };
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

  useEffect(() => {
    const c = ctx.current;
    if (!ready || !c) return;
    const { maps, map, markers } = c;
    c.timers.forEach(clearTimeout);
    c.lines.forEach((l) => l.setMap(null));
    c.timers = [];
    c.lines = [];

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

    // Only markers whose look actually changed are redrawn, which keeps clicks snappy.
    const paint = (stage) => {
      for (const [id, record] of markers) {
        const { marker, node } = record;
        let kind = state.get(id);
        if (kind === "hop1" && stage < 1) kind = null;
        if (kind === "hop2" && stage < 2) kind = null;
        const size = SIZE[node.role] || 5;
        const isFunded = funded.has(id);
        const fill = kind ? COLORS[kind] : isFunded || protectedIds.has(id) ? COLORS.safe : COLORS.idle;
        const dim = focused && !kind && !isFunded;
        const scale = kind === "closed" && view.kind === "cascade" ? 12 : kind ? size + 1.5 : size;
        const showLabel = labels.has(id) && (stage >= 2 || kind === "closed");
        const key = `${fill}|${scale}|${dim}|${isFunded}|${showLabel}|${theme}`;
        if (record.key === key) continue;
        record.key = key;
        marker.setIcon(icon(maps, fill, scale, {
          ring: isFunded || node.applicant ? COLORS.queue : COLORS.ring,
          weight: isFunded ? 3 : node.applicant ? 2 : 1.2,
          opacity: dim ? 0.28 : 1,
        }));
        marker.setZIndex(kind === "closed" ? 30 : kind ? 20 : isFunded ? 15 : node.applicant ? 10 : 1);
        marker.setLabel(showLabel
          ? { text: node.name.length > 26 ? `${node.name.slice(0, 24)}…` : node.name, className: "map-label" }
          : null);
      }
    };

    const drawLinks = (links, color, weight) => links.forEach((l) => {
      const a = markers.get(l.source), b = markers.get(l.target);
      if (!a || !b) return;
      c.lines.push(new maps.Polyline({
        map, path: [a.position, b.position], strokeColor: color, strokeOpacity: 0.75, strokeWeight: weight,
        clickable: false, zIndex: 5,
      }));
    });
    const drawAll = () => {
      if (view?.kind === "cascade") {
        drawLinks(view.links.filter((l) => l.hop === 1), COLORS.hop1, 2);
        drawLinks(view.links.filter((l) => l.hop > 1), COLORS.hop2, 1.2);
      } else if (view) drawLinks(view.links, COLORS.closed, 1.2);
    };

    // Replay the spread only for a new selection, not when a grant or the theme changes.
    const isNew = c.shown !== view;
    c.shown = view;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!view || still || !isNew) {
      drawAll();
      paint(2);
      return;
    }

    paint(0);
    if (view.kind === "cascade") {
      drawLinks(view.links.filter((l) => l.hop === 1), COLORS.hop1, 2);
      c.timers.push(setTimeout(() => {
        paint(1);
        drawLinks(view.links.filter((l) => l.hop > 1), COLORS.hop2, 1.2);
      }, STEP_MS));
    } else {
      c.timers.push(setTimeout(() => { paint(1); drawLinks(view.links, COLORS.closed, 1.2); }, STEP_MS));
    }
    c.timers.push(setTimeout(() => paint(2), STEP_MS * 2));

    // Move the map only when part of the cascade is off screen.
    const visible = map.getBounds();
    const points = [...state.keys()].filter((id) => markers.has(id)).map((id) => markers.get(id).position);
    // "On screen" means clear of the edges and of the headline, not merely inside the frame.
    const comfortable = (p) => {
      const ne = visible.getNorthEast(), sw = visible.getSouthWest();
      const h = ne.lat() - sw.lat(), w = ne.lng() - sw.lng();
      return p.lat < ne.lat() - 0.16 * h && p.lat > sw.lat() + 0.1 * h && p.lng > sw.lng() + 0.08 * w && p.lng < ne.lng() - 0.08 * w;
    };
    if (points.length && visible && !points.every(comfortable)) {
      const focus = new maps.LatLngBounds();
      points.forEach((p) => focus.extend(p));
      map.fitBounds(focus, { top: 90, bottom: 60, left: 40, right: 40 });
    }
  }, [ready, view, funded, protectedIds, theme]);

  return (
    <div className="map">
      <div className="map-canvas" ref={holder} role="application" aria-label="Map of businesses in the Central Market corridor" />
      {problem && <p className="map-problem">{problem}</p>}
    </div>
  );
}

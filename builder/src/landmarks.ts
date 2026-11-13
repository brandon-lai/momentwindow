// Landmarks in the builder: match each famous thing (from Wikipedia and
// Wikidata) to what the map actually has there, then frame the most famous
// one. A landmark only counts if the map has a body for it: a building
// footprint, or a bridge's deck. That filter also drops the organisations,
// stations and wards that share coordinates with real buildings.
import type { Heading, Pt, Ring } from "../../shared/bundle.ts";
import type { Local } from "../../shared/geo.ts";
import { absArea, centroid, distLine, inRing, len } from "./geom.ts";
import type { OsmData } from "./sources/ofm.ts";
import { landmarkKind, WD_COLOUR, WD_MATERIAL, type WikiLandmark } from "./sources/wiki.ts";

export interface Matched {
  w: WikiLandmark; kind: string; x: number; y: number;
  base?: Ring; line?: Pt[]; // footprint, or the bridge deck
}
const BRIDGES = new Set(["suspension", "cablestayed", "arch", "bascule", "bridge"]);

export function matchLandmarks(list: WikiLandmark[], osm: OsmData, L: Local, minLinks = 12): Matched[] {
  const out: Matched[] = [];
  for (const w of list) {
    if (w.links < minLinks) continue;
    const [x, y] = L.toXY(w.lat, w.lon);
    const kind = landmarkKind(w.types) ?? "building";
    // an untyped thing counts only if it is a structure: a ward, a city or an
    // agency can have coordinates inside a building (Tokyo's Minato did)
    if (w.notStructure || (kind === "building" && w.ctype && w.ctype !== "landmark")) continue;
    if (BRIDGES.has(kind)) {
      // the deck: start from bridge pieces near the point and grow along
      // connected bridge pieces (tiles and OSM split a long deck), then order
      // every point along the bridge's axis into one line
      const pieces = osm.transport.filter(t => t.brunnel === "bridge" && t.cls !== "path" && t.cls !== "ferry");
      const used = new Set<number>(); let frontier = pieces.map((t, i) => [t, i] as const).filter(([t]) => distLine(x, y, t.pts) < 160).map(([, i]) => i);
      frontier.forEach(i => used.add(i));
      for (let round = 0; round < 40 && frontier.length; round++) {
        const ends = frontier.flatMap(i => [pieces[i].pts[0], pieces[i].pts[pieces[i].pts.length - 1]]);
        const next: number[] = [];
        pieces.forEach((t, i) => { if (used.has(i)) return; const a = t.pts[0], b = t.pts[t.pts.length - 1]; if (ends.some(e => Math.hypot(e[0] - a[0], e[1] - a[1]) < 40 || Math.hypot(e[0] - b[0], e[1] - b[1]) < 40)) { used.add(i); next.push(i); } });
        frontier = next;
      }
      const pts = [...used].flatMap(i => pieces[i].pts);
      if (pts.length < 2) continue;
      const [ax, ay] = axisOf(pts);
      const proj = pts.map(p => (p[0] - x) * ax + (p[1] - y) * ay);
      let lo = Math.min(...proj), hi = Math.max(...proj);
      // a bridge's length on Wikidata trims approach roads that are also "bridge"
      if (w.length && hi - lo > w.length * 1.15) { const c = (lo + hi) / 2; lo = c - w.length / 2; hi = c + w.length / 2; }
      if (hi - lo < 60) continue;
      const line: Pt[] = []; for (let k = 0; k <= 24; k++) { const t = lo + (hi - lo) * (k / 24); line.push([x + ax * t, y + ay * t]); }
      // frame on Wikipedia's point (mid-span for most bridges)
      out.push({ w, kind, x, y, line });
      continue;
    }
    // the footprint containing the point, or the nearest within 60 m; for
    // stacked parts take the largest one under the point as the base
    // a clock tower, a statue or a needle is the smallest thing under its
    // point (Big Ben stands inside the Palace's footprint); anything else the largest
    const smallest = kind === "clock" || kind === "statue" || kind === "needle" || kind === "obelisk";
    let best: Ring | undefined, bestA = smallest ? Infinity : 0, bestD = Infinity;
    for (const b of osm.buildings) {
      const r = b.rings[0];
      if (inRing(x, y, r)) { const a = absArea(r); if (smallest ? a < bestA : a > bestA) { bestA = a; best = r; bestD = 0; } }
    }
    // a typed structure (tower, statue, church...) may sit a little off its
    // footprint; anything else has to be inside one, or it is a park, an
    // event or a company that happens to have coordinates
    if (!best && kind !== "building") for (const b of osm.buildings) { const c = centroid(b.rings[0]); const d = Math.hypot(c[0] - x, c[1] - y); if (d < 60 && d < bestD) { bestD = d; best = b.rings[0]; } }
    if (!best) continue;
    const [cx, cy] = centroid(best);
    out.push({ w, kind, x: cx, y: cy, base: best });
  }
  // one thing per place: the Parliament and the Palace share a footprint
  const kept: Matched[] = [];
  for (const m of out.sort((a, b) => b.w.links - a.w.links)) if (!kept.some(k => Math.hypot(k.x - m.x, k.y - m.y) < 25 && !BRIDGES.has(k.kind) === !BRIDGES.has(m.kind))) kept.push(m);
  return kept;
}

export function landmarkColour(w: WikiLandmark): [number, number, number] | null {
  for (const c of w.colours) if (WD_COLOUR[c]) return WD_COLOUR[c];
  for (const m of w.materials) if (WD_MATERIAL[m]) return WD_MATERIAL[m];
  return null;
}

export interface Framing { primary: Matched; x: number; y: number; heading: Heading; depth: number; notes: string }

// Puts the most famous landmark near the cell in the window: horizontally
// centred, a little nearer than the middle, facing the way that fits the most
// fame in view, puts water in front, and shows a bridge side-on.
export function frameLandmark(ms: Matched[], cx: number, cy: number, d: number, w: number, water: (x: number, y: number) => boolean, reach: number): Framing | null {
  // things with a shape of their own (bridges, towers, statues, shells) are
  // what a postcard is of: they win close calls (Tower Bridge over the Tower)
  const shaped = (m: Matched) => (["building", "dome", "skyscraper"].includes(m.kind) ? 1 : 1.3);
  const weight = (m: Matched) => m.w.links * shaped(m) * (Math.hypot(m.x - cx, m.y - cy) < 400 ? 1 : Math.max(0.25, 1 - (Math.hypot(m.x - cx, m.y - cy) - 400) / (reach * 1.4)));
  const cands = ms.filter(m => m.w.links >= 25 && Math.hypot(m.x - cx, m.y - cy) < reach).sort((a, b) => weight(b) - weight(a));
  const primary = cands[0]; if (!primary) return null;
  const depth = BRIDGES.has(primary.kind) ? 0.5 : 0.38;
  let best: Framing | null = null, bestS = -Infinity;
  for (const [h, f] of [["N", [0, 1]], ["E", [1, 0]], ["S", [0, -1]], ["W", [-1, 0]]] as [Heading, Pt][]) {
    const r: Pt = [f[1], -f[0]]; // right of forward
    const wx = primary.x + f[0] * d * (0.5 - depth), wy = primary.y + f[1] * d * (0.5 - depth);
    let s = h === "N" ? 2 : 0;
    for (const m of ms) {
      const v = (m.x - wx) * f[0] + (m.y - wy) * f[1] + d / 2, u = (m.x - wx) * r[0] + (m.y - wy) * r[1] + w / 2;
      if (u > w * 0.06 && u < w * 0.94 && v > d * 0.04 && v < d * 1.1) s += m.w.links * (m === primary ? 1 : 0.6);
    }
    // water in the foreground
    let wet = 0, n = 0;
    for (let k = -3; k <= 3; k++) for (let t = 60; t <= d * 0.35; t += 40) { n++; if (water(primary.x - f[0] * t + r[0] * k * 60, primary.y - f[1] * t + r[1] * k * 60)) wet++; }
    s += primary.w.links * 0.35 * (wet / Math.max(1, n));
    // bridges side-on
    if (primary.line) {
      const [ax, ay] = axisOf(primary.line);
      s += primary.w.links * 1.2 * Math.abs(ax * f[1] - ay * f[0]);
    }
    if (s > bestS) { bestS = s; best = { primary, x: primary.x, y: primary.y, heading: h, depth, notes: "" }; }
  }
  if (best) best.notes = `landmark ${primary.w.name} (${primary.w.links} languages, ${primary.kind}) heading ${best.heading}`;
  return best;
}

// principal direction of a line's points (unit vector)
export function axisOf(pts: Pt[]): Pt {
  let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  let sxx = 0, syy = 0, sxy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy); return [Math.cos(a), Math.sin(a)];
}

export function theName(n: string): string {
  if (/^(the|la|le|les|el|il)\s/i.test(n)) return n.replace(/^The /, "the ");
  const the = /^(Eiffel|Empire State|Golden Gate|Brooklyn Bridge|Sydney|Colosseum|Pantheon|Panthéon|Shard|Gherkin|London Eye|Louvre|Burj|Washington|Space Needle|Gateway|Great|Leaning|Chrysler|Flatiron|Brandenburg|Sagrada|CN Tower|Taj|Forbidden|Kremlin|Acropolis|Parthenon|Alhambra|Atomium|Little Mermaid|Rijksmuseum|Vatican|Spanish Steps|Trevi)/.test(n)
    || /^(Palace|Statue|Arc|Basilica|Church|Temple|Cathedral|Museum|Opera|Tower of|Castle|Bridge of)\b/.test(n);
  return the ? `the ${n}` : n;
}

function joinNear(lines: Pt[][], tol = 12): Pt[][] {
  const out = lines.map(l => l.slice());
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const a = out[i], b = out[j], dd = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      let c: Pt[] | null = null;
      if (dd(a[a.length - 1], b[0]) < tol) c = a.concat(b.slice(1));
      else if (dd(a[a.length - 1], b[b.length - 1]) < tol) c = a.concat(b.slice(0, -1).reverse());
      else if (dd(a[0], b[b.length - 1]) < tol) c = b.concat(a.slice(1));
      else if (dd(a[0], b[0]) < tol) c = a.slice().reverse().concat(b.slice(1));
      if (c) { out[i] = c; out.splice(j, 1); merged = true; break outer; }
    }
  }
  return out;
}
export function pointAlong(p: Pt[], s: number): Pt {
  for (let i = 1; i < p.length; i++) { const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); if (s <= l) { const t = l ? s / l : 0; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]; } s -= l; }
  return p[p.length - 1];
}

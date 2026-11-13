// Picks the window for a cell: the most "postcard" public feature inside it,
// in the PRD's order (waterfront or quay, park or plaza, landmark building,
// main street, else the cell centre), and the heading that frames it.
//
// Heading rule, as shipped: for a waterfront the camera sits on the water
// side and looks at the land, so the water fills the foreground and the
// waterfront and its skyline stand behind it. That is the framing of the
// prototype's winning New York card (looking north from the harbour at the
// Battery) and of the Naousa harbour card. Every other feature keeps the
// default heading, north.
import type { Heading, Pt, Ring } from "../../shared/bundle.ts";
import { LANDMARK_CLASSES } from "../../shared/bundle.ts";
import { absArea, centroid, distLine, grid8, inRing, len, rasterise } from "./geom.ts";
import type { OsmData } from "./sources/ofm.ts";

export interface Snap { kind: "waterfront" | "park" | "landmark" | "street" | "centre"; x: number; y: number; heading: Heading; name?: string; score: number }

const PARKISH = new Set(["park", "garden", "recreation_ground", "village_green", "playground", "pedestrian", "plaza", "square"]);

export function waterGrid(osm: OsmData, size: number, res: number) {
  const G = grid8(size, res), n = G.w;
  for (const w of osm.water) if (w.cls !== "swimming_pool") rasterise(G, w.rings, 1);
  for (const p of osm.piers) rasterise(G, p.rings, 0);
  const g = G.data;
  return { n, res, g, at: (x: number, y: number) => { const i = Math.floor(x / res), j = Math.floor(y / res); return i >= 0 && j >= 0 && i < n && j < n ? g[j * n + i] === 1 : false; } };
}

// `cell` is the cell outline in the same local frame as `osm`.
export function pickFeature(osm: OsmData, cell: Ring, size: number): Snap {
  const inCell = (x: number, y: number) => inRing(x, y, cell);
  const [cx, cy] = centroid(cell);
  const W = waterGrid(osm, size, 20);

  // 1. waterfront or quay: land points in the cell within 40 m of real water
  //    (not a pond), with a public edge (path, park or pier) nearby.
  const publicLines = osm.transport.filter(t => t.cls === "path" || t.cls === "pier" || t.sub === "pedestrian" || t.sub === "footway" || t.sub === "cycleway");
  const parks = [...osm.landcover, ...osm.landuse, ...osm.areas].filter(p => PARKISH.has(p.sub ?? "") || PARKISH.has(p.cls));
  // Built-up land ahead makes a better picture than empty land.
  const bG = grid8(size, 40);
  for (const b of osm.buildings) rasterise(bG, b.rings, 1);
  const built = (x: number, y: number) => { const i = Math.floor(x / 40), j = Math.floor(y / 40); return i >= 0 && j >= 0 && i < bG.w && j < bG.h && bG.data[j * bG.w + i] === 1; };
  const wedge = (x: number, y: number, th: number, d0: number, d1: number, f: (x: number, y: number) => boolean) => {
    let n = 0, hit = 0;
    for (let a = -3; a <= 3; a++) { const t = th + (a / 3) * (Math.PI / 5); for (let d = d0; d <= d1; d += 40) { n++; if (f(x + Math.cos(t) * d, y + Math.sin(t) * d)) hit++; } }
    return hit / n;
  };
  let best: Snap | null = null, bestN: Snap | null = null;
  for (let y = cy - 600; y <= cy + 600; y += 20) for (let x = cx - 600; x <= cx + 600; x += 20) {
    if (!inCell(x, y) || W.at(x, y)) continue;
    // real water (not a pond) within 40 m: water in several directions
    let wn = 0, near = false;
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      for (let d = 20; d <= 300; d += 20) if (W.at(x + Math.cos(th) * d, y + Math.sin(th) * d)) { wn++; if (d <= 40) near = true; break; }
    }
    if (!near || wn < 4) continue;
    // open water, not a stream: at least 15% of the ground within 200 m is water
    let wc = 0, wt = 0;
    for (let dy = -200; dy <= 200; dy += 40) for (let dx = -200; dx <= 200; dx += 40) { if (dx * dx + dy * dy > 40000) continue; wt++; if (W.at(x + dx, y + dy)) wc++; }
    if (wc / wt < 0.15) continue;
    const inPark = parks.some(p => inRing(x, y, p.rings[0]));
    const pub = inPark || publicLines.some(l => distLine(x, y, l.pts) < 35);
    if (!pub) continue;
    // the camera stands on the water and looks at the land: score each
    // heading by water in the foreground and buildings ahead
    // North is the default (PRD); another heading wins only when it frames
    // clearly more water in front and town behind.
    let bh: Heading = "N", bs = -Infinity, north = 0;
    for (const [h, th] of [["N", Math.PI / 2], ["E", 0], ["S", -Math.PI / 2], ["W", Math.PI]] as [Heading, number][]) {
      const s = wedge(x, y, th + Math.PI, 40, 480, W.at) * 1.2 + wedge(x, y, th, 80, 880, (u, v) => !W.at(u, v)) * 0.6 + wedge(x, y, th, 80, 880, built);
      if (h === "N") north = s;
      if (s > bs) { bs = s; bh = h; }
    }
    if (bh !== "N" && north >= bs - 0.3) { bh = "N"; bs = north; }
    const score = 10 + bs * 4 + (inPark ? 2 : 0) - Math.hypot(x - cx, y - cy) / 300;
    if (!best || score > best.score) best = { kind: "waterfront", x, y, heading: bh, score };
    if (bh === "N" && (!bestN || score > bestN.score)) bestN = { kind: "waterfront", x, y, heading: bh, score };
  }
  // the default heading again, across the whole cell
  if (best && bestN && best !== bestN && bestN.score >= best.score - 1.2) best = bestN;
  if (best) {
    const p = parks.filter(q => inRing(best!.x, best!.y, q.rings[0]));
    best.name = nameNear(osm, best.x, best.y, 260);
    void p;
    return best;
  }

  // 2. park or plaza: the biggest one whose centre lies in the cell
  const parkC = parks
    .map(p => ({ p, c: centroid(p.rings[0]), a: absArea(p.rings[0]) }))
    .filter(o => o.a > 1500 && inCell(o.c[0], o.c[1]))
    .sort((a, b) => b.a - a.a)[0];
  if (parkC) return { kind: "park", x: parkC.c[0], y: parkC.c[1], heading: "N", score: 5, name: nameNear(osm, parkC.c[0], parkC.c[1], 200) };

  // 3. landmark building
  const lm = osm.pois.filter(p => LANDMARK_CLASSES.has(p.cls) && !/(_stop|halt|entrance|platform)$/.test(p.sub ?? "") && p.name && inCell(p.x, p.y)).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
  if (lm) return { kind: "landmark", x: lm.x, y: lm.y, heading: "N", score: 4, name: lm.name };

  // 4. main street: middle of the longest primary-to-tertiary run in the cell
  const streets = osm.transport.filter(t => ["primary", "secondary", "tertiary", "trunk"].includes(t.cls) && t.brunnel !== "tunnel");
  let bestS: { x: number; y: number; l: number } | null = null;
  for (const s of streets) {
    const inside = s.pts.filter(([x, y]) => inCell(x, y)); if (inside.length < 2) continue;
    const l = len(inside); const m = inside[Math.floor(inside.length / 2)];
    if (!bestS || l > bestS.l) bestS = { x: m[0], y: m[1], l };
  }
  if (bestS) return { kind: "street", x: bestS.x, y: bestS.y, heading: "N", score: 3, name: nameNear(osm, bestS.x, bestS.y, 300) };

  return { kind: "centre", x: cx, y: cy, heading: "N", score: 0, name: nameNear(osm, cx, cy, 800) };
}

export function cardinal(angle: number): Heading {
  // angle: math convention (0 = east, pi/2 = north)
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (a < Math.PI / 4 || a >= (7 * Math.PI) / 4) return "E";
  if (a < (3 * Math.PI) / 4) return "N";
  if (a < (5 * Math.PI) / 4) return "W";
  return "S";
}
export function forward(h: Heading): Pt { return h === "N" ? [0, 1] : h === "S" ? [0, -1] : h === "E" ? [1, 0] : [-1, 0]; }

// The nearest public name: a park, square, landmark or place, never an address.
export function nameNear(osm: OsmData, x: number, y: number, r: number): string | undefined {
  // parks and harbours name a place better than a garden or a monument in them
  const weight = (c: string) => (c === "park" ? 0 : c === "marina" || c === "beach" || c === "harbour" ? 0.2 : c === "garden" ? 0.8 : ["monument", "attraction", "artwork", "memorial"].includes(c) ? 2 : 1);
  const stop = (sub?: string) => !!sub && /(_stop|halt|entrance|platform|stop_position|bus_station)$/.test(sub);
  const good = (c: string, sub?: string) => (LANDMARK_CLASSES.has(c) && !stop(sub)) || weight(c) < 1;
  const cost = (p: { x: number; y: number; cls: string }) => weight(p.cls) + Math.hypot(p.x - x, p.y - y) / r;
  const cands = osm.pois.filter(p => p.name && good(p.cls, p.sub) && Math.hypot(p.x - x, p.y - y) < r).sort((a, b) => cost(a) - cost(b));
  if (cands[0]) return cands[0].name;
  const pl = osm.places.filter(p => p.name && ["neighbourhood", "quarter", "suburb", "village", "hamlet", "town"].includes(p.cls) && Math.hypot(p.x - x, p.y - y) < r * 3)
    .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  return pl[0]?.name;
}

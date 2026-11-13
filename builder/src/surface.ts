// Land cover, colour and trees: the satellite half of the builder. Imagery
// is read, never shown. It decides what covers the ground where OSM is blank,
// what colour each region really is this month, where the snow and the bare
// earth are, and where each tree stands.
import type { Cover, Pt, RGB, Ring, Tree } from "../../shared/bundle.ts";
import { absArea, blur, bbox, centroid, grid, grid8, rasterise, ringsToPolygons, simplify, trace, type Grid } from "./geom.ts";
import type { OsmData, OsmPoly } from "./sources/ofm.ts";
import { WC, type Sentinel } from "./sources/rasters.ts";

// OSM (OpenMapTiles) classes to the painter's cover types
export function osmCoverType(p: OsmPoly, kind: string): string | null {
  const c = p.cls, s = p.sub ?? "";
  if (c === "grass") {
    if (["park", "recreation_ground", "village_green", "dog_park"].includes(s)) return "park";
    if (s === "garden") return "yard";
    if (s === "golf_course") return "park";
    if (s === "meadow" || s === "grassland") return kind === "country" || kind === "mountain" ? "pasture" : "grass";
    return "grass";
  }
  if (c === "farmland") return s === "orchard" || s === "vineyard" ? "grove" : s === "meadow" ? "pasture" : "field";
  if (c === "wood" || c === "forest") return "forest";
  if (c === "sand" || s === "beach") return "sand";
  if (c === "rock") return "rock";
  if (c === "ice" || s === "glacier") return "snow";
  if (c === "wetland") return "wetland";
  if (c === "farmyard") return "farmyard";
  if (c === "cemetery") return "cemetery";
  if (c === "pitch") return "pitch";
  if (c === "track") return "track";
  if (c === "playground") return "plaza";
  if (c === "path" && (s === "pedestrian" || s === "footway")) return "plaza";
  if (c === "swimming_pool") return "pool";
  if (c === "parking") return "parking";
  return null;
}

const WC_TYPE: Record<number, string> = { [WC.tree]: "forest", [WC.shrub]: "scrub", [WC.grass]: "grass", [WC.crop]: "field", [WC.bare]: "bare", [WC.snow]: "snow", [WC.wetland]: "wetland", [WC.mangrove]: "forest", [WC.moss]: "grass" };

function longAxis(r: Ring): number {
  // principal axis of the vertices
  const [cx, cy] = centroid(r); let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of r) { const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

export function median(vals: number[]): number { if (!vals.length) return NaN; const s = vals.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

export function sampleColour(s2: Sentinel | null, poly: Ring[], size: number): RGB | null {
  if (!s2) return null;
  const n = s2.clear.w, res = s2.clear.res;
  const m = grid8(size, res); rasterise(m, poly, 1);
  const R: number[] = [], G: number[] = [], B: number[] = [];
  for (let k = 0; k < n * n; k++) if (m.data[k] && s2.clear.data[k]) { R.push(s2.rgb[0].data[k]); G.push(s2.rgb[1].data[k]); B.push(s2.rgb[2].data[k]); }
  if (R.length < 3) {
    // too small for 10 m pixels: take the nearest clear pixel to its centre
    const [x, y] = centroid(poly[0]); const i = Math.floor(x / res), j = Math.floor(y / res);
    if (i < 0 || j < 0 || i >= n || j >= n || !s2.clear.data[j * n + i]) return null;
    const k = j * n + i; return [s2.rgb[0].data[k], s2.rgb[1].data[k], s2.rgb[2].data[k]];
  }
  return [median(R), median(G), median(B)];
}

interface Ctx { size: number; kind: string; osm: OsmData; wc: Grid<Uint8Array> | null; s2: Sentinel | null; water: (x: number, y: number) => boolean; notes: string[] }

// Covers: OSM first, then WorldCover (split by Sentinel-2 colour for fields)
// wherever OSM left the ground blank, then snow and bare earth from the
// imagery on top.
export function buildCovers(c: Ctx): Cover[] {
  const { size, osm } = c;
  const out: Cover[] = [];
  const res = c.kind === "dense" ? 4 : c.kind === "suburb" ? 5 : 10;
  const claimed = grid8(size, res);
  const add = (type: string, poly: Ring[], colour: RGB | null, angle?: number) => {
    for (const r of [poly[0]]) {
      const tol = type === "pool" || type === "pitch" || type === "track" ? 0.3 : 1;
      const ring = simplify(r, tol, true);
      if (ring.length < 3 || absArea(ring) < (type === "pool" ? 6 : 40)) continue;
      out.push({ type, poly: ring, colour, ...(angle !== undefined ? { angle } : {}) });
    }
  };
  const osmPolys: { type: string; p: OsmPoly }[] = [];
  for (const p of [...osm.landcover, ...osm.landuse, ...osm.areas]) { const t = osmCoverType(p, c.kind); if (t) osmPolys.push({ type: t, p }); }
  for (const w of osm.water) if (w.cls === "swimming_pool") osmPolys.push({ type: "pool", p: w });
  // big first, so small ones paint over them
  osmPolys.sort((a, b) => absArea(b.p.rings[0]) - absArea(a.p.rings[0]));
  for (const { type, p } of osmPolys) {
    rasterise(claimed, p.rings, 1);
    const col = type === "pool" ? null : sampleColour(c.s2, p.rings, size);
    add(type, p.rings, col, type === "field" || type === "grove" ? longAxis(p.rings[0]) : undefined);
  }
  for (const b of osm.buildings) rasterise(claimed, b.rings, 1);

  // WorldCover where OSM is blank
  if (c.wc) {
    const wc = c.wc, n = claimed.w;
    const classes = new Map<number, Grid<Float32Array>>();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * res, y = (j + 0.5) * res;
      if (claimed.data[j * n + i] || c.water(x, y)) continue;
      const wi = Math.floor(x / wc.res), wj = Math.floor(y / wc.res);
      if (wi < 0 || wj < 0 || wi >= wc.w || wj >= wc.h) continue;
      const v = wc.data[wj * wc.w + wi];
      if (!WC_TYPE[v]) continue;
      let g = classes.get(v); if (!g) { g = grid(size, res); classes.set(v, g); }
      g.data[j * n + i] = 1;
    }
    for (const [v, g] of classes) {
      const type = WC_TYPE[v];
      if (type === "field" && c.s2) { out.push(...splitFields(g, c.s2, size, res)); continue; }
      const rings = trace(blur(g, 1, 2), 0.5, res * res * 8);
      for (const poly of ringsToPolygons(rings)) add(type, poly, sampleColour(c.s2, poly, size));
    }
  }

  // snow and bare earth from the imagery itself
  if (c.s2) {
    const s2 = c.s2, n = s2.clear.w, sres = s2.clear.res;
    const snow = grid(size, sres), bare = grid(size, sres);
    let snowN = 0, landN = 0;
    for (let k = 0; k < n * n; k++) {
      const x = ((k % n) + 0.5) * sres, y = (Math.floor(k / n) + 0.5) * sres;
      if (c.water(x, y) || !s2.clear.data[k]) continue;
      landN++;
      if (s2.snow.data[k]) { snow.data[k] = 1; snowN++; }
      const wcv = c.wc ? c.wc.data[Math.floor(y / c.wc.res) * c.wc.w + Math.floor(x / c.wc.res)] : 0;
      if (s2.bare.data[k] && (wcv === WC.grass || wcv === WC.crop || wcv === WC.shrub)) bare.data[k] = 1;
    }
    if (snowN > 0) for (const poly of ringsToPolygons(trace(blur(snow, 1, 1), 0.5, 1500))) add("snow", poly, null);
    for (const poly of ringsToPolygons(trace(blur(bare, 1, 1), 0.55, 2500))) add("bare", poly, sampleColour(s2, poly, size));
    c.notes.push(`snow ${(100 * snowN / Math.max(1, landN)).toFixed(0)}% of clear land`);
  }
  return out;
}

// Farmland from imagery alone: cluster the field pixels by their real colour
// this month (stubble, green crop, ploughed earth, pivots) and trace each
// cluster, so the patchwork follows the ground.
function splitFields(mask: Grid<Float32Array>, s2: Sentinel, size: number, res: number): Cover[] {
  const n = mask.w, pts: number[] = [], px: [number, number, number][] = [];
  for (let k = 0; k < n * n; k++) {
    if (!mask.data[k]) continue;
    const x = ((k % n) + 0.5) * res, y = (Math.floor(k / n) + 0.5) * res;
    const i = Math.floor(x / s2.clear.res), j = Math.floor(y / s2.clear.res), sn = s2.clear.w;
    if (i < 0 || j < 0 || i >= sn || j >= sn) continue;
    const q = j * sn + i; if (!s2.clear.data[q]) continue;
    pts.push(k); px.push([s2.rgb[0].data[q], s2.rgb[1].data[q], s2.rgb[2].data[q]]);
  }
  if (pts.length < 50) return [];
  // k-means, k = 4, seeded deterministically by brightness quantiles
  const K = 4; const order = px.map((p, i) => [p[0] + p[1] + p[2], i]).sort((a, b) => a[0] - b[0]);
  let cent = Array.from({ length: K }, (_, k) => px[order[Math.floor(((k + 0.5) / K) * order.length)][1]].slice() as RGB);
  const lab = new Uint8Array(px.length);
  for (let it = 0; it < 8; it++) {
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      let bk = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { const d = (px[i][0] - cent[k][0]) ** 2 + (px[i][1] - cent[k][1]) ** 2 + (px[i][2] - cent[k][2]) ** 2; if (d < bd) { bd = d; bk = k; } }
      lab[i] = bk; const s = sum[bk]; s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    cent = sum.map((s, k) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cent[k]) as RGB);
  }
  const out: Cover[] = [];
  for (let k = 0; k < K; k++) {
    const g = grid(size, res);
    for (let i = 0; i < pts.length; i++) if (lab[i] === k) g.data[pts[i]] = 1;
    for (const poly of ringsToPolygons(trace(blur(g, 1, 1), 0.5, res * res * 12))) {
      const ring = simplify(poly[0], res * 0.6, true); if (ring.length < 3) continue;
      // stripes along the field's long axis
      const [x0, y0, x1, y1] = bbox(ring);
      out.push({ type: "field", poly: ring, colour: cent[k].map(Math.round) as RGB, angle: (x1 - x0) > (y1 - y0) ? 0 : Math.PI / 2 });
    }
  }
  return out;
}

// Trees from canopy-height peaks: local maxima at least 3 m tall and 4 m
// apart. Each peak becomes a tree with its real height, a crown radius from
// the canopy blob around it, a broadleaf or conifer look, and the colour of
// the imagery under it.
export function placeTrees(canopy: Grid<Float32Array> | null, s2: Sentinel | null, opts: { lat: number; elev: (x: number, y: number) => number; month: number; priority: (x: number, y: number) => number; cap: number; water: (x: number, y: number) => boolean }): Tree[] {
  if (!canopy) return [];
  const { w, h, res, data } = canopy;
  const sep = Math.max(1, Math.round(4 / res));
  const peaks: { i: number; j: number; v: number }[] = [];
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const v = data[j * w + i]; if (v < 3) continue;
    let top = true;
    for (let dj = -sep; dj <= sep && top; dj++) for (let di = -sep; di <= sep; di++) {
      if (!di && !dj) continue; const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const u = data[jj * w + ii]; if (u > v || (u === v && (dj < 0 || (dj === 0 && di < 0)))) { top = false; break; }
    }
    if (top) peaks.push({ i, j, v });
  }
  const leafOff = (opts.lat >= 0 ? [11, 12, 1, 2, 3] : [5, 6, 7, 8, 9]).includes(opts.month);
  const trees: Tree[] = [];
  for (const p of peaks) {
    const x = (p.i + 0.5) * res, y = (p.j + 0.5) * res;
    if (opts.water(x, y)) continue;
    // crown: average distance to where the canopy falls below 60% of the peak
    let rs = 0;
    for (let a = 0; a < 8; a++) {
      const dx = Math.cos((a * Math.PI) / 4), dy = Math.sin((a * Math.PI) / 4); let d = 1;
      for (; d < 12 / res; d++) { const ii = Math.round(p.i + dx * d), jj = Math.round(p.j + dy * d); if (ii < 0 || jj < 0 || ii >= w || jj >= h || data[jj * w + ii] < p.v * 0.6) break; }
      rs += d * res;
    }
    const r = Math.max(1.6, Math.min(rs / 8, p.v * 0.45 + 1, 9));
    let colour: RGB = [82, 120, 84];
    let leafy = true;
    if (s2) {
      const n = s2.clear.w, i = Math.floor(x / s2.clear.res), j = Math.floor(y / s2.clear.res);
      const R: number[] = [], G: number[] = [], B: number[] = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const k = jj * n + ii; if (!s2.clear.data[k]) continue;
        R.push(s2.rgb[0].data[k]); G.push(s2.rgb[1].data[k]); B.push(s2.rgb[2].data[k]);
      }
      if (R.length) colour = [median(R), median(G), median(B)];
      const k = j * n + i; if (i >= 0 && j >= 0 && i < n && j < n && s2.clear.data[k]) leafy = !s2.bare.data[k] && colour[1] >= colour[0];
    }
    const elev = opts.elev(x, y);
    const slim = r / p.v < 0.2;
    const conifer = elev > 1100 || Math.abs(opts.lat) > 58 || (slim && p.v > 12) || (leafOff && leafy && colour[1] < 80);
    trees.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, h: Math.round(p.v * 10) / 10, r: Math.round(r * 10) / 10, kind: conifer ? "conifer" : "broadleaf", colour: colour.map(Math.round) as RGB });
  }
  // cap: visible window first, then tallest
  trees.sort((a, b) => opts.priority(b.x, b.y) - opts.priority(a.x, a.y) || b.h - a.h);
  return trees.slice(0, opts.cap);
}

export function polysToRings(polys: Ring[][]): Ring[] { return polys.map(p => p[0]); }
export type { Pt };

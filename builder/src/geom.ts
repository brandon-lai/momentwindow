// Plane geometry for the builder: clipping, simplifying, rasterising and
// tracing outlines out of rasters. All in local metres.
import type { Pt, Ring } from "../../shared/bundle.ts";

export function area(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // positive = counter-clockwise
}
export const absArea = (r: Ring) => Math.abs(area(r));
export function centroid(r: Ring): Pt {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f; a += f;
  }
  if (Math.abs(a) < 1e-9) { let sx = 0, sy = 0; for (const p of r) { sx += p[0]; sy += p[1]; } return [sx / r.length, sy / r.length]; }
  return [x / (3 * a), y / (3 * a)];
}
export function inRing(x: number, y: number, r: Ring): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
export function inPolygon(x: number, y: number, poly: Ring[]): boolean {
  if (!poly.length || !inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false;
  return true;
}
export function bbox(r: Ring | Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
export function len(p: Pt[]): number { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; }
export function distSeg(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
export function distLine(x: number, y: number, p: Pt[]): number { let m = Infinity; for (let i = 1; i < p.length; i++) m = Math.min(m, distSeg(x, y, p[i - 1], p[i])); return m; }

// Sutherland-Hodgman against an axis-aligned rectangle. Concave input can
// produce zero-width bridges along the clip edge; they fill nothing, which is
// all a painter cares about.
export function clipRing(ring: Ring, x0: number, y0: number, x1: number, y1: number): Ring {
  let out: Ring = ring;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    if (!src.length) break;
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
      else if (pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

// Splits a polyline into the runs that lie inside the rectangle.
export function clipLine(line: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[][] {
  const inside = (p: Pt) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const runs: Pt[][] = []; let run: Pt[] = [];
  const cut = (a: Pt, b: Pt): Pt => {
    // Liang-Barsky style: step from a toward b to the border
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as const) {
      if (p === 0) continue; const r = q / p;
      if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    }
    const t = inside(a) ? t1 : t0;
    return [a[0] + dx * t, a[1] + dy * t];
  };
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (inside(p)) {
      if (!run.length && i > 0) run.push(cut(line[i - 1], p));
      run.push(p);
    } else {
      if (run.length) { run.push(cut(line[i - 1], p)); runs.push(run); run = []; }
      else if (i > 0) {
        // segment may pass through the box with both ends outside
        const a = line[i - 1];
        const c0 = cut(a, p);
        if (inside([(c0[0] + p[0]) / 2, (c0[1] + p[1]) / 2]) && Math.hypot(c0[0] - p[0], c0[1] - p[1]) > 1e-6) {
          const c1 = cut(p, a); runs.push([c1, c0].sort((u, v) => Math.hypot(u[0] - a[0], u[1] - a[1]) - Math.hypot(v[0] - a[0], v[1] - a[1])) as Pt[]);
        }
      }
    }
  }
  if (run.length > 1) runs.push(run);
  return runs.filter(r => r.length > 1);
}

export function simplify(pts: Pt[], tol: number, closed = false): Pt[] {
  if (pts.length <= 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!; let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = distSeg(pts[i][0], pts[i][1], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = pts.filter((_, i) => keep[i]);
  return closed && out.length < 3 ? pts.slice(0, 3) : out;
}

export const round1 = (v: number) => Math.round(v * 10) / 10;
export const roundPts = (p: Pt[]): Pt[] => p.map(([x, y]) => [round1(x), round1(y)]);

// A raster over the scene square: cell (i, j) covers x in [i*res, (i+1)*res),
// y in [j*res, ...). Row 0 is the south edge.
export interface Grid<T extends Float32Array | Uint8Array | Uint16Array = Float32Array> { w: number; h: number; res: number; data: T }
export function grid(size: number, res: number): Grid<Float32Array> { const w = Math.ceil(size / res), h = w; return { w, h, res, data: new Float32Array(w * h) }; }
export function grid8(size: number, res: number): Grid<Uint8Array> { const w = Math.ceil(size / res), h = w; return { w, h, res, data: new Uint8Array(w * h) }; }

// Even-odd scanline fill of polygons into a byte grid.
export function rasterise(g: Grid<Uint8Array>, poly: Ring[], value = 1): void {
  const [x0, y0, x1, y1] = bbox(poly[0]);
  const j0 = Math.max(0, Math.floor(y0 / g.res)), j1 = Math.min(g.h - 1, Math.ceil(y1 / g.res));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = (j + 0.5) * g.res; xs.length = 0;
    for (const r of poly) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const a = r[k], b = r[i];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil(xs[n] / g.res - 0.5)), i1 = Math.min(g.w - 1, Math.floor(xs[n + 1] / g.res - 0.5));
      for (let i = i0; i <= i1; i++) g.data[j * g.w + i] = value;
    }
  }
  void x0; void x1;
}

// Box blur (separable, repeated) over a float grid; used to soften raster
// classes before tracing them, so outlines come out as washes, not stairs.
export function blur(g: Grid<Float32Array>, r: number, passes = 2): Grid<Float32Array> {
  const { w, h } = g; let a = Float32Array.from(g.data), b = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) { let s = 0, n = 0; for (let x = -r; x < w + r; x++) { if (x + r < w) { s += a[y * w + x + r]; n++; } if (x - r - 1 >= 0) { s -= a[y * w + x - r - 1]; n--; } if (x >= 0 && x < w) b[y * w + x] = s / n; } }
    for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let y = -r; y < h + r; y++) { if (y + r < h) { s += b[(y + r) * w + x]; n++; } if (y - r - 1 >= 0) { s -= b[(y - r - 1) * w + x]; n--; } if (y >= 0 && y < h) a[y * w + x] = s / n; } }
  }
  return { w, h, res: g.res, data: a };
}

// Marching squares at `iso`, returning closed rings in local metres. Cells
// outside the grid count as below iso, so every contour closes.
export function trace(g: Grid<Float32Array>, iso = 0.5, minArea = 0): Ring[] {
  const { w, h, res, data } = g;
  const v = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : data[j * w + i]);
  // edge id -> point; segments as pairs of edge ids
  const pt = new Map<number, Pt>(); const next = new Map<number, number>();
  const W = w + 2;
  const eid = (i: number, j: number, horiz: boolean) => ((j + 1) * W + (i + 1)) * 2 + (horiz ? 0 : 1);
  const interp = (a: number, b: number) => (iso - a) / (b - a || 1e-9);
  for (let j = -1; j < h; j++) for (let i = -1; i < w; i++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1); // sw se ne nw (cell centres)
    const k = (a >= iso ? 1 : 0) | (b >= iso ? 2 : 0) | (c >= iso ? 4 : 0) | (d >= iso ? 8 : 0);
    if (k === 0 || k === 15) continue;
    const cx = (i + 0.5) * res, cy = (j + 0.5) * res;
    const S = eid(i, j, true), E = eid(i + 1, j, false), N = eid(i, j + 1, true), Wd = eid(i, j, false);
    const put = (id: number) => {
      if (pt.has(id)) return;
      if (id === S) pt.set(id, [cx + interp(a, b) * res, cy]);
      else if (id === N) pt.set(id, [cx + interp(d, c) * res, cy + res]);
      else if (id === Wd) pt.set(id, [cx, cy + interp(a, d) * res]);
      else pt.set(id, [cx + res, cy + interp(b, c) * res]);
    };
    // segments oriented with the inside on the left (counter-clockwise outer rings)
    const seg = (p: number, q: number) => { put(p); put(q); next.set(p, q); };
    switch (k) {
      case 1: seg(S, Wd); break; case 2: seg(E, S); break; case 3: seg(E, Wd); break;
      case 4: seg(N, E); break; case 5: seg(S, Wd); seg(N, E); break; case 6: seg(N, S); break;
      case 7: seg(N, Wd); break; case 8: seg(Wd, N); break; case 9: seg(S, N); break;
      case 10: seg(E, S); seg(Wd, N); break; case 11: seg(E, N); break; case 12: seg(Wd, E); break;
      case 13: seg(S, E); break; case 14: seg(Wd, S); break;
    }
  }
  const rings: Ring[] = []; const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring: Ring = []; let cur: number | undefined = start;
    while (cur !== undefined && !seen.has(cur)) { seen.add(cur); ring.push(pt.get(cur)!); cur = next.get(cur); }
    if (ring.length >= 3 && Math.abs(area(ring)) >= minArea) rings.push(ring);
  }
  return rings;
}

// Groups traced rings into polygons: counter-clockwise rings are outers,
// clockwise ones holes, each hole going to the smallest outer containing it.
export function ringsToPolygons(rings: Ring[]): Ring[][] {
  const outers = rings.filter(r => area(r) > 0).sort((a, b) => absArea(a) - absArea(b));
  const polys: Ring[][] = outers.map(o => [o]);
  for (const hole of rings.filter(r => area(r) < 0)) {
    const [x, y] = hole[0];
    const k = outers.findIndex(o => inRing(x, y, o));
    if (k >= 0) polys[k].push(hole);
  }
  return polys;
}

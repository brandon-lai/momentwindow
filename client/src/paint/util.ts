// Ported from the prototype ("Moment Terrain Tests"): randomness, canvases,
// pigment, paper and layered washes. Canvases are OffscreenCanvas wherever
// they exist, so the same code paints in a Web Worker or on the page.
export const CW = 1050, CH = 700, M = 26; // logical card size and taped margin
export const PI = Math.PI;

export function mulberry32(a: number) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let R = mulberry32(1);
export function reseed(s: number) { R = mulberry32(s); }
export const rnd = () => R();
export const range = (a: number, b: number) => a + (b - a) * R();
export function gauss() { let u = 0; while (u === 0) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * PI * R()); }
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
export type C3 = [number, number, number];
export const rgb = (c: number[], a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
export const mix = (a: number[], b: number[], t: number): C3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const mul = (a: number[], k: number): C3 => [a[0] * k, a[1] * k, a[2] * k];
export function hex(h: string): C3 | null { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

// The PRD's colour rule: keep the place's real hue and season, pulled 60%
// toward the palette. Done in hue / saturation / lightness: the hue moves 60%
// toward the palette's, saturation is capped near the palette's (satellite
// samples of water and shade are dark and very saturated once lifted), and
// the lightness stays the palette's, so the washes stay watercolour.
export function pull(sample: number[] | null | undefined, pal: number[], k = 0.6): C3 {
  if (!sample) return pal.slice(0, 3) as C3;
  const [hs, ss] = hsl(sample), [hp, sp, lp] = hsl(pal);
  let dh = hs - hp; if (dh > 0.5) dh -= 1; if (dh < -0.5) dh += 1;
  const h = (hp + dh * (1 - k) + 1) % 1;
  const sCap = Math.min(ss, sp * 1.25 + 0.04);
  const sat = sp + (sCap - sp) * (1 - k);
  return fromHsl(ss < 0.06 ? hp : h, sat, lp);
}
function hsl(c: number[]): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): C3 {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export type Cnv = OffscreenCanvas | HTMLCanvasElement;
export type G2 = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export const hasOffscreen = typeof OffscreenCanvas !== "undefined";
export function canvas(w: number, h: number): Cnv {
  if (hasOffscreen) return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c;
}
export const cx = (c: Cnv) => c.getContext("2d") as G2;
export function ident(g: G2) { g.setTransform(1, 0, 0, 1, 0, 0); return g; }

// Screen-space canvases are CW x CH logical, times the device scale.
export let SC = 1;
export function setScale(s: number) { SC = s; }
export function screen(): Cnv { const c = canvas(Math.round(CW * SC), Math.round(CH * SC)); const g = cx(c); g.setTransform(SC, 0, 0, SC, 0, 0); return c; }
export function base(g: G2) { g.setTransform(SC, 0, 0, SC, 0, 0); return g; }

export function softBlur(src: Cnv, k: number): Cnv {
  const sw = Math.max(1, Math.round(src.width / k)), sh = Math.max(1, Math.round(src.height / k));
  const s = canvas(sw, sh), sc = cx(s);
  sc.imageSmoothingQuality = "high"; sc.drawImage(src, 0, 0, sw, sh);
  const s2 = canvas(Math.max(1, sw >> 1), Math.max(1, sh >> 1)), s2c = cx(s2);
  s2c.imageSmoothingQuality = "high"; s2c.drawImage(s, 0, 0, s2.width, s2.height);
  sc.clearRect(0, 0, sw, sh); sc.drawImage(s2, 0, 0, sw, sh);
  const out = canvas(src.width, src.height), oc = cx(out);
  oc.imageSmoothingQuality = "high"; oc.drawImage(s, 0, 0, src.width, src.height);
  return out;
}
export function colorize(mask: Cnv, c: number[], alpha = 1): Cnv {
  const o = canvas(mask.width, mask.height), g = cx(o);
  g.drawImage(mask, 0, 0); g.globalCompositeOperation = "source-in";
  g.fillStyle = rgb(c, alpha); g.fillRect(0, 0, o.width, o.height);
  return o;
}
export function clipTo(layer: Cnv, mask: Cnv) { const g = cx(layer); g.save(); ident(g); g.globalCompositeOperation = "destination-in"; g.drawImage(mask, 0, 0, layer.width, layer.height); g.restore(); }
export function rimOf(mask: Cnv, k: number): Cnv {
  const blurred = softBlur(mask, k);
  const r = canvas(mask.width, mask.height), g = cx(r);
  g.drawImage(mask, 0, 0); g.globalCompositeOperation = "destination-out"; g.drawImage(blurred, 0, 0);
  return r;
}
export function alphaGrid(c: Cnv, gw: number, gh: number): Uint8Array {
  const s = canvas(gw, gh), g = cx(s); g.drawImage(c, 0, 0, gw, gh);
  const d = g.getImageData(0, 0, gw, gh).data, out = new Uint8Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) out[i] = d[i * 4 + 3];
  return out;
}

// tileable noise
function periodicNoise(period: number, seed: number) {
  const r = mulberry32(seed), g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const s = xf * xf * (3 - 2 * xf), t = yf * yf * (3 - 2 * yf);
    const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * s + (c - a) * t + (a - b - c + d) * s * t;
  };
}
export function fbmTile(size: number, basePeriod: number, octaves: number, seed: number) {
  const fns: ((x: number, y: number) => number)[] = []; for (let o = 0; o < octaves; o++) fns.push(periodicNoise(basePeriod << o, seed + o * 97));
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0, amp = 0.5, tot = 0;
    for (let o = 0; o < octaves; o++) { const p = basePeriod << o; v += amp * fns[o](x / size * p, y / size * p); tot += amp; amp *= 0.5; }
    out[y * size + x] = v / tot;
  }
  return out;
}

// pigment and paper
const PIG = 256;
let pigNoise: Float32Array | null = null, toothNoise: Float32Array | null = null;
const tileCache = new Map<string, Cnv>();
function pigmentTile(c: number[]): Cnv {
  const k = c.map(Math.round).join(",");
  const hit = tileCache.get(k); if (hit) return hit;
  if (!pigNoise) { pigNoise = fbmTile(PIG, 3, 5, 1112 * 7 + 3); toothNoise = fbmTile(PIG, 64, 2, 1112 * 13 + 5); }
  const t = canvas(PIG, PIG), g = cx(t), img = g.createImageData(PIG, PIG), d = img.data;
  for (let i = 0; i < PIG * PIG; i++) {
    const a = clamp(0.8 + (pigNoise[i] - 0.5) * 0.7 + (toothNoise![i] - 0.5) * 0.12, 0.35, 1);
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = a * 255;
  }
  g.putImageData(img, 0, 0); tileCache.set(k, t); if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value!);
  return t;
}
const patCache = new WeakMap<G2, Map<string, CanvasPattern>>();
export function pat(g: G2, c: number[]): CanvasPattern {
  let m = patCache.get(g); if (!m) { m = new Map(); patCache.set(g, m); }
  const k = c.map(Math.round).join(",");
  let p = m.get(k); if (!p) { p = g.createPattern(pigmentTile(c) as any, "repeat")!; m.set(k, p); }
  return p;
}
export function jiggle(p: CanvasPattern, scale = 1) {
  const a = range(0, PI * 2), s = range(1.6, 3.2) * scale;
  p.setTransform(new DOMMatrix([Math.cos(a) * s, Math.sin(a) * s, -Math.sin(a) * s, Math.cos(a) * s, range(0, 256), range(0, 256)]));
}
let paperTex: Cnv | null = null, toothSpeckle: Cnv | null = null;
function buildPaper() {
  const S = 512, fiber = fbmTile(S, 4, 5, 11), tooth = fbmTile(S, 128, 2, 23);
  const pc = canvas(S, S), pg = cx(pc), img = pg.createImageData(S, S), d = img.data;
  const sp = canvas(S, S), sg = cx(sp), simg = sg.createImageData(S, S), sd = simg.data;
  for (let i = 0; i < S * S; i++) {
    const v = 255 * (1 - 0.05 * fiber[i] - 0.07 * Math.max(0, tooth[i] - 0.45));
    d[i * 4] = v; d[i * 4 + 1] = v * 0.998; d[i * 4 + 2] = v * 0.99; d[i * 4 + 3] = 255;
    const k = clamp((tooth[i] - 0.55) * 2.2, 0, 1) * clamp(fiber[i] * 1.6 - 0.3, 0, 1);
    sd[i * 4 + 3] = k * 255;
  }
  pg.putImageData(img, 0, 0); sg.putImageData(simg, 0, 0);
  paperTex = pc; toothSpeckle = sp;
}
export function paper(): Cnv { if (!paperTex) buildPaper(); return paperTex!; }
export function granulate(layer: Cnv, amount: number) {
  if (!toothSpeckle) buildPaper();
  const g = cx(layer); g.save(); ident(g); g.globalCompositeOperation = "destination-out"; g.globalAlpha = amount;
  g.fillStyle = g.createPattern(toothSpeckle as any, "repeat")!; g.fillRect(0, 0, layer.width, layer.height); g.restore();
}
// paper frame round the window and the paper's grain over everything
export function finishPaper(g: G2, paperCol: number[]) {
  base(g); g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  g.fillStyle = rgb(paperCol); g.beginPath(); g.rect(0, 0, CW, CH); g.rect(M, M, CW - 2 * M, CH - 2 * M); g.fill("evenodd");
  g.globalCompositeOperation = "multiply"; g.fillStyle = g.createPattern(paper() as any, "repeat")!; g.fillRect(0, 0, CW, CH);
  g.globalCompositeOperation = "source-over";
}

// layered-wash shapes
export interface VP { x: number; y: number; v: number }
export function withVar(pts: number[][], v: number): VP[] { return pts.map(p => ({ x: p[0], y: p[1], v })); }
export function deform(pts: VP[], depth: number): VP[] {
  let cur = pts;
  for (let d = 0; d < depth; d++) {
    const out: VP[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      out.push({ x: a.x, y: a.y, v: a.v * range(0.7, 0.95) });
      out.push({ x: (a.x + b.x) / 2 + gauss() * len * a.v * 0.5, y: (a.y + b.y) / 2 + gauss() * len * a.v * 0.5, v: a.v * range(0.7, 0.95) });
    }
    cur = out;
  }
  return cur;
}
export function tracePoly(g: G2, pts: { x: number; y: number }[]) { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.closePath(); }
export function fillPoly(g: G2, pts: { x: number; y: number }[]) { tracePoly(g, pts); g.fill(); }
export function traceArr(g: G2, p: number[][]) { g.beginPath(); g.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]); g.closePath(); }
export function blob(x: number, y: number, r: number, v: number, n = 10): VP[] {
  const pts: VP[] = [];
  for (let i = 0; i < n; i++) { const a = i / n * PI * 2 + range(-0.2, 0.2); const rr = r * range(0.75, 1.2); pts.push({ x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr, v: v * range(0.7, 1.3) }); }
  return pts;
}
export function wash(g: G2, baseP: VP[], p: CanvasPattern, layers: number, alpha: number, depth = 2, pscale = 1) {
  g.fillStyle = p;
  for (let l = 0; l < layers; l++) { jiggle(p, pscale); g.globalAlpha = alpha; fillPoly(g, deform(baseP, depth)); }
  g.globalAlpha = 1;
}

// geometry
export type P2 = [number, number];
export function polyArea(p: number[][]) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }
export const ccw = (p: P2[]) => polyArea(p) < 0 ? p.slice().reverse() : p;
export function centroid(p: number[][]): P2 { let x = 0, y = 0; for (const q of p) { x += q[0]; y += q[1]; } return [x / p.length, y / p.length]; }
export function regPoly(x: number, y: number, r: number, n: number, a0 = 0): P2[] { const o: P2[] = []; for (let i = 0; i < n; i++) { const a = a0 + i / n * PI * 2; o.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); } return o; }
export function inPoly(x: number, y: number, p: number[][]) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }
export function polyLen(p: number[][]) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; }
export function pointAt(p: number[][], s: number): [number, number, number] {
  if (p.length < 2) return [p[0][0], p[0][1], 0];
  if (s <= 0) { const a = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]); return [p[0][0], p[0][1], a]; }
  for (let i = 1; i < p.length; i++) {
    const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (s <= l || i === p.length - 1) { const t = l ? clamp(s / l, 0, 1) : 0; return [lerp(p[i - 1][0], p[i][0], t), lerp(p[i - 1][1], p[i][1], t), Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0])]; }
    s -= l;
  }
  return [p[p.length - 1][0], p[p.length - 1][1], 0];
}
export function offsetLine(p: number[][], d: number): P2[] {
  return p.map((q, i) => { const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)]; const tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; return [q[0] - ty / l * d, q[1] + tx / l * d] as P2; });
}
export function distSeg(x: number, y: number, a: number[], b: number[]) { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); }
export function distLine(x: number, y: number, p: number[][]) { let m = Infinity; for (let i = 1; i < p.length; i++) m = Math.min(m, distSeg(x, y, p[i - 1], p[i])); return m; }
export function sampleLine(p: number[][], step: number) { const L = polyLen(p), o: [number, number, number][] = []; for (let s = 0; s <= L; s += step) o.push(pointAt(p, s)); return o; }
export function hull(pts: number[][]): P2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]) as P2[];
  if (p.length < 3) return p;
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], up: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
// smallest-area enclosing rectangle (rotating calipers over the hull), with
// edge 0-1 the long side: gable ridges run along it
export function minRect(poly: number[][]): P2[] {
  const h = hull(poly); if (h.length < 3) return h;
  let best: P2[] = [], bestA = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of h) { const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (A < bestA) {
      bestA = A;
      const W = u1 - u0, D = v1 - v0;
      const corners: [number, number][] = W >= D ? [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] : [[u1, v0], [u1, v1], [u0, v1], [u0, v0]];
      best = corners.map(([u, v]) => [u * c - v * s, u * s + v * c]);
    }
  }
  return ccw(best);
}

export function sunPos(utcMs: number, lat: number, lon: number) {
  const rad = PI / 180, d = (utcMs - Date.UTC(2000, 0, 1, 12)) / 864e5;
  const g = (357.529 + 0.98560028 * d) % 360, q = (280.459 + 0.98564736 * d) % 360;
  const L = q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad), e = 23.439 - 0.00000036 * d;
  const ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad)) / rad;
  const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad)) / rad;
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (((gmst * 15 + lon - ra) % 360) + 360) % 360;
  const alt = Math.asin(Math.sin(lat * rad) * Math.sin(dec * rad) + Math.cos(lat * rad) * Math.cos(dec * rad) * Math.cos(ha * rad)) / rad;
  const az = Math.atan2(-Math.sin(ha * rad), Math.tan(dec * rad) * Math.cos(lat * rad) - Math.sin(lat * rad) * Math.cos(ha * rad)) / rad;
  return { alt, az: (az + 360) % 360 };
}
export const norm3 = (v: number[]): C3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
export const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

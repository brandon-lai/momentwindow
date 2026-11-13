// Landmarks in the painter: the shapes people recognise a place by. Each
// landmark's Wikidata type picks a painter: lattice towers, needle towers,
// suspension / bascule / arch / cable-stayed bridges, statues on their
// pedestals, opera-house shells, clock faces and spires, domes, obelisks,
// Ferris wheels, skyscraper masts. Size and colour come from the map and from
// Wikidata (height, official colour, material); nothing here is a model of
// one particular building, except where the map says which kind it is.
import { PI, clamp, lerp, mix, mul, minRect, centroid, polyLen, pointAt, rgb, type C3, type G2, type P2 } from "./util.ts";
import { project, type Cam } from "./paint.ts";
import type { World, WLandmark } from "./scene.ts";

export interface LmEnv {
  L: G2; cam: Cam; sc: World;
  face(pts: number[][], col: number[], a?: number, washA?: number): void;
  edge(pts: number[][], col: number[], a: number, w?: number): void;
  line(pts: number[][], col: number[], a: number, w: number): void;
  hit(pts: number[][], label: string): void; // screen points: a hull for taps, and the depth buffer
  hazeAt(zc: number): number; fadeAt(x: number, y: number): number; sun: [number, number];
}

const P = (cam: Cam, x: number, y: number, z: number) => project(cam, x, y, z);

// a box between two heights over a footprint, drawn far faces first
function prism(e: LmEnv, ring: P2[], z0: number, z1: number, col: C3, a = 1) {
  const { cam } = e;
  const bot = ring.map(([x, y]) => P(cam, x, y, z0)), top = ring.map(([x, y]) => P(cam, x, y, z1));
  const walls: { poly: number[][]; n: number[]; d: number }[] = [];
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length, p = ring[i], q = ring[j], ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1, nx = ey / l, ny = -ex / l;
    if (nx * (cam.x - (p[0] + q[0]) / 2) + ny * (cam.y - (p[1] + q[1]) / 2) <= 0) continue;
    walls.push({ poly: [bot[i], bot[j], top[j], top[i]], n: [nx, ny], d: P(cam, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z0)[3] });
  }
  walls.sort((a, b) => b.d - a.d);
  for (const w of walls) { const lit = 0.78 + 0.22 * Math.max(0, w.n[0] * e.sun[0] - w.n[1] * e.sun[1]); e.face(w.poly, mul(col, lit), a); e.edge(w.poly, mul(col, 0.6), 0.25 * a); }
  e.face(top, mix(col, [255, 255, 255], 0.08), a);
  return { bot, top };
}

// ---------- towers ----------
function lattice(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, z0 = sc.H(lm.x, lm.y), h = lm.h ?? 300;
  const rect = lm.base && lm.base.length >= 3 ? minRect(lm.base) : null;
  const [cx, cy] = rect ? centroid(rect) : [lm.x, lm.y];
  const a0 = rect ? Math.min(Math.hypot(rect[1][0] - rect[0][0], rect[1][1] - rect[0][1]), Math.hypot(rect[2][0] - rect[1][0], rect[2][1] - rect[1][1])) / 2 : h * 0.19;
  const ang = rect ? Math.atan2(rect[1][1] - rect[0][1], rect[1][0] - rect[0][0]) : 0, ca = Math.cos(ang), sa = Math.sin(ang);
  const corner = (k: number, half: number, z: number) => { const u = (k === 0 || k === 3 ? -1 : 1) * half, v = (k < 2 ? -1 : 1) * half; return P(cam, cx + u * ca - v * sa, cy + u * sa + v * ca, z0 + z); };
  // the legs' curve: half-width falls off as (1 - t)^2.6, never quite to a point
  const halfAt = (t: number) => a0 * Math.max(0.045, Math.pow(1 - t, 2.6));
  const banded = !!lm.bands;
  const base: C3 = lm.colour ?? [124, 98, 72];
  const colAt = (t: number): C3 => banded ? (Math.floor(t * 11) % 2 ? [246, 244, 238] : [222, 96, 46]) : base;
  const hz = e.hazeAt(P(cam, cx, cy, z0)[3]);
  const N = 26, tTop = 0.9;
  const lv = Array.from({ length: N + 1 }, (_, i) => (i / N) * tTop);
  // four faces, far ones fainter: an open lattice shows the back through the front
  const cz = P(cam, cx, cy, z0 + h * 0.2)[3];
  const faces = [0, 1, 2, 3].map(k => { const j = (k + 1) % 4; return { k, j, near: (corner(k, a0, h * 0.2)[3] + corner(j, a0, h * 0.2)[3]) / 2 < cz }; });
  for (const pass of [false, true]) for (const f of faces) {
    if (f.near !== pass) continue;
    const alpha = (pass ? 0.92 : 0.45) * e.fadeAt(cx, cy);
    for (let i = 0; i < N; i++) {
      const t0 = lv[i], t1 = lv[i + 1], c = mix(colAt((t0 + t1) / 2), e.sc.pal.haze, hz);
      const p00 = corner(f.k, halfAt(t0), t0 * h), p01 = corner(f.j, halfAt(t0), t0 * h), p10 = corner(f.k, halfAt(t1), t1 * h), p11 = corner(f.j, halfAt(t1), t1 * h);
      // the legs (solid) and the lattice between them (hatched)
      const leg = 0.16 + (t0 < 0.17 ? 0.1 : 0);
      const legA = [p00, [lerp(p00[0], p01[0], leg), lerp(p00[1], p01[1], leg)], [lerp(p10[0], p11[0], leg), lerp(p10[1], p11[1], leg)], p10];
      const legB = [[lerp(p01[0], p00[0], leg), lerp(p01[1], p00[1], leg)], p01, p11, [lerp(p11[0], p10[0], leg), lerp(p11[1], p10[1], leg)]];
      // solid-ish legs, open lattice between them, braced across
      e.face(legA, c, alpha * 0.8, 0.15); e.face(legB, c, alpha * 0.8, 0.15);
      e.face([legA[1], legB[0], legB[3], legA[2]], c, alpha * 0.16, 0.05);
      e.line([[legA[1][0], legA[1][1]], [legB[3][0], legB[3][1]]], mul(c, 0.75), alpha * 0.6, 0.7);
      e.line([[legB[0][0], legB[0][1]], [legA[2][0], legA[2][1]]], mul(c, 0.75), alpha * 0.6, 0.7);
      // cross-hatching inside each leg
      for (const lg of [legA, legB]) { e.line([[lg[0][0], lg[0][1]], [lg[2][0], lg[2][1]]], mul(c, 0.6), alpha * 0.5, 0.5); e.line([[lg[1][0], lg[1][1]], [lg[3][0], lg[3][1]]], mul(c, 0.6), alpha * 0.5, 0.5); }
    }
    // the arch itself
    const archA = corner(f.k, halfAt(0.17) * 0.92, 0), archB = corner(f.j, halfAt(0.17) * 0.92, 0), top = [(corner(f.k, halfAt(0.17), 0.17 * h)[0] + corner(f.j, halfAt(0.17), 0.17 * h)[0]) / 2, (corner(f.k, halfAt(0.17), 0.17 * h)[1] + corner(f.j, halfAt(0.17), 0.17 * h)[1]) / 2];
    e.L.strokeStyle = rgb(mul(base, 0.75), alpha * 0.8); e.L.lineWidth = 1.2;
    e.L.beginPath(); e.L.moveTo(archA[0], archA[1]); e.L.quadraticCurveTo(top[0], top[1] - (archA[1] - top[1]) * 0.15, archB[0], archB[1]); e.L.stroke();
  }
  // platforms: the Eiffel Tower's three, or an observation deck and a top
  // deck on a banded tower like Tokyo's
  for (const t of banded ? [0.45, 0.75] : [0.17, 0.35, 0.86]) {
    const hw = halfAt(t) * (banded ? 1.25 : 1.05), ring = [0, 1, 2, 3].map(k => corner(k, hw, t * h)), ring2 = [0, 1, 2, 3].map(k => corner(k, hw, t * h + Math.max(4, h * 0.02)));
    e.face([ring[0], ring[1], ring2[1], ring2[0]], mul(colAt(t), 0.85), 0.95); e.face([ring[1], ring[2], ring2[2], ring2[1]], mul(colAt(t), 0.75), 0.95); e.face(ring2, mix(colAt(t), [255, 255, 255], 0.1), 0.95);
  }
  const spireBase = P(cam, cx, cy, z0 + tTop * h), spireTop = P(cam, cx, cy, z0 + h);
  e.line([[spireBase[0], spireBase[1]], [spireTop[0], spireTop[1]]], mul(base, 0.7), 0.9, Math.max(1, spireBase[2] * 2));
  const outline = [corner(0, a0, 0), corner(1, a0, 0), corner(2, a0, 0), corner(3, a0, 0), spireTop].map(p => [p[0], p[1]]);
  e.hit(outline, `${lm.name} · ${Math.round(h)} m`);
}

function needle(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, z0 = sc.H(lm.x, lm.y), h = lm.h ?? 350;
  const r0 = Math.max(6, Math.min(20, lm.base ? Math.sqrt(Math.abs(areaOf(lm.base)) / PI) : h * 0.03));
  const col: C3 = lm.colour ?? [212, 210, 204];
  const shaft = (z1: number, z2: number, ra: number, rb: number, c: C3) => {
    const a = P(cam, lm.x, lm.y, z1), b = P(cam, lm.x, lm.y, z2), wa = ra * a[2], wb = rb * b[2];
    e.face([[a[0] - wa, a[1]], [a[0] + wa, a[1]], [b[0] + wb, b[1]], [b[0] - wb, b[1]]], c, 1, 0.25);
    e.face([[a[0] + wa * e.sun[0] * 0.2, a[1]], [a[0] + wa, a[1]], [b[0] + wb, b[1]], [b[0] + wb * e.sun[0] * 0.2, b[1]]], mul(c, 0.82), 0.6, 0.1);
  };
  shaft(0, h * 0.72, r0 * 1.6, r0 * 0.9, col);
  // the pod: a fat ellipse with a dark band of windows
  const pod = P(cam, lm.x, lm.y, z0 + h * 0.74), pr = r0 * 3.2 * pod[2], ph = h * 0.035 * pod[2];
  e.L.globalAlpha = e.fadeAt(lm.x, lm.y);
  e.L.fillStyle = rgb(mix(col, [255, 255, 255], 0.1)); e.L.beginPath(); e.L.ellipse(pod[0], pod[1], pr, ph * 1.4, 0, 0, PI * 2); e.L.fill();
  e.L.fillStyle = rgb(mul(col, 0.45)); e.L.fillRect(pod[0] - pr * 0.95, pod[1] - ph * 0.3, pr * 1.9, ph * 0.5);
  e.L.globalAlpha = 1;
  shaft(h * 0.7, h * 0.88, r0 * 0.75, r0 * 0.45, col);
  const a = P(cam, lm.x, lm.y, z0 + h * 0.87), b = P(cam, lm.x, lm.y, z0 + h);
  e.line([[a[0], a[1]], [b[0], b[1]]], mul(col, 0.6), 0.95, Math.max(1, r0 * 0.3 * a[2]));
  const g = P(cam, lm.x, lm.y, z0);
  e.hit([[g[0] - r0 * 2 * g[2], g[1]], [g[0] + r0 * 2 * g[2], g[1]], [pod[0] + pr, pod[1]], [b[0], b[1]], [pod[0] - pr, pod[1]]], `${lm.name} · ${Math.round(h)} m`);
}

function obelisk(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, z0 = sc.H(lm.x, lm.y), h = lm.h ?? 60, s = Math.max(4, h * 0.05);
  const ring = (half: number): P2[] => [[lm.x - half, lm.y - half], [lm.x + half, lm.y - half], [lm.x + half, lm.y + half], [lm.x - half, lm.y + half]];
  const col: C3 = lm.colour ?? [238, 234, 226];
  // a gently tapering shaft, then the pyramidion
  const steps = 6;
  for (let i = 0; i < steps; i++) prism(e, ring(lerp(s, s * 0.7, (i + 0.5) / steps)), z0 + (i / steps) * h * 0.9, z0 + ((i + 1) / steps) * h * 0.9, col);
  const top = ring(s * 0.68).map(([x, y]) => P(cam, x, y, z0 + h * 0.9)), apex = P(cam, lm.x, lm.y, z0 + h);
  for (let i = 0; i < 4; i++) e.face([top[i], top[(i + 1) % 4], apex], mul(col, 0.85 + 0.1 * (i % 2)), 1);
  const g = P(cam, lm.x, lm.y, z0);
  e.hit([[g[0] - s * g[2], g[1]], [g[0] + s * g[2], g[1]], [apex[0], apex[1]]], `${lm.name} · ${Math.round(h)} m`);
}

// ---------- bridges ----------
function bridgeDeck(e: LmEnv, line: P2[], z: number, width: number, col: C3) {
  const { cam } = e, steps = Math.max(8, Math.round(polyLen(line) / 25));
  const L: number[][] = [], R: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const [x, y, a] = pointAt(line, (i / steps) * polyLen(line)), nx = -Math.sin(a) * width / 2, ny = Math.cos(a) * width / 2;
    L.push(P(cam, x + nx, y + ny, z)); R.push(P(cam, x - nx, y - ny, z));
  }
  const top = L.concat(R.slice().reverse()), under = L.map(p => [p[0], p[1] + Math.max(1.5, p[2] * 2.2)]);
  e.face(L.concat(under.slice().reverse()), mul(col, 0.62), 0.95);
  e.face(top, col, 0.95);
}
function deckZ(sc: World, line: P2[], frac: number) { const a = line[0], b = line[line.length - 1]; return Math.max(sc.H(a[0], a[1]), sc.H(b[0], b[1])) * 0 + frac; }

function suspension(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, line = lm.line!, span = polyLen(line);
  const deck = clamp(span * 0.025, 12, 67), towerH = lm.h ? Math.max(lm.h - 0, deck + 30) : deck + span * 0.12;
  const col: C3 = lm.colour ?? [150, 150, 156], width = clamp(span * 0.011, 14, 28);
  const z = deckZ(sc, line, deck);
  const tAt = [0.27, 0.73].map(f => pointAt(line, f * span));
  const cable = (side: number) => {
    const pts: number[][] = [];
    for (let i = 0; i <= 60; i++) {
      const f = i / 60, [x, y, a] = pointAt(line, f * span), off = side * width / 2;
      let zz: number;
      if (f < 0.27) zz = lerp(z + 2, towerH, Math.pow(f / 0.27, 1.6));
      else if (f > 0.73) zz = lerp(towerH, z + 2, Math.pow((f - 0.73) / 0.27, 0.62));
      else { const u = (f - 0.27) / 0.46; zz = z + 3 + (towerH - z - 3) * Math.pow(2 * u - 1, 2); }
      pts.push(P(cam, x - Math.sin(a) * off, y + Math.cos(a) * off, zz).concat([x - Math.sin(a) * off, y + Math.cos(a) * off]));
    }
    return pts;
  };
  bridgeDeck(e, line, z, width, mix(col, [120, 120, 126], 0.4));
  // towers: two legs, cross struts
  for (const [x, y, a] of tAt) for (const side of [-1, 1]) {
    const lx = x - Math.sin(a) * side * width / 2, ly = y + Math.cos(a) * side * width / 2, s = Math.max(4, width * 0.18);
    prism(e, [[lx - s / 2, ly - s / 2], [lx + s / 2, ly - s / 2], [lx + s / 2, ly + s / 2], [lx - s / 2, ly + s / 2]], 0, towerH, col);
  }
  for (const [x, y, a] of tAt) for (const f of [0.55, 0.78, 0.97]) {
    const zz = lerp(z, towerH, f), p = P(cam, x - Math.sin(a) * width / 2, y + Math.cos(a) * width / 2, zz), q = P(cam, x + Math.sin(a) * width / 2, y - Math.cos(a) * width / 2, zz);
    e.line([[p[0], p[1]], [q[0], q[1]]], col, 0.95, Math.max(1.4, p[2] * 4));
  }
  for (const side of [-1, 1]) {
    const c = cable(side);
    e.line(c.map(p => [p[0], p[1]]), mul(col, 0.8), 0.95, Math.max(1, c[30][2] * 1.2));
    for (let i = 2; i < c.length - 2; i += 2) { const [x, y] = [c[i][4], c[i][5]], d = P(cam, x, y, z); e.line([[c[i][0], c[i][1]], [d[0], d[1]]], mul(col, 0.85), 0.5, 0.6); }
  }
  const t1 = P(cam, tAt[0][0], tAt[0][1], towerH), t2 = P(cam, tAt[1][0], tAt[1][1], towerH), a0 = P(cam, line[0][0], line[0][1], z), a1 = P(cam, line[line.length - 1][0], line[line.length - 1][1], z);
  e.hit([[a0[0], a0[1]], [t1[0], t1[1]], [t2[0], t2[1]], [a1[0], a1[1]]], `${lm.name} · ${Math.round(towerH)} m towers`);
}

function bascule(e: LmEnv, lm: WLandmark) {
  // Tower Bridge's shape: two gothic towers near the middle, high walkways
  // between them, suspension chains to the banks, a low deck
  const { cam, sc } = e, line = lm.line!, span = polyLen(line);
  const towerH = lm.h ?? 65, deck = 9, width = 18, col: C3 = lm.colour ?? [210, 204, 190];
  const z = deckZ(sc, line, deck);
  bridgeDeck(e, line, z, width, [176, 170, 160]);
  const tw = 20, towers = [0.38, 0.62].map(f => pointAt(line, f * span));
  for (const [x, y, a] of towers) {
    const c = Math.cos(a), s = Math.sin(a), sq = (half: number, d = 0): P2[] => [[-half, -half], [half, -half], [half, half], [-half, half]].map(([u, v]) => [x + (u + d) * c - v * s, y + (u + d) * s + v * c] as P2);
    prism(e, sq(tw / 2), 0, towerH * 0.82, col);
    const top = sq(tw / 2).map(([px, py]) => P(cam, px, py, towerH * 0.82)), apex = P(cam, x, y, towerH);
    for (let i = 0; i < 4; i++) e.face([top[i], top[(i + 1) % 4], apex], mul([90, 100, 110], 0.9 + 0.1 * (i % 2)), 1);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const px = x + (u * tw / 2) * c - (v * tw / 2) * s, py = y + (u * tw / 2) * s + (v * tw / 2) * c, b = P(cam, px, py, towerH * 0.82), t = P(cam, px, py, towerH * 0.95); e.line([[b[0], b[1]], [t[0], t[1]]], [90, 100, 110], 0.95, Math.max(1, b[2] * 2.5)); }
  }
  // the high walkways, painted blue
  for (const side of [-1, 1]) {
    const [x0, y0, a] = towers[0], [x1, y1] = towers[1], ox = -Math.sin(a) * side * 6, oy = Math.cos(a) * side * 6;
    const p = [P(cam, x0 + ox, y0 + oy, towerH * 0.68), P(cam, x1 + ox, y1 + oy, towerH * 0.68), P(cam, x1 + ox, y1 + oy, towerH * 0.74), P(cam, x0 + ox, y0 + oy, towerH * 0.74)];
    e.face(p, [96, 140, 196], 0.95);
  }
  // side spans: chains from the towers down to the banks
  for (const [from, to] of [[0, 0.38], [1, 0.62]]) {
    const pts: number[][] = [];
    for (let i = 0; i <= 20; i++) { const f = lerp(from, to, i / 20), [x, y] = pointAt(line, f * span); const zz = lerp(z + 2, towerH * 0.6, Math.pow(i / 20, 1.8)); pts.push(P(cam, x, y, zz)); }
    e.line(pts.map(p => [p[0], p[1]]), [96, 140, 196], 0.95, Math.max(1.2, pts[10][2] * 2));
  }
  const a0 = P(cam, towers[0][0], towers[0][1], towerH), a1 = P(cam, towers[1][0], towers[1][1], towerH), g0 = P(cam, line[0][0], line[0][1], z), g1 = P(cam, line[line.length - 1][0], line[line.length - 1][1], z);
  e.hit([[g0[0], g0[1]], [a0[0], a0[1]], [a1[0], a1[1]], [g1[0], g1[1]]], `${lm.name} · ${Math.round(towerH)} m`);
}

function arch(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, line = lm.line!, span = polyLen(line), col: C3 = lm.colour ?? [150, 154, 160];
  const water = sc.waterAt ?? (() => false);
  // the arch spans the water
  let w0 = -1, w1 = -1; for (let s = 0; s <= span; s += 5) { const [x, y] = pointAt(line, s); if (water(x, y)) { if (w0 < 0) w0 = s; w1 = s; } }
  if (w0 < 0) { w0 = span * 0.2; w1 = span * 0.8; }
  const big = (lm.h ?? 0) > 50;
  if (big) {
    // a steel through-arch (Sydney Harbour Bridge): the deck hangs from it, granite pylons at each end
    const top = lm.h!, deck = top * 0.37, z = deckZ(sc, line, deck), width = 30;
    bridgeDeck(e, line, z, width, [140, 140, 146]);
    for (const side of [-1, 1]) for (const chord of [0, 1]) {
      const pts: number[][] = [];
      for (let i = 0; i <= 40; i++) { const s = lerp(w0, w1, i / 40), [x, y, a] = pointAt(line, s), u = (s - w0) / (w1 - w0); const zz = (chord ? top * 0.82 : top) * Math.sin(u * PI) * 0.98 + 4; pts.push(P(cam, x - Math.sin(a) * side * width / 2, y + Math.cos(a) * side * width / 2, zz)); }
      e.line(pts.map(p => [p[0], p[1]]), col, 0.95, Math.max(1.4, pts[20][2] * (chord ? 3 : 4)));
      if (chord) for (let i = 2; i < 40; i += 2) { const s = lerp(w0, w1, i / 40), [x, y, a] = pointAt(line, s), u = (s - w0) / (w1 - w0), zz = top * 0.82 * Math.sin(u * PI) * 0.98 + 4; if (zz < z) continue; const p = pts[i], d = P(cam, x - Math.sin(a) * side * width / 2, y + Math.cos(a) * side * width / 2, z); e.line([[p[0], p[1]], [d[0], d[1]]], mul(col, 0.9), 0.6, 0.8); }
    }
    for (const s of [w0, w1]) for (const side of [-1, 1]) { const [x, y, a] = pointAt(line, s), px = x - Math.sin(a) * side * (width / 2 + 4), py = y + Math.cos(a) * side * (width / 2 + 4); prism(e, [[px - 7, py - 7], [px + 7, py - 7], [px + 7, py + 7], [px - 7, py + 7]], 0, top * 0.66, [216, 204, 180]); }
    const a0 = P(cam, ...pointAt(line, w0).slice(0, 2) as [number, number], 0), mid = P(cam, ...pointAt(line, (w0 + w1) / 2).slice(0, 2) as [number, number], top), a1 = P(cam, ...pointAt(line, w1).slice(0, 2) as [number, number], 0);
    e.hit([[a0[0], a0[1]], [mid[0], mid[1]], [a1[0], a1[1]]], `${lm.name} · ${Math.round(top)} m`);
  } else {
    // a stone bridge: a parapet band with arches underneath
    const z = deckZ(sc, line, 10), width = 22, n = Math.max(3, Math.round((w1 - w0) / 40));
    bridgeDeck(e, line, z, width, [214, 206, 188]);
    for (let i = 0; i < n; i++) {
      const s0 = lerp(w0, w1, i / n), s1 = lerp(w0, w1, (i + 1) / n), pts: number[][] = [];
      for (let k = 0; k <= 10; k++) { const s = lerp(s0, s1, k / 10), [x, y, a] = pointAt(line, s), u = k / 10; pts.push(P(cam, x + Math.sin(a) * width / 2, y - Math.cos(a) * width / 2, z * (1 - 0.75 * Math.sin(u * PI)))); }
      e.line(pts.map(p => [p[0], p[1]]), [120, 112, 100], 0.7, 1);
    }
    const a0 = P(cam, line[0][0], line[0][1], z), a1 = P(cam, line[line.length - 1][0], line[line.length - 1][1], z);
    e.hit([[a0[0], a0[1] - 6], [a1[0], a1[1] - 6], [a1[0], a1[1] + 10], [a0[0], a0[1] + 10]], lm.name);
  }
}

function cablestayed(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, line = lm.line!, span = polyLen(line), col: C3 = lm.colour ?? [236, 236, 232];
  const deck = clamp(span * 0.02, 10, 50), z = deckZ(sc, line, deck), H = lm.h ?? deck + span * 0.2, width = 24;
  bridgeDeck(e, line, z, width, [180, 180, 184]);
  const [px, py] = pointAt(line, span * 0.5), top = P(cam, px, py, H), foot = P(cam, px, py, 0);
  e.line([[foot[0], foot[1]], [top[0], top[1]]], col, 1, Math.max(2, top[2] * 6));
  for (let i = 1; i <= 12; i++) for (const dir of [-1, 1]) { const [x, y] = pointAt(line, span * (0.5 + dir * i / 26)), d = P(cam, x, y, z), t = P(cam, px, py, H * (0.95 - i * 0.02)); e.line([[t[0], t[1]], [d[0], d[1]]], col, 0.7, 0.7); }
  e.hit([[foot[0] - 20, foot[1]], [top[0], top[1]], [foot[0] + 20, foot[1]]], `${lm.name} · ${Math.round(H)} m`);
}

// ---------- figures, shells, wheels ----------
function statue(e: LmEnv, lm: WLandmark, standOn: number) {
  const { cam } = e, h = lm.h ?? 20, col: C3 = lm.colour ?? [98, 160, 138];
  const b = P(cam, lm.x, lm.y, standOn), t = P(cam, lm.x, lm.y, standOn + h), s = b[2], H = b[1] - t[1], w = Math.max(2, H * 0.22);
  const L = e.L; L.save(); L.globalAlpha = e.fadeAt(lm.x, lm.y);
  // robe
  L.fillStyle = rgb(col); L.beginPath(); L.moveTo(b[0] - w, b[1]); L.quadraticCurveTo(b[0] - w * 0.7, b[1] - H * 0.5, b[0] - w * 0.38, b[1] - H * 0.7); L.lineTo(b[0] + w * 0.4, b[1] - H * 0.7); L.quadraticCurveTo(b[0] + w * 0.75, b[1] - H * 0.45, b[0] + w * 0.9, b[1]); L.closePath(); L.fill();
  L.fillStyle = rgb(mul(col, 0.8)); L.beginPath(); L.moveTo(b[0] + e.sun[0] * w * 0.1, b[1]); L.lineTo(b[0] + w * 0.9, b[1]); L.quadraticCurveTo(b[0] + w * 0.75, b[1] - H * 0.45, b[0] + w * 0.4, b[1] - H * 0.7); L.closePath(); L.fill();
  // head and crown
  const hy = b[1] - H * 0.78, hr = Math.max(1, H * 0.065);
  L.fillStyle = rgb(col); L.beginPath(); L.arc(b[0], hy, hr, 0, PI * 2); L.fill();
  L.strokeStyle = rgb(mul(col, 0.85)); L.lineWidth = Math.max(0.6, hr * 0.3);
  for (let k = -3; k <= 3; k++) { const a = -PI / 2 + k * 0.32; L.beginPath(); L.moveTo(b[0] + Math.cos(a) * hr, hy + Math.sin(a) * hr); L.lineTo(b[0] + Math.cos(a) * hr * 2.1, hy + Math.sin(a) * hr * 2.1); L.stroke(); }
  // the raised arm and the torch
  L.lineWidth = Math.max(1, w * 0.28); L.lineCap = "round"; L.beginPath(); L.moveTo(b[0] + w * 0.32, b[1] - H * 0.68); L.lineTo(b[0] + w * 0.55, t[1] + H * 0.08); L.stroke();
  L.fillStyle = rgb([236, 190, 80]); L.beginPath(); L.ellipse(b[0] + w * 0.57, t[1] + H * 0.03, Math.max(1, w * 0.18), Math.max(1.4, H * 0.05), 0, 0, PI * 2); L.fill();
  // the tablet
  L.fillStyle = rgb(mul(col, 0.9)); L.fillRect(b[0] - w * 0.75, b[1] - H * 0.62, w * 0.35, H * 0.18);
  L.restore();
  void s;
  e.hit([[b[0] - w, b[1]], [b[0] + w, b[1]], [b[0] + w * 0.6, t[1]], [b[0] - w * 0.4, t[1] + H * 0.2]], `${lm.name} · ${Math.round(standOn + h)} m`);
}

function shells(e: LmEnv, lm: WLandmark, z0: number) {
  const { cam } = e, base = lm.base!, rect = minRect(base);
  const [p0, p1, , p3] = rect, ux = (p1[0] - p0[0]), uy = (p1[1] - p0[1]), Lg = Math.hypot(ux, uy), wx = (p3[0] - p0[0]), wy = (p3[1] - p0[1]), Wd = Math.hypot(wx, wy);
  const [cx0, cy0] = centroid(rect), ex: P2 = [ux / Lg, uy / Lg], ey: P2 = [wx / Wd, wy / Wd];
  const H = lm.h ?? 60, podium = z0 + 9;
  prism(e, rect, z0, podium, [212, 200, 180]);
  const at = (u: number, v: number, z: number) => P(cam, cx0 + ex[0] * u + ey[0] * v, cy0 + ex[1] * u + ey[1] * v, z);
  // Two rows of shells (the two halls) side by side, each row a run of
  // nested vaults along the long axis: a spine rises from the podium toward
  // one end, and two curved flanks fall from the spine to the podium edges.
  // Seen from any side that reads as overlapping sails.
  const rows = [-0.23, 0.23];
  const sails: [number, number, number][] = [[-0.42, -0.05, 0.62], [-0.2, 0.18, 0.85], [0.02, 0.4, 1.0], [0.26, 0.5, 0.7]]; // start, apex, height
  const draw: { pts: number[][]; d: number; lit: number }[] = [];
  for (const v of rows) for (const [u0, u1, k] of sails) {
    const half = Wd * 0.2, top = H * 0.92 * k, N = 12;
    const spine: number[][] = [], left: number[][] = [], right: number[][] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = lerp(u0, u1, t) * Lg, z = podium + top * Math.pow(Math.sin(t * PI / 2), 0.75);
      spine.push(at(u, v * Wd, z));
      const fl = half * Math.pow(1 - t, 0.55); // the flanks narrow toward the apex
      left.push(at(lerp(u0, u1, Math.min(1, t * 0.85)) * Lg, v * Wd - fl, podium + top * 0.08 * t));
      right.push(at(lerp(u0, u1, Math.min(1, t * 0.85)) * Lg, v * Wd + fl, podium + top * 0.08 * t));
    }
    const d = spine[N][3];
    draw.push({ pts: left.concat(spine.slice().reverse()).map(p => [p[0], p[1]]), d: d + 0.01, lit: 0.88 });
    draw.push({ pts: right.concat(spine.slice().reverse()).map(p => [p[0], p[1]]), d, lit: 1 });
    // the open mouth of each shell, in shadow
    draw.push({ pts: [left[N - 2], spine[N], right[N - 2]].map(p => [p[0], p[1]]), d: d - 0.01, lit: 0.62 });
  }
  draw.sort((a, b) => b.d - a.d);
  for (const s of draw) { e.face(s.pts, mul([248, 247, 240], s.lit), 1, 0.12); e.edge(s.pts, [176, 174, 166], 0.4); }
  const hull = draw.flatMap(s => s.pts).concat(rect.map(([x, y]) => { const p = P(cam, x, y, z0); return [p[0], p[1]]; }));
  e.hit(hull, `${lm.name} · ${Math.round(H)} m`);
}

function ferris(e: LmEnv, lm: WLandmark) {
  const { cam, sc } = e, D = lm.h ?? 100, z0 = sc.H(lm.x, lm.y), c = P(cam, lm.x, lm.y, z0 + D / 2 + 4);
  const r = (D / 2) * c[2], ry = r, rx = r * 0.82; // turned a little toward the camera
  const L = e.L; L.save(); L.globalAlpha = e.fadeAt(lm.x, lm.y); L.strokeStyle = rgb([236, 236, 232]); L.lineWidth = Math.max(1, r * 0.03);
  L.beginPath(); L.ellipse(c[0], c[1], rx, ry, 0, 0, PI * 2); L.stroke();
  L.lineWidth = Math.max(0.5, r * 0.008); L.globalAlpha *= 0.7;
  for (let k = 0; k < 32; k++) { const a = (k / 32) * PI * 2; L.beginPath(); L.moveTo(c[0], c[1]); L.lineTo(c[0] + Math.cos(a) * rx, c[1] + Math.sin(a) * ry); L.stroke(); }
  L.globalAlpha /= 0.7; L.fillStyle = rgb([250, 250, 246]);
  for (let k = 0; k < 32; k++) { const a = (k / 32) * PI * 2; L.beginPath(); L.ellipse(c[0] + Math.cos(a) * rx * 1.04, c[1] + Math.sin(a) * ry * 1.04, Math.max(1, r * 0.035), Math.max(0.8, r * 0.025), 0, 0, PI * 2); L.fill(); }
  const g = P(cam, lm.x, lm.y, z0); L.strokeStyle = rgb([200, 200, 196]); L.lineWidth = Math.max(1, r * 0.02);
  L.beginPath(); L.moveTo(c[0], c[1]); L.lineTo(g[0] - r * 0.35, g[1]); L.moveTo(c[0], c[1]); L.lineTo(g[0] + r * 0.35, g[1]); L.stroke();
  L.restore();
  e.hit([[c[0] - rx, c[1]], [c[0], c[1] - ry], [c[0] + rx, c[1]], [g[0], g[1]]], `${lm.name} · ${Math.round(D)} m`);
}

function areaOf(r: P2[]) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

// Landmarks that replace their map footprint with a drawn shape.
export const REPLACES = new Set(["lattice", "needle", "obelisk", "shells", "suspension", "bascule", "arch", "bridge", "cablestayed"]);
// Bridges are drawn whole; buildings stay and get extras (spires, clock faces, domes, statues on top).
export function paintLandmark(e: LmEnv, lm: WLandmark) {
  switch (lm.kind) {
    case "lattice": return lattice(e, lm);
    case "needle": return needle(e, lm);
    case "obelisk": return obelisk(e, lm);
    case "suspension": return lm.line ? suspension(e, lm) : undefined;
    case "bascule": return lm.line ? bascule(e, lm) : undefined;
    case "arch": case "bridge": return lm.line ? arch(e, lm) : undefined;
    case "cablestayed": return lm.line ? cablestayed(e, lm) : undefined;
    case "shells": return lm.base ? shells(e, lm, e.sc.H(lm.x, lm.y)) : undefined;
    case "ferris": return ferris(e, lm);
    case "statue": return statue(e, lm, lm.standOn ?? e.sc.H(lm.x, lm.y));
  }
}

// Extras on a landmark building, drawn after its walls: a spire or mast up to
// the real height, clock faces, a dome.
export function paintExtras(e: LmEnv, lm: WLandmark, top: { x: number; y: number; ground: number; z: number; ring: P2[]; aspectOf?: P2[]; clockZ?: number }) {
  // top.z: the part's top above the ground; lm.h: the landmark's real height
  const { cam } = e, h = lm.h ?? 0, gap = h - top.z, G = top.ground;
  const col: C3 = lm.colour ?? [208, 200, 184];
  if (lm.kind === "clock") {
    // clock faces on the sunlit sides, two thirds of the way up the tower
    const r = top.ring, zc = top.clockZ ?? G + top.z * 0.82;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length], ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1, nx = ey / l, ny = -ex / l;
      if (l < 5 || nx * (cam.x - (p[0] + q[0]) / 2) + ny * (cam.y - (p[1] + q[1]) / 2) <= 0) continue;
      const c = P(cam, (p[0] + q[0]) / 2 + nx * 0.4, (p[1] + q[1]) / 2 + ny * 0.4, zc), rr = Math.max(2, l * 0.4 * c[2]);
      e.L.fillStyle = rgb([246, 240, 220]); e.L.beginPath(); e.L.ellipse(c[0], c[1], Math.max(1, rr * Math.abs(nx * 0.8 + 0.2)), Math.max(1, rr), 0, 0, PI * 2); e.L.fill();
      e.L.strokeStyle = rgb([60, 56, 50], 0.8); e.L.lineWidth = Math.max(0.5, rr * 0.12); e.L.stroke();
    }
  }
  if (gap > 6 && !(lm.kind === "clock" && gap < 12)) {
    const base = top.ring, b = base.map(([x, y]) => P(cam, x, y, G + top.z)), apex = P(cam, top.x, top.y, G + h);
    // a long nave is a gothic church: a spire, not a dome
    const mr = minRect(top.aspectOf ?? base), aspect = mr.length === 4 ? Math.hypot(mr[1][0] - mr[0][0], mr[1][1] - mr[0][1]) / Math.max(1, Math.hypot(mr[2][0] - mr[1][0], mr[2][1] - mr[1][1])) : 1;
    if (lm.kind === "dome" && aspect < 1.8) {
      // a dome on a drum, a lantern on top
      const rad = Math.min(Math.sqrt(Math.abs(areaOf(base)) / PI) * 0.9, gap * 0.8), c = P(cam, top.x, top.y, G + top.z + gap * 0.45), r = rad * c[2];
      const drum = P(cam, top.x, top.y, G + top.z);
      e.face([[drum[0] - r, drum[1]], [drum[0] + r, drum[1]], [c[0] + r, c[1]], [c[0] - r, c[1]]], mul(col, 0.9), 1);
      const g = e.L.createRadialGradient(c[0] + e.sun[0] * r * 0.4, c[1] - r * 0.4, r * 0.1, c[0], c[1], r * 1.05);
      const dc: C3 = lm.colour ?? [176, 186, 190];
      g.addColorStop(0, rgb(mix(dc, [255, 255, 255], 0.35))); g.addColorStop(1, rgb(mul(dc, 0.72)));
      e.L.fillStyle = g; e.L.beginPath(); e.L.ellipse(c[0], c[1], r, r * 0.95, 0, PI, 0); e.L.ellipse(c[0], c[1], r, r * cam.sin * 0.55, 0, 0, PI); e.L.fill();
      e.line([[c[0], c[1] - r * 0.95], [apex[0], apex[1]]], mul(dc, 0.7), 1, Math.max(1, r * 0.12));
    } else if (lm.kind === "skyscraper") {
      // a mast or spire to the real height
      const r0 = P(cam, top.x, top.y, G + top.z);
      e.line([[r0[0], r0[1]], [apex[0], apex[1]]], [150, 152, 158], 1, Math.max(1, apex[2] * 2.5));
    } else if (lm.kind === "dome") {
      // a gothic church: a slender spire over the crossing
      const r = 5, sq: P2[] = [[top.x - r, top.y - r], [top.x + r, top.y - r], [top.x + r, top.y + r], [top.x - r, top.y + r]], sb = sq.map(([x, y]) => P(cam, x, y, G + top.z));
      for (let i = 0; i < 4; i++) e.face([sb[i], sb[(i + 1) % 4], apex], mul([96, 104, 110], 0.85 + 0.1 * (i % 2)), 1);
    } else {
      // a pyramid spire (clock towers, steeples)
      const k = base.length;
      for (let i = 0; i < k; i++) e.face([b[i], b[(i + 1) % k], apex], mul([96, 104, 110], 0.85 + 0.1 * (i % 2)), 1);
    }
  }
}
export { polyLen, pointAt };

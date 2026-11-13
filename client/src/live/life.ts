// Life, ported from the prototype and fed from the real map: ferries on the
// real ferry routes, cars on real streets, trains on real rails, people on
// real paths and in real parks, boats only where there is open water. All of
// it lives in world metres. Deterministic from a seed, so a postcard can
// replay the same life.
import { CW, CH, M, PI, clamp, lerp, mulberry32, inPoly, centroid, pointAt, polyLen, rgb, sampleLine, type C3, type P2, type G2 } from "../paint/util.ts";
import type { World } from "../paint/scene.ts";
import { project, type Cam } from "../paint/paint.ts";
import { localHour } from "../moment.ts";

let LR = mulberry32(4242);
const lr = (a: number, b: number) => a + (b - a) * LR();
const lpick = <T,>(a: T[]) => a[Math.floor(LR() * a.length)];

interface Runner { path: P2[]; L: number; s: number; dir: number; speed: number; mode: string; pause: number; wait: number; step(dt: number): void; pos(): [number, number, number] }
function pathRunner(path: P2[], speed: number, mode: string, pause = 0): Runner {
  const L = polyLen(path);
  return {
    path, L, s: lr(0, L), dir: 1, speed, mode, pause, wait: 0,
    step(dt) {
      if (this.wait > 0) { this.wait -= dt; return; }
      this.s += this.dir * this.speed * dt;
      if (this.mode === "loop") this.s = ((this.s % this.L) + this.L) % this.L;
      else if (this.mode === "end") this.s = clamp(this.s, 0, this.L);
      else if (this.s > this.L || this.s < 0) { this.s = clamp(this.s, 0, this.L); this.dir *= -1; this.wait = this.pause; }
    },
    pos() { const p = pointAt(this.path, this.s); if (this.dir < 0) p[2] += PI; return p; },
  };
}
const BOATS: Record<string, { L: number; B: number; hull: C3; deck: C3; cabin: number; sail?: number; lanterns?: boolean }> = {
  ferry: { L: 46, B: 12, hull: [214, 140, 70], deck: [250, 248, 242], cabin: 0.5 },
  small: { L: 14, B: 4.5, hull: [250, 248, 242], deck: [226, 188, 114], cabin: 0.35 },
  tug: { L: 18, B: 6, hull: [178, 72, 60], deck: [244, 240, 232], cabin: 0.35 },
  sail: { L: 9, B: 3, hull: [250, 248, 242], deck: [214, 206, 190], cabin: 0, sail: 11 },
  canal: { L: 22, B: 4.2, hull: [52, 62, 70], deck: [214, 222, 226], cabin: 0.7 },
  lantern: { L: 15, B: 4.4, hull: [92, 60, 54], deck: [214, 160, 110], cabin: 0.6, lanterns: true },
  fishing: { L: 11, B: 3.8, hull: [64, 108, 184], deck: [250, 248, 242], cabin: 0.3 },
};

export interface Life {
  t: number; boats: any[]; cars: any[]; walkers: any[]; birds: any[]; rings: any[]; smoke: any[]; cows: any[];
  flock: any; train: any; lamps: any[]; cables: any[]; clouds: any[]; smokeSrc: any[]; rainNext: number;
  nextRoad(car: any): void; parkPts: P2[]; weather: { rain: boolean; drizzle: boolean; snow: boolean; fog: boolean };
}

// joins polylines whose ends touch (tiles and OSM split routes into pieces)
function joinLines(lines: P2[][], tol = 8): P2[][] {
  const out = lines.map(l => l.slice());
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const a = out[i], b = out[j], d = (p: P2, q: P2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      let c: P2[] | null = null;
      if (d(a[a.length - 1], b[0]) < tol) c = a.concat(b.slice(1));
      else if (d(a[a.length - 1], b[b.length - 1]) < tol) c = a.concat(b.slice(0, -1).reverse());
      else if (d(a[0], b[b.length - 1]) < tol) c = b.concat(a.slice(1));
      else if (d(a[0], b[0]) < tol) c = a.slice().reverse().concat(b.slice(1));
      if (c) { out[i] = c; out.splice(j, 1); merged = true; break outer; }
    }
  }
  return out;
}
const inView = (sc: World, x: number, y: number, m = 0) => x > -m && x < sc.W + m && y > -m && y < sc.D + m;

export function createLife(sc: World, seed: number): Life {
  LR = mulberry32(seed);
  const m = sc.moment, w = m.weather, pal = sc.pal;
  const hour = localHour(m.utc, m.tz);
  const busy = hour >= 7 && hour < 10 || hour >= 16 && hour < 19 ? 1 : hour >= 10 && hour < 16 ? 0.7 : hour >= 19 && hour < 23 ? 0.45 : 0.12;
  const wet = m.rain || m.drizzle || m.snowing;
  const life: Life = { t: 0, boats: [], cars: [], walkers: [], birds: [], rings: [], smoke: [], cows: [], flock: null, train: null, lamps: [], cables: [], clouds: [], smokeSrc: [], rainNext: 2, nextRoad: () => {}, parkPts: [], weather: { rain: m.rain, drizzle: m.drizzle, snow: m.snowing, fog: m.fog } };
  const waterAt = sc.waterAt ?? (() => false);
  const wind = w?.wind ?? 4;

  // ferries on their real routes, pausing at each terminal
  const routes = joinLines(sc.ferries).filter(r => polyLen(r) > 250 && r.some(([x, y]) => inView(sc, x, y))).sort((a, b) => polyLen(b) - polyLen(a)).slice(0, 2);
  for (const r of routes) life.boats.push({ ...BOATS.ferry, kind: "ferry", r: pathRunner(r, 7 * 1.4, "pingpong", 8), trail: [], trailT: 0, wakeT: 0, honk: 0 });
  // boats on open water: loops that never touch land
  const loops: P2[][] = [];
  // only on open water larger than 0.2 km2 (the bundle lists those)
  const open = sc.openWater;
  for (let k = 0; k < 400 && loops.length < 3 && open.length; k++) {
    const x = lr(sc.W * 0.1, sc.W * 0.9), y = lr(20, sc.D * 0.85); if (!waterAt(x, y) || !open.some(r => inPoly(x, y, r))) continue;
    let shore = 0; for (let d = 10; d < 400; d += 10) { let dry = false; for (let a = 0; a < 8; a++) if (!waterAt(x + Math.cos(a * PI / 4) * d, y + Math.sin(a * PI / 4) * d)) dry = true; if (dry) break; shore = d; }
    if (shore < 30) continue;
    const rx = Math.min(shore * 1.6, 260), ry = Math.max(14, Math.min(shore * 0.8, rx * 0.3)), pts: P2[] = [];
    for (let a = 0; a <= PI * 2 + 0.01; a += 0.15) pts.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry]);
    if (pts.every(p => waterAt(p[0], p[1])) && !loops.some(l => Math.hypot(centroid(l)[0] - x, centroid(l)[1] - y) < 120)) loops.push(pts);
  }
  const harbour = sc.cc === "GR" || sc.cc === "CY" || sc.cc === "HR" || sc.cc === "IT";
  loops.forEach((loop, i) => {
    const kind = harbour && i === 0 ? "fishing" : wind < 12 && i === 1 ? "sail" : sc.kind === "dense" && i === 2 ? "tug" : i === 0 ? "small" : wind < 12 ? "sail" : "small";
    const b = BOATS[kind]; life.boats.push({ ...b, kind, r: pathRunner(loop, (kind === "sail" ? 4 : kind === "tug" ? 4 : 8) * 1.2, "loop"), trail: [], trailT: 0, wakeT: 0, honk: 0 });
  });
  // canal and river boats
  const canals = joinLines(sc.canals).filter(c => polyLen(c) > 150 && c.some(([x, y]) => inView(sc, x, y))).slice(0, 3);
  canals.forEach((c, i) => life.boats.push({ ...BOATS[sc.cc === "JP" && pal.night ? "lantern" : "canal"], kind: "canal", r: pathRunner(c, lr(2.4, 3.4), "pingpong", 3 + i), trail: [], trailT: 0, wakeT: 0, honk: 0 }));

  // cars, buses and scooters on the road graph
  const roads = sc.roads.filter(r => (r.kind === "avenue" || r.kind === "street" || (r.kind === "lane" && sc.kind !== "dense")) && polyLen(r.pts) > 30 && r.pts.some(([x, y]) => inView(sc, x, y, 40)));
  const ends = roads.map(r => [r.pts[0], r.pts[r.pts.length - 1]]);
  const carCols: C3[] = [[214, 90, 70], [250, 248, 242], [62, 70, 84], [226, 188, 114], [120, 150, 190], [190, 196, 200], [80, 110, 90]];
  let roadLen = 0; for (const r of roads) roadLen += polyLen(r.pts);
  const nCars = roads.length ? Math.round(clamp(roadLen / 140 * busy, 2, 28)) : 0;
  const scooter = ["GR", "IT", "VN", "TH", "ID", "TW"].includes(sc.cc);
  for (let i = 0; i < nCars; i++) { const ri = Math.floor(LR() * roads.length), r = roads[ri]; life.cars.push({ ri, r: pathRunner(r.pts, lr(8, 13), "end"), col: lpick(carCols), scooter: scooter && LR() < 0.6, bus: !scooter && LR() < 0.06 }); }
  life.nextRoad = (car: any) => {
    const pos = car.r.pos(), cand: [number, number][] = [];
    for (let i = 0; i < roads.length; i++) { if (i === car.ri) continue; ends[i].forEach((e, k) => { if (Math.hypot(e[0] - pos[0], e[1] - pos[1]) < 16) cand.push([i, k]); }); }
    if (!cand.length) { car.r.dir *= -1; car.r.s = clamp(car.r.s, 0, car.r.L); return; }
    const [i, k] = lpick(cand); car.ri = i; car.r = pathRunner(roads[i].pts, car.r.speed, "end"); car.r.s = k ? car.r.L : 0; car.r.dir = k ? -1 : 1;
  };

  // trains on the real line, lit at night
  const rails = joinLines(sc.roads.filter(r => r.kind === "rail").map(r => r.pts)).filter(r => polyLen(r) > 300 && r.some(([x, y]) => inView(sc, x, y))).sort((a, b) => polyLen(b) - polyLen(a));
  if (rails[0] && busy > 0.1) life.train = { r: pathRunner(rails[0], 13, "loop"), cars: polyLen(rails[0]) > 800 ? 8 : 4 };

  // people walking and cycling; fewer in the rain
  const people = (wet ? 0.3 : 1) * (busy + 0.15);
  const bikeShare = sc.cc === "NL" || sc.cc === "DK" ? 0.6 : 0.15;
  const paths = sc.paths.filter(p => polyLen(p) > 40 && p.some(([x, y]) => inView(sc, x, y)));
  for (const p of paths.slice(0, 40)) { const n = Math.round(clamp(polyLen(p) / 220 * people, 0, 3)); for (let i = 0; i < n; i++) life.walkers.push({ r: pathRunner(p, lr(1, 1.5), "loop"), bike: LR() < bikeShare, col: lpick([[214, 90, 70], [62, 70, 84], [64, 108, 184], [226, 188, 114], [250, 248, 242]]) }); }
  if (bikeShare > 0.5) for (const r of roads.filter(r => r.kind === "street").slice(0, 12)) life.walkers.push({ r: pathRunner(r.pts, lr(4, 5.5), "loop"), bike: true, col: lpick([[62, 70, 84], [214, 90, 70], [250, 248, 242]]) });
  for (const park of sc.parks) {
    if (!park.some(([x, y]) => inView(sc, x, y))) continue;
    const xs = park.map(p => p[0]), ys = park.map(p => p[1]);
    for (let k = 0; k < 60; k++) { const x = lr(Math.min(...xs), Math.max(...xs)), y = lr(Math.min(...ys), Math.max(...ys)); if (inPoly(x, y, park) && !waterAt(x, y)) life.parkPts.push([x, y]); }
  }
  for (let i = 0; i < Math.round(clamp(life.parkPts.length / 10 * people, 0, 10)); i++) { const p = lpick(life.parkPts); life.walkers.push({ free: true, x: p[0], y: p[1], tx: p[0], ty: p[1], speed: lr(1, 1.5), col: lpick([[214, 90, 70], [62, 70, 84], [64, 108, 184], [226, 188, 114]]) }); }

  // birds: gulls near water, crows in cities, small birds in suburbs
  let hasWater = false; for (let k = 0; k < 60 && !hasWater; k++) if (waterAt(lr(0, sc.W), lr(0, sc.D))) hasWater = true;
  const bk = hasWater ? "gull" : sc.kind === "dense" ? "crow" : "small";
  const nb = pal.night ? 1 : m.rain ? 2 : 4;
  for (let i = 0; i < nb; i++) life.birds.push({ cx: lr(sc.W * 0.2, sc.W * 0.8), cy: lr(sc.D * 0.2, sc.D * 0.75), rad: lr(50, 140), w: lr(0.12, 0.24) * (i % 2 ? 1 : -1), ph: lr(0, 6.28), alt: lr(25, 60), flap: lr(0, 6.28), kind: bk, scat: 0, sx: 0, sy: 0 });
  // a murmuration over farmland, October to March, near sunset
  const month = new Date(m.utc).getUTCMonth() + 1, north = m.lat >= 0;
  const season = north ? month >= 10 || month <= 3 : month >= 4 && month <= 9;
  const evening = m.sun.alt > -6 && m.sun.alt < 12 && hour >= 13;
  const field = sc.covers.find(c => (c.type === "field" || c.type === "pasture") && c.poly.some(([x, y]) => inView(sc, x, y)));
  if ((sc.kind === "country" || sc.kind === "mountain") && field && season && evening && !m.rain) { const c = centroid(field.poly); life.flock = { c: [clamp(c[0], sc.W * 0.2, sc.W * 0.8), clamp(c[1], sc.D * 0.25, sc.D * 0.7)], r: Math.min(260, sc.W * 0.12), n: 150, ph: Array.from({ length: 150 }, () => [lr(0, 6.28), lr(0, 6.28), lr(0.6, 1.4), lr(-1, 1)]), scat: 0 }; }
  // livestock grazing in pasture, by day
  if (!pal.night) for (const p of sc.pasture.slice(0, 3)) { if (!p.some(([x, y]) => inView(sc, x, y))) continue; for (let i = 0; i < 6; i++) { const q = randomIn(p); life.cows.push({ x: q[0], y: q[1], tx: q[0], ty: q[1], t: lr(0, 8), poly: p }); } }
  // chimney smoke from houses and farms when it is cold, drifting with the real wind
  if ((w?.temp ?? 12) < 8) { const houses = sc.buildings.filter(b => b.house && inView(sc, b.c[0], b.c[1])); for (let i = 0; i < Math.min(sc.kind === "dense" ? 4 : 10, houses.length); i++) { const b = lpick(houses); life.smokeSrc.push({ x: b.c[0], y: b.c[1], z: b.h + b.roofH + 1, next: lr(0, 1) }); } }
  // street lamps along lit roads: they come on one by one as the sun drops below -2 degrees
  for (const r of sc.roads) { if (!r.lit) continue; for (const p of sampleLine(r.pts, 34)) if (inView(sc, p[0], p[1]) && !waterAt(p[0], p[1])) life.lamps.push({ x: p[0] + Math.sin(p[2]) * r.w * 0.5, y: p[1] - Math.cos(p[2]) * r.w * 0.5, on: lr(0, 10), fl: lr(0, 6.28) }); if (life.lamps.length > 500) break; }
  // cable cars and gondolas on their real lines: cabins run up and back
  for (const c of joinLines(sc.cables, 20).filter(c => polyLen(c) > 200 && c.some(([x, y]) => inView(sc, x, y, 200))).slice(0, 2)) {
    const L = polyLen(c); life.cables.push({ path: c, L, cabins: Array.from({ length: Math.max(1, Math.min(6, Math.round(L / 400))) }, (_, i) => ({ s: (i / Math.max(1, Math.round(L / 400))) * L * 2 })) });
  }
  // cloud shadows when it is partly cloudy
  if (m.partly && !pal.night) life.clouds = Array.from({ length: 3 }, () => ({ x: lr(0, sc.W), y: lr(0, sc.D), r: lr(0.12, 0.2) * sc.W, v: lr(5, 9) }));
  return life;
}
function randomIn(poly: P2[]): P2 { const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]); for (let k = 0; k < 200; k++) { const x = lr(Math.min(...xs), Math.max(...xs)), y = lr(Math.min(...ys), Math.max(...ys)); if (inPoly(x, y, poly)) return [x, y]; } return centroid(poly); }

// advance the world; `drop` sends ripples into the water
export function stepLife(sc: World, life: Life, t: number, dt: number, drop: (x: number, y: number, amp: number, rad: number) => void) {
  life.t = t;
  const windDir = ((sc.moment.weather?.windDir ?? 250) + 180) * PI / 180; // blowing toward
  const head = { N: 0, E: 90, S: 180, W: 270 }[sc.heading as "N"] * PI / 180;
  const wx = Math.sin(windDir - head), wy = Math.cos(windDir - head), ws = clamp((sc.moment.weather?.wind ?? 3) / 4, 0.4, 3);
  for (const b of life.boats) {
    b.r.step(dt);
    const [x, y, a] = b.r.pos();
    b.trailT += dt; if (b.trailT > 0.25 && b.r.wait <= 0) { b.trailT = 0; b.trail.unshift([x - Math.cos(a) * b.L * 0.5, y - Math.sin(a) * b.L * 0.5, t, a]); if (b.trail.length > 26) b.trail.pop(); }
    b.wakeT += dt; if (b.wakeT > 0.14 && b.r.wait <= 0) { b.wakeT = 0; b.side = -(b.side || 1); const sx = x - Math.cos(a) * b.L * 0.55, sy = y - Math.sin(a) * b.L * 0.55; drop(sx - Math.sin(a) * b.B * 0.5 * b.side, sy + Math.cos(a) * b.B * 0.5 * b.side, b.L > 30 ? 34 : 24, 1.5); }
    if (b.honk > 0) b.honk -= dt;
    if (b.steam > 0) b.steam -= dt;
  }
  for (const c of life.cars) { c.r.step(dt); if ((c.r.s >= c.r.L && c.r.dir > 0) || (c.r.s <= 0 && c.r.dir < 0)) life.nextRoad(c); }
  for (const w of life.walkers) {
    if (!w.free) { w.r.step(dt); continue; }
    const dx = w.tx - w.x, dy = w.ty - w.y, d = Math.hypot(dx, dy);
    if (d < 1) { const p = lpick(life.parkPts); if (p && Math.hypot(p[0] - w.x, p[1] - w.y) < 160) { w.tx = p[0]; w.ty = p[1]; } }
    else { w.x += dx / d * w.speed * dt; w.y += dy / d * w.speed * dt; }
  }
  for (const b of life.birds) { if (b.scat > 0) { b.scat -= dt; b.sx *= 0.985; b.sy *= 0.985; } b.ox = (b.ox || 0) + b.sx * dt; b.oy = (b.oy || 0) + b.sy * dt; b.ox *= 0.995; b.oy *= 0.995; }
  if (life.flock) life.flock.scat = Math.max(0, life.flock.scat - dt);
  if (life.train) life.train.r.step(dt);
  for (const c of life.cables) for (const k of c.cabins) k.s = (k.s + dt * 5) % (c.L * 2);
  for (const c of life.cows) { c.t -= dt; if (c.t < 0) { c.t = lr(5, 14); if (LR() < 0.6) { const p = [c.x + lr(-12, 12), c.y + lr(-12, 12)]; if (inPoly(p[0], p[1], c.poly)) { c.tx = p[0]; c.ty = p[1]; } } } const dx = c.tx - c.x, dy = c.ty - c.y, d = Math.hypot(dx, dy); if (d > 0.3) { c.x += dx / d * 0.35 * dt; c.y += dy / d * 0.35 * dt; c.a = Math.atan2(dy, dx); } }
  for (const s of life.smokeSrc) { s.next -= dt; if (s.next < 0) { s.next = lr(0.35, 0.7); life.smoke.push({ x: s.x, y: s.y, z: s.z, t0: t, r0: lr(1.2, 2), wx: wx * ws, wy: wy * ws }); } }
  life.smoke = life.smoke.filter(p => t - p.t0 < 11);
  if ((life.weather.rain || life.weather.drizzle) && t > life.rainNext) {
    life.rainNext = t + (life.weather.rain ? lr(0.02, 0.08) : lr(0.06, 0.2));
    for (let k = 0; k < 12; k++) { const x = lr(0, sc.W), y = lr(0, sc.D); if (sc.waterAt?.(x, y)) { life.rings.push({ x, y, t0: t, r: lr(1.5, 3) }); drop(x, y, lr(14, 26), 1.1); break; } }
  }
  life.rings = life.rings.filter(r => t - r.t0 < 1.6);
}

export interface LiveView { cam: Cam; zbuf: Float32Array | null; windows: [number, number, number, number][]; lifeAlpha: number; liveT0: number; label: any; live: { boats: any[]; birds: any[]; flock?: number[] }; weather?: any[]; cloud?: any; fogSprite?: any; S: number }

export function drawLife(sc: World, life: Life, v: LiveView, g: G2, t: number, sprites: { cloud: CanvasImageSource; fog: CanvasImageSource }) {
  const pal = sc.pal, H = sc.H, S = sc.shW, show = v.lifeAlpha, cam = v.cam;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, g.canvas.width, g.canvas.height); g.setTransform(v.S, 0, 0, v.S, 0, 0);
  v.live = { boats: [], birds: [] };
  if (show <= 0) return;
  g.save(); g.beginPath(); g.rect(M, M, CW - 2 * M, CH - 2 * M); g.clip();
  g.globalAlpha = show;
  const fadeAt = (x: number, y: number) => clamp((sc.D - y) / (sc.D * 0.1), 0, 1) * clamp(x / (sc.W * 0.035), 0, 1) * clamp((sc.W - x) / (sc.W * 0.035), 0, 1);
  const P = (x: number, y: number, z?: number) => project(cam, x, y, z ?? H(x, y));
  const zb = v.zbuf;
  const behind = (p: number[]) => { if (!zb) return false; const x = Math.floor(p[0] / 4), y = Math.floor(p[1] / 4); if (x < 0 || y < 0 || x >= CW >> 2 || y >= CH >> 2) return false; return zb[y * (CW >> 2) + x] < p[3] - 2; };
  const on = (p: number[]) => p[0] > M - 30 && p[0] < CW - M + 30 && p[1] > M - 30 && p[1] < CH - M + 30 && p[3] > 0 && !behind(p);
  const ex = 1.15;
  const squash = Math.sin(cam.phi);

  for (const c of life.clouds) {
    const x = ((c.x + t * c.v) % (sc.W * 1.4)) - sc.W * 0.2, p = P(x, c.y, H(clamp(x, 0, sc.W), c.y));
    const r = c.r * p[2];
    g.globalAlpha = 0.08 * show * fadeAt(clamp(x, 0, sc.W), c.y); g.drawImage(sprites.cloud, p[0] - r, p[1] - r * squash * 0.7, r * 2, r * 1.4 * squash);
  }
  g.globalAlpha = show;
  for (const r of life.rings) {
    const age = (t - r.t0) / 1.6, p = P(r.x, r.y, 0); if (!on(p)) continue;
    const rr = (r.r + age * 4) * p[2] * ex;
    g.strokeStyle = `rgba(255,255,252,${(1 - age) * 0.5 * show})`; g.lineWidth = 0.9;
    g.beginPath(); g.ellipse(p[0], p[1], rr, rr * squash, 0, 0, PI * 2); g.stroke();
  }
  for (const b of life.boats) {
    const [x, y, a] = b.r.pos(), z = 0, fade = fadeAt(x, y);
    g.lineCap = "round";
    for (const side of [-1, 1]) {
      g.beginPath(); let started = false;
      for (const [wx, wy, t0, wa] of b.trail) { const age = t - t0, spread = b.B * 0.5 + age * 1.4, px = wx - Math.sin(wa) * spread * side, py = wy + Math.cos(wa) * spread * side; const p = P(px, py, z); if (!started) { g.moveTo(p[0], p[1]); started = true; } else g.lineTo(p[0], p[1]); }
      g.strokeStyle = `rgba(255,255,252,${0.55 * show * fade})`; g.lineWidth = 1.1; g.stroke();
    }
    const bow = P(x + Math.cos(a) * b.L / 2, y + Math.sin(a) * b.L / 2, z), stern = P(x - Math.cos(a) * b.L / 2, y - Math.sin(a) * b.L / 2, z), mid = P(x, y, z);
    if (!on(mid)) continue;
    const ang = Math.atan2(bow[1] - stern[1], bow[0] - stern[0]), len = Math.max(6, Math.hypot(bow[0] - stern[0], bow[1] - stern[1]) * ex);
    const wid = Math.max(2.4, b.B * mid[2] * ex * 0.75);
    g.save(); g.translate(mid[0], mid[1]); g.rotate(ang); g.globalAlpha = show * fade;
    const hull = () => { g.beginPath(); g.moveTo(len / 2, 0); g.quadraticCurveTo(len * 0.3, -wid / 2, -len * 0.42, -wid / 2); g.lineTo(-len / 2, 0); g.lineTo(-len * 0.42, wid / 2); g.quadraticCurveTo(len * 0.3, wid / 2, len / 2, 0); g.closePath(); };
    g.save(); g.translate(2, 2); hull(); g.fillStyle = rgb(pal.shadow, pal.shadowAlpha * 0.7); g.fill(); g.restore();
    hull(); g.fillStyle = rgb(b.hull, 0.96); g.fill();
    if (b.cabin) { g.fillStyle = rgb(b.deck, 0.92); g.fillRect(-len * 0.3, -wid * 0.3, len * b.cabin, wid * 0.6); }
    hull(); g.strokeStyle = rgb(pal.pencil, 0.55); g.lineWidth = 0.8; g.stroke();
    if (pal.night && b.kind !== "sail") { g.fillStyle = rgb(pal.lights, 0.85); for (let k = -1; k <= 1; k++) g.fillRect(-len * 0.2 + k * len * 0.12, -0.6, 1.2, 1.2); }
    g.restore();
    if (b.sail) {
      const mast = P(x, y, z + b.sail); g.globalAlpha = show * fade;
      g.fillStyle = "rgba(252,251,247,0.95)"; g.strokeStyle = rgb(pal.pencil, 0.5); g.lineWidth = 0.7;
      const back = P(x - Math.cos(a) * b.L * 0.4, y - Math.sin(a) * b.L * 0.4, z + 1);
      g.beginPath(); g.moveTo(mid[0], mid[1]); g.lineTo(mast[0], mast[1]); g.lineTo(back[0], back[1]); g.closePath(); g.fill(); g.stroke();
    }
    if (b.lanterns && pal.night) for (let k = -2; k <= 2; k++) { const lp = P(x + Math.cos(a) * k * b.L * 0.18, y + Math.sin(a) * k * b.L * 0.18, z + 2.5); glow(g, lp[0], lp[1], 5, pal.lights, 0.75 * show); }
    if (b.honk > 0) {
      g.strokeStyle = `rgba(255,255,255,${b.honk * 0.6})`; g.lineWidth = 1.2; for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(bow[0], bow[1] - 6, k * 6 * (1.4 - b.honk), -PI * 0.8, -PI * 0.2); g.stroke(); }
      // a puff of steam from the funnel
      const st = 1 - b.honk, fp = P(x, y, z + 6 + st * 8);
      g.fillStyle = `rgba(250,250,252,${b.honk * 0.7 * show})`; for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(fp[0] + k * 3 * st, fp[1] - k * 2 * st, 2 + st * 5 + k, 0, PI * 2); g.fill(); }
    }
    g.globalAlpha = show;
    v.live.boats.push({ x: mid[0], y: mid[1], r: Math.max(12, len * 0.6), b });
  }
  if (life.train) {
    const tr = life.train, L = tr.r.L;
    for (let k = 0; k < tr.cars; k++) {
      const s = ((tr.r.s - k * 21) % L + L) % L, pa = pointAt(tr.r.path, s), pb = pointAt(tr.r.path, Math.max(0, s - 19));
      const a = P(pa[0], pa[1]), b = P(pb[0], pb[1]); if (!on(a)) continue;
      const wv = Math.max(2.4, 3 * a[2] * ex);
      g.strokeStyle = rgb([210, 214, 206], 0.97 * show); g.lineWidth = wv; g.lineCap = "butt"; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.strokeStyle = rgb([70, 140, 90], 0.9 * show); g.lineWidth = Math.max(0.8, wv * 0.3); g.stroke();
      if (pal.night) { g.strokeStyle = rgb(pal.lights, 0.6 * show); g.lineWidth = Math.max(0.6, wv * 0.18); g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]); }
    }
  }
  for (const c of life.cars) {
    const [x, y, a] = c.r.pos(), lane = 1.6, px = x + Math.sin(a) * lane, py = y - Math.cos(a) * lane;
    const p = P(px, py), q = P(px + Math.cos(a) * 2.3, py + Math.sin(a) * 2.3); if (!on(p)) continue;
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), L0 = c.scooter ? 2 : c.bus ? 11 : 4.6;
    const len = Math.max(c.scooter ? 2.2 : 3.4, L0 * p[2] * ex), wid = Math.max(1.6, (c.scooter ? 0.8 : c.bus ? 2.5 : 1.9) * p[2] * ex);
    const fade = fadeAt(px, py);
    g.save(); g.translate(p[0], p[1]); g.rotate(ang); g.globalAlpha = show * fade;
    g.fillStyle = rgb(c.bus ? [214, 70, 60] : c.col, 0.95); g.fillRect(-len / 2, -wid / 2, len, wid);
    g.strokeStyle = rgb(pal.pencil, 0.4); g.lineWidth = 0.6; g.strokeRect(-len / 2, -wid / 2, len, wid);
    g.restore(); g.globalAlpha = show;
    if (pal.night) { const hp = P(px + Math.cos(a) * 4, py + Math.sin(a) * 4); glow(g, hp[0], hp[1], 7, [255, 236, 190], 0.5 * show * fade); const tp = P(px - Math.cos(a) * 2.6, py - Math.sin(a) * 2.6); glow(g, tp[0], tp[1], 3, [240, 80, 70], 0.6 * show * fade); }
  }
  for (const w of life.walkers) {
    let x: number, y: number; if (w.free) { x = w.x; y = w.y; } else { const p = w.r.pos(); x = p[0]; y = p[1]; }
    const p = P(x, y); if (!on(p)) continue;
    const r = Math.max(1, (w.bike ? 0.7 : 0.5) * p[2] * ex * 1.4);
    g.fillStyle = rgb(w.col, 0.9 * show * fadeAt(x, y)); g.beginPath(); g.arc(p[0], p[1] - r, r, 0, PI * 2); g.fill();
    if (life.weather.rain && !w.bike) { g.fillStyle = rgb([40, 44, 60], 0.7 * show); g.beginPath(); g.ellipse(p[0], p[1] - r * 2.6, r * 2.2, r * 1.0, 0, PI, 0); g.fill(); }
  }
  for (const c of life.cows) {
    const p = P(c.x, c.y); if (!on(p)) continue;
    const len = Math.max(2.4, 2.2 * p[2] * ex * 1.3), wid = len * 0.45;
    g.save(); g.translate(p[0], p[1]); g.rotate(-(c.a || 0)); g.fillStyle = rgb([250, 248, 242], 0.95 * show); g.beginPath(); g.ellipse(0, 0, len / 2, wid / 2, 0, 0, PI * 2); g.fill();
    g.fillStyle = rgb([46, 44, 50], 0.85 * show); g.beginPath(); g.ellipse(len * 0.12, 0, len * 0.18, wid * 0.42, 0, 0, PI * 2); g.fill(); g.beginPath(); g.arc(len * 0.5, 0, wid * 0.3, 0, PI * 2); g.fill(); g.restore();
  }
  // cable cars: the line sags between its ends, cabins hang from it
  for (const c of life.cables) {
    const a = c.path[0], b = c.path[c.path.length - 1], za = H(a[0], a[1]) + 12, zb = H(b[0], b[1]) + 12;
    const at = (u: number): [number, number, number] => { const p = pointAt(c.path, u * c.L); return [p[0], p[1], za + (zb - za) * u - Math.sin(u * PI) * c.L * 0.03]; };
    g.strokeStyle = rgb(pal.pencil, 0.5 * show); g.lineWidth = 0.7; g.beginPath(); let st = false;
    for (let i = 0; i <= 40; i++) { const q = at(i / 40), p = P(q[0], q[1], q[2]); if (p[3] <= 0) { st = false; continue; } if (st) g.lineTo(p[0], p[1]); else { g.moveTo(p[0], p[1]); st = true; } }
    g.stroke();
    for (const k of c.cabins) {
      const u = k.s <= c.L ? k.s / c.L : 2 - k.s / c.L, q = at(u), p = P(q[0], q[1], q[2] - 3); if (!on(p)) continue;
      const sz = Math.max(3, 4 * p[2] * ex);
      g.fillStyle = rgb([200, 60, 52], 0.95 * show); g.fillRect(p[0] - sz / 2, p[1] - sz * 0.4, sz, sz * 0.8);
      g.strokeStyle = rgb(pal.pencil, 0.6 * show); g.strokeRect(p[0] - sz / 2, p[1] - sz * 0.4, sz, sz * 0.8); g.beginPath(); g.moveTo(p[0], p[1] - sz * 0.4); g.lineTo(p[0], p[1] - sz * 0.9); g.stroke();
    }
  }
  // lamps: one by one over ten seconds once the sun is 2 degrees down
  const age = t - v.liveT0;
  if (life.lamps.length && sc.moment.sun.alt < -2) for (const l of life.lamps) {
    if (age < l.on) continue; const p = P(l.x, l.y, H(l.x, l.y) + 5); if (!on(p)) continue;
    const k = clamp((age - l.on) / 1.5, 0, 1) * (0.85 + 0.15 * Math.sin(t * 3 + l.fl)) * fadeAt(l.x, l.y);
    glow(g, p[0], p[1], Math.max(3, 4 * p[2] * 1.5), pal.lights, 0.6 * k * show);
  }
  // lit windows: a few switch each minute
  if (v.windows.length) {
    const minute = Math.floor(t / 60);
    for (let i = 0; i < v.windows.length; i += 1) {
      const k = Math.sin(i * 12.9898 + minute * 78.233) * 43758.5453, f = k - Math.floor(k);
      const w = v.windows[i];
      if (f > 0.985) { g.fillStyle = rgb(mix3(pal.lights, [40, 40, 70], 0.7), 0.9 * show); g.fillRect(w[0] - w[2] / 2, w[1] - w[3] / 2, w[2], w[3]); }
      else if (f < 0.04) glow(g, w[0], w[1], Math.max(2.5, w[3] * 1.6), pal.lights, 0.35 * show);
    }
  }
  for (const s of life.smoke) {
    const a = t - s.t0, p = P(s.x + a * 1.2 * s.wx, s.y + a * 1.2 * s.wy, s.z + H(s.x, s.y) + a * 1.4); if (!on(p)) continue;
    const r = Math.max(1, (s.r0 * 0.6 + a * 0.35) * p[2] * ex);
    g.fillStyle = `rgba(236,236,240,${0.22 * (1 - a / 11) * show})`; g.beginPath(); g.ellipse(p[0], p[1], r * 1.3, r * 0.8, 0, 0, PI * 2); g.fill();
  }
  if (life.flock) {
    const f = life.flock, c = [f.c[0] + Math.sin(t * 0.05) * f.r * 0.6, f.c[1] + Math.cos(t * 0.037) * f.r * 0.4];
    const rx = 70 + 40 * Math.sin(t * 0.21), ry = 40 + 25 * Math.cos(t * 0.17 + 1), sc2 = 1 + f.scat * 1.5;
    g.fillStyle = rgb([40, 38, 46], 0.8 * show);
    for (const [a0, b0, k, d] of f.ph) {
      const th = a0 + t * 0.25 * k, x = c[0] + (Math.cos(th) * rx + Math.sin(b0 + t * 0.6) * 18) * sc2, y = c[1] + (Math.sin(th * 2 + d) * ry + Math.cos(b0 + t * 0.5) * 12) * sc2;
      const p = P(x, y, H(x, y) + 70 + d * 20); if (!on(p)) continue;
      g.fillRect(p[0], p[1], 1.6, 1.3);
    }
    v.live.flock = P(c[0], c[1], H(c[0], c[1]) + 70);
  }
  for (const b of life.birds) {
    const a = b.ph + t * b.w, x = b.cx + Math.cos(a) * b.rad + (b.ox || 0), y = b.cy + Math.sin(a) * b.rad * 0.6 + (b.oy || 0), gz = H(clamp(x, 0, sc.W), clamp(y, 0, sc.D));
    const hx = -Math.sin(a) * Math.sign(b.w) + b.sx * 0.05, hy = Math.cos(a) * 0.6 * Math.sign(b.w) + b.sy * 0.05;
    const p = P(x, y, gz + b.alt), ahead = P(x + hx * 5, y + hy * 5, gz + b.alt); if (!on(p)) continue;
    const head = Math.atan2(ahead[1] - p[1], ahead[0] - p[0]);
    const fast = b.scat > 0 ? 3 : 1, flap = Math.sin(t * 7 * fast + b.flap) > 0.4 || b.scat > 0 ? 0.5 + 0.5 * Math.sin(t * 22 + b.flap) : 0.25;
    const size = (b.kind === "small" ? 5 : b.kind === "crow" ? 8 : 10) * clamp(p[2] / 1.1, 0.6, 1.4);
    const col = b.kind === "gull" ? rgb(pal.pencil, 0.78 * show) : rgb([34, 32, 40], 0.85 * show);
    if (pal.shadowAlpha > 0.1) { const sp = P(x + S.dx * b.alt * Math.min(S.perM, 2.5), y + S.dy * b.alt * Math.min(S.perM, 2.5), gz); drawBird(g, sp[0], sp[1], head, flap, size, rgb(pal.shadow, 0.22 * show), 2.2); }
    drawBird(g, p[0], p[1], head, flap, size, col, 1.4);
    v.live.birds.push({ x: p[0], y: p[1], b });
  }
  // weather over everything
  const W = life.weather;
  if (W.snow || W.rain || W.drizzle || W.fog) {
    if (!v.weather) v.weather = Array.from({ length: W.fog ? 7 : W.snow ? 170 : W.rain ? 160 : 90 }, () => ({ x: lr(0, CW), y: lr(0, CH), s: lr(0.5, 1.4), ph: lr(0, 6.28) }));
    for (const p of v.weather) {
      if (W.snow) {
        const y = (p.y + t * 26 * p.s) % CH, x = (p.x + Math.sin(t * 0.8 * p.s + p.ph) * 12 + t * 6) % CW;
        g.fillStyle = `rgba(255,255,255,${0.9 * show})`; g.strokeStyle = `rgba(150,160,186,${0.45 * show})`; g.lineWidth = 0.6;
        g.beginPath(); g.arc(x, y, 1.1 + p.s, 0, PI * 2); g.fill(); g.stroke();
      } else if (W.rain || W.drizzle) {
        const sp = W.rain ? 620 : 420, y = (p.y + t * sp * p.s) % CH, x = (p.x + t * 60 * p.s) % CW;
        g.strokeStyle = `rgba(110,124,140,${(W.rain ? 0.3 : 0.22) * show})`; g.lineWidth = W.rain ? 1 : 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 2.4, y - (W.rain ? 18 : 14) * p.s); g.stroke();
      } else {
        const x = ((p.x + t * 9 * p.s) % (CW + 600)) - 300, y = p.y * 0.8 + 40;
        g.globalAlpha = 0.32 * show; g.drawImage(sprites.fog, x - 250, y - 90, 500, 180); g.globalAlpha = show;
      }
    }
  }
  // a building's name, when tapped
  if (v.label) {
    const L = v.label, a = clamp(1 - (t - L.t0 - 2.6) / 0.8, 0, 1) * clamp((t - L.t0) / 0.2, 0, 1);
    if (t - L.t0 > 3.4) v.label = null;
    else if (a > 0) {
      g.globalAlpha = a;
      g.strokeStyle = rgb(pal.pencil, 0.75); g.lineWidth = 1.2; g.beginPath(); L.poly.forEach((p: number[], i: number) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.stroke();
      g.font = "30px 'Reenie Beanie', 'Bradley Hand', cursive"; g.textAlign = L.x > CW - 260 ? "right" : "left"; g.textBaseline = "bottom";
      const tx = L.x + (g.textAlign === "right" ? -14 : 14), ty = Math.max(M + 34, L.y - 14);
      g.beginPath(); g.moveTo(L.x, L.y); g.lineTo(tx, ty + 2); g.stroke();
      g.lineWidth = 5; g.strokeStyle = "rgba(250,248,242,0.85)"; g.strokeText(L.text, tx, ty);
      g.fillStyle = rgb([40, 38, 48], 0.92); g.fillText(L.text, tx, ty);
      g.globalAlpha = show;
    }
  }
  g.restore();
}
const mix3 = (a: number[], b: number[], t: number) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function drawBird(g: G2, x: number, y: number, head: number, flap: number, s: number, color: string, lw: number) {
  g.save(); g.translate(x, y); g.rotate(head + PI / 2);
  const lift = s * 0.32 * flap;
  g.strokeStyle = color; g.lineWidth = lw; g.lineCap = "round";
  g.beginPath(); g.moveTo(-s, 2 + lift * 0.6); g.quadraticCurveTo(-s * 0.45, -lift - 1, 0, 0); g.quadraticCurveTo(s * 0.45, -lift - 1, s, 2 + lift * 0.6); g.stroke();
  g.restore();
}
function glow(g: G2, x: number, y: number, r: number, c: number[], a: number) {
  const gg = g.createRadialGradient(x, y, 0, x, y, r);
  gg.addColorStop(0, rgb([255, 250, 230], a)); gg.addColorStop(0.35, rgb(c, a * 0.7)); gg.addColorStop(1, rgb(c, 0));
  g.fillStyle = gg; g.beginPath(); g.arc(x, y, r, 0, PI * 2); g.fill();
}
export function rng(seed: number) { LR = mulberry32(seed); }
export { lr };

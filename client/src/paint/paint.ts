// The painter, ported from the prototype: a flat watercolour of the ground in
// world space, draped over a 3D terrain mesh, then sky, buildings and trees
// painted on top in screen space. Deterministic from the seed (cell + date),
// so a postcard replays exactly. Output is a set of layers, so the page can
// bloom them in the PRD's order: sky, water, ground, buildings, trees.
import { CW, CH, M, PI, SC, base, blob, canvas, ccw, centroid, clamp, clipTo, colorize, cx, deform, dot3, fillPoly, finishPaper, gauss, granulate, hull, ident, inPoly, jiggle, lerp, mix, mul, pat, pointAt, polyArea, polyLen, range, reseed, rgb, rimOf, screen, smoothstep, softBlur, traceArr, tracePoly, wash, withVar, alphaGrid, offsetLine, type C3, type Cnv, type G2, type P2 } from "./util.ts";
import type { World } from "./scene.ts";
import type { GLR } from "./gl.ts";

export interface Cam { x: number; y: number; z: number; phi: number; F: number; cos: number; sin: number; near: number; far: number }
export function project(cam: Cam, x: number, y: number, z: number): [number, number, number, number] {
  const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
  const yc = dy * cam.sin + dz * cam.cos, zc = dy * cam.cos - dz * cam.sin;
  return [CW / 2 + cam.F * dx / zc, CH / 2 - cam.F * yc / zc, cam.F / zc, zc];
}
export function unproject(cam: Cam, px: number, py: number, level = 0): P2 | null {
  const xs = (px - CW / 2) / cam.F, ys = -(py - CH / 2) / cam.F;
  const dir = [xs, cam.cos + ys * cam.sin, -cam.sin + ys * cam.cos];
  if (dir[2] >= -1e-6) return null;
  const t = (level - cam.z) / dir[2];
  return [cam.x + dir[0] * t, cam.y + dir[1] * t];
}

// Fit by bisection on camera height: the near edge sits on the bottom of the
// frame and the highest visible terrain at 20-24% of the frame height.
export function makeCam(sc: World): Cam {
  const phi = sc.camPitch * PI / 180, F = CW, vh = Math.atan((CH / 2) / F), aBot = phi + vh;
  const near = 0, depth = sc.D - near, zBase = sc.H(sc.W / 2, near + depth * 0.25), target = sc.farScreen * CH;
  const samples: [number, number, number][] = [];
  for (let j = 0; j <= 24; j++) for (let i = 0; i <= 16; i++) { const x = i / 16 * sc.W, y = near + j / 24 * depth; samples.push([x, y, sc.H(x, y)]); }
  const build = (hc: number): Cam => ({ x: sc.W / 2, y: near - hc / Math.tan(aBot), z: hc + zBase, phi, F, cos: Math.cos(phi), sin: Math.sin(phi), near: 0, far: 0 });
  const topY = (cam: Cam) => { let m = Infinity; for (const [x, y, z] of samples) { const p = project(cam, x, y, z); if (p[3] > 0 && p[0] > -60 && p[0] < CW + 60) m = Math.min(m, p[1]); } return m; };
  let lo = 0.05 * sc.D, hi = 8 * sc.D;
  for (let k = 0; k < 36; k++) { const mid = (lo + hi) / 2; if (topY(build(mid)) < target) lo = mid; else hi = mid; }
  const cam = build(hi);
  cam.near = project(cam, sc.W / 2, near, zBase)[3]; cam.far = project(cam, sc.W / 2, sc.D, sc.H(sc.W / 2, sc.D))[3];
  return cam;
}

export interface GroundOut { tex: Cnv; wmask: Cnv; ppm: number; gw: number; gh: number }

// ---------- the ground: one world-space painting ----------
export async function paintGround(sc: World, tick: () => Promise<void>): Promise<GroundOut> {
  reseed(sc.seed);
  const pal = sc.pal, gw = 2048, ppm = gw / sc.W, gh = Math.round(sc.D * ppm), K = gw / 1500;
  const P = (q: number[]): P2 => [q[0] * ppm, (sc.D - q[1]) * ppm], PP = (a: number[][]) => a.map(P);
  const mk = () => canvas(gw, gh);

  // masks: land everywhere, water cut out (with its islands), piers added back
  const land = mk(), lg = cx(land); lg.fillStyle = "#000";
  lg.fillRect(0, 0, gw, gh); lg.globalCompositeOperation = "destination-out";
  for (const poly of sc.water) {
    lg.beginPath();
    for (const r of poly) { const pts = deform(withVar(PP(r), 0.004), 1); lg.moveTo(pts[0].x, pts[0].y); for (const p of pts) lg.lineTo(p.x, p.y); lg.closePath(); }
    lg.fill("evenodd");
  }
  lg.globalCompositeOperation = "source-over";
  for (const e of sc.land) { traceArr(lg, PP(e)); lg.fill(); }
  const wmask = mk(), wmg = cx(wmask);
  wmg.fillRect(0, 0, gw, gh); wmg.globalCompositeOperation = "destination-out"; wmg.drawImage(land, 0, 0); wmg.globalCompositeOperation = "source-over";
  const wgw = gw >> 2, wgh = gh >> 2, wgrid = alphaGrid(wmask, wgw, wgh);
  sc.waterAt = (x, y) => { const gx = Math.floor(x * ppm / 4), gy = Math.floor((sc.D - y) * ppm / 4); return gx >= 0 && gy >= 0 && gx < wgw && gy < wgh && wgrid[gy * wgw + gx] > 128; };
  const hasWater = wgrid.some(v => v > 128);
  await tick();

  // water
  const water = mk(), w = cx(water);
  if (hasWater) {
    const pW = pat(w, pal.water), pG = pat(w, pal.waterGreen), pL = pat(w, pal.waterLight), pD = pat(w, pal.waterDeep);
    const grad = w.createLinearGradient(0, 0, gw, gh);
    grad.addColorStop(0, rgb(pal.waterLight, 0.55)); grad.addColorStop(0.55, rgb(pal.water, 0.5)); grad.addColorStop(1, rgb(pal.water, 0.62));
    w.fillStyle = grad; w.fillRect(0, 0, gw, gh);
    jiggle(pW, K); w.globalAlpha = 0.22; w.fillStyle = pW; w.fillRect(0, 0, gw, gh); w.globalAlpha = 1;
    const broad = mk(), bw = cx(broad);
    for (let i = 0; i < 12; i++) { const k = rnd01(); wash(bw, deform(blob(range(-100, gw + 100), range(-100, gh + 100), range(220, 400) * K, 0.32), 4), k < 0.45 ? pW : k < 0.75 ? pG : pL, 8, 0.06, 2, K); }
    w.drawImage(softBlur(broad, 12), 0, 0); w.globalAlpha = 0.3; w.drawImage(broad, 0, 0); w.globalAlpha = 1;
    const wet = mk(), wt = cx(wet), tide: ReturnType<typeof deform>[] = [];
    for (let i = 0; i < 9; i++) { const b = deform(blob(range(0, gw), range(0, gh), range(110, 240) * K, 0.38), 4); wash(wt, b, rnd01() < 0.5 ? pD : pW, 8, 0.045, 2, K); tide.push(b); }
    w.drawImage(softBlur(wet, 16), 0, 0); w.globalAlpha = 0.14; w.drawImage(wet, 0, 0); w.globalAlpha = 1;
    for (const t of tide) { if (rnd01() < 0.35) continue; w.strokeStyle = rgb(pal.waterDeep, range(0.08, 0.16)); w.lineWidth = range(0.9, 1.6) * K; tracePoly(w, deform(t, 1)); w.stroke(); }
    clipTo(water, softBlur(wmask, 1.5));
    if (pal.waterShallow) w.drawImage(colorize(rimOf(wmask, 26), pal.waterShallow, 0.55), 0, 0);
    w.drawImage(colorize(rimOf(wmask, 6), pal.waterDeep, 0.4), 0, 0);
    w.save(); w.globalCompositeOperation = "destination-out"; w.fillStyle = "#000";
    for (let i = 0; i < 90; i++) { w.globalAlpha = range(0.1, 0.22); w.beginPath(); w.ellipse(range(0, gw), range(0, gh), range(18, 60) * K, range(0.8, 1.8) * K, range(-0.1, 0), 0, PI * 2); w.fill(); }
    w.restore();
    clipTo(water, wmask);
    granulate(water, 0.22);
  }
  await tick();

  // ground, with roads reserved as bare paper
  const ground = mk(), gr = cx(ground);
  const pGr = pat(gr, pal.ground), pRo = pat(gr, pal.groundRose);
  jiggle(pGr, K); gr.globalAlpha = 0.18; gr.fillStyle = pGr; gr.fillRect(0, 0, gw, gh); gr.globalAlpha = 1;
  const sp = 240 * K;
  for (let gy = -1; gy <= gh / sp + 1; gy++) for (let gx = -1; gx <= gw / sp + 1; gx++)
    wash(gr, deform(blob(gx * sp + range(-80, 80) * K, gy * sp + range(-80, 80) * K, range(150, 240) * K, 0.33), 4), rnd01() < 0.7 ? pGr : pRo, 6, 0.045, 2, K);
  const lightGrad = gr.createLinearGradient(gw * 0.12, gh * 0.95, gw * 0.88, gh * 0.08);
  lightGrad.addColorStop(0, rgb(pal.warmLight, 0.4)); lightGrad.addColorStop(0.5, rgb(pal.warmLight, 0)); lightGrad.addColorStop(1, rgb(pal.coolAir, 0.36));
  gr.fillStyle = lightGrad; gr.fillRect(0, 0, gw, gh);
  clipTo(ground, softBlur(land, 1.5));
  gr.drawImage(colorize(rimOf(land, 5), pal.groundDark, 0.3), 0, 0);
  if (!pal.snow) {
    gr.save(); gr.globalCompositeOperation = "destination-out"; gr.lineCap = "round"; gr.lineJoin = "round"; gr.strokeStyle = "#000"; gr.fillStyle = "#000";
    for (const r of sc.roads) {
      if (r.kind === "rail" || r.kind === "dirt" || rnd01() < 0.05) continue;
      gr.globalAlpha = r.kind === "path" ? range(0.35, 0.55) : range(0.6, 0.9);
      gr.lineWidth = Math.max(2, r.w * ppm * range(0.8, 1.0));
      const pts = PP(r.pts); gr.beginPath(); pts.forEach((p, i) => i ? gr.lineTo(p[0] + gauss() * 0.6, p[1] + gauss() * 0.6) : gr.moveTo(p[0], p[1])); gr.stroke();
    }
    for (let i = 0; i < 26; i++) { gr.globalAlpha = range(0.15, 0.35); fillPoly(gr, deform(blob(range(0, gw), range(0, gh), range(25, 70) * K, 0.4), 3)); }
    gr.restore();
  }
  clipTo(ground, land);
  granulate(ground, 0.28);
  await tick();

  // land cover: fields, woods, parks, yards, pools, sand, snow
  const cov = mk(), cv = cx(cov);
  const order = (t: string) => ({ forest: 0, field: 1, pasture: 1, grass: 2, park: 3, cemetery: 3, scrub: 2, wetland: 2, bare: 2, snow: 4, yard: 5, plaza: 6, pitch: 6, track: 7, parking: 7, sand: 4, pool: 9 } as Record<string, number>)[t] ?? 5;
  for (const c of sc.covers.slice().sort((a, b) => order(a.type) - order(b.type))) {
    const col = c.col, pts = PP(c.poly);
    if (pts.length < 3) continue;
    const sharp = c.type === "pool" || c.type === "parking" || c.type === "pitch" || c.type === "track";
    const baseP = withVar(pts, sharp ? 0.01 : c.type === "forest" ? 0.07 : 0.03);
    wash(cv, baseP, pat(cv, col), sharp ? 2 : 4, c.type === "pool" ? 0.5 : c.type === "forest" ? 0.11 : c.type === "snow" ? 0.35 : sharp ? 0.32 : 0.2, sharp ? 1 : 2, K);
    if (c.type === "pool") { cv.strokeStyle = rgb([255, 255, 255], 0.9); cv.lineWidth = 1.2; traceArr(cv, pts); cv.stroke(); }
    if (c.type === "pitch") { cv.strokeStyle = rgb([255, 255, 255], 0.55); cv.lineWidth = 1; traceArr(cv, pts); cv.stroke(); }
    if (c.type === "field" || c.type === "grove") {
      cv.save(); traceArr(cv, pts); cv.clip();
      const [mx, my] = centroid(pts), ang = -(c.angle || 0), span = Math.max(gw, gh);
      const spacing = c.type === "grove" ? 9 * K : c.crop === "plowed" ? 3.2 * K : c.crop === "pasture" ? 0 : 6 * K;
      if (spacing) {
        cv.strokeStyle = rgb(mul(col, 0.72), c.crop === "plowed" ? 0.3 : 0.16); cv.lineWidth = c.crop === "plowed" ? 1.4 * K : 1;
        cv.beginPath();
        const ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
        for (let o = -span; o < span; o += spacing) { cv.moveTo(mx + vx * o - ux * span, my + vy * o - uy * span); cv.lineTo(mx + vx * o + ux * span, my + vy * o + uy * span); }
        cv.stroke();
      }
      cv.restore();
    }
  }
  clipTo(cov, land);
  granulate(cov, 0.22);
  await tick();

  // shadows at the sun's real angle
  const shadow = mk(), sh = cx(shadow), S = sc.shW;
  if (pal.shadowAlpha > 0.05) {
    // building shadows swept along the sun, on a quarter-resolution mask:
    // they are blurred anyway, and this is the costliest part of the ground
    const q = 4, sw = Math.ceil(gw / q), shh = Math.ceil(gh / q), qp = ppm / q;
    const sm = canvas(sw, shh), smg = cx(sm); smg.fillStyle = "#000"; smg.fillRect(0, 0, sw, shh); smg.globalCompositeOperation = "lighten";
    const sdx = S.dx * qp, sdy = -S.dy * qp;
    for (const b of sc.buildings.slice().sort((a, c) => a.h - c.h)) {
      const L = Math.min((b.h + b.roofH * 0.6) * S.perM, 260), steps = Math.max(2, Math.min(24, Math.ceil(L * qp / 2))), pts = b.p.map(p => [p[0] * qp, (sc.D - p[1]) * qp]);
      if (!pts.some(([x, y]) => x > -L * qp && x < sw + L * qp && y > -L * qp && y < shh + L * qp)) continue;
      for (let k = steps; k >= 0; k--) {
        const f = k / steps, gv = Math.round(255 * Math.pow(1 - f, 1.6));
        smg.fillStyle = `rgb(${gv},${gv},${gv})`; smg.beginPath();
        pts.forEach((p, i) => { const x = p[0] + sdx * L * f, y = p[1] + sdy * L * f; i ? smg.lineTo(x, y) : smg.moveTo(x, y); });
        smg.closePath(); smg.fill();
      }
    }
    const big = mk(), bg = cx(big); bg.imageSmoothingQuality = "high"; bg.drawImage(sm, 0, 0, gw, gh);
    const sid = cx(softBlur(big, 3)).getImageData(0, 0, gw, gh), sdd = sid.data;
    for (let i = 0; i < sdd.length; i += 4) { sdd[i + 3] = sdd[i]; sdd[i] = sdd[i + 1] = sdd[i + 2] = 0; }
    const smask = mk(), smc = cx(smask); smc.putImageData(sid, 0, 0);
    const ts = mk(), tg = cx(ts); tg.fillStyle = "#000";
    const ang = Math.atan2(-S.dy, S.dx), tdx = S.dx * ppm, tdy = -S.dy * ppm;
    for (const t of sc.trees) {
      const L = Math.min(t.h * 0.62 * S.perM, 90), [x, y] = P([t.x, t.y]);
      tg.globalAlpha = 0.6; tg.beginPath();
      tg.ellipse(x + tdx * L, y + tdy * L, t.r * ppm * (1 + Math.min(S.perM, 3) * 0.25), t.r * ppm * 0.9, ang, 0, PI * 2); tg.fill();
    }
    tg.globalAlpha = 1;
    smc.drawImage(softBlur(ts, 2), 0, 0);
    const pS = pat(sh, pal.shadow); jiggle(pS, K); sh.fillStyle = pS; sh.fillRect(0, 0, gw, gh);
    clipTo(shadow, smask); granulate(shadow, 0.25);
  }
  await tick();

  // ink on the ground: rails, dirt tracks, snowy roads, bridges
  const ink = mk(), ik = cx(ink); ik.lineCap = "round"; ik.lineJoin = "round";
  const line = (pts: P2[], wpx: number, col: number[], a: number) => { ik.strokeStyle = rgb(col, a); ik.lineWidth = wpx; ik.beginPath(); pts.forEach((p, i) => i ? ik.lineTo(p[0], p[1]) : ik.moveTo(p[0], p[1])); ik.stroke(); };
  for (const r of sc.roads) {
    const pts = PP(r.pts);
    if (r.kind === "dirt") line(pts, Math.max(1.6, r.w * ppm), mix(pal.groundDark, pal.ground, 0.3), 0.42);
    else if (r.kind === "rail") { line(pts, r.w * ppm, mix(pal.groundDark, [150, 150, 160], 0.5), 0.35); line(offsetLine(pts, 2.2 * ppm), 1, pal.pencil, 0.45); line(offsetLine(pts, -2.2 * ppm), 1, pal.pencil, 0.45); }
    else if (pal.snow) line(pts, Math.max(2, r.w * ppm * 0.8), [150, 160, 186], 0.32);
  }
  const top = mk(), tp = cx(top); tp.lineCap = "butt";
  if (hasWater) for (const r of sc.roads) {
    if (r.kind === "dirt" || r.kind === "path") continue;
    const L = polyLen(r.pts); let run: P2[] = [];
    const flush = () => {
      if (run.length > 1) {
        const pts = PP(run), wpx = Math.max(3, r.w * ppm);
        tp.strokeStyle = rgb(pal.groundDark, 0.55); tp.lineWidth = wpx + 3 * K; tp.beginPath(); pts.forEach((p, i) => i ? tp.lineTo(p[0], p[1]) : tp.moveTo(p[0], p[1])); tp.stroke();
        tp.strokeStyle = rgb(r.kind === "rail" ? mix(pal.groundDark, pal.paper, 0.4) : mix(pal.paper, pal.ground, 0.25)); tp.lineWidth = wpx; tp.stroke();
      }
      run = [];
    };
    for (let s = 0; s <= L; s += 4) { const p = pointAt(r.pts, s); if (sc.waterAt!(p[0], p[1])) { if (!run.length) { const q = pointAt(r.pts, Math.max(0, s - 8)); run.push([q[0], q[1]]); } run.push([p[0], p[1]]); } else if (run.length) { const q = pointAt(r.pts, Math.min(L, s + 4)); run.push([q[0], q[1]]); flush(); } }
    flush();
  }

  // compose
  const tex = mk(), t = cx(tex);
  t.fillStyle = rgb(pal.paper); t.fillRect(0, 0, gw, gh);
  t.globalCompositeOperation = "multiply";
  t.drawImage(water, 0, 0); t.drawImage(ground, 0, 0); t.drawImage(cov, 0, 0);
  t.globalAlpha = pal.shadowAlpha; t.drawImage(shadow, 0, 0); t.globalAlpha = 1;
  t.drawImage(ink, 0, 0);
  t.globalCompositeOperation = "source-over"; t.drawImage(top, 0, 0);
  if (pal.groundTint) { t.globalCompositeOperation = "multiply"; t.fillStyle = rgb(pal.groundTint); t.fillRect(0, 0, gw, gh); t.globalCompositeOperation = "source-over"; }
  return { tex, wmask, ppm, gw, gh };
}
const rnd01 = () => range(0, 1);

// ---------- finishing touches ----------
function splatter(g: G2, pal: World["pal"], corners: [number, number][]) {
  for (const [sx, sy] of corners) for (let i = 0; i < 22; i++) {
    const x = sx + gauss() * 55, y = sy + gauss() * 38, r = Math.abs(gauss()) * 1.5 + 0.4;
    g.fillStyle = rgb(pal.waterDeep, range(0.22, 0.5)); g.beginPath(); g.arc(x, y, r, 0, PI * 2); g.fill();
  }
}
function vignette(g: G2, pal: World["pal"], cx0: number, cy0: number, inner: number, a: number) {
  const rg = g.createRadialGradient(cx0, cy0, CW * inner, cx0, cy0, CW * 0.72);
  rg.addColorStop(0, rgb(pal.paper, 0)); rg.addColorStop(1, rgb(pal.paper, a));
  g.fillStyle = rg; g.fillRect(0, 0, CW, CH);
}
function shadeTone(sc: World, tone: number[], n: number[]): C3 {
  const pal = sc.pal, L = pal.dif < 0.25 ? sc.reliefV : sc.sunV, dif = pal.dif < 0.25 ? 0.22 : pal.dif;
  const k = clamp((pal.amb + dif * Math.max(dot3(n, L), 0) - pal.amb) / Math.max(dif, 0.01), 0, 1);
  const dark = mix(mul(tone, 0.6), pal.shadow, 0.22), lit = mix(tone, pal.warmLight, 0.16);
  return mix(dark, lit, pal.night ? k * 0.4 : 0.15 + k * 0.85);
}

// ---------- the pencil drawing: geometry alone, painted first ----------
export function paintPencil(sc: World, cam: Cam): Cnv {
  reseed(sc.seed + 5);
  const out = screen(), g = cx(out), pal = sc.pal;
  g.fillStyle = rgb(pal.paper); g.fillRect(0, 0, CW, CH);
  g.lineCap = "round"; g.lineJoin = "round";
  const H = sc.H;
  const fade = (x: number, y: number) => smoothstep(sc.D, sc.D * 0.9, y) * smoothstep(0, sc.W * 0.035, x) * smoothstep(sc.W, sc.W * 0.965, x);
  const stroke = (pts: number[][], z: (x: number, y: number) => number, a: number, w = 0.7) => {
    g.beginPath(); let on = false;
    for (const q of pts) {
      if (q[1] < -50 || q[1] > sc.D + 50) { on = false; continue; }
      const p = project(cam, q[0], q[1], z(q[0], q[1])); if (p[3] <= 0) { on = false; continue; }
      const jx = p[0] + gauss() * 0.3, jy = p[1] + gauss() * 0.3;
      if (on) g.lineTo(jx, jy); else { g.moveTo(jx, jy); on = true; }
    }
    g.strokeStyle = rgb(pal.pencil, a); g.lineWidth = w; g.stroke();
  };
  for (const poly of sc.water) for (const r of poly) stroke([...r, r[0]], () => 0, 0.32, 0.8);
  for (const r of sc.roads) { if (r.kind === "path") continue; const f = fade(r.pts[0][0], r.pts[0][1]); stroke(r.pts, H, (r.kind === "avenue" ? 0.3 : 0.18) * Math.max(0.3, f), r.kind === "avenue" ? 0.8 : 0.6); }
  const objs = sc.buildings.map(b => ({ b, d: project(cam, b.c[0], b.c[1], b.z0)[3] })).filter(o => o.d > 0).sort((a, b) => b.d - a.d);
  for (const { b } of objs) {
    const f = fade(b.c[0], b.c[1]); if (f < 0.05) continue;
    const z1 = b.z0 + b.h;
    const top = b.p.map(([x, y]) => project(cam, x, y, z1)), bot = b.p.map(([x, y]) => project(cam, x, y, b.z0));
    g.strokeStyle = rgb(pal.pencil, 0.26 * f); g.lineWidth = 0.6;
    traceArr(g, top); g.stroke();
    if (b.h > 15) for (let i = 0; i < b.p.length; i++) { if (rnd01() < 0.5) continue; g.beginPath(); g.moveTo(bot[i][0], bot[i][1]); g.lineTo(top[i][0], top[i][1]); g.stroke(); }
  }
  // the skyline of the terrain, so hills read before any paint
  if (sc.relief > 20) { const ridge: number[][] = []; for (let x = 0; x <= sc.W; x += sc.W / 60) ridge.push([x, sc.D]); stroke(ridge, H, 0.4, 0.9); }
  finishPaper(g, pal.paper);
  return out;
}

// ---------- sky and what lies past the far edge ----------
function paintSky(sc: World, cam: Cam, g: G2, yFar: number) {
  const pal = sc.pal;
  const grd = g.createLinearGradient(0, 0, 0, Math.max(60, yFar + 40));
  grd.addColorStop(0, rgb(pal.sky[0])); grd.addColorStop(1, rgb(pal.sky[1]));
  g.fillStyle = grd; g.fillRect(0, 0, CW, CH);
  const sky = screen(), s = cx(sky);
  for (let i = 0; i < 9; i++) wash(s, deform(blob(range(-100, CW + 100), range(-60, yFar), range(120, 260), 0.35), 3), pat(s, mix(pal.sky[0], pal.sky[1], range(0, 0.6))), 4, 0.06, 2);
  g.globalAlpha = 0.8; g.drawImage(softBlur(sky, 6 * SC), 0, 0, CW, CH); g.globalAlpha = 1;
  const cloudy = sc.moment.weather ? sc.moment.weather.cloud : 40;
  if ((pal.clouds !== false && cloudy > 8) || pal.night) {
    const cl = screen(), c = cx(cl); c.fillStyle = "#000";
    const n = Math.round(clamp(cloudy / 12, 2, 9));
    for (let i = 0; i < n; i++) { const y = range(10, yFar * 0.85); fillPoly(c, deform(blob(range(0, CW), y, range(50, 120), 0.4), 3)); fillPoly(c, deform(blob(range(0, CW), y + range(-10, 10), range(30, 70), 0.4), 3)); }
    const soft = softBlur(cl, 10 * SC), sg = cx(soft); ident(sg); sg.globalCompositeOperation = "source-in";
    sg.fillStyle = rgb(pal.night ? (pal.dark ? [120, 116, 160] : [190, 140, 160]) : [255, 253, 248]); sg.fillRect(0, 0, soft.width, soft.height);
    g.globalAlpha = pal.night ? 0.35 : 0.85; g.drawImage(soft, 0, 0, CW, CH); g.globalAlpha = 1;
  }
  if (pal.night && !pal.dark) { const glow = g.createLinearGradient(0, yFar - 120, 0, yFar + 30); glow.addColorStop(0, rgb([244, 168, 120], 0)); glow.addColorStop(1, rgb([250, 180, 120], 0.55)); g.fillStyle = glow; g.fillRect(0, 0, CW, CH); }
  if (pal.dark) {
    // a few stars where the sky is clear, and the city's glow low down
    if (cloudy < 50) for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(255,250,235,${range(0.25, 0.7)})`; g.beginPath(); g.arc(range(M, CW - M), range(M, yFar * 0.7), range(0.4, 1.1), 0, PI * 2); g.fill(); }
    if (sc.kind === "dense" || sc.kind === "suburb") { const glow = g.createLinearGradient(0, yFar - 90, 0, yFar + 20); glow.addColorStop(0, rgb([210, 150, 120], 0)); glow.addColorStop(1, rgb([230, 170, 120], 0.35)); g.fillStyle = glow; g.fillRect(0, 0, CW, CH); }
  }
  // distant silhouettes past the far edge
  const far = screen(), f = cx(far);
  const col = mix(pal.haze, pal.night ? [70, 60, 110] : pal.pencil, pal.night ? 0.55 : 0.28);
  // Real ridges from the terrain beyond the window. A true projection would
  // put distant flat ground all the way up the sky (at this pitch the
  // horizon is above the frame), so each ridge is drawn as seen from the far
  // edge itself: it rises above the far line by its real elevation angle from
  // there. Flat country stays flat; the Eiger fills the sky. Two bands, near
  // over far.
  let ridgeDrawn = false;
  if (sc.beyond?.length) {
    const shift = sc.baseShift, hRef = sc.H(sc.W / 2, sc.D) + shift, top = M + 14, room = yFar - top;
    // snow lies above a seasonal line (lower in winter, lower still if the
    // imagery saw snow), unless it is snowing or lying here too
    const mo = new Date(sc.moment.utc).getUTCMonth() + 1, north = sc.moment.lat >= 0;
    const winter = north ? [11, 12, 1, 2, 3, 4].includes(mo) : [5, 6, 7, 8, 9, 10].includes(mo);
    const snowline = pal.snow ? -1e9 : (winter ? 1500 : [6, 7, 8, 9].includes(mo) === north ? 3000 : 2400) - (sc.absBase ?? 0);
    const vis = sc.moment.weather?.visibility ?? 30000, wet = sc.moment.rain || sc.moment.drizzle || sc.moment.snowing;
    const bands: [number, number, number][] = [[6000, 40000, 0.3 * clamp((vis - 6000) / 14000, 0, 1) * (wet ? 0.4 : 1)], [0, 6000, 0.5 * clamp((vis - 1500) / 5000, 0.15, 1) * (wet ? 0.6 : 1)]];
    for (const [d0, d1, a] of bands) {
      if (a < 0.03) continue;
      const pts: [number, number, number][] = [];
      for (const ray of sc.beyond) {
        const th = ray.az * PI / 180, dFar = sc.D / Math.max(0.3, Math.cos(th));
        let best = 0, hb = -1e9;
        ray.dist.forEach((d, i) => { const dd = d - dFar; if (dd < 150 || dd < d0 || dd > d1) return; const t = (ray.h[i] - hRef) / dd; if (t > best) { best = t; hb = ray.h[i]; } });
        const xw = sc.W / 2 + Math.sin(th) * dFar;
        const x = project(cam, xw, sc.D, sc.H(clamp(xw, 0, sc.W), sc.D))[0];
        // compressive: gentle hills stay low, big peaks keep their shapes
        pts.push([x, yFar - room * (1 - Math.exp(-best * 2.4)), hb]);
      }
      pts.sort((p, q) => p[0] - q[0]);
      if (pts.length > 10 && pts.some(p => p[1] < yFar - 6)) {
        ridgeDrawn = true;
        f.fillStyle = pat(f, mix(col, pal.tree, d0 > 1000 ? 0.06 : 0.18)); jiggle(f.fillStyle as CanvasPattern); f.globalAlpha = a;
        f.beginPath(); f.moveTo(-10, yFar + 40); f.lineTo(-10, pts[0][1]);
        for (const p of pts) f.lineTo(p[0], p[1] + gauss() * 0.4);
        f.lineTo(CW + 10, pts[pts.length - 1][1]); f.lineTo(CW + 10, yFar + 40); f.closePath(); f.fill();
        if (sc.kind === "mountain") { f.globalAlpha = Math.min(1, a * 1.4); f.strokeStyle = rgb(pal.pencil, 0.45); f.lineWidth = 0.8; f.beginPath(); pts.forEach((p, i) => i ? f.lineTo(p[0], p[1]) : f.moveTo(p[0], p[1])); f.stroke(); }
        // snow caps where the ridge is above the snowline
        f.globalAlpha = Math.min(1, a * 1.5); f.fillStyle = rgb([250, 251, 255]);
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1]; if (p[2] < snowline && q[2] < snowline) continue;
          const dp = clamp((yFar - p[1]) * 0.3, 0, 30) * clamp((p[2] - snowline) / 600, 0, 1), dq = clamp((yFar - q[1]) * 0.3, 0, 30) * clamp((q[2] - snowline) / 600, 0, 1);
          f.beginPath(); f.moveTo(p[0], p[1]); f.lineTo(q[0], q[1]); f.lineTo(q[0], q[1] + dq); f.lineTo(p[0], p[1] + dp); f.closePath(); f.fill();
        }
        f.globalAlpha = 1;
      }
    }
  }
  if (sc.distant === "skyline") {
    // a pale city beyond the far edge: low blocks, a shade darker than the sky
    const scol = mix(pal.haze, pal.night ? [60, 54, 100] : pal.pencil, pal.night ? 0.5 : 0.36);
    let x = range(-20, 10);
    while (x < CW) { const wv = range(16, 46), h = range(10, 46) * (0.55 + 0.45 * Math.sin(x / 140) ** 2) + range(0, 12); f.fillStyle = rgb(scol, range(0.28, 0.45)); f.fillRect(x, yFar - h + 8, wv, h + 30); if (rnd01() < 0.06) f.fillRect(x + wv / 2 - 1, yFar - h - range(6, 16), 2, 16); x += wv + range(-4, 6); }
  } else if (!ridgeDrawn && sc.distant === "island") {
    for (const [amp, a, off] of [[sc.distant === "island" ? 34 : 50, 0.35, 0], [sc.distant === "island" ? 22 : 30, 0.55, 14]]) {
      f.fillStyle = pat(f, mix(col, pal.tree, 0.15)); jiggle(f.fillStyle as CanvasPattern); f.globalAlpha = a;
      f.beginPath(); f.moveTo(-10, yFar + 40); const ph = range(0, 10);
      for (let x = -10; x <= CW + 10; x += 10) f.lineTo(x, yFar + off - amp * (0.55 + 0.45 * Math.sin(x / 170 + ph) * Math.sin(x / 61 + ph * 2)) - range(0, 3));
      f.lineTo(CW + 10, yFar + 40); f.closePath(); f.fill(); f.globalAlpha = 1;
    }
  }
  g.drawImage(softBlur(far, 2 * SC), 0, 0, CW, CH);
  if (sc.moment.fog) { for (let i = 0; i < 5; i++) { g.fillStyle = rgb(pal.haze, 0.5); fillPoly(g, deform(blob(range(0, CW), yFar + range(-10, 20), range(120, 260), 0.2, 12).map(p => ({ ...p, y: yFar + (p.y - yFar) * 0.15 })), 2)); } }
}

export interface ViewOut {
  sky: Cnv; ground: Cnv | null; refl: Cnv; A: Cnv; B: Cnv; glows: Cnv; finish: Cnv;
  mask: Cnv; hits: { poly: P2[]; label: string; landmark: boolean }[]; windows: [number, number, number, number][]; zbuf: Float32Array; yFar: number;
}

export function farLine(sc: World, cam: Cam): number { let yFar = CH; for (let x = 0; x <= sc.W; x += sc.W / 24) yFar = Math.min(yFar, project(cam, x, sc.D, sc.H(x, sc.D))[1]); return yFar; }
export function skyLayer(sc: World, cam: Cam): Cnv {
  reseed(sc.seed + 41);
  const skyC = screen(); paintSky(sc, cam, cx(skyC), farLine(sc, cam)); return skyC;
}

export function paintView(sc: World, cam: Cam, gd: GroundOut, glr: GLR | null, skyC: Cnv): ViewOut {
  reseed(sc.seed + 23);
  const pal = sc.pal, H = sc.H;
  const yFar = farLine(sc, cam);
  // the ground, painted in 3D
  const rendered = glr ? glr.renderGround(sc, cam, gd) : null;
  const mask = canvas(CW >> 1, CH >> 1), mg = cx(mask);
  if (rendered) mg.drawImage(rendered.water, 0, 0, CW >> 1, CH >> 1);
  const hazeAt = (zc: number) => smoothstep(cam.near, cam.far * 1.05, zc) * pal.hazeAmt * 0.85;
  const fadeAt = (x: number, y: number) => smoothstep(sc.D, sc.D * 0.9, y) * smoothstep(0, sc.W * 0.035, x) * smoothstep(sc.W, sc.W * 0.965, x);
  const occluded = sc.relief > 8 ? (x: number, y: number, z: number) => {
    const dx = cam.x - x, dy = cam.y - y, dz = cam.z - z;
    for (let k = 1; k <= 14; k++) { const t = k / 14 * 0.7; const px = x + dx * t, py = y + dy * t; if (px < 0 || px > sc.W || py < 0 || py > sc.D) continue; if (H(px, py) > z + dz * t + 1.5) return true; }
    return false;
  } : () => false;

  type Obj = { b?: World["buildings"][number]; t?: World["trees"][number]; z?: number; d: number };
  const objs: Obj[] = [];
  for (const b of sc.buildings) { const p = project(cam, b.c[0], b.c[1], b.z0); if (p[0] < -200 || p[0] > CW + 200 || p[1] < -100 || p[1] > CH + 300 || p[3] <= 0) continue; objs.push({ b, d: p[3] }); }
  for (const t of sc.trees) { const z = H(t.x, t.y), p = project(cam, t.x, t.y, z); if (p[0] < -40 || p[0] > CW + 40 || p[1] < -40 || p[1] > CH + 80 || p[3] <= 0) continue; objs.push({ t, z, d: p[3] }); }
  objs.sort((a, b) => b.d - a.d);

  // reflections in the water
  const refl = screen(), rf = cx(refl);
  const nearWater = (x: number, y: number, r: number) => { for (const [ox, oy] of [[0, -r], [r, 0], [-r, 0], [0, r], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) if (sc.waterAt!(x + ox, y + oy)) return true; return false; };
  for (const o of objs) {
    if (o.b) {
      const b = o.b; if (!nearWater(b.c[0], b.c[1], 18) && !nearWater(b.c[0], b.c[1], 34)) continue;
      const zw = b.z0, hz = hazeAt(o.d), col = mix(mix(b.tone, pal.waterDeep, 0.35), pal.haze, hz);
      rf.fillStyle = rgb(col, 0.85);
      const top = b.p.map(([x, y]) => project(cam, x, y, zw - b.h)), bot = b.p.map(([x, y]) => project(cam, x, y, zw));
      for (let i = 0; i < b.p.length; i++) { const j = (i + 1) % b.p.length; rf.beginPath(); rf.moveTo(bot[i][0], bot[i][1]); rf.lineTo(bot[j][0], bot[j][1]); rf.lineTo(top[j][0], top[j][1]); rf.lineTo(top[i][0], top[i][1]); rf.closePath(); rf.fill(); }
    } else if (o.t) {
      const t = o.t; if (!nearWater(t.x, t.y, 14)) continue;
      const p = project(cam, t.x, t.y, -t.h * 0.62), r = t.r * p[2];
      rf.fillStyle = rgb(mix(t.tone, pal.waterDeep, 0.3), 0.8); rf.beginPath(); rf.ellipse(p[0], p[1], r, r * 1.05, 0, 0, PI * 2); rf.fill();
    }
  }
  const rs = softBlur(refl, 1.6 * SC), streak = screen(), st = cx(streak);
  st.globalAlpha = 0.5; st.drawImage(rs, 0, 0, CW, CH); st.globalAlpha = 0.25; st.drawImage(rs, -3, 1, CW, CH); st.drawImage(rs, 3, 2, CW, CH);
  const wm = screen(); cx(wm).drawImage(mask, 0, 0, CW, CH); clipTo(streak, wm);

  // objects into two layers, buildings (A) and trees (B); whichever is
  // nearer erases its silhouette from the other, so A then B composites to
  // the same picture as one far-to-near pass
  const A = screen(), LA = cx(A), Bc = screen(), LB = cx(Bc);
  const hits: ViewOut["hits"] = [], windows: ViewOut["windows"] = [], glows: [number, number, number, C3][] = [];
  const ZW = CW >> 2, ZH = CH >> 2, zbuf = new Float32Array(ZW * ZH).fill(1e9);
  const jit = (p: number[]): P2 => [p[0] + gauss() * 0.35, p[1] + gauss() * 0.35];
  mg.save(); mg.scale(0.5, 0.5); mg.globalCompositeOperation = "destination-out"; mg.fillStyle = "#000";
  let L = LA, O = LB;
  const erase = (draw: (g: G2) => void) => { O.save(); O.globalCompositeOperation = "destination-out"; O.globalAlpha = 1; O.fillStyle = "#000"; O.strokeStyle = "#000"; draw(O); O.restore(); };
  const face = (pts: number[][], col: number[], a = 1, washA = 0.28) => {
    const q = pts.map(jit);
    L.globalAlpha = a; L.fillStyle = rgb(mix(col, pal.paper, 0.12)); traceArr(L, q); L.fill();
    const p = pat(L, mul(col, 0.92)); jiggle(p); L.fillStyle = p; L.globalAlpha = a * washA; L.fill(); L.globalAlpha = 1;
    if (a > 0.5) erase(g => { traceArr(g, q); g.fill(); });
    traceArr(mg, pts); mg.fill();
  };
  const edge = (pts: number[][], col: number[], a: number) => { L.strokeStyle = rgb(col, a); L.lineWidth = 0.8; traceArr(L, pts); L.stroke(); };
  const sunScreen = (() => { const s = sc.sunV; const v = [s[0], -(s[1] * cam.sin + s[2] * cam.cos)]; const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; })();
  let nWin = 0;
  const night = pal.night;
  for (const o of objs) {
    const hz = hazeAt(o.d);
    if (o.t) {
      L = LB; O = LA;
      const t = o.t, fade = fadeAt(t.x, t.y); if (fade < 0.05) continue;
      if (occluded(t.x, t.y, o.z! + t.h)) continue;
      const bp = project(cam, t.x, t.y, o.z!), pxm = bp[2];
      const col = mix(t.tone, pal.haze, hz);
      const r = t.r * pxm * 1.08;
      if (r < 1.1) { L.globalAlpha = fade; L.fillStyle = rgb(col, 0.8); L.fillRect(bp[0] - 1, bp[1] - 2, 2, 2); L.globalAlpha = 1; continue; }
      L.globalAlpha = fade;
      if (t.kind === "conifer") {
        const tip = project(cam, t.x, t.y, o.z! + t.h), mid = project(cam, t.x, t.y, o.z! + t.h * 0.12);
        const tri = [[mid[0] - r * 1.05, mid[1]], [mid[0] + r * 1.05, mid[1]], [tip[0], tip[1]]];
        face(tri, col, fade, 0.35);
        if (pal.snow) { L.fillStyle = rgb(mix(col, [255, 255, 255], 0.75), 0.7); L.beginPath(); L.moveTo(tip[0], tip[1]); L.lineTo(lerp(tip[0], tri[0][0], 0.45), lerp(tip[1], tri[0][1], 0.45)); L.lineTo(lerp(tip[0], tri[1][0], 0.3), lerp(tip[1], tri[1][1], 0.3)); L.closePath(); L.fill(); }
        else { L.fillStyle = rgb(pal.sunlit, 0.18); L.beginPath(); L.moveTo(tip[0], tip[1]); L.lineTo(sunScreen[0] > 0 ? tri[1][0] : tri[0][0], tri[0][1]); L.lineTo(mid[0], mid[1]); L.closePath(); L.fill(); }
      } else {
        const cpt = project(cam, t.x, t.y, o.z! + t.h * 0.64);
        L.strokeStyle = rgb(mix([96, 80, 70], pal.haze, hz), 0.7 * fade); L.lineWidth = Math.max(0.8, 0.45 * pxm); L.beginPath(); L.moveTo(bp[0], bp[1]); L.lineTo(cpt[0], cpt[1] + r * 0.5); L.stroke();
        erase(g => { g.lineWidth = Math.max(0.8, 0.45 * pxm); g.beginPath(); g.moveTo(bp[0], bp[1]); g.lineTo(cpt[0], cpt[1] + r * 0.5); g.stroke(); });
        const crown = deform(blob(cpt[0], cpt[1], r, 0.25, 8), 1).map(p => [p.x, p.y]);
        face(crown, col, fade, 0.4);
        L.fillStyle = rgb(pal.snow ? [255, 255, 255] : pal.sunlit, (pal.snow ? 0.4 : night ? 0.06 : 0.22) * fade);
        fillPoly(L, deform(blob(cpt[0] + sunScreen[0] * r * 0.35, cpt[1] + sunScreen[1] * r * 0.35, r * 0.5, 0.3, 6), 1));
        L.fillStyle = rgb(pal.shadow, 0.16 * fade); fillPoly(L, deform(blob(cpt[0] - sunScreen[0] * r * 0.35, cpt[1] - sunScreen[1] * r * 0.35, r * 0.55, 0.3, 6), 1));
      }
      L.globalAlpha = 1;
      continue;
    }
    L = LA; O = LB;
    const b = o.b!, fade = fadeAt(b.c[0], b.c[1]); if (fade < 0.05) continue;
    const z0 = b.z0, z1 = z0 + b.h, n = b.p.length;
    if (occluded(b.c[0], b.c[1], z1 + b.roofH)) continue;
    const bse = b.p.map(([x, y]) => project(cam, x, y, z0)), top = b.p.map(([x, y]) => project(cam, x, y, z1));
    const tone = mix(b.tone, pal.haze, hz), roofC = mix(b.roofTone, pal.haze, hz);
    const rk = b.roof, isG = rk === "gable" && n === 4;
    const ridge = isG ? [[(b.p[3][0] + b.p[0][0]) / 2, (b.p[3][1] + b.p[0][1]) / 2], [(b.p[1][0] + b.p[2][0]) / 2, (b.p[1][1] + b.p[2][1]) / 2]].map(([x, y]) => project(cam, x, y, z1 + b.roofH)) : null;
    const walls: { poly: number[][]; col: C3; i: number; j: number; len: number; nx: number; ny: number; d: number }[] = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a = b.p[i], c = b.p[j], ex = c[0] - a[0], ey = c[1] - a[1], len = Math.hypot(ex, ey) || 1;
      const nx = ey / len, ny = -ex / len, mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
      if (nx * (cam.x - mx) + ny * (cam.y - my) <= 0) continue;
      let poly: number[][] = [bse[i], bse[j], top[j], top[i]];
      if (isG && i === 1) poly = [bse[1], bse[2], top[2], ridge![1], top[1]];
      if (isG && i === 3) poly = [bse[3], bse[0], top[0], ridge![0], top[3]];
      walls.push({ poly, col: shadeTone(sc, tone, [nx, ny, 0]), i, j, len, nx, ny, d: project(cam, mx, my, z0)[3] });
    }
    walls.sort((a, c) => c.d - a.d);
    for (const w of walls) {
      face(w.poly, w.col, fade);
      const hpx = Math.abs(bse[w.i][1] - top[w.i][1]);
      if (b.h > 8 && hpx > 9 && nWin < 90000 && w.len > 5 && top[w.i][2] > 1.0) {
        const floors = Math.floor((b.h - 2) / 3.4), per = Math.max(1, Math.floor(w.len / 3.8));
        const a = b.p[w.i], c = b.p[w.j];
        for (let f = 0; f < floors; f++) for (let k = 0; k < per; k++) {
          const u = (k + 0.5) / per, zz = z0 + 2.2 + f * 3.4;
          const p = project(cam, lerp(a[0], c[0], u) + w.nx * 0.2, lerp(a[1], c[1], u) + w.ny * 0.2, zz);
          const ww = Math.max(0.8, 1.1 * p[2] * Math.abs(w.nx * cam.sin + 0.5)), wh = Math.max(0.8, 1.4 * p[2]);
          const lit = night && ((b.i * 31 + f * 7 + k * 13) % 10) < 4;
          L.fillStyle = lit ? rgb(pal.lights, 0.9 * fade) : rgb(mul(w.col, 0.62), 0.42 * fade);
          L.fillRect(p[0] - ww / 2, p[1] - wh / 2, ww, wh);
          if (lit) windows.push([p[0], p[1], ww, wh]);
          nWin++;
        }
      }
      const gb = (bse[w.i][1] + bse[w.j][1]) / 2, gt = (top[w.i][1] + top[w.j][1]) / 2;
      if (gb - gt > 5) { const lgr = L.createLinearGradient(0, gb, 0, gt); lgr.addColorStop(0, rgb(pal.shadow, 0.24 * fade)); lgr.addColorStop(0.4, rgb(pal.shadow, 0)); lgr.addColorStop(1, rgb(pal.paper, 0.1 * fade)); L.fillStyle = lgr; traceArr(L, w.poly); L.fill(); }
      if (sc.signs && b.h > 10 && b.h < 60 && b.i % 4 === 0 && gb - gt > 14) {
        const a = b.p[w.i], c = b.p[w.j], u = 1.6 / w.len, ox = w.nx * 0.6, oy = w.ny * 0.6, sz0 = z0 + 4, sz1 = z0 + Math.min(b.h * 0.75, 22);
        const q = [[u, sz0], [u * 2, sz0], [u * 2, sz1], [u, sz1]].map(([uu, zz]) => project(cam, lerp(a[0], c[0], uu) + ox, lerp(a[1], c[1], uu) + oy, zz));
        const sgc: C3 = ([[236, 84, 84], [250, 206, 90], [96, 210, 220], [244, 128, 178]] as C3[])[b.i % 4];
        L.fillStyle = rgb(sgc, 0.95 * fade); traceArr(L, q); L.fill();
        if (night) glows.push([(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2, Math.min(9, Math.abs(q[2][1] - q[0][1]) * 0.35), sgc]);
      }
      edge(w.poly, mul(w.col, 0.7), 0.22 * fade);
      if (rnd01() < 0.35) edge(w.poly, pal.pencil, 0.14 * fade);
    }
    if (rk === "flat" || (rk === "gable" && !isG)) {
      face(top, shadeTone(sc, roofC, [0, 0, 1]), fade);
      if (rnd01() < 0.5) edge(top, pal.pencil, 0.14 * fade);
    } else if (isG) {
      const t0 = [top[0], top[1], ridge![1], ridge![0]], t1 = [top[2], top[3], ridge![0], ridge![1]];
      const nAx = (b.p[0][0] + b.p[1][0] - b.p[2][0] - b.p[3][0]) / 2, nAy = (b.p[0][1] + b.p[1][1] - b.p[2][1] - b.p[3][1]) / 2, nl = Math.hypot(nAx, nAy) || 1;
      const nA = [nAx / nl, nAy / nl];
      const dpt = Math.hypot(b.p[1][0] - b.p[2][0], b.p[1][1] - b.p[2][1]) / 2;
      const nrm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
      const planes = [{ poly: t0, n: nrm([nA[0] * b.roofH, nA[1] * b.roofH, dpt]), d: 0 }, { poly: t1, n: nrm([-nA[0] * b.roofH, -nA[1] * b.roofH, dpt]), d: 0 }];
      planes.forEach(pl => { pl.d = -(pl.n[0] * (cam.x - b.c[0]) + pl.n[1] * (cam.y - b.c[1]) + pl.n[2] * (cam.z - z1)); });
      planes.sort((a, c) => c.d - a.d);
      for (const pl of planes) { face(pl.poly, shadeTone(sc, roofC, pl.n), fade); if (rnd01() < 0.5) edge(pl.poly, pal.pencil, 0.15 * fade); }
    } else if (rk === "pyramid") {
      const apex = project(cam, b.c[0], b.c[1], z1 + b.roofH), tris: { poly: number[][]; n: number[]; d: number }[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, a = b.p[i], c = b.p[j], ex = c[0] - a[0], ey = c[1] - a[1], len = Math.hypot(ex, ey) || 1;
        const nx = ey / len, ny = -ex / len, inr = Math.abs((b.c[0] - a[0]) * nx + (b.c[1] - a[1]) * ny);
        const l3 = Math.hypot(nx * b.roofH, ny * b.roofH, inr) || 1, nn = [nx * b.roofH / l3, ny * b.roofH / l3, inr / l3];
        if (dot3(nn, [cam.x - (a[0] + c[0]) / 2, cam.y - (a[1] + c[1]) / 2, cam.z - z1 - b.roofH / 2]) <= 0) continue;
        tris.push({ poly: [top[i], top[j], apex], n: nn, d: project(cam, (a[0] + c[0]) / 2, (a[1] + c[1]) / 2, z1)[3] });
      }
      tris.sort((a, c) => c.d - a.d);
      for (const t of tris) face(t.poly, shadeTone(sc, roofC, t.n), fade);
    } else if (rk === "dome") {
      face(top, shadeTone(sc, mix(roofC, tone, 0.5), [0, 0, 1]), fade);
      const rad = Math.min(Math.sqrt(Math.abs(polyArea(b.p)) / PI), b.roofH * 1.3), c = project(cam, b.c[0], b.c[1], z1 + b.roofH * 0.35), r = rad * c[2];
      const gg = L.createRadialGradient(c[0] + sunScreen[0] * r * 0.4, c[1] + sunScreen[1] * r * 0.4 - r * 0.2, r * 0.1, c[0], c[1], r * 1.05);
      gg.addColorStop(0, rgb(mix(roofC, pal.paper, 0.4))); gg.addColorStop(1, rgb(mul(roofC, 0.78)));
      L.fillStyle = gg; L.globalAlpha = fade; L.beginPath(); L.ellipse(c[0], c[1], r, r * 0.95, 0, PI, 0); L.ellipse(c[0], c[1], r, r * cam.sin * 0.6, 0, 0, PI); L.fill(); L.globalAlpha = 1;
      erase(g => { g.beginPath(); g.arc(c[0], c[1], r, 0, PI * 2); g.fill(); });
      mg.beginPath(); mg.arc(c[0], c[1], r, 0, PI * 2); mg.fill();
    }
    // a screen hull for taps, and the coarse depth buffer
    const pts = bse.concat(top).concat(ridge || []).map(p => [p[0], p[1]]);
    if (rk === "pyramid" || rk === "dome") { const ap = project(cam, b.c[0], b.c[1], z1 + b.roofH); pts.push([ap[0], ap[1]]); }
    const hp = hull(pts); hits.push({ poly: hp, label: b.label, landmark: b.landmark });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const q of hp) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
    const dz = o.d - Math.sqrt(Math.abs(polyArea(b.p))) * 0.4;
    for (let zy = Math.max(0, Math.floor(y0 / 4)); zy <= Math.min(ZH - 1, Math.floor(y1 / 4)); zy++) for (let zx = Math.max(0, Math.floor(x0 / 4)); zx <= Math.min(ZW - 1, Math.floor(x1 / 4)); zx++) if (inPoly(zx * 4 + 2, zy * 4 + 2, hp)) { const k = zy * ZW + zx; if (dz < zbuf[k]) zbuf[k] = dz; }
  }
  mg.restore();
  granulate(A, 0.1); granulate(Bc, 0.1);
  const glowC = screen(), gl2 = cx(glowC);
  for (const [x, y, r, c] of glows) { const gg = gl2.createRadialGradient(x, y, 0, x, y, r * 1.6); gg.addColorStop(0, rgb(c, 0.28)); gg.addColorStop(1, rgb(c, 0)); gl2.fillStyle = gg; gl2.fillRect(x - r * 2, y - r * 2, r * 4, r * 4); }
  // haze veil near the far edge, soft paper at the near corners, a splatter
  const finish = screen(), fg = cx(finish);
  const veil = fg.createLinearGradient(0, yFar - 10, 0, yFar + 90);
  veil.addColorStop(0, rgb(pal.haze, pal.hazeAmt * 0.3)); veil.addColorStop(1, rgb(pal.haze, 0));
  fg.fillStyle = veil; fg.fillRect(0, 0, CW, CH);
  vignette(fg, pal, CW / 2, CH * 0.35, 0.45, 0.35);
  splatter(fg, pal, [[CW - 150, CH - 100]]);
  return { sky: skyC, ground: rendered ? rendered.color : null, refl: streak, A, B: Bc, glows: glowC, finish, mask, hits, windows, zbuf, yFar };
}

// Composes the final painting (also used for postcards and share images).
export function compose(v: ViewOut, pal: World["pal"], stage = 99, out?: Cnv): Cnv {
  const c = out ?? screen(), g = cx(c);
  ident(g); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.drawImage(v.sky, 0, 0);
  if (v.ground && stage >= 2) g.drawImage(v.ground, 0, 0, c.width, c.height);
  if (stage >= 2) { g.globalCompositeOperation = "multiply"; g.globalAlpha = pal.night ? 0.5 : 0.55; g.drawImage(v.refl, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; }
  if (stage >= 3) g.drawImage(v.A, 0, 0);
  if (stage >= 4) { g.drawImage(v.B, 0, 0); g.globalCompositeOperation = "lighter"; g.drawImage(v.glows, 0, 0); g.globalCompositeOperation = "source-over"; g.drawImage(v.finish, 0, 0); }
  finishPaper(g, pal.paper);
  ident(g);
  return c;
}
export { ccw, polyLen };

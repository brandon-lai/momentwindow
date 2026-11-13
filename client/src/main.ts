// The page: one window. It finds the scene for this cell, shows the pencil
// drawing, blooms the washes in (sky, water, ground, buildings, trees),
// brings the place to life, and keeps it in real time.
import type { SceneBundle } from "../../shared/bundle.ts";
import { makeMoment, clockLine, type Moment, type Weather } from "./moment.ts";
import { buildWorld, type World } from "./paint/scene.ts";
import { makeCam, paintPencil, unproject, project, type Cam } from "./paint/paint.ts";
import { CW, CH, M, PI, canvas, clamp, cx, finishPaper, inPoly, setScale, fbmTile, rgb, deform, blob, fillPoly, softBlur, type Cnv } from "./paint/util.ts";
import type { Layer, PaintMeta } from "./paint/pipeline.ts";
import { createGLR, type GLR } from "./paint/gl.ts";
import { createLife, stepLife, drawLife, lr, type Life, type LiveView } from "./live/life.ts";
import { makeSim, type Sim } from "./live/water.ts";
import { horn } from "./live/sound.ts";
import { openSend, openSearch, openCredits, setupDialogs } from "./ui.ts";

interface Boot { cell?: string; how?: string; country?: string; postcard?: Postcard | null; error?: string }
export interface Postcard { id: string; cell: string; month: string; utc: number; weather: Weather | null; lifeSeed: number; steps: number; note: string; label: string }

const qs = new URLSearchParams(location.search);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const S = Math.min(2, Math.max(1, Math.round((devicePixelRatio || 1) * 4) / 4));
setScale(S);
const DT = 1 / 30;

const el = {
  card: document.getElementById("card") as HTMLDivElement,
  stage: document.getElementById("stage") as HTMLCanvasElement,
  gl: document.getElementById("gl") as HTMLCanvasElement,
  life: document.getElementById("life") as HTMLCanvasElement,
  fade: document.getElementById("fade") as HTMLCanvasElement,
  status: document.getElementById("status") as HTMLSpanElement,
  line: document.getElementById("line") as HTMLParagraphElement,
  note: document.getElementById("note") as HTMLParagraphElement,
};
for (const c of [el.stage, el.gl, el.life, el.fade]) { c.width = Math.round(CW * S); c.height = Math.round(CH * S); }

const state: {
  bundle: SceneBundle | null; weather: Weather | null; moment: Moment | null; world: World | null; cam: Cam | null; meta: PaintMeta | null;
  painting: Cnv | null; mask: CanvasImageSource | null; life: Life | null; sim: Sim | null; view: LiveView | null; glr: GLR | null;
  live: boolean; simT: number; steps: number; acc: number; lifeSeed: number; seed: number; postcard: Postcard | null; job: number; loadT0: number;
  marks: Record<string, number>; lastPaintKey: string; cell: string; lifeStart: number;
} = { bundle: null, weather: null, moment: null, world: null, cam: null, meta: null, painting: null, mask: null, life: null, sim: null, view: null, glr: null,
  live: false, simT: 0, steps: 0, acc: 0, lifeSeed: 1, seed: 1, postcard: null, job: 0, loadT0: performance.now(), marks: {}, lastPaintKey: "", cell: "", lifeStart: 0 };
(window as any).__moment = state;
const mark = (k: string) => { if (!(k in state.marks)) state.marks[k] = Math.round(performance.now() - state.loadT0); };

function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const now = () => (qs.get("at") ? new Date(qs.get("at")!).getTime() + (performance.now() - state.loadT0) : Date.now());

// ---------- loading ----------
async function getBoot(): Promise<Boot> {
  const inline = document.getElementById("boot");
  if (inline?.textContent?.trim()) return JSON.parse(inline.textContent);
  const r = await fetch("/boot" + location.search); return r.json();
}

async function fetchScene(cell: string, month: string | null, onFirst: (b: SceneBundle) => void): Promise<SceneBundle> {
  const q = new URLSearchParams(); if (month) q.set("month", month); const d = qs.get("date"); if (d && !month) q.set("date", d);
  const r = await fetch(`/scene/${cell}${q.toString() ? "?" + q : ""}`);
  if (!r.ok) { const j = await r.json().catch(() => ({ error: "Could not reach the map." })); throw new Error(j.error || `scene ${r.status}`); }
  // newline-delimited: a quick streets-and-footprints bundle may come first
  const reader = r.body!.getReader(), dec = new TextDecoder(); let buf = "", last: SceneBundle | null = null, n = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (value) buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      const obj = JSON.parse(line); if (obj.error) throw new Error(obj.error);
      last = obj; if (n++ === 0) onFirst(obj);
    }
    if (done) break;
  }
  if (buf.trim()) { const obj = JSON.parse(buf); if (obj.error) throw new Error(obj.error); last = obj; if (n++ === 0) onFirst(obj); }
  if (!last) throw new Error("The map came back empty.");
  return last;
}

async function fetchWeather(cell: string): Promise<Weather | null> {
  try { const r = await fetch(`/weather/${cell}`); if (!r.ok) return null; const w = await r.json(); w.fetchedAt = Date.now(); return w; } catch { return null; }
}

export async function load(cell: string, opts: { postcard?: Postcard | null } = {}) {
  const job = ++state.job;
  state.cell = cell; state.postcard = opts.postcard ?? null; state.live = false; state.life = null; state.view = null; state.marks = {}; state.loadT0 = performance.now();
  el.gl.style.opacity = "0"; el.life.style.opacity = "1";
  const sg = el.stage.getContext("2d")!; sg.setTransform(1, 0, 0, 1, 0, 0); sg.fillStyle = "#f9f7f2"; sg.fillRect(0, 0, el.stage.width, el.stage.height);
  status("Finding the light…");
  const pc = state.postcard;
  const wP = pc ? Promise.resolve(pc.weather) : fetchWeather(cell);
  let pencilDone = false;
  try {
    const bundle = await fetchScene(cell, pc?.month ?? null, async b => {
      // the first bundle: show the pencil drawing at once, from geometry alone
      const w0 = await Promise.race([wP, new Promise<null>(r => setTimeout(() => r(null), 300))]);
      if (job !== state.job || pencilDone) return;
      const m0 = momentFor(b, w0);
      const world = buildWorld(b, m0, 1); const cam = makeCam(world);
      showPencil(paintPencil(world, cam)); pencilDone = true;
      setLine(b, m0);
    });
    if (job !== state.job) return;
    state.bundle = bundle;
    const weather = await Promise.race([wP, new Promise<null>(r => setTimeout(() => r(null), 2500))]);
    state.weather = weather;
    const m = momentFor(bundle, weather);
    state.moment = m;
    setLine(bundle, m);
    state.seed = hash(cell + new Date(m.utc).toISOString().slice(0, 10)) % 2147483647;
    state.lifeSeed = pc ? pc.lifeSeed : (state.seed ^ (Math.random() * 1e9)) >>> 0;
    await paint(bundle, m, job, true);
    if (!pc) schedule();
  } catch (err) {
    if (job !== state.job) return;
    status(String((err as Error).message || err), true);
  }
}

function momentFor(b: SceneBundle, w: Weather | null): Moment {
  const pc = state.postcard;
  const utc = pc ? pc.utc : now();
  return makeMoment(utc, b.centre[0], b.centre[1], w, { snowCover: b.sample?.snowCover, weatherOverride: qs.get("weather") });
}

function setLine(b: SceneBundle, m: Moment) {
  const text = `${b.label} · ${clockLine(m.utc, m.tz)} · ${m.phrase}`;
  el.line.textContent = text;
  el.stage.setAttribute("aria-label", `${text}, painted in watercolour`);
  el.note.textContent = state.postcard?.note ? `“${state.postcard.note}”` : "";
  el.note.hidden = !state.postcard?.note;
  document.title = `Moment · ${b.label.replace(/^Around /, "")}`;
}

function status(text: string, stay = false) { el.status.textContent = text; el.status.style.opacity = text ? "1" : "0"; el.status.dataset.stay = stay ? "1" : ""; }

// ---------- painting (in a worker when possible) ----------
let worker: Worker | null = null;
function getWorker(): Worker | null {
  if (worker !== null) return worker;
  try { worker = new Worker(new URL("./paint/worker.ts", import.meta.url), { type: "module" }); } catch { worker = null; }
  return worker;
}

function paint(bundle: SceneBundle, m: Moment, job: number, reveal: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const layers: Partial<Record<Layer, CanvasImageSource>> = {};
    let revealChain = Promise.resolve();
    const onLayer = (name: Layer, img: CanvasImageSource) => {
      if (job !== state.job) return;
      layers[name] = img;
      if (!reveal) return;
      if (name === "pencil") { mark("pencil"); revealChain = revealChain.then(() => showPencil(img)); }
      if (name === "sky") revealChain = revealChain.then(() => bloom(img, null, 0.42)).then(() => mark("sky"));
      if (name === "top") {
        // everything is here: water, ground, buildings, trees, then the finish
        const ground = layers.ground, mask = layers.mask;
        revealChain = revealChain
          .then(() => ground && mask ? bloom(ground, mask, 0.4) : undefined).then(() => mark("water"))
          .then(() => ground ? bloom(ground, null, 0.4) : undefined)
          .then(() => bloom(layers.A!, null, 0.4)).then(() => mark("buildings"))
          .then(() => bloom(layers.B!, null, 0.35)).then(() => mark("trees"));
      }
    };
    const onMeta = async (meta: PaintMeta) => {
      if (job !== state.job) return;
      await revealChain;
      if (job !== state.job) return;
      const world = buildWorld(bundle, m, state.seed);
      // the page needs to know where the water is, for life and ripples
      world.waterAt = waterRaster(world);
      const painting = composeFinal(layers, meta);
      (window as any).__layers = layers; // for the regression probe: each layer on its own
      state.world = world; state.cam = meta.cam; state.meta = meta; state.painting = painting; state.mask = layers.mask!;
      state.lastPaintKey = paintKey(m);
      if (reveal) { await crossfadeTo(painting, 0.3); mark("painted"); }
      else await crossfadeTo(painting, 2.5);
      startLive(world, meta, painting, layers.mask!, !reveal);
      resolve();
    };
    const w = reveal || !worker ? getWorker() : worker;
    const runHere = async () => {
      const { paintAll } = await import("./paint/pipeline.ts");
      await paintAll(bundle, m, state.seed, S, { layer: (n, c) => onLayer(n, c as CanvasImageSource), meta: mt => { onMeta(mt); } });
    };
    if (!w) { runHere().catch(reject); return; }
    w.onmessage = (ev: MessageEvent) => {
      const d = ev.data; if (d.id !== job) return;
      if (d.kind === "layer") onLayer(d.name, d.bm);
      else if (d.kind === "meta") onMeta(d.meta);
      else if (d.kind === "unsupported") { worker = null; runHere().catch(reject); }
      else if (d.kind === "error") { console.error(d.message); runHere().catch(reject); }
    };
    w.postMessage({ id: job, bundle, moment: m, seed: state.seed, scale: S });
  });
}
const paintKey = (m: Moment) => `${m.key}|${Math.round(m.sun.alt / 3)}|${Math.round(m.sun.az / 6)}|${m.rain}${m.drizzle}${m.snowing}${m.fog}`;

function composeFinal(L: Partial<Record<Layer, CanvasImageSource>>, meta: PaintMeta): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = Math.round(CW * S); c.height = Math.round(CH * S);
  const g = c.getContext("2d")!;
  for (const k of ["sky", "ground", "A", "B", "top"] as Layer[]) if (L[k]) g.drawImage(L[k]!, 0, 0, c.width, c.height);
  // the pencil shows faintly through the washes, as it does on paper
  if (L.pencil) { g.globalCompositeOperation = "multiply"; g.globalAlpha = 0.18; g.drawImage(L.pencil, 0, 0, c.width, c.height); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; }
  finishPaper(g, meta.paper);
  return c;
}

// ---------- reveal ----------
const frame = () => new Promise<number>(r => requestAnimationFrame(t => r(t)));
let baseCanvas: HTMLCanvasElement | null = null;
function base() { if (!baseCanvas) { baseCanvas = document.createElement("canvas"); baseCanvas.width = el.stage.width; baseCanvas.height = el.stage.height; } return baseCanvas; }
async function showPencil(img: CanvasImageSource) {
  const b = base(), bg = b.getContext("2d")!; bg.setTransform(1, 0, 0, 1, 0, 0); bg.drawImage(img, 0, 0, b.width, b.height);
  const sg = el.stage.getContext("2d")!; sg.setTransform(1, 0, 0, 1, 0, 0);
  const t0 = performance.now();
  for (;;) { const t = await frame(); const p = reduceMotion ? 1 : clamp((t - t0) / 300, 0, 1); sg.globalAlpha = p; sg.drawImage(b, 0, 0); sg.globalAlpha = 1; if (p >= 1) break; }
  mark("pencilShown");
  if (!el.status.dataset.stay) status("");
}
// washes bloom out from a few wet spots, the prototype's reveal
async function bloom(img: CanvasImageSource, clip: CanvasImageSource | null, dur: number) {
  const b = base(), bg = b.getContext("2d")!, sg = el.stage.getContext("2d")!;
  const W = b.width, H = b.height;
  const m = document.createElement("canvas"); m.width = W; m.height = H; const mg = m.getContext("2d")!;
  const tmp = document.createElement("canvas"); tmp.width = W; tmp.height = H; const tg = tmp.getContext("2d")!;
  const seeds = Array.from({ length: 9 }, () => ({ x: Math.random() * W, y: Math.random() * H, k: 0.6 + Math.random() * 0.65, d: Math.random() * 0.35 }));
  const t0 = performance.now(); let frames = 0;
  for (;;) {
    const t = await frame(); frames++; const p = reduceMotion ? 1 : clamp((t - t0) / (dur * 1000), 0, 1);
    mg.clearRect(0, 0, W, H);
    if (p >= 1) { mg.fillStyle = "#000"; mg.fillRect(0, 0, W, H); }
    else for (const s of seeds) {
      const q = clamp((p - s.d) / (1 - s.d), 0, 1); if (q <= 0) continue;
      const r = (40 + q * q * 1100 * s.k) * S, gr = mg.createRadialGradient(s.x, s.y, r * 0.55, s.x, s.y, r);
      gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(1, "rgba(0,0,0,0)"); mg.fillStyle = gr; mg.beginPath(); mg.arc(s.x, s.y, r, 0, PI * 2); mg.fill();
    }
    if (clip) { mg.globalCompositeOperation = "destination-in"; mg.drawImage(clip, 0, 0, W, H); mg.globalCompositeOperation = "source-over"; }
    tg.globalCompositeOperation = "source-over"; tg.clearRect(0, 0, W, H); tg.drawImage(m, 0, 0);
    tg.globalCompositeOperation = "source-in"; tg.drawImage(img, 0, 0, W, H);
    sg.drawImage(b, 0, 0); sg.drawImage(tmp, 0, 0);
    if (p >= 1) { bg.drawImage(tmp, 0, 0); break; }
  }
  (state as any).blooms = ((state as any).blooms ?? []).concat([[Math.round(t0 - state.loadT0), Math.round(performance.now() - t0), frames]]);
}
async function crossfadeTo(painting: CanvasImageSource, dur: number) {
  const sg = el.stage.getContext("2d")!; const b = base();
  const from = document.createElement("canvas"); from.width = b.width; from.height = b.height; from.getContext("2d")!.drawImage(el.stage, 0, 0);
  const t0 = performance.now();
  for (;;) { const t = await frame(); const p = reduceMotion ? 1 : clamp((t - t0) / (dur * 1000), 0, 1); sg.globalAlpha = 1; sg.drawImage(from, 0, 0); sg.globalAlpha = p; sg.drawImage(painting, 0, 0, b.width, b.height); sg.globalAlpha = 1; if (p >= 1) break; }
  b.getContext("2d")!.drawImage(painting, 0, 0, b.width, b.height);
}

// ---------- water raster for life (the worker keeps its own) ----------
function waterRaster(sc: World) {
  const res = 4, w = Math.ceil(sc.W / res), h = Math.ceil(sc.D / res);
  const c = canvas(w, h), g = cx(c);
  g.fillStyle = "#000";
  for (const poly of sc.water) { g.beginPath(); for (const r of poly) { r.forEach((p, i) => i ? g.lineTo(p[0] / res, h - p[1] / res) : g.moveTo(p[0] / res, h - p[1] / res)); g.closePath(); } g.fill("evenodd"); }
  g.globalCompositeOperation = "destination-out"; for (const r of sc.land) { g.beginPath(); r.forEach((p, i) => i ? g.lineTo(p[0] / res, h - p[1] / res) : g.moveTo(p[0] / res, h - p[1] / res)); g.closePath(); g.fill(); }
  const d = g.getImageData(0, 0, w, h).data;
  return (x: number, y: number) => { const i = Math.floor(x / res), j = Math.floor(h - y / res); return i >= 0 && j >= 0 && i < w && j < h && d[(j * w + i) * 4 + 3] > 128; };
}

// ---------- the live window ----------
let sprites: { cloud: CanvasImageSource; fog: CanvasImageSource } | null = null;
function makeSprites(pal: World["pal"]) {
  const c = canvas(300, 200), g = cx(c); g.fillStyle = "rgba(68,78,108,1)";
  for (let i = 0; i < 6; i++) fillPoly(g, deform(blob(150 + (Math.random() - 0.5) * 80, 100 + (Math.random() - 0.5) * 40, 40 + Math.random() * 35, 0.35), 3));
  const f = canvas(500, 180), fg = cx(f); fg.fillStyle = rgb(pal.haze);
  for (let i = 0; i < 6; i++) fillPoly(fg, deform(blob(250 + (Math.random() - 0.5) * 180, 90 + (Math.random() - 0.5) * 28, 50 + Math.random() * 40, 0.3), 3).map(p => ({ ...p, y: 90 + (p.y - 90) * 0.5 })));
  return { cloud: softBlur(c, 10) as CanvasImageSource, fog: softBlur(f, 12) as CanvasImageSource };
}

function startLive(world: World, meta: PaintMeta, painting: HTMLCanvasElement, mask: CanvasImageSource, keepLife: boolean) {
  if (!state.glr) { state.glr = createGLR(el.gl); }
  state.sim = makeSim(210, 280, mask);
  const light = (() => { const sv = world.sunV, l = Math.hypot(sv[0], sv[1]) || 1; return [sv[0] / l, -sv[1] / l] as [number, number]; })();
  (state as any).light = light;
  if (state.glr) { state.glr.attach(painting, mask as TexImageSource, 210, 280, state.sim.bytes); el.gl.style.opacity = "1"; }
  sprites = makeSprites(world.pal);
  const prevView = state.view;
  state.view = { cam: meta.cam, zbuf: meta.zbuf, windows: meta.windows, lifeAlpha: keepLife ? 1 : 0, liveT0: prevView && keepLife ? prevView.liveT0 : state.simT, label: null, live: { boats: [], birds: [] }, S };
  if (!keepLife || !state.life) {
    state.life = createLife(world, state.lifeSeed);
    state.simT = 0; state.steps = 0; state.acc = 0; state.view.liveT0 = 0;
    // a postcard replays the frozen moment: the same seed, stepped to the same instant
    const target = state.postcard ? Math.min(state.postcard.steps, 30 * 60 * 20) : 0;
    for (let i = 0; i < target; i++) { stepLife(world, state.life, state.simT, DT, () => {}); state.simT += DT; state.steps++; }
    state.view.liveT0 = state.postcard ? -12 : state.simT;
    // something moves within two seconds: the first ripple, right away
    for (let k = 0; k < 400; k++) { const x = lr(M + 60, CW - M - 60), y = lr(M + 60, CH - M - 60); if (state.sim.isWet(x, y)) { state.sim.drop(x, y, 150, 2.6); break; } }
  } else {
    state.life.weather = { rain: world.moment.rain, drizzle: world.moment.drizzle, snow: world.moment.snowing, fog: world.moment.fog };
  }
  state.live = true; state.lifeStart = performance.now(); mark("live");
  if (!loopRunning) { loopRunning = true; requestAnimationFrame(loop); }
}

let loopRunning = false, last = performance.now(), slow = 0, fpsN = 0, fpsT = performance.now();
function loop(t: number) {
  const dt = Math.min(0.1, (t - last) / 1000 || 0.016); last = t;
  fpsN++; if (t - fpsT > 2000) { (state as any).fps = Math.round(fpsN * 1000 / (t - fpsT)); fpsN = 0; fpsT = t; }
  if (state.live && state.world && state.life && state.view && !document.hidden) {
    const world = state.world, life = state.life, v = state.view, sim = state.sim!;
    if (!reduceMotion) {
      state.acc += dt;
      let n = 0;
      while (state.acc >= DT && n < 6) { stepLife(world, life, state.simT, DT, (x, y, a, r) => worldDrop(x, y, a, r)); state.simT += DT; state.steps++; state.acc -= DT; n++; }
      if (n === 6) state.acc = 0;
    }
    let dirty = false;
    if (!reduceMotion && sim.energy > 0) { sim.step(); sim.energy--; dirty = true; }
    if (state.glr) state.glr.present(state.simT, reduceMotion ? 0 : 1, (state as any).light, (state.seed % 97) / 13, dirty ? sim.bytes : null, sim.gw, sim.gh);
    v.lifeAlpha = clamp((performance.now() - state.lifeStart) / 1200, 0, 1);
    if (v.lifeAlpha > 0.05) mark("lifeVisible");
    drawLife(world, life, v, el.life.getContext("2d")!, state.simT, sprites!);
    // frame budget: drop life detail before dropping frames
    slow = dt > 0.04 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 90 && v.windows.length > 400) { v.windows = v.windows.filter((_, i) => i % 2 === 0); slow = 0; }
  }
  requestAnimationFrame(loop);
}

function worldDrop(x: number, y: number, amp: number, rad: number) {
  const cam = state.cam, sim = state.sim; if (!cam || !sim) return;
  const p = project(cam, x, y, 0); if (p[3] <= 0) return;
  if (sim.isWet(p[0], p[1])) sim.drop(p[0], p[1], amp, rad);
}

// ---------- taps: boat, bird, flock, water, building ----------
function toCanvas(ev: PointerEvent): [number, number] { const r = el.card.getBoundingClientRect(); return [(ev.clientX - r.left) / r.width * CW, (ev.clientY - r.top) / r.height * CH]; }
function hitBuilding(x: number, y: number) { const hits = state.meta?.hits ?? []; for (let i = hits.length - 1; i >= 0; i--) if (inPoly(x, y, hits[i].poly)) return hits[i]; return null; }
export function tap(x: number, y: number): string {
  const v = state.view, sim = state.sim; if (!v || !sim || !state.live) return "none";
  for (const b of v.live.boats) if (Math.hypot(b.x - x, b.y - y) < b.r + 8) { horn(b.b.L > 30); b.b.honk = 1; if (sim.isWet(b.x, b.y)) sim.drop(b.x, b.y, 120, 2.2); return "boat"; }
  const near = v.live.birds.filter(b => Math.hypot(b.x - x, b.y - y) < 22);
  if (near.length) { for (const n of near) { const a = Math.random() * PI * 2; n.b.scat = 2.4; n.b.sx = Math.cos(a) * 26; n.b.sy = Math.sin(a) * 26; } return "bird"; }
  if (v.live.flock && Math.hypot(v.live.flock[0] - x, v.live.flock[1] - y) < 120 && state.life?.flock) { state.life.flock.scat = 2.5; return "flock"; }
  if (sim.isWet(x, y) && !reduceMotion) { sim.drop(x, y, 170, 2.6); return "water"; }
  const h = hitBuilding(x, y);
  if (h) { let top = h.poly[0]; for (const p of h.poly) if (p[1] < top[1]) top = p; v.label = { text: h.label, poly: h.poly, x: top[0], y: top[1], t0: state.simT }; return "building"; }
  if (sim.isWet(x, y)) return "water";
  return "none";
}
(window as any).__tap = tap;
(window as any).__hit = (x: number, y: number) => ({ building: hitBuilding(x, y)?.label ?? null, boats: state.view?.live.boats.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.r)]) ?? [], birds: state.view?.live.birds.map(b => [Math.round(b.x), Math.round(b.y)]) ?? [] });

let pressing = false, lastP: [number, number] | null = null;
el.card.addEventListener("pointerdown", ev => { const [x, y] = toCanvas(ev); pressing = true; lastP = [x, y]; tap(x, y); });
el.card.addEventListener("pointermove", ev => {
  if (!state.live || !state.sim) return;
  const [x, y] = toCanvas(ev);
  el.card.style.cursor = state.sim.isWet(x, y) || hitBuilding(x, y) ? "pointer" : "default";
  if (!pressing || !lastP || reduceMotion) return;
  if (Math.hypot(x - lastP[0], y - lastP[1]) > 10) { if (state.sim.isWet(x, y)) state.sim.drop(x, y, 70, 1.8); lastP = [x, y]; }
});
for (const n of ["pointerup", "pointercancel", "pointerleave"]) el.card.addEventListener(n, () => { pressing = false; lastP = null; });

// ---------- real time ----------
let timer: number | undefined;
function schedule() {
  clearInterval(timer);
  timer = window.setInterval(async () => {
    if (!state.bundle || !state.live || state.postcard || document.hidden) return;
    if (state.weather && Date.now() - state.weather.fetchedAt > 15 * 60e3) { const w = await fetchWeather(state.cell); if (w) state.weather = w; }
    const m = momentFor(state.bundle, state.weather);
    state.moment = m; setLine(state.bundle, m);
    // lamps and windows follow the sun every frame; the washes follow it here
    if (paintKey(m) !== state.lastPaintKey) await paint(state.bundle, m, state.job, false);
  }, 60e3);
}

// ---------- postcards ----------
export function freeze(): { postcard: Omit<Postcard, "id" | "note">; share: HTMLCanvasElement } | null {
  if (!state.bundle || !state.moment || !state.painting) return null;
  const share = document.createElement("canvas"); share.width = 1200; share.height = 630;
  const g = share.getContext("2d")!;
  // 3:2 frame cropped to the 1.9:1 share image
  const sw = 1200, sh = 800, oy = -Math.round((sh - 630) * 0.45);
  g.drawImage(state.glr ? el.gl : state.painting, 0, oy, sw, sh);
  g.drawImage(el.life, 0, oy, sw, sh);
  return {
    postcard: { cell: state.cell, month: state.bundle.built.month, utc: state.moment.utc, weather: state.moment.weather, lifeSeed: state.lifeSeed, steps: state.steps, label: state.bundle.label },
    share,
  };
}
export function currentBundle() { return state.bundle; }
export function currentMoment() { return state.moment; }

// ---------- start ----------
setupDialogs({ load, freeze, currentBundle });
document.getElementById("send-btn")!.addEventListener("click", () => openSend());
document.getElementById("exact-btn")!.addEventListener("click", () => exactArea());
document.getElementById("else-btn")!.addEventListener("click", () => openSearch());
document.getElementById("credits-btn")!.addEventListener("click", () => openCredits());

async function exactArea() {
  if (!navigator.geolocation) return;
  status("Asking your browser where you are…");
  navigator.geolocation.getCurrentPosition(async pos => {
    // the coordinates go through the same snapping on the server and are dropped there
    const r = await fetch("/locate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude }) });
    const j = await r.json(); if (j.cell) { history.replaceState(null, "", "/"); load(j.cell); } else status(j.error || "Could not place you.", true);
  }, () => status("No location shared; still painting the area your connection suggests.", false), { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}

(async () => {
  try {
    const boot = await getBoot();
    if (boot.error && !boot.cell) { status(boot.error, true); return; }
    if (boot.postcard) { document.body.classList.add("postcard"); await load(boot.postcard.cell, { postcard: boot.postcard }); }
    else if (boot.cell) await load(boot.cell);
    else status("Could not tell where you are. Try “Paint somewhere else”.", true);
  } catch (err) { status(String((err as Error).message || err), true); }
  window.addEventListener("pagehide", () => {
    const body = JSON.stringify({ marks: state.marks, cached: !!state.bundle && !state.bundle.built.notes.includes("lite") });
    navigator.sendBeacon?.("/t", body);
  });
})();
export { unproject, fbmTile };

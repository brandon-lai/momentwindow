// Runs the whole painting, handing over each layer as soon as it exists so
// the page can show the pencil drawing, then bloom the washes in order (sky,
// water, ground, buildings, trees). The same function runs in a Web Worker
// (OffscreenCanvas) or, failing that, on the page.
import type { SceneBundle } from "../../../shared/bundle.ts";
import type { Moment } from "../moment.ts";
import { buildWorld } from "./scene.ts";
import { makeCam, paintGround, paintPencil, paintView, skyLayer, type Cam, type ViewOut } from "./paint.ts";
import { createGLR, type GLR } from "./gl.ts";
import { canvas, cx, setScale, type Cnv } from "./util.ts";

// ground: the 3D ground with reflections already in it; top: lit signs, the
// haze veil, the vignette and the splatter
export type Layer = "pencil" | "sky" | "ground" | "A" | "B" | "top" | "mask";
export interface PaintMeta { cam: Cam; hits: ViewOut["hits"]; windows: ViewOut["windows"]; zbuf: Float32Array; yFar: number; timings: Record<string, number>; hasGL: boolean; night: boolean; paper: number[] }
export interface Sink { layer(name: Layer, c: Cnv): void | Promise<void>; meta(m: PaintMeta): void }

let glr: GLR | null | undefined;
const tick = () => new Promise<void>(r => setTimeout(r, 0));

export async function paintAll(bundle: SceneBundle, moment: Moment, seed: number, scale: number, sink: Sink): Promise<void> {
  const t0 = performance.now(), timings: Record<string, number> = {}, pending: (void | Promise<void>)[] = [];
  const mark = (k: string) => { timings[k] = Math.round(performance.now() - t0); };
  setScale(scale);
  const world = buildWorld(bundle, moment, seed);
  const cam = makeCam(world);
  pending.push(sink.layer("pencil", paintPencil(world, cam))); mark("pencil");
  await tick();
  const sky = skyLayer(world, cam); pending.push(sink.layer("sky", sky)); mark("sky");
  await tick();
  const gd = await paintGround(world, tick); mark("groundTexture");
  if (glr === undefined) glr = createGLR();
  const v = paintView(world, cam, gd, glr, sky); mark("view");
  const ground = canvas(v.A.width, v.A.height), gg = cx(ground);
  if (v.ground) gg.drawImage(v.ground, 0, 0, ground.width, ground.height);
  gg.globalCompositeOperation = "multiply"; gg.globalAlpha = world.pal.night ? 0.5 : 0.55; gg.drawImage(v.refl, 0, 0); gg.globalAlpha = 1; gg.globalCompositeOperation = "source-over";
  const top = canvas(v.A.width, v.A.height), tg = cx(top);
  tg.globalCompositeOperation = "lighter"; tg.drawImage(v.glows, 0, 0); tg.globalCompositeOperation = "source-over"; tg.drawImage(v.finish, 0, 0);
  pending.push(sink.layer("ground", ground), sink.layer("mask", v.mask), sink.layer("A", v.A), sink.layer("B", v.B), sink.layer("top", top));
  await Promise.all(pending); mark("posted");
  sink.meta({ cam, hits: v.hits, windows: v.windows, zbuf: v.zbuf, yFar: v.yFar, timings, hasGL: !!glr, night: world.pal.night, paper: world.pal.paper });
}
